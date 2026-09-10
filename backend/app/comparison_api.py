"""Bounded, cancellable comparison jobs and immutable result downloads."""
from __future__ import annotations

import json
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from . import detector_comparison as dc
from . import spherex_client as sx

router = APIRouter(prefix="/api/detector-comparison", tags=["detector comparison"])
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="six-detector")
_lock = threading.Lock()
_jobs = {}


def result_dir(job_id):
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise HTTPException(404, "Comparison not found")
    return Path(sx.CACHE_DIR) / "comparisons" / job_id


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
        tmp.write_text(json.dumps(result, allow_nan=False, separators=(",", ":")))
        tmp.replace(path / "result.json")
        with _lock:
            _jobs[job_id].update(status="complete", message="Comparison ready")
    except dc.Cancelled:
        with _lock:
            _jobs[job_id].update(status="cancelled", message="Cancelled")
    except Exception as exc:
        with _lock:
            _jobs[job_id].update(status="error", message=str(exc))


@router.post("", status_code=202)
def start_comparison(recipe: dc.Recipe):
    with _lock:
        if sum(j["status"] in ("queued", "running") for j in _jobs.values()) >= 2:
            raise HTTPException(429, "Two comparisons are already building; cancel one or wait for completion")
        # Disk exports survive registry eviction and server restarts.
        terminal = [key for key, value in _jobs.items() if value["status"] not in ("queued", "running")]
        for key in terminal[:-8]:
            _jobs.pop(key)
        job_id, cancel = uuid.uuid4().hex, threading.Event()
        _jobs[job_id] = {"status": "queued", "message": "Queued", "done": 0, "total": 0, "cancel": cancel, "created": time.time()}
    _pool.submit(_run, job_id, recipe, cancel)
    return {"job_id": job_id, "status": "queued"}


@router.get("/{job_id}")
def comparison_status(job_id: str):
    path = result_dir(job_id)
    with _lock:
        job = _jobs.get(job_id)
        if job:
            return {"job_id": job_id, **{key: value for key, value in job.items() if key != "cancel"}}
    if (path / "result.json").is_file():
        return {"job_id": job_id, "status": "complete", "message": "Comparison ready"}
    raise HTTPException(404, "Comparison not found")


@router.delete("/{job_id}")
def cancel_comparison(job_id: str):
    result_dir(job_id)
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(404, "Comparison not found")
        if job["status"] in ("queued", "running"):
            job["cancel"].set()
            job["message"] = "Cancelling after the current archive request finishes"
    return {"job_id": job_id, "status": "cancellation_requested"}


def _completed(job_id):
    path = result_dir(job_id)
    if not (path / "result.json").is_file():
        raise HTTPException(409, "Comparison is not complete")
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
