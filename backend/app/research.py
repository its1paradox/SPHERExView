"""Browser-owned, durable research workspaces. No account or automatic expiry.

A random browser capability identifies the owner; it never appears in share URLs.
Each target has its own downloads and products, so clearing it cannot invalidate
another researcher's results. The public legacy API remains available separately.
"""
from contextvars import ContextVar, copy_context
from functools import wraps, lru_cache
from pathlib import Path
from typing import Literal
import hashlib
import inspect
import json
import os
import re
import shutil
import threading
import time
import uuid

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/research", tags=["research history"])
current = ContextVar("research", default=None)
lock = threading.RLock()
active = {}


def root():
    return Path(os.getenv("SPHEREX_CACHE_DIR", Path(__file__).resolve().parents[1] / "cache")) / "research"


def owner(key):
    if not key or not re.fullmatch(r"[0-9a-f]{64}", key):
        raise HTTPException(401, "This browser's research key is required.")
    return hashlib.sha256(key.encode()).hexdigest()


def target_path(who, target):
    if not re.fullmatch(r"[0-9a-f]{32}", target):
        raise HTTPException(404, "Saved target not found.")
    path = root() / who / target
    if not (path / "record.json").is_file():
        raise HTTPException(404, "Saved target not found in this browser's history.")
    return path


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        tmp.write_text(json.dumps(value, allow_nan=False, separators=(",", ":")), encoding="utf8")
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def record(path):
    return json.loads((path / "record.json").read_text(encoding="utf8"))


def update(path, **values):
    with lock:
        data = record(path)
        data.update(values)
        write_json(path / "record.json", data)
        return data


def cache_dir(default):
    ctx = current.get()
    path = ctx / "data" / "downloads" if ctx else Path(default)
    path.mkdir(parents=True, exist_ok=True)
    return path


def product_dir(default):
    ctx = current.get()
    path = ctx / "data" / "comparisons" if ctx else Path(default) / "comparisons"
    path.mkdir(parents=True, exist_ok=True)
    return path


def assets_dir(default):
    ctx = current.get()
    path = ctx / "data" / "assets" if ctx else Path(default) / "cutouts"
    path.mkdir(parents=True, exist_ok=True)
    return path


def asset_url(name):
    ctx = current.get()
    return f"/api/research/{ctx.name}/files/{name}" if ctx else f"/static/cutouts/{name}"


def map_context(pool, function, items):
    # ThreadPoolExecutor does not inherit ContextVars, unlike FastAPI's workers.
    def run(pair):
        context, item = pair
        return context.run(function, item)
    return pool.map(run, [(copy_context(), item) for item in items])


def file_cache(maxsize):
    """Scope cached calibration paths to their owner; rehydrate after deletion."""
    def decorate(function):
        @lru_cache(maxsize=maxsize)
        def memo(namespace, *args, **kwargs):
            return function(*args, **kwargs)
        @wraps(function)
        def run(*args, **kwargs):
            namespace = str(current.get() or os.getenv("SPHEREX_CACHE_DIR", "legacy"))
            result = memo(namespace, *args, **kwargs)
            if not Path(result[0]).is_file():
                memo.cache_clear()
                result = memo(namespace, *args, **kwargs)
            return result
        run.cache_clear = memo.cache_clear
        return run
    return decorate


def hold(path):
    if path:
        with lock:
            active[str(path)] = active.get(str(path), 0) + 1


def release(path):
    if path:
        with lock:
            count = active.get(str(path), 1) - 1
            if count:
                active[str(path)] = count
            else:
                active.pop(str(path), None)


def tool_update(tool, **values):
    path = current.get()
    if path:
        with lock:
            data = record(path)
            data.setdefault("tools", {}).setdefault(tool, {}).update(values)
            data["visited_at"] = time.time()
            write_json(path / "record.json", data)


def request_update(name, status, result=None):
    path = current.get()
    if path:
        with lock:
            data = record(path)
            state = data.setdefault("tools", {}).setdefault("timeline", {})
            requests = state.setdefault("requests", {})
            requests[name] = {"status": status}
            if result is not None:
                requests[name].update(available=result.get("count"),
                    attempted=result.get("n_attempted", result.get("n_exposures_input")),
                    skipped=result.get("n_exposures_skipped", 0))
                state["checked_at"] = time.time()
            states = [r["status"] for r in requests.values()]
            state["status"] = "processing" if "processing" in states else "incomplete" if "incomplete" in states else "saved"
            write_json(path / "record.json", data)


def cached(function):
    """Persist a complete API response by exact scientific arguments.

    Refresh removes these responses explicitly. FITS are immutable archive
    products and remain reusable; inventory discovery always runs on a miss.
    """
    @wraps(function)
    def run(*args, **kwargs):
        path = current.get()
        if not path:
            return function(*args, **kwargs)
        key = hashlib.sha256(json.dumps([function.__name__, args, kwargs], sort_keys=True, default=str).encode()).hexdigest()
        destination = path / "data" / "responses" / (key + ".json")
        if destination.is_file():
            return json.loads(destination.read_text(encoding="utf8"))
        request_update(function.__name__, "processing")
        try:
            result = function(*args, **kwargs)
            write_json(destination, result)
            request_update(function.__name__, "incomplete" if result.get("n_exposures_skipped", 0) else "saved", result)
            return result
        except Exception:
            request_update(function.__name__, "incomplete")
            raise
    run.__signature__ = inspect.signature(function, eval_str=True)
    return run


