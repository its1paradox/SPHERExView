"""Exercise the real epoch API with synthetic, already-calibrated exposures.

Only archive discovery/downloads are replaced. Grouping, channel thresholds,
coaddition and serialization use the production implementations.
"""
from collections import Counter

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend.app import coadd as cx, main, releases, spherex_client as sx


def observation(rel, day, detector, sequence):
    obs_id = f'{rel}-D{detector}-{sequence}'
    mjd = 61000 + day
    url = f'https://irsa.ipac.caltech.edu/ibe/data/spherex/{rel}/level2/2026W01_1A/l2b-v27-2026-222/{detector}/{obs_id}.fits'
    image = sx.SpherexImage(url, f'SPHEREx-D{detector}', f'spherex_{rel}', obs_id,
                            mjd - .001, mjd + .001, 100, None, None, 10, -5)
    # Different shapes/intensities make unintended cross-release mixing visible.
    pixels = np.arange(16, dtype=float).reshape(4, 4) - 8
    if rel == 'qr3':
        pixels = np.rot90(pixels) * 3
    aligned = cx.AlignedExposure(pixels + sequence, np.full((4, 4), sequence + 1.),
                                 np.ones((4, 4), bool), mjd, 3. if detector == 4 else 4.7,
                                 .03, detector, obs_id=obs_id,
                                 extras={'data_release': rel, 'gain_correction_applied': False})
    return image, aligned


@pytest.fixture
def epoch_api(monkeypatch):
    def call(observations, **params):
        images = [im for im, _ in observations]
        aligned = {im.obs_id: exp for im, exp in observations}
        def query(*args):
            release = args[-1]
            return [im for im in images if release == 'all' or releases.product_release(im.access_url) == release]
        monkeypatch.setattr(main, '_query_sorted_images', query)
        monkeypatch.setattr(main, '_fetch_aligned', lambda rows, *args: ([aligned[im.obs_id] for im in rows], 0))
        response = TestClient(main.app).get('/api/epoch-coadds', params={
            'ra': 10, 'dec': -5, 'radius_arcsec': 12.4, 'release': 'all',
            'short_detectors': '4', 'long_detectors': '6', **params})
        assert response.status_code == 200, response.text
        return response.json()
    return call


def member_ids(frame):
    return {entry['obs_id'] for entry in frame['metadata']['input_calibrations']}


def assert_partition(result, observations):
    assert result['n_exposures_input'] == len(observations)
    assert result['n_exposures_skipped'] == 0
    actual = Counter(entry['obs_id'] for f in result['frames'] for entry in f['metadata']['input_calibrations'])
    assert actual == Counter(im.obs_id for im, _ in observations), 'Every input must contribute exactly once'
    starts = [f['metadata']['mjd_min'] for f in result['frames']]
    assert starts == sorted(starts), 'Completed epochs must return in chronological order'
    for frame in result['frames']:
        metadata = frame['metadata']
        assert {e['data_release'] for e in metadata['input_calibrations']} == {metadata['data_release']}
        assert all(e['gain_correction_applied'] is False for e in metadata['input_calibrations'])


@pytest.mark.parametrize('minimum', [1, 2])
@pytest.mark.parametrize('tied_times', [False, True])
def test_interleaved_releases_produce_two_complete_color_coadds(epoch_api, minimum, tied_times):
    observations = [observation('qr2' if i % 2 == 0 else 'qr3',
                               (i // 2 if tied_times else i) * .01,
                               4 if i % 4 < 2 else 6, i) for i in range(8)]
    result = epoch_api(observations, min_channel_exposures=minimum)
    assert result['count'] == 2
    assert_partition(result, observations)
    for frame in result['frames']:
        m = frame['metadata']
        assert m['channels'] == 'color' and m['n_exposures'] == 4
        assert m['short_channel']['n_exposures'] == m['long_channel']['n_exposures'] == 2
        assert m['short_channel']['coverage_center'] == m['long_channel']['coverage_center'] == 2
        # Adding another release must not change a release's pixels, noise,
        # wavelength statistics, exposure membership or visit boundaries.
        alone = epoch_api(observations, release=m['data_release'], min_channel_exposures=minimum)['frames'][0]
        for key in ('data_b64', 'data2_b64'):
            assert frame[key] == alone[key]
        for key in ('mjd_min', 'mjd_max', 'mjd_mean', 'short_channel', 'long_channel', 'input_calibrations'):
            assert m[key] == alone['metadata'][key]
    assert result == epoch_api(list(reversed(observations)), min_channel_exposures=minimum)


def test_other_release_cannot_bridge_a_genuine_visit_gap(epoch_api):
    observations = [observation(rel, day, 4, i) for i, (rel, day) in enumerate([
        ('qr2', 0), ('qr3', 10), ('qr3', 20), ('qr3', 30), ('qr2', 40), ('qr3', 40)])]
    result = epoch_api(observations)
    assert result['count'] == 3
    assert_partition(result, observations)
    groups = [member_ids(f) for f in result['frames']]
    assert groups == [{observations[0][0].obs_id}, {observations[i][0].obs_id for i in (1, 2, 3, 5)}, {observations[4][0].obs_id}]


def test_exact_gap_threshold_and_missing_channel_remain_valid(epoch_api):
    observations = [observation('qr2', day, 4, i) for i, day in enumerate([0, 30, 60.001])]
    result = epoch_api(observations)
    assert result['count'] == 2
    assert_partition(result, observations)
    assert [f['metadata']['n_exposures'] for f in result['frames']] == [2, 1]
    assert all(f['metadata']['channels'] == 'short-only' and 'data2_b64' not in f for f in result['frames'])


def test_deep_field_windows_are_independent_and_keep_boundary_inputs_once(epoch_api):
    observations = []
    # Each release continuously covers two 30.4375-day windows. Include their
    # first point, internal edge and final point to test bin-edge membership.
    for rel, offset in [('qr3', 0), ('qr2', .001)]:
        for j in range(13):
            day = j * 5.072916666666667 + offset
            for detector in (4, 6):
                observations.append(observation(rel, day, detector, len(observations)))
    result = epoch_api(observations, bin_months=1, min_channel_exposures=2)
    assert result['count'] == 4
    assert_partition(result, observations)
    assert [f['metadata']['data_release'] for f in result['frames']] == ['qr3', 'qr2', 'qr3', 'qr2']
    for rel in ('qr2', 'qr3'):
        joint = [f for f in result['frames'] if f['metadata']['data_release'] == rel]
        alone = epoch_api(observations, release=rel, bin_months=1, min_channel_exposures=2)['frames']
        for combined, single in zip(joint, alone):
            assert combined['metadata']['grouping'] == 'window'
            assert combined['metadata']['channels'] == 'color'
            assert member_ids(combined) == member_ids(single)
            assert combined['data_b64'] == single['data_b64']
            assert combined['data2_b64'] == single['data2_b64']
