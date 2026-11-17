"""Cache budgets change storage, never scientific inventory or ownership."""
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from backend.app import research as r, main, comparison_api as comparison

@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv('SPHEREX_CACHE_DIR', str(tmp_path))
    monkeypatch.setenv('SPHEREX_MIN_FREE_GB', '0')
    monkeypatch.setenv('SPHEREX_PUBLIC_LIMITS', '0')
    return tmp_path

def test_no_server_history_or_per_user_downloads():
    client=TestClient(main.app)
    assert client.get('/api/research').status_code==404
    assert client.post('/api/research',json={'ra':1,'dec':2}).status_code in (404,405)
    paths=[]
    for i in range(100):
        token=r.current.set(r.target_path(r.owner(f'{i:064x}'), 'a'*32))
        try: paths.append(r.cache_dir('unused'))
        finally: r.current.reset(token)
    assert len(set(paths))==1
    assert not list(r.root().rglob('record.json'))

def test_source_lru_stays_bounded_across_1007_observations():
    folder=r.cache_dir('unused')
    os.environ['SPHEREX_SOURCE_CACHE_BYTES']='128'
    try:
        values=[]
        for i in range(1007):
            with r.source_scope():
                path=folder/f'{i}.fits'; r.pin(path)
                with r.lock:
                    r.reserve_source(32); path.write_bytes(bytes([i%256])*32)
                values.append(path.read_bytes()[0])
            assert sum(p.stat().st_size for p in folder.iterdir())<=128
        assert values==[i%256 for i in range(1007)]
        assert not r._pinned
    finally: os.environ.pop('SPHEREX_SOURCE_CACHE_BYTES')

def test_pins_survive_other_requests_and_capacity_is_explicit(monkeypatch):
    monkeypatch.setenv('SPHEREX_SOURCE_CACHE_BYTES','64')
    path=r.cache_dir('unused')/'held.fits';path.write_bytes(b'x'*64)
    with r.source_scope():
        r.pin(path)
        with ThreadPoolExecutor(1) as pool:
            with pytest.raises(r.CacheCapacityError): pool.submit(r.reserve_source,1).result()
        assert path.read_bytes()==b'x'*64
    r.reserve_source(1)
    assert not path.exists()

def test_source_pins_propagate_into_prefetch_and_release():
    path=r.cache_dir('unused')/'frame.fits';path.write_bytes(b'x')
    with r.source_scope():
        with ThreadPoolExecutor(2) as pool: list(r.map_context(pool,lambda _:r.pin(path),range(2)))
        assert r._pinned[str(path)]==1
        r.unpin(path)
    assert not r._pinned

def test_100_users_share_fixed_result_budget_and_active_handoff_is_safe(monkeypatch):
    monkeypatch.setenv('SPHEREX_RESULT_CACHE_BYTES','96')
    for i in range(100):
        path=r.target_path(r.owner(f'{i:064x}'),'a'*32)
        path.mkdir(parents=True)
        (path/'result.json').write_bytes(b'x'*32)
        r.maintain_outputs(path)
        assert sum(s.st_size for _,s in r.files(r.root()/'outputs'))<=96
    r.hold(path)
    try:
        monkeypatch.setenv('SPHEREX_RESULT_TTL_SECONDS','-1')
        r.maintain_outputs(); assert path.exists()
    finally: r.release(path)
    r.maintain_outputs(); assert not path.exists()

def test_resource_refusal_is_not_recorded_as_skipped_observation(monkeypatch):
    monkeypatch.setattr(main.sx,'query_releases',lambda *a,**k:[type('Image',(),{'mjd_mid':1,'access_url':'archive','obs_id':'one'})()])
    def fail(*a):raise r.CacheCapacityError()
    monkeypatch.setattr(main.sx,'download_cutout',fail)
    response=TestClient(main.app).get('/api/epoch-stack?ra=1&dec=2')
    assert response.status_code==507
    assert 'No subset' in response.json()['detail']

def test_private_temporary_pixels_and_no_response_cache():
    key='a'*64; target='b'*32
    path=r.target_path(r.owner(key),target)/'assets';path.mkdir(parents=True)
    name='timeline-'+'c'*64+'.json';(path/name).write_text('{"data_b64":"AAAAAA=="}')
    client=TestClient(main.app)
    url=f'/api/research/{target}/files/{name}'
    assert client.get(url).status_code==401
    assert client.get(url,headers={'X-Research-Key':'d'*64}).status_code==410
    assert client.get(url,headers={'X-Research-Key':key,'X-Research-Target':target}).json()['data_b64']=='AAAAAA=='
    assert client.get(f'/api/research/{target}/files/record.json',headers={'X-Research-Key':key}).status_code==404

def test_calibration_rehydrates_after_eviction_and_is_shared():
    calls=[]
    @r.file_cache(maxsize=2)
    def calibration(detector):
        path=r.cache_dir('unused')/f'cal-{detector}.fits';path.write_bytes(b'calibration');calls.append(path)
        return str(path),'url','digest'
    for i in range(2):
        token=r.current.set(r.target_path(r.owner(f'{i:064x}'),'a'*32))
        try:
            with r.source_scope(): calibration(1)
        finally:r.current.reset(token)
    assert len(calls)==1
    calls[0].unlink()
    with r.source_scope(): assert Path(calibration(1)[0]).exists()
    assert len(calls)==2

def test_comparison_expiry_is_explicit_and_failed_capacity_never_publishes(monkeypatch):
    monkeypatch.setenv('SPHEREX_RESULT_CACHE_BYTES','10')
    def build(recipe,path,progress,cancel):
        path.mkdir(parents=True,exist_ok=True)
        (path/'epoch-0.fits').write_bytes(b'x'*20)
        return {'recipe':recipe.model_dump(),'epochs':[]}
    monkeypatch.setattr(comparison.dc,'build',build)
    client=TestClient(main.app)
    job=client.post('/api/detector-comparison',json={'ra':1,'dec':2}).json()['job_id']
    for _ in range(100):
        state=client.get(f'/api/detector-comparison/{job}').json()
        if state['status']=='error':break
        time.sleep(.01)
    assert state['status']=='error' and 'No subset' in state['message']
    assert client.get(f'/api/detector-comparison/{job}/result').status_code==410

def test_startup_migrates_only_known_runtime_cache_and_cleans_abandoned_scratch(isolated, monkeypatch):
    base=isolated
    (base/('a'*32+'.fits')).write_bytes(b'fits')
    (base/'notes.txt').write_text('keep')
    scratch=base/'timeline-work/tmp-old';scratch.mkdir(parents=True);(scratch/'data.bin').write_bytes(b'old')
    static=base/'static';(static/'cutouts').mkdir(parents=True)
    pixel=static/'cutouts'/('timeline-'+'b'*64+'.json');pixel.write_text('{}')
    monkeypatch.setenv('SPHEREX_STATIC_DIR',str(static))
    r.maintenance(startup=True)
    assert (r.root()/'sources'/('a'*32+'.fits')).read_bytes()==b'fits'
    assert (base/'notes.txt').read_text()=='keep'
    assert not scratch.exists() and not pixel.exists()
    assert (r.root()/'outputs/public/public/assets'/pixel.name).exists()
