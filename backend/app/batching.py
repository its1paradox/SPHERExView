"""Disk-backed timeline inputs; batching changes storage, not the estimator."""
from contextvars import ContextVar
from functools import wraps
import inspect
import os
from pathlib import Path
import shutil
import tempfile

import numpy as np
from fastapi import HTTPException

_workspace = ContextVar("timeline_workspace", default=None)


class Skipped(int):
    def __new__(cls, records):
        result = super().__new__(cls, len(records))
        result.records = records
        return result


def check_space(path, required=0):
    reserve = float(os.getenv("SPHEREX_MIN_FREE_GB", "3")) * 1024 ** 3 if os.getenv("SPHEREX_PUBLIC_LIMITS") == "1" else 0
    if shutil.disk_usage(path).free < required + reserve:
        raise HTTPException(507, "Insufficient disk space to process all observations. No subset was substituted.")


def workspace(function):
    @wraps(function)
    def run(*args, **kwargs):
        root = Path(os.getenv("SPHEREX_CACHE_DIR", tempfile.gettempdir())) / "timeline-work"
        root.mkdir(parents=True, exist_ok=True)
        check_space(root)
        with tempfile.TemporaryDirectory(dir=root) as folder:
            token = _workspace.set(Path(folder))
            try:
                return function(*args, **kwargs)
            finally:
                _workspace.reset(token)
    run.__signature__ = inspect.signature(function, eval_str=True)
    return run


class DiskArray:
    """Read only the requested slice, closing each mapping immediately."""
    def __init__(self, path, array):
        self.path, self.shape, self.dtype = path, array.shape, array.dtype
        with open(path, "ab") as output:
            self.offset = output.tell()
            array.tofile(output)

    def __getitem__(self, key):
        value = np.memmap(self.path, dtype=self.dtype, shape=self.shape, offset=self.offset, mode="r")
        try:
            return np.array(value[key], copy=True)
        finally:
            value._mmap.close()


def spill(exposure, index):
    folder = _workspace.get()
    if folder is None:
        return exposure
    check_space(folder, sum(getattr(exposure, k).nbytes for k in ("sci", "var", "valid")))
    for name in ("sci", "var", "valid"):
        setattr(exposure, name, DiskArray(folder / f"{name}.bin", getattr(exposure, name)))
    return exposure


def combine(exposures, sigma=5.0, maxiters=2, min_clip_n=5):
    """Exact full-input clipping and weights, with bounded spatial tiles.

    Clipping sees ALL exposures per pixel. Scalar variance weights are computed
    over each FULL exposure after clipping, never independently per batch.
    """
    from astropy.stats import sigma_clip, mad_std
    import warnings
    from . import releases

    input_releases = {e.extras.get("data_release", "unknown") for e in exposures}
    families = {releases.calibration_family(r) for r in input_releases}
    if len(families) > 1 or ("unknown" in families and len(input_releases) > 1):
        raise ValueError("Cannot coadd different or unknown release calibrations")
    n = len(exposures)
    shape = exposures[0].sci.shape
    pixels = int(np.prod(shape))
    # Budget all temporary clipping arrays, not just the input cube.
    budget = int(os.getenv("SPHEREX_COADD_TILE_BYTES", str(32 * 1024 ** 2)))
    tile = max(1, min(pixels, budget // max(1, n * 96)))
    folder = _workspace.get()
    with tempfile.TemporaryDirectory(dir=folder) as tmp:
        check_space(tmp, n * pixels)
        mask_path = Path(tmp) / "mask.bin"
        with open(mask_path, "wb") as file:
            file.truncate(n * pixels)
        def read(array, start, end):
            # Whole rows retain simple disk slicing, then trim to exact pixels.
            first, last = start // shape[1], (end - 1) // shape[1] + 1
            return array[first:last, :].reshape(-1)[start - first * shape[1]:end - first * shape[1]]
        rejected = 0
        for start in range(0, pixels, tile):
            end = min(pixels, start + tile)
            x = np.stack([read(e.sci, start, end) for e in exposures])
            keep = np.stack([read(e.valid, start, end) for e in exposures])
            if sigma is not None and n >= min_clip_n:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    clipped = sigma_clip(np.ma.array(x, mask=~keep), axis=0,
                                         cenfunc="median", stdfunc=mad_std,
                                         sigma=sigma, maxiters=maxiters)
                mask = np.ma.getmaskarray(clipped)
                rejected += int((mask & keep).sum())
                keep &= ~mask
            disk = np.memmap(mask_path, dtype=bool, mode="r+", shape=(n, pixels))
            disk[:, start:end] = keep
            disk.flush()
            disk._mmap.close()
        weights = np.empty(n)
        lam_weights = np.zeros(n)
        c = shape[0] // 2
        lo, hi = max(0, c - 1), min(shape[0], c + 2)
        for i, e in enumerate(exposures):
            disk = np.memmap(mask_path, dtype=bool, mode="r", offset=i * pixels, shape=shape)
            keep = np.array(disk)
            disk._mmap.close()
            vv = e.var[:, :][keep]
            vv = vv[np.isfinite(vv) & (vv > 0)]
            weights[i] = 1.0 / float(np.median(vv)) if vv.size else 0.0
            lam_weights[i] = float(np.where(keep[lo:hi, lo:hi], weights[i], 0.0).sum())
        image, variance = np.full(pixels, np.nan), np.full(pixels, np.nan)
        coverage = np.zeros(pixels, dtype=np.uint64)
        for start in range(0, pixels, tile):
            end = min(pixels, start + tile)
            x = np.stack([read(e.sci, start, end) for e in exposures])
            v = np.stack([read(e.var, start, end) for e in exposures])
            disk = np.memmap(mask_path, dtype=bool, mode="r", shape=(n, pixels))
            keep = np.array(disk[:, start:end])
            disk._mmap.close()
            w = np.where(keep, weights[:, None], 0.0)
            total = w.sum(axis=0)
            image[start:end] = np.divide((w * x).sum(axis=0), total,
                                        out=np.full(end-start, np.nan), where=total > 0)
            variance[start:end] = np.divide((w**2 * np.where(keep, v, 0.0)).sum(axis=0), total**2,
                                           out=np.full(end-start, np.nan), where=total > 0)
            coverage[start:end] = keep.sum(axis=0)
        selected = [(e.wavelength_um, lam_weights[i]) for i, e in enumerate(exposures)
                    if e.wavelength_um is not None and lam_weights[i] > 0]
        wavelengths = None
        if selected:
            values, w = np.array(selected).T
            wavelengths = {"min_um": round(float(values.min()), 4),
                           "max_um": round(float(values.max()), 4),
                           "weighted_mean_um": round(float(np.average(values, weights=w)), 4),
                           "n_sampled": len(values)}
        return image.reshape(shape), variance.reshape(shape), coverage.reshape(shape), rejected, wavelengths
