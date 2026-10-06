"""Precompute exposure-level, background-subtracted aperture F_nu on a sky grid.

Operate on native pixels, before coadd resampling. Elliptical pixel apertures
are the local affine image of a fixed sky circle; Photutils supplies exact
pixel overlap. The small-aperture affine approximation is recorded explicitly.
"""
from functools import lru_cache
import hashlib
import json
import re

import astropy.units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
import numpy as np
from photutils.aperture import EllipticalAperture

from . import spherex_client as sx

AREA_VERSIONS = {"qr2": "cal-sapm-v2-2025-164", "qr3": "cal-sapm-v3-2026-191"}
MAX_SPECTRAL_CELLS = 1_000_000
UNITS = {"flux": "uJy", "variance": "uJy2", "sky_flux": "uJy", "sky_variance": "uJy2", "wavelength": "um", "bandwidth": "um",
         "lambda_min": "um", "lambda_max": "um", "aperture_coverage": "", "sky_coverage": ""}
METHOD = {
    "version": "native-aperture-1",
    "flux_estimator": "1e12 * sum(aperture_fraction * solid_angle_sr * I_nu_MJy_sr); supplied recipe background only",
    "sky_flux_estimator": "1e12 * sum((aperture_fraction * solid_angle_sr - aperture_solid_angle_sr * sky_weight) * I_nu_MJy_sr)",
    "sky_estimator": "Solid-angle-weighted mean in annulus, excluding SOURCE and fatal pixels; no sigma clipping",
    "variance_estimator": "Sum of squared combined linear coefficients times native VARIANCE; assumes independent native pixels",
    "wavelength_estimator": "Solid-angle/aperture-overlap weighted CWAVE; range and mean CBAND retained; not flux weighted",
    "aperture_geometry": "Fixed sky radius, local affine WCS ellipse, exact fractional pixel overlap",
    "position_sampling": "Nearest output grid center; no spatial or spectral interpolation on hover",
    "minimum_aperture_coverage": 0.999999,
    "minimum_sky_coverage": 0.5,
    "limitations": [
        "Aperture flux density, not PSF-corrected total source flux; wavelength-dependent PSF losses remain.",
        "One point per usable exposure; finite LVF bandpasses and wavelengths across the aperture are retained, not monochromatic bins.",
        "Epoch samples are not simultaneous. A highest measured F_nu sample is not a fitted spectral-line peak or a peak in F_lambda.",
        "Default flux retains local sky after the selected supplied background model. Optional local-annulus subtraction can remove extended emission or include uncatalogued sources. Neighbours inside the aperture are not deblended.",
        "Incomplete or flagged apertures are omitted, never area-corrected or zero-filled. Annulus must have at least 50% usable area and 10 effective pixels.",
        "Errors exclude calibration, background-model systematics, input covariance, aperture corrections and astrometric errors.",
    ],
}


@lru_cache(maxsize=24)
def solid_angle_file(detector, release, version):
    if release not in AREA_VERSIONS or not re.fullmatch(r"cal-sapm-v\d+-\d{4}-\d{3}", version):
        raise ValueError("Unsupported solid-angle calibration")
    url = f"https://irsa.ipac.caltech.edu/ibe/data/spherex/{release}/solid_angle_pixel_map/{version}/{detector}/solid_angle_pixel_map_D{detector}_spx_{version}.fits"
    path = sx.download_cutout(url)
    with fits.open(path) as hdul:
        hdu = hdul["IMAGE"]
        # QR2 names this ARRAY; QR3 adds DETECTOR. Reject disagreement if both
        # are present rather than silently preferring either identity.
        identities = [int(hdu.header[key]) for key in ("DETECTOR", "ARRAY") if key in hdu.header]
        if hdu.data.shape != (2040, 2040) or not identities or any(d != detector for d in identities) or hdu.header.get("DETCOORD") != "sky":
            raise ValueError("Solid-angle map has incompatible shape, detector or orientation")
        u.Unit(hdu.header["BUNIT"]).to(u.sr)
    with open(path, "rb") as stream:
        digest = hashlib.sha256(stream.read()).hexdigest()
    return path, url, digest


def solid_angles(header, detector, release, xcal, ycal):
    history = " ".join(str(c.value) for c in header.cards if c.keyword == "HISTORY")
    versions = set(re.findall(r"cal-sapm-v\d+-\d{4}-\d{3}", history))
    if len(versions) > 1:
        raise ValueError("Ambiguous solid-angle calibration provenance")
    version = next(iter(versions)) if versions else AREA_VERSIONS[release]
    path, url, digest = solid_angle_file(detector, release, version)
    with fits.open(path) as hdul:
        omega = np.asarray(hdul["IMAGE"].data[ycal, xcal], dtype=float) * u.Unit(hdul["IMAGE"].header["BUNIT"]).to(u.sr)
    if not np.all(np.isfinite(omega) & (omega > 0)):
        raise ValueError("Invalid solid-angle calibration values")
    return omega, {"solid_angle_url": url, "solid_angle_sha256": digest, "solid_angle_version": version}


