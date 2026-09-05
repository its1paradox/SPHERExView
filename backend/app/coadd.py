"""Per-detector CO-ADD of SPHEREx exposures.

Scientific design (see docs/coadd_feature_research.md for the full study)
-------------------------------------------------------------------------
Every SPHEREx detector sits behind a linear variable filter (LVF): the
passband wavelength varies across the array, and repeated visits observe a
target at different detector positions (= different wavelengths).  A
per-detector coadd is therefore a *broadband-like visualization product* --
a sampling-weighted average over part of the detector's wavelength range --
NOT a monochromatic image.  The UI labels it "CO-ADD (mixed lambda)" and
reports the actual wavelength range sampled at the target.

Recipe (MVP, per the research report):

1. ``IMAGE - ZODI``: the QR pipeline stores its zodiacal-light model in a
   ``ZODI`` extension instead of subtracting it.  Zodi is time-variable
   (seasonal) and carries an LVF wavelength gradient, so exposures from
   different dates MUST be background-matched before averaging.
2. Reproject science / variance / flags once onto ONE shared north-up TAN
   grid centred on the target (all detectors share the grid, so the six
   coadds blink perfectly aligned).  The conservative default is
   nearest-neighbour at the native 6.2 arcsec sampling: it keeps raw pixel
   values intact, variances remain valid per-pixel, and no correlated noise
   is introduced.  A display-optimised bilinear mode and finer output
   sampling are also available for less blocky visual inspection; they do
   not create additional angular resolution.  There is NO second
   reprojection.
3. Zero-weight pixels with fatal ``FLAGS`` bits (bit numbers read from each
   file's FLAGS header, e.g. ``MP_NONFUNC``), non-finite science values,
   non-finite / non-positive variance, and no reprojection coverage.
   ``MP_SOURCE`` (real detected sources) and ``MP_FULLSAMPLE`` are benign
   and never masked.
4. Optional conservative sigma-clipping (only when N >= 5 exposures cover a
   pixel): 5-sigma about the median with a MAD scale, max 2 iterations.
5. Weighted mean with per-exposure SCALAR weights ``w_i = 1 / median(V_i)``
   (inverse sky variance).  Per-PIXEL inverse-variance weights would be
   signal-dependent -- SPHEREx VARIANCE includes source photon noise, so
   exposures in which the source is brighter get down-weighted exactly at
   the source, biasing its flux low (we measured a ~35% deficit on a bright
   star before switching; scalar weights are the standard survey-coadd fix).
   Per-pixel variance is still used for masking and is propagated exactly:
   ``V_coadd = sum(w_i^2 V_ip) / (sum w_i)^2``.  Integer coverage map
   ``N_p`` counts contributing exposures per pixel.
6. Per-exposure target wavelength comes from the official ``WCS-WAVE``
   lookup table (FITS -TAB convention, alternate WCS key 'W') evaluated at
   the target's native detector position; the response reports min /
   weighted-mean / max over the used exposures.

Expected SNR gain for a stationary source is ~sqrt(N) in the
background-limited regime (photometric validation in tests/test_coadd.py).
"""

from __future__ import annotations

import logging
import warnings
from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np
from astropy.io import fits
from astropy.stats import mad_std, sigma_clip
from astropy.wcs import WCS
from reproject import reproject_interp

from .imaging import _north_up_wcs, wcs_to_dict

log = logging.getLogger("spherex-wiseview")

# Canonical shared-grid pixel scale: SPHEREx native pixels are ~6.15-6.2
# arcsec; one fixed scale keeps all six detector coadds on the SAME grid.
COADD_PIXSCALE_ARCSEC = 6.2

