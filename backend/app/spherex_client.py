"""Client for querying SPHEREx spectral images from NASA/IPAC IRSA.

Design notes / lessons learned
------------------------------
1. We use ``astroquery.ipac.irsa.Irsa.query_sia`` rather than a bare
   ``pyvo.dal.SIA2Service``.  Two reasons:

   * ``SIA2Service.search(pos=(ra, dec))`` does NOT accept a raw float
     tuple -- it expects ``(SkyCoord, Quantity)`` pairs and raises a bare
     ``ValueError`` from ``_validate_pos`` otherwise.
   * A service constructed from
     ``https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_qr2`` does not
     reliably apply the COLLECTION filter, and can return images from other
     missions (e.g. Spitzer).  ``Irsa.query_sia(collection=...)`` passes the
     collection through correctly.

2. IRSA's cutout service can return HTTP 422 ("Arrays do not overlap") for
   images whose elongated / rotated SPHEREx detector footprint matched the
   cone search but does not actually contain the requested position.  We
   surface this as :class:`CutoutNoOverlapError` so callers can skip the
   image instead of failing the whole request.
"""

from __future__ import annotations

from . import research

import hashlib
import logging
import os
import random
import threading
import time
import warnings
from dataclasses import dataclass, asdict, field as dataclass_field
from datetime import timezone
from email.utils import parsedate_to_datetime
from typing import List, Optional

import astropy.units as u
import requests
from astropy.coordinates import SkyCoord
from astroquery.ipac.irsa import Irsa
from . import releases

log = logging.getLogger("spherex-wiseview")

# Map friendly survey names to IRSA obs_collection identifiers.
COLLECTIONS = {survey: releases.RELEASES["dr1"][survey] for survey in ("wide", "deep")}

CACHE_DIR = os.environ.get(
    "SPHEREX_CACHE_DIR",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "cache")),
)

CONNECT_TIMEOUT = 15  # seconds to establish a connection
REQUEST_TIMEOUT = 120  # seconds without response data, not a total transfer deadline
DOWNLOAD_RETRIES = 5  # total attempts, including the first request
RETRY_BACKOFF_S = 2
MAX_RETRY_DELAY_S = 60
RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}


class CutoutNoOverlapError(Exception):
    """The requested cutout does not overlap this image's footprint."""


class CutoutDownloadError(Exception):
    """The cutout service returned an unexpected error."""


@dataclass
class SpherexImage:
    """One SPHEREx spectral image (one detector exposure) from SIA2."""

    access_url: str
    band: str
    survey: str
    obs_id: str
    t_min: Optional[float]  # MJD
    t_max: Optional[float]  # MJD
    t_exptime: Optional[float]
    em_min: Optional[float]  # metres
    em_max: Optional[float]  # metres
    s_ra: Optional[float]
    s_dec: Optional[float]
    # Every other column IRSA's SIA2 service returns for this image --
    # exposed verbatim so the UI can show ALL the archive metadata.
    extra: dict = dataclass_field(default_factory=dict)

    @property
    def mjd_mid(self) -> Optional[float]:
        if self.t_min is not None and self.t_max is not None:
            return 0.5 * (self.t_min + self.t_max)
        return self.t_min

    def to_dict(self) -> dict:
        d = asdict(self)
        extra = d.pop("extra", {}) or {}
        d["mjd_mid"] = self.mjd_mid
        d["data_release"] = releases.product_release(self.access_url, self.survey)
        # Merge the full SIA record without clobbering the typed fields.
        for k, v in extra.items():
            d.setdefault(k, v)
        return d


def _plain(val):
    """Convert an astropy/numpy table value to a JSON-safe plain type."""
    import numpy as np

    if val is None or (hasattr(val, "mask") and getattr(val, "mask", False)):
        return None
    if isinstance(val, (np.floating, np.integer, np.bool_)):
        val = val.item()
    if isinstance(val, bytes):
        val = val.decode(errors="replace")
    if isinstance(val, float) and (np.isnan(val) or np.isinf(val)):
        return None
    if isinstance(val, (str, int, float, bool)):
        return val
    return str(val)


def _get(row, key, default=None):
    """Robustly read a possibly-masked value from an astropy table row."""
    try:
        val = row[key]
    except KeyError:
        return default
    try:
        import numpy as np

        if val is None or (hasattr(val, "mask") and val.mask):
            return default
        if isinstance(val, (np.floating, np.integer)):
            val = val.item()
        if isinstance(val, float) and np.isnan(val):
            return default
    except Exception:
        pass
    return val


