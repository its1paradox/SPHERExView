"""Bounded shared source cache and short-lived result handoff, never user history.

Single-process service: files in use are pinned; only idle files are evicted.
The browser is the durable owner of results. Scientific input selection is unchanged.
"""
from contextvars import ContextVar, copy_context
from contextlib import contextmanager
from functools import wraps
from pathlib import Path
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

router = APIRouter(prefix="/api/research", tags=["temporary result transfer"])
current = ContextVar("research", default=None)
_pins = ContextVar("source_pins", default=None)
lock = threading.RLock()
active = {}
_pinned = {}
_download_locks = {}

class CacheCapacityError(HTTPException):
    def __init__(self):
        super().__init__(507, "Working storage is insufficient to process all observations. No subset was substituted. Retry later or use a smaller field.")

def root():
    from . import spherex_client as sx
    return Path(os.getenv("SPHEREX_CACHE_DIR", sx.CACHE_DIR)) / "managed"

def budget(kind):
    return int(os.getenv(f"SPHEREX_{kind.upper()}_CACHE_BYTES", str((2 if kind == 'source' else 1) * 1024**3)))

def files(folder):
    result = []
    for p in folder.rglob('*') if folder.exists() else []:
        try:
            if p.is_file(): result.append((p, p.stat()))
        except FileNotFoundError:
            pass  # Atomic publication can rename a temporary file during a scan.
    return result

def _trim_sources(required=0):
    entries = files(root() / 'sources')
    total = sum(s.st_size for _, s in entries)
    for path, stat in sorted(entries, key=lambda item: item[1].st_mtime):
        if total + required <= budget('source'):
            break
        # In-progress downloads and all active readers are protected.
        if _pinned.get(str(path)) or '.tmp.' in path.name:
            continue
        path.unlink(missing_ok=True)
        total -= stat.st_size
    if total + required > budget('source'):
        raise CacheCapacityError()

def reserve_source(count):
    with lock:
        _trim_sources(count)
        if shutil.disk_usage(root()).free < count + float(os.getenv('SPHEREX_MIN_FREE_GB', '3')) * 1024**3:
            raise CacheCapacityError()

def pin(path):
    group = _pins.get()
    with lock:
        if group is not None and str(path) not in group:
            group.add(str(path))
            _pinned[str(path)] = _pinned.get(str(path), 0) + 1

def unpin(path):
    group = _pins.get()
    with lock:
        if group is not None and str(path) in group:
            group.remove(str(path))
            count = _pinned.get(str(path), 1) - 1
            if count: _pinned[str(path)] = count
            else: _pinned.pop(str(path), None)

@contextmanager
def source_scope():
    token = _pins.set(set())
    try:
        yield
    finally:
        for path in list(_pins.get()): unpin(path)
        _pins.reset(token)

def source_reader(function):
    @wraps(function)
    def run(*args, **kwargs):
        with source_scope(): return function(*args, **kwargs)
    return run

def source_download(path_for):
    """Pin before cache lookup; serialize writers of the same immutable URL."""
    def decorate(function):
        @wraps(function)
        def run(*args, **kwargs):
            path = str(path_for(*args, **kwargs))
            with lock:
                pin(path)
                entry = _download_locks.setdefault(path, [threading.Lock(), 0])
                entry[1] += 1
            try:
                with entry[0]:
                    result = function(*args, **kwargs)
                    with lock:
                        os.utime(result, None)
                        _trim_sources()
                    return result
            finally:
                with lock:
                    entry[1] -= 1
                    if not entry[1]: _download_locks.pop(path, None)
        return run
    return decorate

def cache_dir(default):
    path = root() / 'sources'
    path.mkdir(parents=True, exist_ok=True)
    return path

def workspace():
    return current.get() or root() / 'outputs' / 'public' / 'public'

def product_dir(default):
    path = workspace() / 'comparisons'
    path.mkdir(parents=True, exist_ok=True)
    return path

def assets_dir(default):
    path = workspace() / 'assets'
    path.mkdir(parents=True, exist_ok=True)
    return path

def asset_url(name):
    ctx = current.get()
    return f"/api/research/{ctx.name if ctx else 'public'}/files/{name}"

def owner(key):
    if not key or not re.fullmatch(r'[0-9a-f]{64}', key):
        raise HTTPException(401, 'Temporary transfer key required.')
    return hashlib.sha256(key.encode()).hexdigest()

def target_path(who, target):
    if not re.fullmatch(r'[0-9a-f]{32}', target):
        raise HTTPException(404, 'Temporary result not found.')
    return root() / 'outputs' / who / target

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        tmp.write_text(json.dumps(value, allow_nan=False, separators=(',', ':')), encoding='utf8')
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)

def hold(path):
    with lock:
        active[str(path)] = active.get(str(path), 0) + 1

def release(path):
    with lock:
        count = active.get(str(path), 1) - 1
        if count: active[str(path)] = count
        else: active.pop(str(path), None)

