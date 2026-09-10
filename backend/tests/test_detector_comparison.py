"""Numerical and integration tests using explicitly synthetic tagged inputs."""
import base64
import json
import threading

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.app import detector_comparison as dc
from backend.app.main import app
from backend.app.spherex_client import SpherexImage


def image(detector=1, mjd=61000, obs="synthetic", version=20):
    return SpherexImage(f"{dc.IRSA_ROOT}/level2/2026W01_1A/l2b-v{version}-2026-001/{detector}/{obs}D{detector}.fits", f"SPHEREx-D{detector}", "wide", obs, mjd - .001, mjd + .001, 100, None, None, None, None)


def samples(index=(0,), intensity=(1,), variance=(4,), wavelength=(1,), weight=1, mjd=61000):
    arrays = [np.asarray(x) for x in (index, intensity, variance, wavelength)]
    return dc.Samples(*arrays, np.full(len(index), .03), weight, mjd, {"synthetic": True, "mjd_utc": mjd})


def test_linear_estimator_signed_values_and_distinct_exposures():
    a = dc.Accumulator(2)
    # Two native pixels from ONE exposure enter output pixel zero.
    a.add(samples((0, 0, 1), (2, 6, -4), (1, 9, 4), (1, 2, 1), weight=2))
    a.add(samples((0,), (10,), (4,), (3,), weight=1, mjd=61001))
    m = a.finish(1)
    assert m['intensity'][0, 0] == pytest.approx(26 / 5, rel=1e-6)
    assert m['variance'][0, 0] == pytest.approx(44 / 25, rel=1e-6)
    assert m['wavelength'][0, 0] == pytest.approx(9 / 5, rel=1e-6)
    assert m['hits'][0, 0] == 3 and m['coverage'][0, 0] == 2
    assert m['neff'][0, 0] == pytest.approx(25 / 9, rel=1e-6)
    assert m['intensity'][0, 1] == -4
    assert m['mjd'][0, 0] == pytest.approx(61000.2, abs=1e-10)
    assert np.isnan(m['intensity'][1, 1]) and m['coverage'][1, 1] == 0
    floor = a.finish(2)
    assert np.isnan(floor['intensity'][0, 1]) and floor['coverage'][0, 1] == 1


def test_statistical_variance_matches_independent_monte_carlo():
    rng = np.random.default_rng(2040)
    draws = rng.normal(0, np.sqrt([1, 9, 4]), (30000, 3))
    measured = ((draws * [2, 2, 1]).sum(axis=1) / 5).var(ddof=1)
    a = dc.Accumulator(1)
    a.add(samples((0, 0), (0, 0), (1, 9), (1, 1), weight=2))
    a.add(samples((0,), (0,), (4,), (1,)))
    predicted = a.finish(1)['variance'][0, 0]
    assert measured == pytest.approx(predicted, rel=.025)


def test_inventory_deduplicates_reprocessing_but_keeps_distinct_detectors():
    r = dc.Recipe(ra=1, dec=2)
    rows, excluded = dc.inventory([image(version=19), image(version=20), image(version=20), image(detector=2)], r)
    assert len(rows) == 2 and len(excluded) == 2
    assert all('v20-' in i.access_url for i in rows)
    assert {dc.detector_of(i) for i in rows} == {1, 2}


def test_epochs_share_boundaries_before_sampling_and_missing_detectors():
    r = dc.Recipe(ra=1, dec=2, grouping='fixed', epoch_origin_mjd=61000, bin_months=1)
    boundary = 61000 + 30.4375
    rows = [image(1, 61000, 'a'), image(6, boundary - .01, 'b'), image(2, boundary, 'c')]
    groups = dc.group_epochs(rows, r)
    assert [[im.obs_id for im in g[0]] for g in groups] == [['a', 'b'], ['c']]
    assert groups[0][3] == groups[1][2] == boundary
    assert sum(len(g[0]) for g in groups) == len(rows)