def query_sia2(
    ra: float,
    dec: float,
    radius_deg: float = 0.01,
    collection: str = "spherex_dr1",
    band: Optional[str] = None,
) -> List[SpherexImage]:
    """Cone-search SPHEREx spectral images via IRSA's SIA2 interface.

    Parameters
    ----------
    ra, dec : float
        ICRS position in decimal degrees.
    radius_deg : float
        Search radius in degrees.
    collection : str
        IRSA obs_collection, e.g. ``spherex_dr1`` (wide) or
        ``spherex_dr1_deep`` (deep).
    band : str, optional
        Filter on SPHEREx detector/band name(s), e.g. ``SPHEREx-D1`` or a
        comma-separated list ``SPHEREx-D1,SPHEREx-D3``.  Substring match,
        case-insensitive; an image is kept if it matches ANY listed band.
    """
    wanted = [b.strip().lower() for b in band.split(",") if b.strip()] if band else None
    coord = SkyCoord(ra=ra * u.deg, dec=dec * u.deg, frame="icrs")
    log.info(
        "SIA2 query: ra=%.5f dec=%.5f r=%.4f deg collection=%s",
        ra, dec, radius_deg, collection,
    )
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        table = Irsa.query_sia(pos=(coord, radius_deg * u.deg), collection=collection)
    if any("overflow" in str(w.message).lower() for w in caught):
        raise ValueError("IRSA truncated the observation inventory; narrow the search")

    images: List[SpherexImage] = []
    for row in table:
        fmt = str(_get(row, "access_format", "") or "")
        if "fits" not in fmt.lower():
            continue
        access_url = _get(row, "access_url")
        if not access_url:
            continue
        actual_collection = str(_get(row, "obs_collection", "") or "")
        if actual_collection != collection:
            raise ValueError("IRSA returned an unexpected collection; refusing to mix datasets")
        releases.product_release(str(access_url), actual_collection)
        band_name = str(_get(row, "energy_bandpassname", "") or "")
        if wanted and not any(b in band_name.lower() for b in wanted):
            continue
        extra = {}
        try:
            for col in table.colnames:
                v = _plain(_get(row, col))
                if v is not None:
                    extra[col] = v
        except Exception:  # metadata must never break the query
            pass
        images.append(
            SpherexImage(
                access_url=str(access_url),
                band=band_name,
                survey=str(_get(row, "obs_collection", collection) or collection),
                obs_id=str(_get(row, "obs_id", "") or ""),
                t_min=_get(row, "t_min"),
                t_max=_get(row, "t_max"),
                t_exptime=_get(row, "t_exptime"),
                em_min=_get(row, "em_min"),
                em_max=_get(row, "em_max"),
                s_ra=_get(row, "s_ra"),
                s_dec=_get(row, "s_dec"),
                extra=extra,
            )
        )
    log.info("SIA2 returned %d FITS images after filtering", len(images))
    return images


def query_releases(ra, dec, radius_deg=0.01, survey="wide", release="all", band=None,
                   query=None):
    """Fresh discovery for every request; a failed release query is not empty coverage.

    Query both releases before any time sorting or preview sampling. Select one
    processing per physical observation/detector, preferring current processing
    over legacy QR2, and retain superseded copies in exported provenance.
    """
    query = query or query_sia2
    images = []
    for collection in releases.collections(survey, release):
        images.extend(query(ra, dec, radius_deg=radius_deg, collection=collection, band=band))
    chosen = {}
    for im in images:
        rel = releases.product_release(im.access_url, im.survey)
        if release != "all" and rel != release:
            raise ValueError("Archive product does not match the requested release")
        if not im.obs_id or not im.band:
            raise ValueError("Archive product lacks a reproducible exposure identity/version")
        rank = releases.processing_rank(im.access_url, rel)
        key = (im.obs_id, im.band)
        old = chosen.get(key)
        if old and rank == old[0] and im.access_url != old[1].access_url:
            raise ValueError("Conflicting products have the same exposure and processing version")
        if old:
            winner, loser = (im, old[1]) if rank > old[0] else (old[1], im)
            if loser.access_url != winner.access_url:
                winner.extra.setdefault("superseded_products", []).extend(
                    [loser.access_url, *loser.extra.get("superseded_products", [])])
        if old is None or rank > old[0]:
            chosen[key] = (rank, im)
    return sorted((v[1] for v in chosen.values()), key=lambda im: (
        im.mjd_mid is None, im.mjd_mid or 0, im.obs_id, im.band))


def preview_order(images, limit):
    """Prioritize a time-spanning preview so early data cannot hide later visits.

    Remaining candidates allow callers to replace failed cutouts. This is
    display sampling only; the six-detector science path uses its full inventory.
    """
    if len(images) <= limit:
        return list(images)
    import numpy as np
    indices = [len(images) - 1] if limit == 1 else np.linspace(0, len(images) - 1, limit).round().astype(int).tolist()
    chosen = set(indices)
    return [images[i] for i in indices] + [im for i, im in enumerate(images) if i not in chosen]


def get_cutout_url(access_url: str, ra: float, dec: float, size_arcsec: float) -> str:
    """Build an IRSA cutout URL from a SPHEREx image access_url.

    IRSA's dataset-level cutout service accepts ``center`` (decimal degrees)
    and ``size`` (with unit suffix) query parameters appended to the file URL.
    """
    sep = "&" if "?" in access_url else "?"
    return f"{access_url}{sep}center={ra},{dec}&size={size_arcsec}arcsec"