def maintain_outputs(required_path=None, required_bytes=0):
    """LRU plus TTL; whole handoffs are evicted, never pieces of an active job."""
    with lock:
        folder = root() / 'outputs'
        entries = []
        for path in folder.glob('*/*'):
            if path.is_dir():
                entries.append((path, sum(s.st_size for _, s in files(path)), path.stat().st_mtime))
        total = sum(size for _, size, _ in entries)
        ttl = float(os.getenv('SPHEREX_RESULT_TTL_SECONDS', '3600'))
        for path, size, touched in sorted(entries, key=lambda e: e[2]):
            if active.get(str(path)) or path == required_path:
                continue
            if total + required_bytes <= budget('result') and time.time() - touched < ttl:
                continue
            # Paths are enumerated only inside the managed output root.
            path.resolve().relative_to(folder.resolve())
            shutil.rmtree(path)
            total -= size
        if required_path and total + required_bytes > budget('result'):
            raise CacheCapacityError()
        # Remove empty namespace directories so user count cannot accumulate them.
        for path in folder.glob('*'):
            if path.is_dir() and not any(path.iterdir()): path.rmdir()

def cached(function):
    # Name retained for endpoint decorators: responses are now cached ONLY locally.
    @wraps(function)
    def run(*args, **kwargs):
        path = workspace()
        hold(path)
        try:
            with source_scope(): result = function(*args, **kwargs)
            if path.exists():
                os.utime(path, None)
                maintain_outputs(path)
            return result
        finally:
            release(path)
    run.__signature__ = inspect.signature(function, eval_str=True)
    return run

def file_cache(maxsize):
    def decorate(function):
        memo = {}
        @wraps(function)
        def run(*args, **kwargs):
            key = (str(root()), args, tuple(sorted(kwargs.items())))
            with lock:
                result = memo.get(key)
                if result and Path(result[0]).is_file():
                    pin(result[0])
                    return result
            result = function(*args, **kwargs)
            with lock:
                pin(result[0])
                memo[key] = result
                while len(memo) > maxsize: memo.pop(next(iter(memo)))
            return result
        run.cache_clear = memo.clear
        return run
    return decorate

def map_context(pool, function, items):
    def run(pair):
        context, item = pair
        return context.run(function, item)
    return pool.map(run, [(copy_context(), item) for item in items])

@router.get('/{target}/files/{name}')
def pixels(target: str, name: str, x_research_key: str = Header(default='')):
    if not re.fullmatch(r'timeline-[0-9a-f]{64}\.json', name): raise HTTPException(404)
    path = (root() / 'outputs/public/public' if target == 'public' else target_path(owner(x_research_key), target)) / 'assets' / name
    if not path.is_file(): raise HTTPException(410, 'Temporary result expired. Refresh this target to rebuild it.')
    return FileResponse(path, headers={'Cache-Control': 'private, no-store'})

class ResearchMiddleware:
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http': return await self.app(scope, receive, send)
        headers = dict(scope.get('headers', []))
        target = headers.get(b'x-research-target', b'').decode()
        try:
            path = target_path(owner(headers.get(b'x-research-key', b'').decode()), target) if target else root() / 'outputs/public/public'
            with lock:
                hold(path)
                if path.exists(): os.utime(path, None)
                maintain_outputs()
        except HTTPException as exc:
            return await JSONResponse({'detail': exc.detail}, status_code=exc.status_code)(scope, receive, send)
        token = current.set(path if target else None)
        async def private_send(message):
            if message['type'] == 'http.response.start':
                message['headers'] = [(k,v) for k,v in message.get('headers',[]) if k.lower() != b'cache-control'] + [(b'cache-control',b'private, no-store')]
            await send(message)
        try:
            await self.app(scope, receive, private_send)
        finally:
            current.reset(token)
            release(path)
            maintain_outputs()


def maintenance(startup=False):
    """Called at startup and periodically even when no users visit."""
    with lock:
        if startup:
            source = cache_dir(None)
            base = root().parent.resolve()
            # Move only known legacy runtime products; never repository/user files.
            for path in base.glob('*.fits'):
                if re.fullmatch(r'[0-9a-f]{32}\.fits', path.name) and not path.is_symlink():
                    path.resolve().relative_to(base)
                    destination = source / path.name
                    if destination.exists(): path.unlink()
                    else: path.replace(destination)
            legacy = base / 'comparisons'
            destination = root() / 'outputs/public/public/comparisons'
            for path in legacy.glob('*'):
                if re.fullmatch(r'[0-9a-f]{32}', path.name) and path.is_dir() and not path.is_symlink():
                    path.resolve().relative_to(base)
                    destination.mkdir(parents=True, exist_ok=True)
                    if not (destination / path.name).exists(): path.rename(destination / path.name)
            static = Path(os.getenv('SPHEREX_STATIC_DIR', Path(__file__).resolve().parents[1] / 'static')).resolve()
            for path in (static / 'cutouts').glob('timeline-*.json'):
                if re.fullmatch(r'timeline-[0-9a-f]{64}\.json', path.name) and not path.is_symlink():
                    path.resolve().relative_to(static)
                    destination = root() / 'outputs/public/public/assets' / path.name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    if destination.exists(): path.unlink()
                    else: path.replace(destination)
            # Scratch directories are owned by a single process and cannot survive a restart.
            for path in (base / 'timeline-work').glob('tmp*'):
                if path.is_dir() and not path.is_symlink():
                    path.resolve().relative_to(base)
                    shutil.rmtree(path)
        for path, stat in files(root() / 'sources'):
            if '.tmp.' in path.name and (startup or time.time() - stat.st_mtime > 86400):
                path.unlink(missing_ok=True)
        _trim_sources()
        maintain_outputs()
