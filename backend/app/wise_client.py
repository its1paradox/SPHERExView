"""WiseView (byw.tools) time-resolved unWISE epoch client + Gaia DR3 markers.

This uses the same services as http://byw.tools/wiseview and AstroToolBox's
Image Viewer tab:

- ``http://byw.tools/tiles?ra=&dec=``    -> lists time-resolved unWISE epochs
  (one per ~6 months since 2010) with their mean MJDs per band.
- ``http://byw.tools/cutout?ra=&dec=&size=&band=&epoch=`` -> FITS cutout of a
  single epoch coadd (size in unWISE pixels, 2.75 arcsec/px).

Gaia DR3 sources are queried once per field via the ESA Gaia TAP service and
propagated (proper motion) to each epoch's MJD.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from typing import Dict, List

import numpy as np
import requests

log = logging.getLogger("spherex-wiseview")

TILES_URL = "http://byw.tools/tiles"
CUTOUT_URL = "http://byw.tools/cutout"
UNWISE_PIXSCALE = 2.75  # arcsec / pixel
MAX_SIZE_PX = 300

CACHE_DIR = os.environ.get(
    "SPHEREX_CACHE_DIR",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "cache")),
)

REQUEST_TIMEOUT = 120
DOWNLOAD_RETRIES = 3
RETRY_BACKOFF_S = 1.5


def _get_with_retries(url: str, params: dict, what: str) -> requests.Response:
    """GET with retries on transient 5xx / network errors.  Raises
    WiseCutoutError (never a raw requests exception) so callers can treat
    failures as "skip", keeping the API alive."""
    last_err = None
    for attempt in range(DOWNLOAD_RETRIES):
        if attempt:
            time.sleep(RETRY_BACKOFF_S * attempt)
        try:
            resp = requests.get(url, params=params, timeout=REQUEST_TIMEOUT)
        except requests.RequestException as exc:
            last_err = f"network error: {exc.__class__.__name__}: {exc}"
            continue
        if resp.status_code in (500, 502, 503, 504):
            last_err = f"HTTP {resp.status_code}"
            continue
        return resp
    raise WiseCutoutError(f"{what}: giving up after {DOWNLOAD_RETRIES} attempts ({last_err})")


class WiseCutoutError(Exception):
    """byw.tools returned no usable data for this request."""


def arcsec_to_px(size_arcsec: float) -> int:
    return int(np.clip(round(size_arcsec / UNWISE_PIXSCALE), 10, MAX_SIZE_PX))


def get_epochs(ra: float, dec: float, band: int) -> List[dict]:
    """List time-resolved unWISE epochs at this position for band 1|2.

    Returns [{"epoch": int, "mjdmean": float, "forward": int}, ...] sorted by
    epoch number.
    """
    resp = _get_with_retries(TILES_URL, {"ra": ra, "dec": dec}, "tiles service")
    if resp.status_code != 200:
        raise WiseCutoutError(f"tiles service HTTP {resp.status_code}")
    tiles = resp.json().get("tiles") or []
    if not tiles:
        raise WiseCutoutError("no unWISE tile covers this position")
    epochs = [
        {"epoch": e["epoch"], "mjdmean": e["mjdmean"], "forward": e.get("forward", 0)}
        for e in tiles[0].get("epochs", [])
        if e.get("band") == band
    ]
    epochs.sort(key=lambda e: e["epoch"])
    log.info("byw.tools: %d W%d epochs at (%.4f, %.4f)", len(epochs), band, ra, dec)
    return epochs


def download_epoch_cutout(
    ra: float, dec: float, size_arcsec: float, band: int, epoch: int
) -> str:
    """Download one time-resolved epoch cutout FITS (cached). Returns path."""
    size_px = arcsec_to_px(size_arcsec)
    key = hashlib.md5(f"byw|{ra:.5f}|{dec:.5f}|{size_px}|{band}|{epoch}".encode()).hexdigest()
    path = os.path.join(CACHE_DIR, f"{key}.fits")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path

    resp = _get_with_retries(
        CUTOUT_URL,
        {"ra": ra, "dec": dec, "size": size_px, "band": band, "epoch": epoch},
        f"cutout epoch={epoch}",
    )
    if resp.status_code != 200 or len(resp.content) < 2880:
        raise WiseCutoutError(f"cutout HTTP {resp.status_code} for epoch={epoch}")

    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}.{threading.get_ident()}"
    with open(tmp, "wb") as fh:
        fh.write(resp.content)
    os.replace(tmp, path)
    return path


# ---------------------------------------------------------------------------
# Gaia DR3
# ---------------------------------------------------------------------------

_GAIA_CACHE: Dict[str, list] = {}
_GAIA_LOCK = threading.Lock()

GAIA_REF_EPOCH = 2016.0  # Gaia DR3 reference epoch (Julian year)
GAIA_MAX_SOURCES = 200


def query_gaia(ra: float, dec: float, radius_arcsec: float) -> List[dict]:
    """Cone-search Gaia DR3. Returns [{source_id, ra, dec, pmra, pmdec, gmag}].

    Results are cached in-memory per field.  pmra/pmdec are mas/yr (pmra
    includes cos(dec)); missing proper motions are returned as 0.
    """
    key = f"{ra:.5f}|{dec:.5f}|{radius_arcsec:.1f}"
    with _GAIA_LOCK:
        if key in _GAIA_CACHE:
            return _GAIA_CACHE[key]

    from astroquery.gaia import Gaia  # deferred import (slow module)

    radius_deg = radius_arcsec / 3600.0
    adql = f"""
        SELECT TOP {GAIA_MAX_SOURCES}
               source_id, ra, dec, pmra, pmdec, phot_g_mean_mag
        FROM gaiadr3.gaia_source
        WHERE 1=CONTAINS(POINT('ICRS', ra, dec),
                         CIRCLE('ICRS', {ra}, {dec}, {radius_deg}))
        ORDER BY phot_g_mean_mag ASC
    """
    job = Gaia.launch_job(adql)
    table = job.get_results()

    # astroquery returns UPPERCASE column names in some versions (e.g.
    # SOURCE_ID) and lowercase in others -- resolve case-insensitively.
    colmap = {c.lower(): c for c in table.colnames}

    sources = []
    for row in table:
        def val(col, default=None):
            v = row[colmap[col]]
            if v is None or (hasattr(v, "mask") and v.mask):
                return default
            v = float(v)
            return default if np.isnan(v) else v

        sources.append(
            {
                "source_id": str(row[colmap["source_id"]]),
                "ra": val("ra"),
                "dec": val("dec"),
                "pmra": val("pmra", 0.0) or 0.0,
                "pmdec": val("pmdec", 0.0) or 0.0,
                "gmag": val("phot_g_mean_mag"),
            }
        )

    with _GAIA_LOCK:
        _GAIA_CACHE[key] = sources
    log.info("Gaia DR3: %d sources at (%.4f, %.4f) r=%.0f\"", len(sources), ra, dec, radius_arcsec)
    return sources


def propagate(sources: List[dict], epoch_year: float) -> List[dict]:
    """Propagate Gaia positions from 2016.0 to epoch_year using pmra/pmdec."""
    dt = epoch_year - GAIA_REF_EPOCH
    out = []
    for s in sources:
        cosd = np.cos(np.radians(s["dec"])) or 1e-9
        out.append(
            {
                **s,
                "ra": s["ra"] + (s["pmra"] / 3.6e6) * dt / cosd,
                "dec": s["dec"] + (s["pmdec"] / 3.6e6) * dt,
            }
        )
    return out
