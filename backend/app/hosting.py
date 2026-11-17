"""Opt-in admission controls for a single-instance public pilot.

Reject oversized work explicitly; never silently change a science recipe.
No cached data or downloaded user files are deleted by these controls.
"""
import math
import os
import shutil
import threading
from pathlib import Path

from fastapi import HTTPException
from starlette.datastructures import QueryParams
from starlette.responses import JSONResponse

_slot = threading.BoundedSemaphore(1)
MAX_FIELD_ARCSEC = 500
HEAVY_PATHS = frozenset({"/api/cutouts", "/api/epoch-stack", "/api/coadd",
                         "/api/epoch-coadds", "/api/wise-stack", "/api/spectra/submit"})


def enabled():
    return os.getenv("SPHEREX_PUBLIC_LIMITS", "0") == "1"


class Lease:
    def __init__(self, slot=None):
        self.slot = slot

    def release(self):
        if self.slot is not None:
            slot, self.slot = self.slot, None
            slot.release()


def acquire():
    if not enabled():
        return Lease()
    if not _slot.acquire(blocking=False):
        raise HTTPException(429, "The public server is processing another request. Please retry shortly.",
                            headers={"Retry-After": "15"})
    lease = Lease(_slot)
    try:
        cache = Path(os.environ["SPHEREX_CACHE_DIR"])
        cache.mkdir(parents=True, exist_ok=True)
        minimum = float(os.getenv("SPHEREX_MIN_FREE_GB", "3")) * 1024 ** 3
        if shutil.disk_usage(cache).free < minimum:
            raise HTTPException(507, "Server storage is low. New calculations are paused; existing results remain available.")
        return lease
    except BaseException:
        lease.release()
        raise


def validate_comparison(recipe):
    if enabled() and (recipe.size_arcsec > MAX_FIELD_ARCSEC or recipe.pixscale_arcsec < 6.2):
        raise HTTPException(422, f"Public pilot limits: field size at most {MAX_FIELD_ARCSEC} arcsec and pixel scale at least 6.2 arcsec. Your recipe was not changed.")


def validate_query(query):
    bounds = {"radius_arcsec": (0, MAX_FIELD_ARCSEC / 2), "size_arcsec": (0, MAX_FIELD_ARCSEC),
              "pixscale_arcsec": (3.1, 24.8)}
    for key, (low, high) in bounds.items():
        if key not in query:
            continue
        try:
            value = float(query[key])
        except ValueError:
            continue  # FastAPI returns its normal validation error.
        if not math.isfinite(value) or value < low or value > high:
            raise HTTPException(422, f"Public pilot requires {key} between {low} and {high}. Your request was not changed.")


class PublicAdmissionMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "").rstrip("/")
        heavy = path in HEAVY_PATHS or path.startswith(("/api/spectra/table/", "/api/spectra/download/"))
        if scope["type"] != "http" or not enabled() or not heavy or scope.get("method") == "OPTIONS":
            await self.app(scope, receive, send)
            return
        try:
            validate_query(QueryParams(scope.get("query_string", b"")))
            lease = acquire()
        except HTTPException as exc:
            await JSONResponse({"detail": exc.detail}, status_code=exc.status_code,
                               headers=exc.headers)(scope, receive, send)
            return
        try:
            await self.app(scope, receive, send)
        finally:
            lease.release()
