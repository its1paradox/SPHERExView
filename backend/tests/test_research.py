"""Research lifecycle and isolation; no external archive or production files."""
import json
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from backend.app import research, comparison_api as comparison
from backend.app import main

KEY = "a" * 64
OTHER = "b" * 64
SPEC = {"ra": 133.7599588, "dec": -7.2449993, "size": 120}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path))
    monkeypatch.setenv("SPHEREX_PUBLIC_LIMITS", "0")
    monkeypatch.setattr(comparison.sx, "CACHE_DIR", str(tmp_path))
    return TestClient(main.app)


def headers(key=KEY, target=None):
    return {"X-Research-Key": key, **({"X-Research-Target": target} if target else {})}


def remember(client, key=KEY, spec=SPEC):
    response = client.post('/api/research', headers=headers(key), json=spec)
    assert response.status_code == 200, response.text
    return response.json()["id"]


def test_private_inventory_durable_and_canonical_coordinates(client):
    target = remember(client)
    assert remember(client, spec={**SPEC, "size": 120.0}) == target
    assert client.get('/api/research').status_code == 401
    assert client.get('/api/research', headers=headers(OTHER)).json()["targets"] == []
    assert client.delete(f'/api/research/{target}', headers=headers(OTHER)).status_code == 404
    with TestClient(main.app) as restarted:
        rows = restarted.get('/api/research', headers=headers()).json()["targets"]
        assert len(rows) == 1
        assert rows[0]["ra"] == SPEC["ra"]
    assert client.post('/api/research', headers=headers(), json={**SPEC, "ra": 360}).status_code == 422


def test_actual_bytes_clear_and_forget_are_isolated(client):
    target = remember(client)
    other = remember(client, OTHER)
    for key, content in [(KEY, b"a" * 137), (OTHER, b"b" * 251)]:
        path = research.target_path(research.owner(key), target)
        file = path / "data" / "downloads" / "input.fits"
        file.parent.mkdir(parents=True)
        file.write_bytes(content)
    listing = client.get('/api/research', headers=headers()).json()
    assert listing["bytes"] == listing["targets"][0]["bytes"] == 137
    result = client.delete(f'/api/research/{target}/cache', headers=headers())
    assert result.json()["freed_bytes"] == 137
    remaining = client.get('/api/research', headers=headers()).json()["targets"]
    assert len(remaining) == 1 and remaining[0]["bytes"] == 0
    assert client.get('/api/research', headers=headers(OTHER)).json()["bytes"] == 251
    assert client.delete(f'/api/research/{target}', headers=headers()).status_code == 200
    assert not client.get('/api/research', headers=headers()).json()["targets"]
    assert research.target_path(research.owner(OTHER), other).exists()


def test_revisit_uses_saved_response_and_refresh_requeries(client, monkeypatch):
    target = remember(client)
    calls = []
    def build(*args):
        calls.append(args)
        with ThreadPoolExecutor(2) as pool:
            contexts = list(research.map_context(pool, lambda _: research.current.get(), [1, 2]))
        assert contexts == [research.current.get()] * 2
        cache = research.cache_dir(main.sx.CACHE_DIR)
        (cache / 'immutable.fits').write_bytes(b'original science')
        return {"count": 1007, "cutouts": [], "science": [-2.5, 0, 4.25]}
    monkeypatch.setattr(main, '_build_stack', build)
    url = '/api/epoch-stack?ra=133.7599588&dec=-7.2449993&radius_arcsec=60&limit=1'
    first = client.get(url, headers=headers(target=target))
    assert first.status_code == 200
    second = client.get(url, headers=headers(target=target))
    assert first.json() == second.json()
    assert len(calls) == 1
    assert second.headers['cache-control'] == 'private, no-store'
    assert client.post(f'/api/research/{target}/refresh?tool=timeline', headers=headers()).status_code == 200
    client.get(url, headers=headers(target=target))
    assert len(calls) == 2
    assert (research.target_path(research.owner(KEY), target) / 'data/downloads/immutable.fits').read_bytes() == b'original science'