def aperture_maps(sci, variance, wavelength, bandwidth, valid, sky_valid, omega, sky_wcs, wcs_out, n, radius):
    """Return one measurement per output grid center; no reprojection of flux.

    The annulus radii are 1.5r and 2.5r. All weights of a native pixel are
    combined BEFORE squaring for variance, including any fractional overlap
    between aperture/annulus. Masked/edge apertures are never renormalized.
    """
    maps = {key: np.full((n, n), np.nan, dtype="<f4") for key in UNITS}
    yy, xx = np.indices((n, n))
    ra, dec = wcs_out.pixel_to_world_values(xx.ravel(), yy.ravel())
    coords = SkyCoord(ra * u.deg, dec * u.deg)
    x, y = sky_wcs.world_to_pixel_values(ra, dec)
    # Pixel / arcsec Jacobian, including SIP; offsets are tangent east/north.
    columns = []
    for angle in (90, 0):
        plus = coords.directional_offset_by(angle * u.deg, .5 * u.arcsec)
        minus = coords.directional_offset_by((angle + 180) * u.deg, .5 * u.arcsec)
        xp, yp = sky_wcs.world_to_pixel_values(plus.ra.deg, plus.dec.deg)
        xm, ym = sky_wcs.world_to_pixel_values(minus.ra.deg, minus.dec.deg)
        columns.append(np.stack((xp - xm, yp - ym), axis=-1))
    jacobian = np.stack(columns, axis=-1)
    finite = np.isfinite(jacobian).all(axis=(1, 2)) & np.isfinite(x) & np.isfinite(y)
    for i in np.flatnonzero(finite):
        axes, scales, _ = np.linalg.svd(jacobian[i])
        a, b = radius * scales
        if not (0 < b <= a < 100):
            continue
        theta = np.arctan2(axes[1, 0], axes[0, 0])
        # A common native-pixel bounding box makes the covariance accounting explicit.
        half = int(np.ceil(2.5 * a + 1))
        cx, cy = int(np.floor(x[i])), int(np.floor(y[i]))
        x0, x1 = max(0, cx - half), min(sci.shape[1], cx + half + 2)
        y0, y1 = max(0, cy - half), min(sci.shape[0], cy + half + 2)
        if x1 <= x0 or y1 <= y0:
            continue
        shape = (y1 - y0, x1 - x0)
        def mask(scale):
            ap = EllipticalAperture((x[i] - x0, y[i] - y0), a * scale, b * scale, theta=theta)
            values = ap.to_mask(method="exact").to_image(shape)
            return values if values is not None else np.zeros(shape)
        aperture = mask(1)
        sky = np.maximum(0, mask(2.5) - mask(1.5))
        sl = np.s_[y0:y1, x0:x1]
        good = valid[sl]
        usable_sky = sky_valid[sl] & good
        ap_coverage = np.sum(aperture * good) / (np.pi * a * b)
        sky_coverage = np.sum(sky * usable_sky) / (np.pi * a * b * (2.5**2 - 1.5**2))
        maps["aperture_coverage"].flat[i] = min(1, ap_coverage)
        maps["sky_coverage"].flat[i] = min(1, sky_coverage)
        if ap_coverage < METHOD["minimum_aperture_coverage"]:
            continue
        aw = aperture * omega[sl] * good
        intensity = np.where(good, sci[sl], 0)
        var = np.where(good, variance[sl], 0)
        maps["flux"].flat[i] = np.sum(1e12 * aw * intensity)
        maps["variance"].flat[i] = np.sum((1e12 * aw) ** 2 * var)
        used = aw > 0
        maps["wavelength"].flat[i] = np.sum(aw[used] * wavelength[sl][used]) / aw.sum()
        maps["bandwidth"].flat[i] = np.sum(aw[used] * bandwidth[sl][used]) / aw.sum()
        maps["lambda_min"].flat[i] = np.min(wavelength[sl][used])
        maps["lambda_max"].flat[i] = np.max(wavelength[sl][used])
        if sky_coverage < METHOD["minimum_sky_coverage"]:
            continue
        sw = sky * omega[sl] * usable_sky
        if sw.sum() <= 0 or sw.sum() ** 2 / np.sum(sw ** 2) < 10:
            continue
        sw /= sw.sum()
        coefficients = 1e12 * (aw - aw.sum() * sw)
        maps["sky_flux"].flat[i] = np.sum(coefficients * intensity)
        maps["sky_variance"].flat[i] = np.sum(coefficients ** 2 * var)
    return maps


def save_spectra(path, spectra, wcs, recipe, epoch):
    primary = fits.PrimaryHDU()
    primary.header.update({"ALGO": METHOD["version"], "RELEASE": epoch["data_release"], "APRADIUS": recipe.aperture_radius_arcsec,
                           "ANNIN": 1.5 * recipe.aperture_radius_arcsec, "ANNOUT": 2.5 * recipe.aperture_radius_arcsec,
                           "PSFCORR": False, "TIMESYS": "UTC", "BKG": recipe.background})
    hdus = [primary]
    if spectra:
        for key, unit in UNITS.items():
            h = wcs.to_header(); h["BUNIT"] = unit
            h.update({"WCSAXES": 3, "CTYPE3": "EXPOSURE", "CRPIX3": 1, "CRVAL3": 1, "CDELT3": 1})
            hdus.append(fits.ImageHDU(np.stack([s["arrays"][key] for s in spectra]), h, name=key.upper()))
        hdus.append(fits.BinTableHDU.from_columns([
            fits.Column(name="DETECTOR", format="J", array=[s["detector"] for s in spectra]),
            fits.Column(name="MJD", format="D", unit="d", array=[s["mjd"] for s in spectra]),
            fits.Column(name="OBSID", format=f'{max(len(s["obs_id"]) for s in spectra)}A', array=[s["obs_id"] for s in spectra]),
        ], name="EXPOSURES"))
    hdus.append(fits.ImageHDU(np.frombuffer(json.dumps({"method": METHOD, "recipe": recipe.model_dump(mode="json"),
        "samples": [{k: v for k, v in s.items() if k != "arrays"} for s in spectra]}).encode(), dtype=np.uint8), name="PROVENANCE"))
    fits.HDUList(hdus).writeto(path, overwrite=True, checksum=True)