@pytest.mark.parametrize('kwargs', [{'ra': float('nan')}, {'dec': 91}, {'wavelength_ranges': {7: [1, 2]}}, {'wavelength_ranges': {1: [2, 1]}}, {'mjd_start': 3, 'mjd_end': 2}])
def test_invalid_science_recipes_are_rejected(kwargs):
    with pytest.raises(ValidationError):
        dc.Recipe(**({'ra': 1, 'dec': 2} | kwargs))


def wave_header(n, key='', xoff=0, yoff=0):
    h = fits.Header()
    for k, v in {'WCSAXES': 2, 'CTYPE1': 'WAVE-TAB', 'CTYPE2': 'WAVE-TAB', 'CUNIT1': 'um', 'CUNIT2': 'um', 'CRPIX1': 1, 'CRPIX2': 1, 'CRVAL1': 1 + xoff, 'CRVAL2': 1 + yoff, 'CDELT1': 1, 'CDELT2': 1, 'PS1_0': 'WCS-WAVE', 'PS2_0': 'WCS-WAVE', 'PS1_1': 'VALUES', 'PS2_1': 'VALUES', 'PS1_2': 'X', 'PS2_2': 'Y', 'PV1_3': 1, 'PV2_3': 2}.items():
        h[k + key] = v
    return h


def wave_table(n):
    vals = np.zeros((1, 2, 2, 2), dtype=np.float32)
    for y in range(2):
        for x in range(2): vals[0, y, x] = [1 + .01 * x * (n - 1) + .02 * y * (n - 1), .03]
    return fits.BinTableHDU.from_columns([
        fits.Column(name='X', format='2J', array=[[1, n]]),
        fits.Column(name='Y', format='2J', array=[[1, n]]),
        fits.Column(name='VALUES', format='8E', dim='(2,2,2)', array=vals),
    ], name='WCS-WAVE')


@pytest.fixture
def calibrated_cutout(tmp_path):
    n = 12
    yy, xx = np.indices((n, n))
    # True CWAVE is intentionally different from the approximate table.
    lam = (1 + .01 * xx + .02 * yy + .0004 * np.sin(xx)).astype(np.float32)
    ch = wave_header(n); ch['DETECTOR'] = 1; ch['DETCOORD'] = 'sky'; ch['BUNIT'] = 'um'
    cal_path = tmp_path / 'synthetic-calibration.fits'
    fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(lam, ch, name='CWAVE'), fits.ImageHDU(np.full((n, n), .03), fits.Header({'BUNIT': 'um'}), name='CBAND'), wave_table(n)]).writeto(cal_path)
    _, wcs = dc.cx.output_grid(10, -5, 24.8, 6.2)
    h = wcs.to_header(); h.update(wave_header(n, 'W', 3, 5))
    h.update({'DETECTOR': 1, 'OBSID': 'synthetic', 'BUNIT': 'MJy / sr', 'DETCOORD': 'sky', 'FINAST': 0, 'MJD-AVG': 61000, 'TIMESYS': 'UTC'})
    for k, v in {'WCSAXES': 2, 'CTYPE1': 'LINEAR', 'CTYPE2': 'LINEAR', 'CRPIX1': -2, 'CRPIX2': -4, 'CRVAL1': 0, 'CRVAL2': 0, 'CDELT1': 1, 'CDELT2': 1, 'CUNIT1': 'pixel', 'CUNIT2': 'pixel'}.items(): h[k + 'A'] = v
    flags = np.zeros((4, 4), dtype=np.int32)
    flags[0, 0] = 1 << 21  # SOURCE: must survive.
    flags[1, 1] = 1 << 15  # NONLINEAR: must not survive.
    fh = fits.Header({'HIERARCH ' + name: bit for name, bit in zip(dc.cx.FATAL_FLAG_NAMES, dc.cx.FATAL_FLAG_FALLBACK_BITS)})
    fh['HIERARCH MP_SOURCE'] = 21
    data = np.arange(16, dtype=np.float32).reshape(4, 4)
    path = tmp_path / 'synthetic-cutout.fits'
    fits.HDUList([fits.PrimaryHDU(header=fits.Header({'VERSION': '6.4+psffix1'})), fits.ImageHDU(data, h, name='IMAGE'), fits.ImageHDU(np.full((4, 4), 4.), fits.Header({'BUNIT': 'MJy2 / sr2'}), name='VARIANCE'), fits.ImageHDU(flags, fh, name='FLAGS'), fits.ImageHDU(np.full((4, 4), 1.), fits.Header({'BUNIT': 'MJy / sr'}), name='ZODI'), wave_table(n)]).writeto(path)
    return path, cal_path, lam, wcs


