"""Full-input numerical equivalence and bounded transport regressions."""
from dataclasses import replace
from collections import Counter
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend.app import batching, coadd, main
from test_epoch_release_grouping import observation, epoch_api, assert_partition


def samples(n):
    rng = np.random.default_rng(23)
    rows = []
    for i in range(n):
        sci = rng.normal(size=(9, 9)) + np.arange(81).reshape(9, 9) / 10
        var = rng.uniform(.3, 3, size=(9, 9))
        valid = rng.uniform(size=(9, 9)) > .12
        valid[0, 0] = False
        sci[2, 2] += 1000 if i % 13 == 0 else 0
        rows.append(coadd.AlignedExposure(sci, var, valid, 61000 + i / 100,
                    2 + i / n, .03, 4, obs_id=str(i), extras={'data_release': 'dr1'}))
    return rows


@pytest.mark.parametrize('sigma', [None, 3.0])
@pytest.mark.parametrize('n', [7, 1007])
def test_disk_batched_estimator_matches_full_array(n, sigma, monkeypatch, tmp_path):
    original = samples(n)
    expected = coadd.combine(original, sigma=sigma, maxiters=3)
    monkeypatch.setenv('SPHEREX_CACHE_DIR', str(tmp_path))
    # Force multiple spatial tiles even for the tiny fixture.
    monkeypatch.setenv('SPHEREX_COADD_TILE_BYTES', str(n * 96 * 37))
    @batching.workspace
    def calculate():
        rows = [batching.spill(replace(e), i) for i, e in enumerate(original)]
        assert all(isinstance(e.sci, batching.DiskArray) for e in rows)
        return batching.combine(rows, sigma=sigma, maxiters=3)
    actual = calculate()
    for a, b in zip(actual[:2], expected[:2]):
        np.testing.assert_allclose(a, b, rtol=2e-14, atol=2e-14, equal_nan=True)
    np.testing.assert_array_equal(actual[2], expected[2])
    assert actual[3:] == expected[3:]
    assert list((tmp_path / 'timeline-work').iterdir()) == []


def test_all_1007_observations_contribute_even_with_legacy_limit(epoch_api):
    rows = [observation('dr1' if i % 2 else 'qr3', i * .001, 4 if i % 2 else 6, i)
            for i in range(1007)]
    result = epoch_api(rows, limit=1)
    assert result['n_exposures_input'] == 1007
    assert Counter(entry['obs_id'] for frame in result['frames'] for entry in frame['metadata']['input_calibrations']) == Counter(im.obs_id for im, _ in rows)
    assert all(frame['metadata']['data_release'] == 'dr1+qr3' for frame in result['frames'])
    assert result['n_exposures_contributing'] == 1007
    assert result['complete'] is True


def test_discovery_does_not_sample_when_legacy_limit_is_supplied(monkeypatch):
    images = [observation('dr1', i, 4, i)[0] for i in range(1007)]
    monkeypatch.setattr(main.sx, 'query_releases', lambda *a, **k: images)
    assert main._query_sorted_images(10, -5, 10, 'wide', None, 1) == images
    main._validate_coadd_workload(100, 1_000_000)


def test_raw_stack_processes_every_candidate_and_returns_lazy_pixels(monkeypatch, tmp_path):
    monkeypatch.setenv('SPHEREX_CACHE_DIR', str(tmp_path))
    images = [observation('dr1', i * .001, 4, i)[0] for i in range(1007)]
    monkeypatch.setattr(main.sx, 'query_releases', lambda *a, **k: images)
    monkeypatch.setattr(main.sx, 'download_cutout', lambda url: 'fixture')
    class Fits:
        def __enter__(self): return self
        def __exit__(self, *args): pass
    monkeypatch.setattr(main.fits, 'open', lambda path: Fits())
    monkeypatch.setattr(main.releases, 'fits_provenance', lambda *a: {'data_release': 'dr1'})
    monkeypatch.setattr(main.imaging, 'fits_to_array', lambda *a, **k:
        (np.arange(16).reshape(4, 4), 4, 4, {}, {}))
    monkeypatch.setattr(main, 'STATIC_DIR', str(tmp_path))
    (tmp_path / 'cutouts').mkdir()
    monkeypatch.setenv('SPHEREX_FETCH_WORKERS', '2')
    submitted = []
    real_pool = main.ThreadPoolExecutor
    class Pool(real_pool):
        def map(self, fn, rows):
            submitted.append(len(rows))
            return super().map(fn, rows)
    monkeypatch.setattr(main, 'ThreadPoolExecutor', Pool)
    result = main._build_stack(10, -5, 12, 'wide', None, 1)
    assert result['count'] == result['n_attempted'] == 1007
    assert max(submitted) == 2
    assert result['preview_subset'] is False
    assert result['complete'] is True
    assert all('data_b64' not in frame and 'data_url' in frame for frame in result['cutouts'])
    # Equal payloads are stored once; repeat queries don't duplicate the cache.
    files = list(main.research.assets_dir(tmp_path).iterdir())
    assert len(files) == 1
    assert json.loads(files[0].read_text())['data_b64']


def test_workspace_cleans_up_after_failure(monkeypatch, tmp_path):
    monkeypatch.setenv('SPHEREX_CACHE_DIR', str(tmp_path))
    @batching.workspace
    def fail():
        batching.spill(samples(1)[0], 0)
        raise RuntimeError('interrupted calculation')
    with pytest.raises(RuntimeError):
        fail()
    assert list((tmp_path / 'timeline-work').iterdir()) == []


def test_disk_refusal_does_not_produce_a_partial_coadd(monkeypatch, tmp_path):
    monkeypatch.setenv('SPHEREX_CACHE_DIR', str(tmp_path))
    monkeypatch.setattr(batching.shutil, 'disk_usage', lambda p: type('Disk', (), {'free': 0})())
    @batching.workspace
    def fail():
        batching.spill(samples(1)[0], 0)
    with pytest.raises(Exception, match='No subset was substituted'):
        fail()
    assert list((tmp_path / 'timeline-work').iterdir()) == []