def _cache_path(cutout_url: str) -> str:
    key = hashlib.md5(cutout_url.encode()).hexdigest()
    return os.path.join(research.cache_dir(CACHE_DIR), f"{key}.fits")


def _retry_after_seconds(value):
    """Parse either HTTP Retry-After form; malformed values use local backoff."""
    if not value:
        return None
    value = value.strip()
    if value.isascii() and value.isdecimal():
        value = value.lstrip("0") or "0"
        # Avoid unbounded integer parsing for a malformed upstream header.
        return int(value) if len(value) < 10 else MAX_RETRY_DELAY_S + 1
    try:
        date = parsedate_to_datetime(value)
        if date.tzinfo is None:
            date = date.replace(tzinfo=timezone.utc)
        return max(0, date.timestamp() - time.time())
    except (TypeError, ValueError, OverflowError):
        return None


def _looks_like_fits(path):
    """Cheap transport/cache check; science loaders validate the FITS contents."""
    try:
        size = os.path.getsize(path)
        if size < 2880 or size % 2880:
            return False
        with open(path, "rb") as stream:
            return stream.read(9) == b"SIMPLE  ="
    except FileNotFoundError:
        return False


@research.source_download(_cache_path)
def download_cutout(cutout_url: str) -> str:
    """Download a FITS cutout (with on-disk caching). Returns the local path.

    Raises
    ------
    CutoutNoOverlapError
        If the service reports the cutout does not overlap the image
        (HTTP 422, typically "Arrays do not overlap").
    CutoutDownloadError
        For permanent HTTP errors or exhausted transient retries.
    """
    os.makedirs(research.cache_dir(CACHE_DIR), exist_ok=True)
    path = _cache_path(cutout_url)
    if _looks_like_fits(path):
        return path

    # Keep our own retry loop: failures can occur while consuming the body,
    # after HTTP-level adapter retries have already finished. Never publish a
    # partial transfer, and close the response before waiting/retrying.
    last_err = None
    tmp = f"{path}.tmp.{os.getpid()}.{threading.get_ident()}"
    for attempt in range(DOWNLOAD_RETRIES):
        retry_after = None
        try:
            with requests.get(cutout_url, timeout=(CONNECT_TIMEOUT, REQUEST_TIMEOUT), stream=True) as resp:
                if resp.status_code == 422:
                    raise CutoutNoOverlapError(cutout_url)
                if resp.status_code in RETRYABLE_STATUS:
                    last_err = f"HTTP {resp.status_code}"
                    retry_after = _retry_after_seconds(resp.headers.get("Retry-After"))
                elif resp.status_code != 200:
                    raise CutoutDownloadError(f"HTTP {resp.status_code} for {cutout_url}")
                else:
                    size = 0
                    with open(tmp, "wb") as stream:
                        for chunk in resp.iter_content(chunk_size=64 * 1024):
                            if chunk:
                                with research.lock:
                                    research.reserve_source(len(chunk))
                                    stream.write(chunk)
                                    stream.flush()
                                size += len(chunk)
                    # iter_content decodes HTTP content encodings. Compare
                    # Content-Length only when it describes the decoded bytes.
                    length = resp.headers.get("Content-Length", "")
                    identity = resp.headers.get("Content-Encoding", "identity").lower() == "identity"
                    if identity and length.isascii() and length.isdecimal() and str(size) != (length.lstrip("0") or "0"):
                        last_err = f"truncated response ({size} of {length} bytes)"
                    elif not _looks_like_fits(tmp):
                        last_err = f"invalid or truncated FITS response ({size} bytes)"
                    else:
                        os.replace(tmp, path)
                        return path
        except requests.RequestException as exc:
            last_err = f"network error: {exc.__class__.__name__}: {exc}"
        finally:
            try:
                os.remove(tmp)
            except FileNotFoundError:
                pass
        if attempt + 1 == DOWNLOAD_RETRIES:
            break
        # Do not shorten a server-directed delay to fit our wait limit. End
        # this download instead of hammering an unavailable archive too early.
        if retry_after is not None and retry_after > MAX_RETRY_DELAY_S:
            raise CutoutDownloadError(
                f"{last_err} for {cutout_url}; server Retry-After exceeds "
                f"the {MAX_RETRY_DELAY_S}s retry wait limit; try again later"
            )
        backoff = min(MAX_RETRY_DELAY_S, RETRY_BACKOFF_S * 2**attempt)
        delay = max(backoff, retry_after or 0)
        delay = min(MAX_RETRY_DELAY_S, delay + random.uniform(0, 1))
        log.warning("Retrying SPHEREx download in %.1fs (%d/%d): %s", delay, attempt + 2, DOWNLOAD_RETRIES, last_err)
        time.sleep(delay)
    raise CutoutDownloadError(
        f"giving up after {DOWNLOAD_RETRIES} attempts for {cutout_url}: {last_err}"
    )