def test_calibration_offset_source_mask_and_negative_intensity(calibrated_cutout):
    path, cal, lam, wcs = calibrated_cutout
    r = dc.Recipe(ra=10, dec=-5, size_arcsec=24.8)
    s = dc.load_samples(path, image(), r, wcs, 4, lambda d: (cal, 'synthetic', 'fixture'))
    assert len(s.index) == 15
    assert 0 in s.index and 5 not in s.index
    j = np.where(s.index == 0)[0][0]
    assert s.intensity[j] == -1
    assert s.wavelength[j] == pytest.approx(lam[5, 3], abs=1e-7)
    assert abs(s.wavelength[j] - (1 + .01 * 3 + .02 * 5)) > 1e-5


def test_wavelength_selection_uses_input_calibration(calibrated_cutout):
    path, cal, lam, wcs = calibrated_cutout
    lower = float(lam[5, 3]) - 1e-7
    upper = float(lam[5, 3]) + 1e-7
    r = dc.Recipe(ra=10, dec=-5, size_arcsec=24.8, wavelength_ranges={1: (lower, upper)})
    s = dc.load_samples(path, image(), r, wcs, 4, lambda d: (cal, 'synthetic', 'fixture'))
    assert s.index.tolist() == [0]


@pytest.mark.parametrize('fault,code', [('mask', 'flags_unsupported'), ('detector', 'identity_mismatch'), ('unit', 'units_invalid'), ('offset', 'detector_coordinates_missing')])
def test_input_metadata_failures_are_explicit(calibrated_cutout, fault, code):
    path, cal, _, wcs = calibrated_cutout
    with fits.open(path, mode='update') as hdul:
        if fault == 'mask': del hdul['FLAGS'].header['MP_NONFUNC']
        if fault == 'detector': hdul['IMAGE'].header['DETECTOR'] = 6
        if fault == 'unit': hdul['IMAGE'].header['BUNIT'] = 'adu'
        if fault == 'offset': del hdul['IMAGE'].header['CRPIX1A']
    with pytest.raises(dc.InputError) as error:
        dc.load_samples(path, image(), dc.Recipe(ra=10, dec=-5, size_arcsec=24.8), wcs, 4, lambda d: (cal, 'synthetic', 'fixture'))
    assert error.value.code == code