def test_delete_and_refresh_refuse_active_workspace(client):
    target = remember(client)
    path = research.target_path(research.owner(KEY), target)
    research.hold(path)
    try:
        assert client.get('/api/research', headers=headers()).json()['targets'][0]['busy']
        assert client.delete(f'/api/research/{target}/cache', headers=headers()).status_code == 409
        assert client.delete(f'/api/research/{target}', headers=headers()).status_code == 409
        assert client.post(f'/api/research/{target}/refresh?tool=timeline', headers=headers()).status_code == 409
    finally:
        research.release(path)


def test_pixel_payload_requires_owner_and_cannot_traverse(client):
    target = remember(client)
    name = 'timeline-' + 'c' * 64 + '.json'
    path = research.target_path(research.owner(KEY), target) / 'data/assets' / name
    path.parent.mkdir(parents=True)
    path.write_text('{"data_b64":"AAAAAA=="}')
    url = f'/api/research/{target}/files/{name}'
    assert client.get(url).status_code == 401
    assert client.get(url, headers=headers(OTHER)).status_code == 404
    assert client.get(url, headers=headers()).json()['data_b64'] == 'AAAAAA=='
    assert client.get(f'/api/research/{target}/files/record.json', headers=headers()).status_code == 404


def test_comparison_reuse_refresh_and_export_isolation(client, monkeypatch):
    target = remember(client)
    runs = []
    def build(recipe, path, progress, cancel):
        runs.append(recipe)
        path.mkdir(parents=True, exist_ok=True)
        (path / 'epoch-0.fits').write_bytes(b'science fits')
        return {'recipe': recipe.model_dump(), 'epochs': [], 'science': [-1, 0, 2]}
    monkeypatch.setattr(comparison.dc, 'build', build)
    recipe = {'ra': SPEC['ra'], 'dec': SPEC['dec'], 'size_arcsec': 120}
    h = headers(target=target)
    first = client.post('/api/detector-comparison', headers=h, json=recipe).json()['job_id']
    for _ in range(100):
        if client.get(f'/api/detector-comparison/{first}', headers=h).json()['status'] == 'complete':
            break
        time.sleep(.01)
    assert client.get(f'/api/detector-comparison/{first}/result', headers=h).json()['science'] == [-1, 0, 2]
    again = client.post('/api/detector-comparison', headers=h, json=recipe).json()['job_id']
    assert again == first and len(runs) == 1
    assert client.get(f'/api/detector-comparison/{first}/result').status_code != 200
    assert client.get(f'/api/detector-comparison/{first}/epochs/0.fits', headers=h).content == b'science fits'
    assert client.post(f'/api/research/{target}/refresh?tool=detectors', headers=headers()).status_code == 200
    second = client.post('/api/detector-comparison', headers=h, json=recipe).json()['job_id']
    assert second != first
    for _ in range(100):
        if not client.get('/api/research', headers=headers()).json()['targets'][0]['busy']:
            break
        time.sleep(.01)
    assert len(runs) == 2


def test_failure_does_not_publish_cached_success(client, monkeypatch):
    target = remember(client)
    def fail(*args):
        from fastapi import HTTPException
        raise HTTPException(502, 'Archive unavailable')
    monkeypatch.setattr(main, '_build_stack', fail)
    response = client.get('/api/epoch-stack?ra=1&dec=2', headers=headers(target=target))
    assert response.status_code == 502
    row = client.get('/api/research', headers=headers()).json()['targets'][0]
    assert row['tools']['timeline']['status'] == 'incomplete'
    assert not row['busy']
    assert row['storage']['responses'] == 0


def test_calibration_memo_is_per_workspace_and_reloads_cleared_files(client):
    target = remember(client)
    remember(client, OTHER)
    calls = []
    @research.file_cache(maxsize=4)
    def calibration(detector):
        path = research.cache_dir('unused') / f'cal-{detector}.fits'
        path.write_bytes(b'calibration')
        calls.append(path)
        return str(path), 'archive', 'checksum'
    paths = [research.target_path(research.owner(key), target) for key in (KEY, OTHER)]
    for path in paths:
        token = research.current.set(path)
        try:
            assert calibration(1) == calibration(1)
        finally:
            research.current.reset(token)
    assert len(calls) == 2 and calls[0] != calls[1]
    client.delete(f'/api/research/{target}/cache', headers=headers())
    assert calls[1].is_file()
    token = research.current.set(paths[0])
    try:
        assert calibration(1)[0] == str(calls[0])
        assert calls[0].is_file() and len(calls) == 3
    finally:
        research.current.reset(token)