# FLAGS bits that invalidate a pixel (bit numbers resolved per-file from the
# FLAGS header's MP_* keywords; these names are the fallback contract).
# MP_SOURCE (=real astronomical sources!) and MP_FULLSAMPLE are benign.
FATAL_FLAG_NAMES = (
    "MP_TRANSIENT", "MP_OVERFLOW", "MP_SUR_ERROR", "MP_PHANTOM",
    "MP_REFERENCE", "MP_NONFUNC", "MP_DICHROIC", "MP_MISSING_DATA",
    "MP_HOT", "MP_COLD", "MP_PHANMISS", "MP_NONLINEAR", "MP_PERSIST",
    "MP_OUTLIER",
)
# Fallback bit numbers (QR2 convention) if a FLAGS header lacks MP_* cards.
FATAL_FLAG_FALLBACK_BITS = (0, 1, 2, 4, 5, 6, 7, 9, 10, 11, 14, 15, 17, 19)


@dataclass
class AlignedExposure:
    """One exposure's cutout resampled onto the shared coadd grid."""

    sci: np.ndarray          # background-treated surface brightness (MJy/sr)
    var: np.ndarray          # per-pixel variance ((MJy/sr)^2)
    valid: np.ndarray        # bool: pixel may contribute
    mjd: Optional[float]
    wavelength_um: Optional[float]   # LVF wavelength at the target position
    bandwidth_um: Optional[float]
    detector: Optional[int]
    obs_id: str = ""
    did: str = ""            # obs_publisher_did (provenance)
    extras: dict = field(default_factory=dict)


def output_grid(
    ra: float,
    dec: float,
    out_size_arcsec: float,
    pixscale_arcsec: float = COADD_PIXSCALE_ARCSEC,
):
    """The shared north-up TAN grid all detector coadds live on."""
    n = max(4, int(round(out_size_arcsec / pixscale_arcsec)))
    return n, _north_up_wcs(ra, dec, pixscale_arcsec / 3600.0, n)


def _fatal_mask_value(flags_header) -> int:
    """Build the fatal-bit mask from a FLAGS header's MP_* keywords."""
    mask = 0
    found = False
    for name in FATAL_FLAG_NAMES:
        if name in flags_header:
            mask |= 1 << int(flags_header[name])
            found = True
    if not found:  # header stripped by the cutout service -> QR2 fallback
        for bit in FATAL_FLAG_FALLBACK_BITS:
            mask |= 1 << bit
    return mask


def _strip_sip(header: fits.Header) -> fits.Header:
    """Header copy without SIP polynomial cards.

    The wavelength lookup (alternate WCS 'W', -TAB convention) is defined on
    raw pixel coordinates; astropy would otherwise apply the celestial SIP
    polynomial to it and emit a warning.
    """
    h = header.copy()
    for order_key in ("A_ORDER", "B_ORDER", "AP_ORDER", "BP_ORDER"):
        h.pop(order_key, None)
    for card in list(h.keys()):
        if card and card[:2] in ("A_", "B_") or card[:3] in ("AP_", "BP_"):
            h.pop(card, None)
    return h


def _masked_bilinear_reproject(sci, var, valid, wcs_in, wcs_out, shape_out):
    """Bilinearly resample valid samples and propagate their variances.

    A normalized convolution prevents flagged/invalid native pixels from
    leaking into neighboring output pixels.  If ``a_j`` are the four
    bilinear coefficients that survive the validity mask, the output
    variance is ``sum(a_j**2 * V_j) / sum(a_j)**2``.
    """
    yy, xx = np.indices(shape_out, dtype=np.float64)
    lon, lat = wcs_out.pixel_to_world_values(xx, yy)
    xin, yin = wcs_in.world_to_pixel_values(lon, lat)
    finite_xy = np.isfinite(xin) & np.isfinite(yin)
    xin_safe = np.where(finite_xy, xin, 0.0)
    yin_safe = np.where(finite_xy, yin, 0.0)
    x0 = np.floor(xin_safe).astype(np.int64)
    y0 = np.floor(yin_safe).astype(np.int64)
    dx = xin_safe - x0
    dy = yin_safe - y0

    norm = np.zeros(shape_out, dtype=np.float64)
    sci_num = np.zeros(shape_out, dtype=np.float64)
    var_num = np.zeros(shape_out, dtype=np.float64)
    h, w = sci.shape
    for ox, oy, coeff in (
        (0, 0, (1 - dx) * (1 - dy)),
        (1, 0, dx * (1 - dy)),
        (0, 1, (1 - dx) * dy),
        (1, 1, dx * dy),
    ):
        xi = x0 + ox
        yi = y0 + oy
        inside = finite_xy & (xi >= 0) & (xi < w) & (yi >= 0) & (yi < h)
        xi_safe = np.clip(xi, 0, w - 1)
        yi_safe = np.clip(yi, 0, h - 1)
        use = inside & valid[yi_safe, xi_safe]
        a = np.where(use, coeff, 0.0)
        norm += a
        sci_num += a * np.where(use, sci[yi_safe, xi_safe], 0.0)
        var_num += a * a * np.where(use, var[yi_safe, xi_safe], 0.0)

    covered = norm > 1e-12
    sci_out = np.full(shape_out, np.nan, dtype=np.float64)
    var_out = np.full(shape_out, np.nan, dtype=np.float64)
    sci_out[covered] = sci_num[covered] / norm[covered]
    var_out[covered] = var_num[covered] / np.square(norm[covered])
    return sci_out, var_out, covered


