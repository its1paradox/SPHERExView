"""Six-detector, time-resolved surface-brightness coadds.

This is an independent science path; the historical blink recipes are unchanged.
The estimator retains signed intensities, formal variance, coverage and
wavelength/time sampling. Native PSFs and input covariance are not matched.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.metadata
import json
import math
import re
import threading
import warnings
from dataclasses import dataclass
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from typing import Callable, Literal

import astropy.units as u
import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import coadd as cx
from . import imaging
from . import spherex_client as sx

ALGORITHM = "six-detector-1.0"
CALIBRATION_VERSION = "cal-wcs-v4-2025-254"
IRSA_ROOT = "https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2"
CAL_LOCK = threading.Lock()
MAX_OUTPUT_CELLS = 400_000
MAP_UNITS = {
    "intensity": "MJy sr-1", "variance": "MJy2 sr-2", "coverage": "count",
    "hits": "count", "weight": "", "neff": "", "wavelength": "um",
    "lambda_min": "um", "lambda_max": "um", "bandwidth": "um",
    "mjd": "d", "mjd_min": "d", "mjd_max": "d",
}
LIMITATIONS = [
    "Detector coadds average different LVF wavelength samples; they are not six fixed filters.",
    "Native, wavelength-dependent PSFs are retained. Peak brightness is not a total source flux.",
    "Variance propagates input statistical variance only; calibration, foreground-model and input-pixel covariance errors are not included.",
    "Changing wavelength or time sampling can mimic source variability; inspect the sampling maps and input table.",
    "No additional sigma clipping is applied: real spectral features must not be clipped as temporal outliers.",
    "SIA2 inventory can lag newly ingested archive data. All-input depth refers to this query's returned inventory.",
]


class Recipe(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    ra: float = Field(ge=0, lt=360)
    dec: float = Field(ge=-90, le=90)
    size_arcsec: float = Field(default=240, ge=24, le=1800)
    survey: Literal["wide", "deep"] = "wide"
    bin_months: float = Field(default=6, ge=0.1, le=12)
    grouping: Literal["visit", "fixed"] = "visit"
    epoch_origin_mjd: float = Field(default=60000, ge=0, le=100000)
    mjd_start: float | None = Field(default=None, ge=0, le=100000)
    mjd_end: float | None = Field(default=None, ge=0, le=100000)
    max_per_tile: int = Field(default=0, ge=0, le=10000)
    pixscale_arcsec: float = Field(default=6.2, ge=3.1, le=24.8)
    resampling: Literal["bin", "nearest"] = "bin"
    background: Literal["zodi", "none"] = "zodi"
    weighting: Literal["equal", "sky"] = "equal"
    min_exposures: int = Field(default=1, ge=1, le=10000)
    # Half-open selection of calibrated INPUT pixel central wavelengths.
    wavelength_ranges: dict[int, tuple[float, float]] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_ranges(self):
        if self.mjd_start is not None and self.mjd_end is not None and self.mjd_end <= self.mjd_start:
            raise ValueError("MJD end must be greater than MJD start")
        for detector, bounds in self.wavelength_ranges.items():
            lo, hi = bounds
            if detector not in range(1, 7) or not (0 < lo < hi <= 10):
                raise ValueError("Wavelength ranges require D1-D6 and 0 < lower < upper <= 10 microns")
        if round(self.size_arcsec / self.pixscale_arcsec) > 512:
            raise ValueError("Output exceeds 512 pixels per side; reduce field size or use coarser sampling")
        return self


class InputError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Cancelled(Exception):
    pass


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def detector_of(image):
    match = re.fullmatch(r"SPHEREx-D([1-6])", str(image.band), re.IGNORECASE)
    if not match:
        raise InputError("detector_unknown", "Unrecognized archive detector label")
    return int(match.group(1))


def inventory(images, recipe):
    """Deduplicate physical exposures before epoch assignment or preview sampling."""
    chosen, excluded = {}, []
    for image in images:
        try:
            detector = detector_of(image)
            if not image.obs_id:
                raise InputError("identity_missing", "Archive observation ID is absent")
            t = image.mjd_mid
            if t is None or not math.isfinite(t):
                raise InputError("time_missing", "Archive time is absent")
            if recipe.mjd_start is not None and t < recipe.mjd_start:
                continue
            if recipe.mjd_end is not None and t >= recipe.mjd_end:
                continue
            if not image.access_url.startswith(IRSA_ROOT + "/level2/"):
                raise InputError("release_mismatch", "Only on-premises QR2 Level 2 products are supported")
            version = re.search(r"l2b-v(\d+)-(\d{4})-(\d{3})", image.access_url)
            if not version:
                raise InputError("version_unknown", "Cannot identify the archive processing version")
            rank = tuple(map(int, version.groups()))
            key = (image.obs_id, detector)
            if key in chosen:
                old, old_rank = chosen[key]
                if rank == old_rank and image.access_url != old.access_url:
                    raise InputError("identity_conflict", "Conflicting products have the same processing version")
                loser = old if rank > old_rank else image
                excluded.append({"obs_id": loser.obs_id, "detector": detector, "url": loser.access_url, "status": "duplicate_or_older_processing"})
                if rank <= old_rank:
                    continue
            chosen[key] = (image, rank)
        except InputError as exc:
            if exc.code == "identity_conflict":
                raise
            excluded.append({"obs_id": image.obs_id, "url": image.access_url, "status": exc.code, "reason": str(exc)})
    return sorted((v[0] for v in chosen.values()), key=lambda im: (im.mjd_mid, detector_of(im), im.obs_id)), excluded


def group_epochs(images, recipe):
    """Common time membership is determined from inventory, before failed downloads."""
    if not images:
        return []
    days = recipe.bin_months * 30.4375
    groups = []
    if recipe.grouping == "fixed":
        bins = {}
        for image in images:
            i = math.floor((image.mjd_mid - recipe.epoch_origin_mjd) / days)
            bins.setdefault(i, []).append(image)
        for i, rows in sorted(bins.items()):
            groups.append((rows, "fixed", recipe.epoch_origin_mjd + i * days, recipe.epoch_origin_mjd + (i + 1) * days))
    else:
        gap = min(30, days / 4)
        components = [[images[0]]]
        for previous, image in zip(images, images[1:]):
            if image.mjd_mid - previous.mjd_mid > gap:
                components.append([])
            components[-1].append(image)
        for rows in components:
            span = rows[-1].mjd_mid - rows[0].mjd_mid
            windows = max(1, math.ceil(span / days))
            if windows == 1:
                groups.append((rows, "visit", min(i.t_min if i.t_min is not None else i.mjd_mid for i in rows), max(i.t_max if i.t_max is not None else i.mjd_mid for i in rows)))
            else:
                edges = np.linspace(rows[0].mjd_mid, np.nextafter(rows[-1].mjd_mid, np.inf), windows + 1)
                bins = [[] for _ in range(windows)]
                for image in rows:
                    i = min(windows - 1, max(0, np.searchsorted(edges, image.mjd_mid, side="right") - 1))
                    bins[i].append(image)
                groups.extend((b, "window", float(edges[i]), float(edges[i + 1])) for i, b in enumerate(bins) if b)
    return groups


@lru_cache(maxsize=6)
def calibration_file(detector):
    # Freeze a named QR2 calibration, never a moving "latest" URL. The
    # exposure's spectral WCS is checked against it before it can contribute.
    url = f"{IRSA_ROOT}/spectral_wcs/{CALIBRATION_VERSION}/{detector}/spectral_wcs_D{detector}_spx_{CALIBRATION_VERSION}.fits"
    with CAL_LOCK:
        path = sx.download_cutout(url)
    with fits.open(path) as hdul:
        for name in ("CWAVE", "CBAND"):
            if hdul[name].data.shape != (2040, 2040):
                raise InputError("calibration_invalid", f"{name} is not a full-resolution calibration")
    return path, url, sha256_file(path)


def calibration_pixels(header, shape, calibration):
    """Recover zero-based active-detector indices, without celestial SIP."""
    yy, xx = np.indices(shape)
    required = ("CRPIX1A", "CRPIX2A", "CRVAL1A", "CRVAL2A", "CDELT1A", "CDELT2A")
    if any(key not in header for key in required):
        raise InputError("detector_coordinates_missing", "Cutout has no complete active-pixel WCS A")
    clean = cx._strip_sip(header)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        active = WCS(clean, key="A")
        active.sip = None
        x, y = active.pixel_to_world_values(xx, yy)
    if not (np.isfinite(x).all() and np.isfinite(y).all() and np.allclose(x, np.round(x), atol=1e-6) and np.allclose(y, np.round(y), atol=1e-6)):
        raise InputError("detector_coordinates_invalid", "Cutout is not an integer subset of original detector pixels")
    x, y = np.round(x).astype(int), np.round(y).astype(int)
    h, w = calibration["CWAVE"].data.shape
    if np.any((x < 0) | (x >= w) | (y < 0) | (y >= h)):
        raise InputError("detector_coordinates_invalid", "Cutout maps outside spectral calibration")
    return x, y


@dataclass
class Samples:
    index: np.ndarray
    intensity: np.ndarray
    variance: np.ndarray
    wavelength: np.ndarray
    bandwidth: np.ndarray
    weight: float
    mjd: float
    metadata: dict


def load_samples(path, image, recipe, wcs_out, n, calibration_loader=calibration_file):
    detector = detector_of(image)
    try:
        cal_path, cal_url, cal_hash = calibration_loader(detector)
    except Exception as exc:
        raise InputError("calibration_unavailable", str(exc)) from exc
    with fits.open(path) as hdul, fits.open(cal_path) as calibration:
        try:
            header = hdul["IMAGE"].header
            sci = np.asarray(hdul["IMAGE"].data, dtype=np.float64)
            variance = np.asarray(hdul["VARIANCE"].data, dtype=np.float64)
            flags = np.asarray(hdul["FLAGS"].data)
        except KeyError as exc:
            raise InputError("extensions_missing", str(exc)) from exc
        if int(header.get("DETECTOR", 0)) != detector or str(header.get("OBSID", "")).strip() != image.obs_id.strip():
            raise InputError("identity_mismatch", "FITS detector/observation does not match archive identity")
        if sci.ndim != 2 or sci.shape != variance.shape or sci.shape != flags.shape or flags.dtype.kind not in "iu":
            raise InputError("shape_invalid", "IMAGE, VARIANCE and integer FLAGS must have identical 2-D shapes")
        try:
            sci *= u.Unit(header["BUNIT"]).to(u.MJy / u.sr)
            variance *= u.Unit(hdul["VARIANCE"].header["BUNIT"]).to((u.MJy / u.sr) ** 2)
        except (KeyError, ValueError) as exc:
            raise InputError("units_invalid", "Calibrated IMAGE/VARIANCE units are required") from exc
        version = str(hdul[0].header.get("VERSION", ""))
        numbers = re.match(r"(\d+)\.(\d+)(?:\.(\d+))?", version)
        if not numbers or tuple(int(x or 0) for x in numbers.groups()) < (6, 4, 0):
            raise InputError("pipeline_unsupported", "Expected a QR2 pipeline version >= 6.4")
        if header.get("FINAST") != 0:
            raise InputError("astrometry_flagged", "Fine astrometric solution is absent or flagged")
        if recipe.background == "zodi":
            try:
                zodi = np.asarray(hdul["ZODI"].data, dtype=np.float64)
                if zodi.shape != sci.shape:
                    raise ValueError("ZODI shape mismatch")
                sci -= zodi * u.Unit(hdul["ZODI"].header["BUNIT"]).to(u.MJy / u.sr)
            except (KeyError, ValueError) as exc:
                raise InputError("zodi_invalid", str(exc)) from exc
        flag_header = hdul["FLAGS"].header
        bit_map = {}
        for name in (*cx.FATAL_FLAG_NAMES, "MP_SOURCE"):
            bit = flag_header.get(name)
            if not isinstance(bit, int) or bit < 0 or bit > 31:
                raise InputError("flags_unsupported", f"Missing or invalid flag definition: {name}")
            bit_map[name] = bit
        if len(set(bit_map.values())) != len(bit_map):
            raise InputError("flags_unsupported", "Flag definitions overlap")
        fatal = sum(1 << bit_map[name] for name in cx.FATAL_FLAG_NAMES)
        valid = np.isfinite(sci) & np.isfinite(variance) & (variance > 0) & ((flags & fatal) == 0)
        # Scalar sky weights use SOURCE only for the weight estimate, never
        # for removing sources from the science image. No guessed fallback.
        weight = 1.0
        if recipe.weighting == "sky":
            sky = valid & ((flags & (1 << bit_map["MP_SOURCE"])) == 0)
            if sky.sum() < 30:
                raise InputError("sky_weight_unavailable", "Fewer than 30 valid source-free sky pixels; choose equal weights or a larger field")
            weight = 1 / float(np.median(variance[sky]))
        xcal, ycal = calibration_pixels(header, sci.shape, calibration)
        wavelength = np.asarray(calibration["CWAVE"].data[ycal, xcal], dtype=float)
        bandwidth = np.asarray(calibration["CBAND"].data[ycal, xcal], dtype=float)
        # Both maps are in microns by the QR2 product specification. If a
        # unit is supplied, require it to be compatible rather than ignore it.
        for name, values in (("CWAVE", wavelength), ("CBAND", bandwidth)):
            unit = calibration[name].header.get("BUNIT", "um")
            values *= u.Unit(unit).to(u.um)
        # WCS-WAVE is used ONLY to identify/calibrate the correct orientation
        # and release, never as the science wavelength or selection map.
        yy, xx = np.indices(sci.shape)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            sky_wcs = WCS(header)
            wave_wcs = WCS(cx._strip_sip(header), hdul, key="W")
            wave_wcs.sip = None
            approximate, approximate_bw = wave_wcs.pixel_to_world_values(xx, yy)
            cal_wcs = WCS(calibration["CWAVE"].header, calibration)
            cal_approximate, cal_approximate_bw = cal_wcs.pixel_to_world_values(xcal, ycal)
        same_detector = int(calibration["CWAVE"].header.get("DETECTOR", 0)) == detector
        same_orientation = header.get("DETCOORD") == calibration["CWAVE"].header.get("DETCOORD") == "sky"
        if not same_detector or not same_orientation or not (np.allclose(approximate, cal_approximate, atol=1e-6, rtol=0) and np.allclose(approximate_bw, cal_approximate_bw, atol=1e-6, rtol=0)):
            raise InputError("calibration_mismatch", "CWAVE disagrees with this exposure's spectral calibration/orientation; no approximate fallback used")
        valid &= np.isfinite(wavelength) & (wavelength > 0) & np.isfinite(bandwidth) & (bandwidth > 0)
        bounds = recipe.wavelength_ranges.get(detector)
        if bounds:
            valid &= (wavelength >= bounds[0]) & (wavelength < bounds[1])
        time_scale = str(header.get("TIMESYS", "")).lower()
        if time_scale not in Time.SCALES or "MJD-AVG" not in header:
            raise InputError("time_missing", "Explicit TIMESYS and MJD-AVG are required")
        mjd = float(Time(header["MJD-AVG"], format="mjd", scale=time_scale).utc.mjd)
        if not math.isfinite(mjd) or abs(mjd - image.mjd_mid) > 1 / 86400:
            raise InputError("time_mismatch", "FITS and archive midpoint differ by more than one second")
        if recipe.resampling == "bin":
            ra, dec = sky_wcs.pixel_to_world_values(xx, yy)
            xo, yo = wcs_out.world_to_pixel_values(ra, dec)
            finite = np.isfinite(xo) & np.isfinite(yo)
            xi = np.floor(np.where(finite, xo, -100) + 0.5).astype(int)
            yi = np.floor(np.where(finite, yo, -100) + 0.5).astype(int)
            use = valid & finite & (xi >= 0) & (xi < n) & (yi >= 0) & (yi < n)
            index = (yi[use] * n + xi[use]).ravel()
            selected = tuple(values[use] for values in (sci, variance, wavelength, bandwidth))
        else:
            yo, xo = np.indices((n, n))
            ra, dec = wcs_out.pixel_to_world_values(xo, yo)
            xn, yn = sky_wcs.world_to_pixel_values(ra, dec)
            finite = np.isfinite(xn) & np.isfinite(yn)
            xi = np.floor(np.where(finite, xn, -100) + 0.5).astype(int)
            yi = np.floor(np.where(finite, yn, -100) + 0.5).astype(int)
            inside = finite & (xi >= 0) & (xi < sci.shape[1]) & (yi >= 0) & (yi < sci.shape[0])
            ys, xs = np.clip(yi, 0, sci.shape[0] - 1), np.clip(xi, 0, sci.shape[1] - 1)
            use = inside & valid[ys, xs]
            index = (yo[use] * n + xo[use]).ravel()
            selected = tuple(values[ys[use], xs[use]] for values in (sci, variance, wavelength, bandwidth))
        if not index.size:
            raise InputError("no_valid_samples", "No valid pixels in this field and wavelength selection")
        history = [str(c.value) for c in header.cards if c.keyword == "HISTORY" and "[CALIB]" in str(c.value)]
        metadata = {
            "pipeline_version": version, "calibration_url": cal_url,
            "calibration_sha256": cal_hash, "calibration_history": history,
            "cutout_sha256": sha256_file(path), "mask_bits": bit_map,
            "weight_per_sample": weight, "accepted_samples": int(index.size),
            "mjd_utc": mjd, "native_psf_fwhm_arcsec": header.get("PSF_FWHM"),
            "exposure_time_s": header.get("XPOSURE"),
            "native_time_scale": str(header.get("TIMESYS")),
            "native_mjd_start": header.get("MJD-BEG"),
            "native_mjd_end": header.get("MJD-END"),
            "psf_header_status": "corrected_or_unaffected" if "+psffix1" in version or tuple(int(x or 0) for x in numbers.groups()) >= (6, 5, 6) else "affected_or_unverified",
            "field_sample_median_wavelength_um": float(np.median(selected[2])),
            "sample_wavelength_min_um": float(np.min(selected[2])),
            "sample_wavelength_max_um": float(np.max(selected[2])),
        }
        return Samples(index, *selected, weight, mjd, metadata)


class Accumulator:
    """Streaming linear estimator; distinct exposures and pixel hits are separate."""
    def __init__(self, n):
        self.n = n
        self.maps = {k: np.zeros(n * n, dtype=np.float64) for k in ("sum", "varsum", "weight", "w2", "lambda", "bandwidth", "time", "hits", "coverage")}
        for k in ("lambda_min", "mjd_min"):
            self.maps[k] = np.full(n * n, np.inf)
        for k in ("lambda_max", "mjd_max"):
            self.maps[k] = np.full(n * n, -np.inf)

    def add(self, samples):
        m, s, size = self.maps, samples, self.n ** 2
        hits = np.bincount(s.index, minlength=size)
        m["hits"] += hits
        m["coverage"] += hits > 0
        for key, values in (("sum", s.intensity * s.weight), ("varsum", s.variance * s.weight ** 2), ("lambda", s.wavelength * s.weight), ("bandwidth", s.bandwidth * s.weight)):
            m[key] += np.bincount(s.index, weights=values, minlength=size)
        m["weight"] += hits * s.weight
        m["w2"] += hits * s.weight ** 2
        m["time"] += hits * s.weight * s.mjd
        np.minimum.at(m["lambda_min"], s.index, s.wavelength)
        np.maximum.at(m["lambda_max"], s.index, s.wavelength)
        m["mjd_min"][hits > 0] = np.minimum(m["mjd_min"][hits > 0], s.mjd)
        m["mjd_max"][hits > 0] = np.maximum(m["mjd_max"][hits > 0], s.mjd)

    def finish(self, min_exposures):
        m = self.maps
        supported = (m["weight"] > 0) & (m["coverage"] >= min_exposures)
        def mean(key, denominator):
            return np.divide(m[key], denominator, out=np.full(self.n ** 2, np.nan), where=supported)
        out = {
            "intensity": mean("sum", m["weight"]),
            "variance": mean("varsum", m["weight"] ** 2),
            "wavelength": mean("lambda", m["weight"]),
            "bandwidth": mean("bandwidth", m["weight"]),
            "mjd": mean("time", m["weight"]),
            "neff": np.divide(m["weight"] ** 2, m["w2"], out=np.zeros(self.n ** 2), where=m["w2"] > 0),
        }
        for key in ("lambda_min", "lambda_max", "mjd_min", "mjd_max"):
            out[key] = np.where(supported, m[key], np.nan)
        for key in ("coverage", "hits", "weight"):
            out[key] = m[key]
        return {key: value.reshape(self.n, self.n).astype("<f8" if key.startswith("mjd") else "<u4" if key in ("coverage", "hits") else "<f4") for key, value in out.items()}


def encode_maps(maps):
    return {key: {"dtype": value.dtype.str, "data_b64": base64.b64encode(np.flipud(value).tobytes()).decode("ascii")} for key, value in maps.items()}


def save_epoch(path, epoch, products, wcs, recipe, provenance):
    primary = fits.PrimaryHDU()
    primary.header["ORIGIN"] = "SPHERExView"
    primary.header["ALGO"] = ALGORITHM
    primary.header["EPOCH"] = epoch["index"]
    primary.header["TIMESYS"] = "UTC"
    primary.header["MJD-BEG"] = epoch["mjd_start"]
    primary.header["MJD-END"] = epoch["mjd_end"]
    primary.header["DATATYPE"] = "MIXED-LAMBDA"
    primary.header["PSFMATCH"] = False
    hdus = [primary]
    for detector, maps in products.items():
        for key, values in maps.items():
            header = wcs.to_header()
            header["BUNIT"] = MAP_UNITS[key]
            if key == "weight" and recipe.weighting == "sky":
                header["BUNIT"] = "sr2 MJy-2"
            header["DETECTOR"] = detector
            header["TIMESYS"] = "UTC"
            header["RESAMPLE"] = recipe.resampling
            header["BKG"] = recipe.background
            header["WEIGHT"] = recipe.weighting
            hdus.append(fits.ImageHDU(values, header=header, name=f"D{detector}_{key.upper()}"))
    payload = json.dumps({"recipe": recipe.model_dump(mode="json"), "epoch": epoch, "inputs": provenance, "limitations": LIMITATIONS}, allow_nan=False, separators=(",", ":")).encode()
    hdus.append(fits.ImageHDU(np.frombuffer(payload, dtype=np.uint8), name="MANIFEST"))
    hdus[-1].header["ENCODING"] = "UTF-8 JSON"
    fits.HDUList(hdus).writeto(path, overwrite=True, checksum=True)


def prefetch_downloads(images, recipe, downloader, cancelled):
    """At most four in-flight downloads; consume in deterministic input order."""
    pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="comparison-fits")
    queue, remaining = deque(), iter(images)
    def fill():
        if cancelled.is_set():
            raise Cancelled()
        while len(queue) < 4:
            im = next(remaining, None)
            if im is None:
                break
            url = sx.get_cutout_url(im.access_url, recipe.ra, recipe.dec, recipe.size_arcsec * 1.45)
            queue.append((im, url, pool.submit(downloader, url)))
    try:
        fill()
        while queue:
            if cancelled.is_set():
                raise Cancelled()
            yield queue.popleft()
            fill()
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def build(recipe: Recipe, output_dir: Path, progress: Callable, cancelled: threading.Event,
          query=sx.query_sia2, downloader=sx.download_cutout, loader=load_samples):
    """Query once, retain provenance, stream each input once, publish six slots atomically."""
    progress("Querying the QR2 archive", 0, 0)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        images = query(recipe.ra, recipe.dec, radius_deg=recipe.size_arcsec / 7200, collection=sx.COLLECTIONS[recipe.survey])
    if any("overflow" in str(w.message).lower() for w in caught):
        raise ValueError("Archive inventory was truncated; reduce the field or time range")
    rows, excluded = inventory(images, recipe)
    groups = group_epochs(rows, recipe)
    if not groups:
        raise ValueError("No supported QR2 observations in this field/time range")
    n, wcs = cx.output_grid(recipe.ra, recipe.dec, recipe.size_arcsec, recipe.pixscale_arcsec)
    if 6 * len(groups) * n * n > MAX_OUTPUT_CELLS:
        raise ValueError("Comparison is too large; shorten the time range, reduce the field, or use coarser pixels")
    output_dir.mkdir(parents=True, exist_ok=True)
    epochs, provenance, finished, selected_total = [], [], 0, 0
    selected = []
    for group, _, _, _ in groups:
        per_detector = []
        for detector in range(1, 7):
            sub = [im for im in group if detector_of(im) == detector]
            if recipe.max_per_tile and len(sub) > recipe.max_per_tile:
                indices = set(np.linspace(0, len(sub) - 1, recipe.max_per_tile).round().astype(int))
                excluded.extend({"obs_id": im.obs_id, "detector": detector, "url": im.access_url, "status": "preview_excluded"} for i, im in enumerate(sub) if i not in indices)
                sub = [im for i, im in enumerate(sub) if i in indices]
            per_detector.append(sub)
            selected_total += len(sub)
        selected.append(per_detector)
    for k, (rows_in_epoch, grouping, start, end) in enumerate(groups):
        epoch = {"index": k, "grouping": grouping, "mjd_start": float(start), "mjd_end": float(end), "datetime_start": Time(start, format="mjd").isot, "datetime_end": Time(end, format="mjd").isot, "tiles": []}
        products, epoch_inputs = {}, []
        for detector, sub in enumerate(selected[k], start=1):
            accumulator, accepted, failures = Accumulator(n), [], []
            for im, url, download in prefetch_downloads(sub, recipe, downloader, cancelled):
                if cancelled.is_set():
                    raise Cancelled()
                record = {"epoch": k, "detector": detector, "obs_id": im.obs_id, "did": str(im.extra.get("obs_publisher_did", "")), "url": im.access_url, "cutout_url": url, "archive_mjd_mid": float(im.mjd_mid), "archive_mjd_start": im.t_min, "archive_mjd_end": im.t_max}
                try:
                    path = download.result()
                    samples = loader(path, im, recipe, wcs, n)
                    accumulator.add(samples)
                    accepted.append(samples.mjd)
                    record.update(samples.metadata, status="accepted")
                except Cancelled:
                    raise
                except Exception as exc:
                    status = getattr(exc, "code", "no_overlap" if isinstance(exc, sx.CutoutNoOverlapError) else "input_error")
                    record.update(status=status, reason=str(exc))
                    failures.append(status)
                provenance.append(record)
                epoch_inputs.append(record)
                finished += 1
                progress(f"Epoch {k + 1}/{len(groups)} · D{detector} · {finished}/{selected_total} exposures", finished, selected_total)
            maps = accumulator.finish(recipe.min_exposures)
            has_data = bool(np.isfinite(maps["intensity"]).any())
            tile = {"detector": detector, "status": "ok" if has_data else "missing" if not sub else "unavailable", "n_inventory": sum(detector_of(im) == detector for im in rows_in_epoch), "n_selected": len(sub), "n_accepted": len(accepted), "failures": {code: failures.count(code) for code in set(failures)}, "mjd_start": min(accepted) if accepted else None, "mjd_end": max(accepted) if accepted else None}
            if sub:
                products[detector] = maps
                tile["maps"] = encode_maps(maps)
            epoch["tiles"].append(tile)
        epoch["complete_six"] = all(t["status"] == "ok" for t in epoch["tiles"])
        # FITS contains native FITS row ordering and the same numeric values
        # as the encoded arrays, before the display-only vertical flip.
        metadata_epoch = {**epoch, "tiles": [{key: value for key, value in tile.items() if key != "maps"} for tile in epoch["tiles"]]}
        save_epoch(output_dir / f"epoch-{k}.fits", metadata_epoch, products, wcs, recipe, epoch_inputs)
        epochs.append(epoch)
    if cancelled.is_set():
        raise Cancelled()
    deps = {name: importlib.metadata.version(name) for name in ("numpy", "astropy", "astroquery")}
    source_hashes = {name: sha256_file(Path(__file__).with_name(name)) for name in ("detector_comparison.py", "coadd.py", "imaging.py", "spherex_client.py")}
    manifest = {"algorithm": ALGORITHM, "created_utc": Time.now().isot, "recipe": recipe.model_dump(mode="json"), "dependencies": deps, "wcs": imaging.wcs_to_dict(wcs, n), "width": n, "height": n, "units": MAP_UNITS, "array_orientation": "API row 0 is north/top; FITS is unflipped", "variance_scope": LIMITATIONS[2], "limitations": LIMITATIONS + (["Nearest-neighbor outputs can reuse native pixels; output pixels are correlated."] if recipe.resampling == "nearest" else []), "n_archive_rows": len(images), "n_unique_inventory": len(rows), "n_selected": selected_total, "preview_subset": any(r["status"] == "preview_excluded" for r in excluded), "excluded": excluded, "inputs": provenance, "epochs": [{**e, "tiles": [{key: value for key, value in tile.items() if key != "maps"} for tile in e["tiles"]]} for e in epochs]}
    manifest["source_sha256"] = source_hashes
    manifest["time_assignment"] = "Archive exposure midpoint, MJD UTC; fixed bins and requested time bounds are half-open"
    manifest["weight_units"] = "dimensionless" if recipe.weighting == "equal" else "sr2 MJy-2"
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, allow_nan=False))
    return {**manifest, "epochs": epochs}