class Target(BaseModel):
    ra: float = Field(ge=0, lt=360, allow_inf_nan=False)
    dec: float = Field(ge=-90, le=90, allow_inf_nan=False)
    size: float = Field(gt=0, le=7200, allow_inf_nan=False)
    survey: Literal["wide", "deep"] = "wide"
    release: Literal["all", "dr1", "qr3"] = "all"


def summary(path):
    data = record(path)
    sizes = {kind: sum(p.stat().st_size for p in (path / "data" / kind).rglob("*") if p.is_file())
             for kind in ("downloads", "responses", "assets", "comparisons", "job-index")}
    data.update(bytes=sum(sizes.values()), storage=sizes, busy=bool(active.get(str(path))))
    return data


@router.get("")
def history(x_research_key: str = Header(default="")):
    folder = root() / owner(x_research_key)
    with lock:
        items = [summary(p.parent) for p in folder.glob("*/record.json")]
    return {"targets": sorted(items, key=lambda x: x["visited_at"], reverse=True),
            "bytes": sum(x["bytes"] for x in items)}


@router.post("")
def remember(target: Target, x_research_key: str = Header(default="")):
    values = target.model_dump()
    # Canonical numbers ensure both tools share an entry for the same field.
    for key in ("ra", "dec", "size"):
        values[key] = float(values[key]) or 0.0
    ident = hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()[:32]
    path = root() / owner(x_research_key) / ident
    with lock:
        if not (path / "record.json").exists():
            write_json(path / "record.json", {"id": ident, **values, "created_at": time.time(), "visited_at": time.time(), "tools": {}})
        else:
            update(path, visited_at=time.time())
        return summary(path)


class ViewLink(BaseModel):
    tool: Literal["timeline", "detectors"]
    hash: str = Field(max_length=16000, pattern=r"^#[^\r\n]*$")


@router.put("/{target}/view")
def save_view(target: str, view: ViewLink, x_research_key: str = Header(default="")):
    path = target_path(owner(x_research_key), target)
    with lock:
        data = record(path)
        data.setdefault("tools", {}).setdefault(view.tool, {})["hash"] = view.hash
        write_json(path / "record.json", data)
    return {"saved": True}


@router.post("/{target}/refresh")
def refresh(target: str, tool: Literal["timeline", "detectors"], x_research_key: str = Header(default="")):
    path = target_path(owner(x_research_key), target)
    with lock:
        if active.get(str(path)):
            raise HTTPException(409, "This target is processing. Wait for it to finish before refreshing.")
        # Remove response/index caches only. Keep previous products and source
        # FITS until the user clears the workspace, including on refresh failure.
        folder = path / "data" / ("responses" if tool == "timeline" else "job-index")
        if folder.exists():
            shutil.rmtree(folder)
        data = record(path)
        state = data.setdefault("tools", {}).setdefault(tool, {})
        state.update(status="refresh requested", refresh_at=time.time())
        state.pop("requests", None)
        write_json(path / "record.json", data)
    return {"refresh": tool}


@router.delete("/{target}/cache")
def clear_cache(target: str, x_research_key: str = Header(default="")):
    path = target_path(owner(x_research_key), target)
    with lock:
        if active.get(str(path)):
            raise HTTPException(409, "This target is processing. Wait for it to finish before deleting cached files.")
        before = summary(path)["bytes"]
        if (path / "data").exists():
            shutil.rmtree(path / "data")
        data = record(path)
        for state in data.get("tools", {}).values():
            state.update(status="cache cleared", checked_at=None)
        write_json(path / "record.json", data)
    return {"freed_bytes": before}


@router.delete("/{target}")
def forget(target: str, x_research_key: str = Header(default="")):
    with lock:
        result = clear_cache(target, x_research_key)
        path = target_path(owner(x_research_key), target)
        shutil.rmtree(path)
    return result


@router.get("/{target}/files/{name}")
def pixels(target: str, name: str, x_research_key: str = Header(default="")):
    if not re.fullmatch(r"timeline-[0-9a-f]{64}\.json", name):
        raise HTTPException(404)
    path = target_path(owner(x_research_key), target) / "data" / "assets" / name
    if not path.is_file():
        raise HTTPException(404, "Cached image was cleared. Reopen this target from the dashboard.")
    return FileResponse(path, headers={"Cache-Control": "private, no-store"})


class ResearchMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        target = headers.get(b"x-research-target", b"").decode()
        if not target or scope["path"].startswith("/api/research"):
            return await self.app(scope, receive, send)
        try:
            with lock:
                path = target_path(owner(headers.get(b"x-research-key", b"").decode()), target)
                hold(path)
        except HTTPException as exc:
            return await JSONResponse({"detail": exc.detail}, status_code=exc.status_code)(scope, receive, send)
        token = current.set(path)
        async def private_send(message):
            if message["type"] == "http.response.start":
                message["headers"] = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"cache-control"] + [(b"cache-control", b"private, no-store")]
            await send(message)
        try:
            await self.app(scope, receive, private_send)
        finally:
            current.reset(token)
            release(path)