def load_aligned_exposure(
    fits_path: str,
    ra: float,
    dec: float,
    out_size_arcsec: float,
    background: str = "zodi",
    pixscale_arcsec: float = COADD_PIXSCALE_ARCSEC,
    resampling: str = "nearest",
) -> AlignedExposure:
    """Read one SPHEREx QR cutout and resample it onto the shared grid.

    Raises ValueError if the cutout lacks the required extensions or has no
    valid pixel on the output grid.
    """
    n, wcs_out = output_grid(ra, dec, out_size_arcsec, pixscale_arcsec)
    shape_out = (n, n)

    with fits.open(fits_path) as hdul:
        try:
            img_hdu = hdul["IMAGE"]
            var = np.asarray(hdul["VARIANCE"].data, dtype=np.float64)
            flags = np.asarray(hdul["FLAGS"].data)
            flags_header = hdul["FLAGS"].header
        except KeyError as exc:
            raise ValueError(f"cutout lacks QR extensions ({exc})") from exc

        header = img_hdu.header
        sci = np.asarray(img_hdu.data, dtype=np.float64)

        if background == "zodi":
            try:
                sci = sci - np.asarray(hdul["ZODI"].data, dtype=np.float64)
            except KeyError as exc:
                raise ValueError("cutout lacks ZODI extension") from exc

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            wcs_sky = WCS(header)

            # LVF wavelength at the target's native detector position, from
            # the official WCS-WAVE lookup table (-TAB, alternate key 'W').
            wavelength = bandwidth = None
            try:
                wcs_wave = WCS(_strip_sip(header), hdul, key="W")
                x_t, y_t = wcs_sky.world_to_pixel_values(ra, dec)
                lam, bw = wcs_wave.pixel_to_world_values(x_t, y_t)
                if np.isfinite(lam):
                    wavelength = float(lam)
                    bandwidth = float(bw) if np.isfinite(bw) else None
            except Exception:
                log.debug("WCS-WAVE lookup failed for %s", fits_path, exc_info=True)

            # Fatal-flag pixels are invalidated in the NATIVE frame.
            fatal = _fatal_mask_value(flags_header)
            native_valid = (
                np.isfinite(sci)
                & np.isfinite(var)
                & (var > 0)
                & ((flags & fatal) == 0)
            )

            if resampling == "bilinear":
                sci_out, var_out, valid_out = _masked_bilinear_reproject(
                    sci, var, native_valid, wcs_sky, wcs_out, shape_out
                )
                foot = valid_out
            else:
                kwargs = dict(shape_out=shape_out, order="nearest-neighbor")
                sci_out, foot = reproject_interp((sci, wcs_sky), wcs_out, **kwargs)
                var_out, _ = reproject_interp((var, wcs_sky), wcs_out, **kwargs)
                valid_out, _ = reproject_interp(
                    (native_valid.astype(np.float64), wcs_sky),
                    wcs_out,
                    **kwargs,
                )

    valid = (
        (foot > 0)
        & np.isfinite(sci_out)
        & np.isfinite(var_out)
        & (var_out > 0)
        & (np.nan_to_num(valid_out) > 0.5)
    )
    if not valid.any():
        raise ValueError("no valid pixels on the output grid")

    detector = header.get("DETECTOR")
    return AlignedExposure(
        sci=np.where(valid, sci_out, 0.0),
        var=np.where(valid, var_out, np.inf),
        valid=valid,
        mjd=header.get("MJD-OBS"),
        wavelength_um=wavelength,
        bandwidth_um=bandwidth,
        detector=int(detector) if detector is not None else None,
    )


