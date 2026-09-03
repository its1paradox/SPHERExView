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

import hashlib
import logging
import os
import threading
import time
from dataclasses import dataclass, asdict, field as dataclass_field
from typing import List, Optional

import astropy.units as u
import requests
from astropy.coordinates import SkyCoord
from astroquery.ipac.irsa import Irsa

log = logging.getLogger("spherex-wiseview")

# Map friendly survey names to IRSA obs_collection identifiers.
COLLECTIONS = {
    "wide": "spherex_qr2",
    "deep": "spherex_qr2_deep",
}

CACHE_DIR = os.environ.get(
    "SPHEREX_CACHE_DIR",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "cache")),
)

REQUEST_TIMEOUT = 120  # seconds
DOWNLOAD_RETRIES = 3
RETRY_BACKOFF_S = 1.5


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
    collection: str = "spherex_qr2",
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
        IRSA obs_collection, e.g. ``spherex_qr2`` (wide) or
        ``spherex_qr2_deep`` (deep).
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
    table = Irsa.query_sia(pos=(coord, radius_deg * u.deg), collection=collection)

    images: List[SpherexImage] = []
    for row in table:
        fmt = str(_get(row, "access_format", "") or "")
        if "fits" not in fmt.lower():
            continue
        access_url = _get(row, "access_url")
        if not access_url:
            continue
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


def get_cutout_url(access_url: str, ra: float, dec: float, size_arcsec: float) -> str:
    """Build an IRSA cutout URL from a SPHEREx image access_url.

    IRSA's dataset-level cutout service accepts ``center`` (decimal degrees)
    and ``size`` (with unit suffix) query parameters appended to the file URL.
    """
    sep = "&" if "?" in access_url else "?"
    return f"{access_url}{sep}center={ra},{dec}&size={size_arcsec}arcsec"


def _cache_path(cutout_url: str) -> str:
    key = hashlib.md5(cutout_url.encode()).hexdigest()
    return os.path.join(CACHE_DIR, f"{key}.fits")


def download_cutout(cutout_url: str) -> str:
    """Download a FITS cutout (with on-disk caching). Returns the local path.

    Raises
    ------
    CutoutNoOverlapError
        If the service reports the cutout does not overlap the image
        (HTTP 422, typically "Arrays do not overlap").
    CutoutDownloadError
        For any other non-200 response.
    """
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = _cache_path(cutout_url)
    if os.path.exists(path) and os.path.getsize(path) >= 2880:
        return path

    # IRSA is flaky under load: transient 5xx ("Server busy") and broken
    # chunked transfers (IncompleteRead) are common.  Retry with backoff and
    # NEVER let a requests exception escape -- callers treat
    # CutoutDownloadError as "skip this frame", keeping the API alive.
    last_err = None
    for attempt in range(DOWNLOAD_RETRIES):
        if attempt:
            time.sleep(RETRY_BACKOFF_S * attempt)
        try:
            resp = requests.get(cutout_url, timeout=REQUEST_TIMEOUT)
        except requests.RequestException as exc:
            # ChunkedEncodingError / ConnectionError / Timeout / ...
            last_err = f"network error: {exc.__class__.__name__}: {exc}"
            continue
        if resp.status_code == 422:
            raise CutoutNoOverlapError(cutout_url)
        if resp.status_code in (500, 502, 503, 504):
            last_err = f"HTTP {resp.status_code}: {resp.text[:120]}"
            continue
        if resp.status_code != 200:
            raise CutoutDownloadError(
                f"HTTP {resp.status_code} for {cutout_url}: {resp.text[:200]}"
            )
        if len(resp.content) < 2880:  # smaller than one FITS block = junk
            last_err = f"truncated response ({len(resp.content)} bytes)"
            continue
        # Atomic write so a crashed/partial download never poisons the cache.
        tmp = f"{path}.tmp.{os.getpid()}.{threading.get_ident()}"
        with open(tmp, "wb") as fh:
            fh.write(resp.content)
        os.replace(tmp, path)
        return path
    raise CutoutDownloadError(
        f"giving up after {DOWNLOAD_RETRIES} attempts for {cutout_url}: {last_err}"
    )