def test_build_missing_slots_no_epoch_fallback_and_fits_round_trip(tmp_path):
    rows = [image(1, 61000, 'first'), image(6, 61000, 'broken'), image(2, 61200, 'second')]
    def loader(path, im, recipe, wcs, n):
        if im.obs_id == 'broken': raise dc.InputError('calibration_unavailable', 'Synthetic failure')
        return samples((0, 1), (0, -2), (4, 4), (1, 2), mjd=im.mjd_mid)
    r = dc.Recipe(ra=1, dec=2, size_arcsec=24.8)
    result = dc.build(r, tmp_path, lambda *a: None, threading.Event(), query=lambda *a, **k: rows, downloader=lambda u: 'synthetic', loader=loader)
    assert len(result['epochs']) == 2
    for e in result['epochs']: assert [t['detector'] for t in e['tiles']] == [1, 2, 3, 4, 5, 6]
    assert result['epochs'][0]['tiles'][5]['failures'] == {'calibration_unavailable': 1}
    assert result['epochs'][1]['tiles'][0]['status'] == 'missing'
    tile = result['epochs'][0]['tiles'][0]
    with fits.open(tmp_path / 'epoch-0.fits', checksum=True) as hdul:
        for name, encoded in tile['maps'].items():
            displayed = np.frombuffer(base64.b64decode(encoded['data_b64']), dtype=encoded['dtype']).reshape(4, 4)
            np.testing.assert_array_equal(displayed, np.flipud(hdul[f'D1_{name}'].data))
        assert hdul['D1_MJD'].data.dtype.itemsize == 8
        assert hdul['D1_INTENSITY'].header['BUNIT'] == 'MJy sr-1'
        manifest = json.loads(hdul['MANIFEST'].data.tobytes())
        assert manifest['inputs'][1]['status'] == 'calibration_unavailable'
    assert json.loads((tmp_path / 'manifest.json').read_text())['n_unique_inventory'] == 3


def test_cancelled_build_stops_before_download(tmp_path):
    cancel = threading.Event(); cancel.set()
    def download(url): pytest.fail('Cancelled build attempted a download')
    with pytest.raises(dc.Cancelled):
        dc.build(dc.Recipe(ra=1, dec=2), tmp_path, lambda *a: None, cancel, query=lambda *a, **k: [image()], downloader=download)


def test_api_rejects_invalid_recipes_and_export_paths():
    client = TestClient(app)
    assert client.post('/api/detector-comparison', json={'ra': 360, 'dec': 0}).status_code == 422
    assert client.get('/api/detector-comparison/not-a-job').status_code == 404
    assert client.get('/api/detector-comparison/' + 'a' * 32 + '/epochs/-1.fits').status_code == 409


def test_completed_job_exports_survive_registry_eviction(tmp_path, monkeypatch):
    from backend.app import comparison_api as api
    import time
    monkeypatch.setattr(api.sx, 'CACHE_DIR', str(tmp_path))
    def small_build(recipe, path, progress, cancelled):
        path.mkdir(parents=True)
        (path / 'manifest.json').write_text('{"synthetic":true}')
        fits.PrimaryHDU().writeto(path / 'epoch-0.fits')
        return {'synthetic': True, 'epochs': []}
    monkeypatch.setattr(dc, 'build', small_build)
    client = TestClient(app)
    response = client.post('/api/detector-comparison', json={'ra': 1, 'dec': 2})
    assert response.status_code == 202
    job = response.json()['job_id']
    for _ in range(100):
        state = client.get(f'/api/detector-comparison/{job}').json()
        if state['status'] == 'complete': break
        time.sleep(.01)
    assert state['status'] == 'complete'
    with api._lock: api._jobs.pop(job)
    assert client.get(f'/api/detector-comparison/{job}').json()['status'] == 'complete'
    assert client.get(f'/api/detector-comparison/{job}/result').json()['synthetic']
    assert client.get(f'/api/detector-comparison/{job}/manifest').json()['synthetic']
    assert client.get(f'/api/detector-comparison/{job}/epochs/0.fits').status_code == 200
    assert client.get(f'/api/detector-comparison/{job}/epochs/1.fits').status_code == 404


def test_calibration_table_mismatch_fails_without_fallback(calibrated_cutout):
    path, cal, _, wcs = calibrated_cutout
    with fits.open(path, mode='update') as hdul:
        hdul['WCS-WAVE'].data['VALUES'][0, :, :, 0] += .01
    with pytest.raises(dc.InputError) as error:
        dc.load_samples(path, image(), dc.Recipe(ra=10, dec=-5, size_arcsec=24.8), wcs, 4, lambda d: (cal, 'synthetic', 'fixture'))
    assert error.value.code == 'calibration_mismatch'