def combine(
    exposures: List[AlignedExposure],
    sigma: Optional[float] = 5.0,
    maxiters: int = 2,
    min_clip_n: int = 5,
):
    """Sky-noise weighted stack with optional robust clipping.

    Each exposure gets one SCALAR weight, the inverse of its median valid
    per-pixel variance (~ sky + zodi photon noise).  Weights are therefore
    independent of the source signal, which keeps photometry unbiased --
    per-pixel 1/V weighting would systematically down-weight the exposures
    in which a source is brightest (their variance includes its photon
    noise) and depress its coadd flux.

    Returns (coadd, coadd_var, coverage, n_rejected_px, lambda_stats).
    ``coadd`` contains NaN where no exposure has valid data.
    """
    x = np.stack([e.sci for e in exposures])       # (N, H, W)
    v = np.stack([e.var for e in exposures])
    keep = np.stack([e.valid for e in exposures])

    n_rejected = 0
    if sigma is not None and len(exposures) >= min_clip_n:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            clipped = sigma_clip(
                np.ma.array(x, mask=~keep),
                axis=0, cenfunc="median", stdfunc=mad_std,
                sigma=sigma, maxiters=maxiters,
            )
        newly = np.ma.getmaskarray(clipped) & keep
        n_rejected = int(newly.sum())
        keep = keep & ~np.ma.getmaskarray(clipped)

    # One signal-independent weight per exposure: inverse median sky variance.
    w_exp = np.empty(len(exposures))
    for i in range(len(exposures)):
        vv = v[i][keep[i]]
        vv = vv[np.isfinite(vv) & (vv > 0)]
        w_exp[i] = 1.0 / float(np.median(vv)) if vv.size else 0.0

    w = np.where(keep, w_exp[:, None, None], 0.0)
    wsum = w.sum(axis=0)
    shape = x.shape[1:]
    coadd = np.divide((w * x).sum(axis=0), wsum,
                      out=np.full(shape, np.nan), where=wsum > 0)
    # Exact propagation of the per-pixel variances through the scalar weights.
    v_num = (w ** 2 * np.where(keep, v, 0.0)).sum(axis=0)
    coadd_var = np.divide(v_num, wsum ** 2,
                          out=np.full(shape, np.nan), where=wsum > 0)
    coverage = keep.sum(axis=0).astype(np.uint16)

    # Wavelength statistics weighted by each exposure's ivar in the central
    # 3x3 aperture (= how much it contributes AT the target).
    c = shape[0] // 2
    lo, hi = max(0, c - 1), min(shape[0], c + 2)
    lams, lam_w = [], []
    for i, e in enumerate(exposures):
        if e.wavelength_um is None:
            continue
        wt = float(w[i, lo:hi, lo:hi].sum())
        if wt > 0:
            lams.append(e.wavelength_um)
            lam_w.append(wt)
    lambda_stats = None
    if lams:
        lams_arr = np.asarray(lams)
        lambda_stats = {
            "min_um": round(float(lams_arr.min()), 4),
            "max_um": round(float(lams_arr.max()), 4),
            "weighted_mean_um": round(float(np.average(lams_arr, weights=lam_w)), 4),
            "n_sampled": len(lams),
        }
    return coadd, coadd_var, coverage, n_rejected, lambda_stats
