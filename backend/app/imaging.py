"""FITS handling: raw pixel extraction, metadata, and WCS projection.

The frontend renders images client-side from raw float32 arrays so that
contrast/stretch/zoom controls (AstroToolBox-style) react instantly without
re-requesting the server."""

from __future__ import annotations

import base64
import logging
import os
from typing import Optional, Tuple

import numpy as np
from astropy.io import fits
from astropy.visualization import AsinhStretch, ZScaleInterval
from astropy.wcs import WCS
from PIL import Image
from reproject import reproject_interp

log = logging.getLogger("spherex-wiseview")

# Upscale factor for display: SPHEREx native pixels are ~6.2 arcsec, so raw
# cutouts are tiny (e.g. 19x19 px for a 60 arcsec radius). Nearest-neighbour
# upscaling keeps pixels sharp for blinking.
DISPLAY_SCALE = 16
MAX_DISPLAY_PX = 1024


def _find_image_hdu(hdul: fits.HDUList) -> Optional[fits.ImageHDU]:
    """Return the first HDU that carries a 2-D image."""
    for hdu in hdul:
        if hdu.data is not None and getattr(hdu.data, "ndim", 0) == 2:
            return hdu
    return None


def fits_to_png(fits_path: str, png_path: str) -> Tuple[str, dict]:
    """Convert a SPHEREx FITS cutout to a stretched grayscale PNG.

    Uses zscale interval + asinh stretch for a DS9/WISE-like appearance.
    Returns (png_path, metadata_dict).
    """
    with fits.open(fits_path) as hdul:
        hdu = _find_image_hdu(hdul)
        if hdu is None:
            raise ValueError(f"No 2-D image HDU found in {fits_path}")
        data = np.asarray(hdu.data, dtype=np.float64)
        header = hdu.header
        primary = hdul[0].header

    meta = {
        "shape": list(data.shape),
        "detector": primary.get("DETECTOR", header.get("DETECTOR")),
        "obsdate": primary.get("DATE-OBS", header.get("DATE-OBS")),
        "mjd": primary.get("MJD-OBS", header.get("MJD-OBS")),
        "exptime": primary.get("EXPTIME", header.get("EXPTIME")),
        "bunit": header.get("BUNIT"),
    }

    finite = data[np.isfinite(data)]
    if finite.size == 0:
        raise ValueError(f"Cutout {fits_path} contains no finite pixels")

    # Replace NaNs with the median so the stretch is not skewed.
    data = np.where(np.isfinite(data), data, np.median(finite))

    interval = ZScaleInterval()
    try:
        vmin, vmax = interval.get_limits(data)
    except Exception:
        vmin, vmax = np.percentile(data, [1, 99])
    if vmax <= vmin:
        vmin, vmax = float(data.min()), float(data.max() or data.min() + 1)

    norm = np.clip((data - vmin) / (vmax - vmin), 0, 1)
    stretched = AsinhStretch(a=0.1)(norm)
    img8 = (stretched * 255).astype(np.uint8)

    # FITS row order is bottom-up; flip so north-up images display correctly.
    img = Image.fromarray(np.flipud(img8), mode="L")

    scale = min(DISPLAY_SCALE, max(1, MAX_DISPLAY_PX // max(img.size)))
    if scale > 1:
        img = img.resize((img.size[0] * scale, img.size[1] * scale), Image.NEAREST)

    os.makedirs(os.path.dirname(png_path), exist_ok=True)
    img.save(png_path)
    return png_path, meta


def _north_up_wcs(ra: float, dec: float, pixscale_deg: float, n: int) -> WCS:
    """Plain TAN WCS centered on (ra, dec): north up, east LEFT (negative
    CD1_1), the standard astronomical display orientation used by unWISE /
    WiseView / AstroToolBox."""
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2.0, (n + 1) / 2.0]
    w.wcs.cd = [[-pixscale_deg, 0.0], [0.0, pixscale_deg]]
    return w


def wcs_to_dict(wcs: WCS, height: int) -> dict:
    """Linear TAN terms for the frontend hover readout (display-oriented:
    the frontend un-flips the row before applying, see render.js)."""
    cd = wcs.pixel_scale_matrix  # deg/px, includes rotation; SIP-free here
    return {
        "crval1": float(wcs.wcs.crval[0]),
        "crval2": float(wcs.wcs.crval[1]),
        "crpix1": float(wcs.wcs.crpix[0]),
        "crpix2": float(wcs.wcs.crpix[1]),
        "cd11": float(cd[0, 0]),
        "cd12": float(cd[0, 1]),
        "cd21": float(cd[1, 0]),
        "cd22": float(cd[1, 1]),
        "height": int(height),
    }


def fits_to_array(fits_path: str, north_up_center=None, out_size_arcsec=None):
    """Extract the 2-D image as a display-oriented float32 array.

    Returns (array, height, width, metadata, wcs_dict).  The array is flipped
    vertically (FITS row order is bottom-up) so row 0 is the TOP row --
    the frontend can copy it straight into an ImageData buffer.  NaNs are
    replaced with the median of finite pixels.

    If ``north_up_center=(ra, dec)`` the image is first REPROJECTED onto a
    north-up/east-left TAN grid centered on that position at the image's
    native pixel scale (nearest-neighbour, so raw pixel values survive).
    SPHEREx exposures carry arbitrary spacecraft roll angles in their WCS,
    so without this step frames appear rotated/mirrored relative to the
    unWISE (WiseView) panel.  ``out_size_arcsec`` sets the output grid's
    field of view (defaults to the largest input dimension).
    """
    with fits.open(fits_path) as hdul:
        hdu = _find_image_hdu(hdul)
        if hdu is None:
            raise ValueError(f"No 2-D image HDU found in {fits_path}")
        data = np.asarray(hdu.data, dtype=np.float32)
        header = hdu.header
        primary = hdul[0].header
        wcs_in = WCS(header)

        meta = {
            "shape": list(data.shape),
            "detector": primary.get("DETECTOR", header.get("DETECTOR")),
            "obsdate": primary.get("DATE-OBS", header.get("DATE-OBS")),
            "mjd": primary.get("MJD-OBS", header.get("MJD-OBS")),
            "exptime": primary.get("EXPTIME", header.get("EXPTIME")),
            "bunit": header.get("BUNIT"),
        }

        finite = data[np.isfinite(data)]
        if finite.size == 0:
            raise ValueError(f"Cutout {fits_path} contains no finite pixels")
        fill = np.float32(np.median(finite))

        wcs_out = wcs_in
        if north_up_center is not None:
            ra0, dec0 = north_up_center
            pixscale = float(np.sqrt(abs(np.linalg.det(wcs_in.pixel_scale_matrix))))
            if out_size_arcsec:
                n = max(4, int(round(out_size_arcsec / (pixscale * 3600.0))))
            else:
                n = max(data.shape)
            wcs_out = _north_up_wcs(ra0, dec0, pixscale, n)
            data, _ = reproject_interp(
                (data, wcs_in), wcs_out, shape_out=(n, n), order="nearest-neighbor"
            )
            data = np.asarray(data, dtype=np.float32)
            meta["reprojected"] = True
            meta["pixscale_arcsec"] = pixscale * 3600.0
            # Coverage bookkeeping BEFORE NaNs are filled: does this
            # exposure actually contain data at the target position (the
            # output grid center)?  Cone-matched SPHEREx footprints can
            # clip only the edge of the field; the combined WISE->SPHEREx
            # movie drops frames whose target pixel is empty.
            finite_mask = np.isfinite(data)
            meta["valid_frac"] = round(float(finite_mask.mean()), 4)
            c = n // 2
            lo, hi = max(0, c - 1), min(n, c + 2)
            meta["target_covered"] = bool(np.any(finite_mask[lo:hi, lo:hi]))

    data = np.where(np.isfinite(data), data, fill)
    data = np.flipud(data)
    h, w = data.shape
    return data, h, w, meta, wcs_to_dict(wcs_out, h)


def array_to_b64(data: np.ndarray) -> str:
    """Encode a float32 array as base64 little-endian bytes for JSON."""
    return base64.b64encode(np.ascontiguousarray(data, dtype="<f4").tobytes()).decode()


def world_to_pixels(fits_path: str, coords: list) -> list:
    """Project (ra, dec) pairs into display-oriented pixel coordinates.

    Coordinates match the arrays produced by :func:`fits_to_array` (row 0 =
    top).  The frontend multiplies by its zoom factor.  Points outside the
    image are returned as None.
    """
    with fits.open(fits_path) as hdul:
        hdu = _find_image_hdu(hdul)
        if hdu is None:
            raise ValueError(f"No 2-D image HDU found in {fits_path}")
        wcs = WCS(hdu.header)
        h, w = hdu.data.shape

    out = []
    for ra, dec in coords:
        try:
            x, y = wcs.world_to_pixel_values(ra, dec)
            x, y = float(x), float(y)
        except Exception:
            out.append(None)
            continue
        if not (np.isfinite(x) and np.isfinite(y)) or not (-0.5 <= x < w - 0.5 and -0.5 <= y < h - 0.5):
            out.append(None)
            continue
        out.append(
            {
                "x": x + 0.5,
                "y": h - 1 - y + 0.5,  # vertical flip applied in fits_to_array
            }
        )
    return out
