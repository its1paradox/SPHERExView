"""Bounded, cancellable comparison jobs and immutable result downloads."""
from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from contextvars import copy_context
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from . import detector_comparison as dc
from . import spherex_client as sx
from . import releases
from . import hosting
from . import research

router = APIRouter(prefix="/api/detector-comparison", tags=["detector comparison"])
_max_jobs = int(os.getenv("SPHEREX_MAX_COMPARISONS", "2"))
_pool = ThreadPoolExecutor(max_workers=_max_jobs, thread_name_prefix="six-detector")
_lock = threading.Lock()
_jobs = {}


def result_dir(job_id):
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise HTTPException(404, "Comparison not found")
    return research.product_dir(sx.CACHE_DIR) / job_id


def _run(job_id, recipe, cancel):
    def progress(message, done, total):
        with _lock:
            _jobs[job_id].update(message=message, done=done, total=total)
    try:
        if cancel.is_set():
            raise dc.Cancelled()
        with _lock:
            _jobs[job_id]["status"] = "running"
        result = dc.build(recipe, result_dir(job_id), progress, cancel)
        path = result_dir(job_id)
        # Publish only after all six slots in every epoch have been resolved.
        tmp = path / "result.tmp"
        encoded = json.dumps(result, allow_nan=False, separators=(",", ":"))
        research.maintain_outputs(research.workspace(), len(encoded.encode()))
        tmp.write_text(encoded)
        tmp.replace(path / "result.json")
        research.maintain_outputs(research.workspace())
        with _lock:
            _jobs[job_id].update(status="complete", message="Comparison ready")
    except dc.Cancelled:
        (result_dir(job_id) / "result.json").unlink(missing_ok=True)
        with _lock:
            _jobs[job_id].update(status="cancelled", message="Cancelled")
    except Exception as exc:
        (result_dir(job_id) / "result.json").unlink(missing_ok=True)
        with _lock:
            _jobs[job_id].update(status="error", message=str(exc))


def _run_guarded(job_id, recipe, cancel, lease):
    try:
        with research.source_scope():
            _run(job_id, recipe, cancel)
    finally:
        lease.release()
        research.release(research.workspace())
        research.maintain_outputs()


@router.post("", status_code=202)
def start_comparison(recipe: dc.Recipe):
    try:
        releases.collections(recipe.survey, recipe.release)
    except releases.RetiredReleaseError as exc:
        raise HTTPException(410, str(exc)) from exc
    hosting.validate_comparison(recipe)
    workspace = research.current.get()
    lease = hosting.acquire()
    job_id = None
    try:
        with _lock:
            if sum(j["status"] in ("queued", "running") for j in _jobs.values()) >= _max_jobs:
                raise HTTPException(429, "The comparison server is busy; cancel a job or wait for completion")
            # Disk exports survive registry eviction and server restarts.
            terminal = [key for key, value in _jobs.items() if value["status"] not in ("queued", "running")]
            for key in terminal[:-8]:
                _jobs.pop(key)
            job_id, cancel = uuid.uuid4().hex, threading.Event()
            _jobs[job_id] = {"status": "queued", "message": "Queued", "done": 0, "total": 0, "cancel": cancel, "created": time.time(), "workspace": str(workspace) if workspace else None}
        research.hold(research.workspace())
        try:
            _pool.submit(copy_context().run, _run_guarded, job_id, recipe, cancel, lease)
        except BaseException:
            research.release(research.workspace())
            raise
        return {"job_id": job_id, "status": "queued"}
    except BaseException:
        if job_id is not None:
            with _lock:
                _jobs.pop(job_id, None)
        lease.release()
        raise


@router.get("/{job_id}")
def comparison_status(job_id: str):
    path = result_dir(job_id)
    with _lock:
        job = _jobs.get(job_id)
        if job and job.get("workspace") == (str(research.current.get()) if research.current.get() else None):
            return {"job_id": job_id, **{key: value for key, value in job.items() if key not in ("cancel", "workspace")}}
    if (path / "result.json").is_file():
        return {"job_id": job_id, "status": "complete", "message": "Comparison ready"}
    raise HTTPException(404, "Comparison not found")


@router.delete("/{job_id}")
def cancel_comparison(job_id: str):
    result_dir(job_id)
    with _lock:
        job = _jobs.get(job_id)
        if not job or job.get("workspace") != (str(research.current.get()) if research.current.get() else None):
            raise HTTPException(404, "Comparison not found")
        if job["status"] in ("queued", "running"):
            job["cancel"].set()
            job["message"] = "Cancelling after the current exposure finishes"
    return {"job_id": job_id, "status": "cancellation_requested"}


def _completed(job_id):
    path = result_dir(job_id)
    if not (path / "result.json").is_file():
        raise HTTPException(410, "Temporary comparison expired or is not complete. Refresh the target to rebuild it.")
    return path


@router.get("/{job_id}/result")
def comparison_result(job_id: str):
    return FileResponse(_completed(job_id) / "result.json", media_type="application/json")


@router.get("/{job_id}/manifest")
def comparison_manifest(job_id: str):
    return FileResponse(_completed(job_id) / "manifest.json", media_type="application/json", filename=f"spherex-comparison-{job_id[:8]}.json")


@router.get("/{job_id}/epochs/{epoch}.fits")
def comparison_fits(job_id: str, epoch: int):
    path = _completed(job_id) / f"epoch-{epoch}.fits"
    if epoch < 0 or not path.is_file():
        raise HTTPException(404, "Epoch not found")
    return FileResponse(path, media_type="application/fits", filename=f"spherex-{job_id[:8]}-epoch-{epoch + 1}.fits")


@router.get("/{job_id}/spectra/{epoch}.fits")
def comparison_spectrum_fits(job_id: str, epoch: int):
    path = _completed(job_id) / f"spectrum-{epoch}.fits"
    if epoch < 0 or not path.is_file():
        raise HTTPException(404, "Spectrum epoch not found")
    return FileResponse(path, media_type="application/fits", filename=f"spherex-{job_id[:8]}-spectrum-{epoch + 1}.fits")
