"""DR1 integration contracts and scientific invariants (synthetic fixtures)."""
from dataclasses import replace
import json
import threading

import numpy as np
import pytest
from astropy.io import fits
from fastapi.testclient import TestClient

from backend.app import coadd as cx, detector_comparison as dc, main, releases
from backend.app import spectra_client as sp, spherex_client as sx
from test_detector_comparison import calibrated_cutout, image, samples
from test_epoch_release_grouping import epoch_api, observation
from test_qr3 import exposure, upgrade_cutout


def product(release, **kwargs):
    im = image(**kwargs)
    return replace(im, access_url=im.access_url.replace('/qr2/', f'/{release}/'),
                   survey=f'spherex_{release}', extra={})


@pytest.mark.parametrize('survey', ['wide', 'deep'])
def test_default_discovery_queries_current_releases_and_deduplicates(survey):
    suffix = '_deep' if survey == 'deep' else ''
    calls = []
    def query(*args, collection, **kwargs):
        calls.append(collection)
        if collection == f'spherex_dr1{suffix}':
            return [product('dr1', obs='early', version=26), product('dr1', obs='early', version=27)]
        if collection == f'spherex_qr3{suffix}':
            return [product('qr3', obs='later', mjd=61200, version=27)]
        pytest.fail('A retired or unknown collection was queried')
    rows = sx.query_releases(10, -5, survey=survey, query=query)
    assert calls == [f'spherex_dr1{suffix}', f'spherex_qr3{suffix}']
    assert [r.to_dict()['data_release'] for r in rows] == ['dr1', 'qr3']
    assert len(rows[0].extra['superseded_products']) == 1
    assert 'v26-' in rows[0].extra['superseded_products'][0]


def test_dr1_inventory_supersedes_qr2_even_when_legacy_file_version_is_larger():
    old, new = product('qr2', version=99), product('dr1', version=27)
    rows, excluded = dc.inventory([old, new], dc.Recipe(ra=10, dec=-5))
    assert [r.access_url for r in rows] == [new.access_url]
    assert len(excluded) == 1 and excluded[0]['url'] == old.access_url


@pytest.mark.parametrize('endpoint', ['cutouts', 'epoch-stack', 'coadd', 'epoch-coadds'])
def test_retired_image_search_returns_gone_before_network(monkeypatch, endpoint):
    monkeypatch.setattr(sx, 'query_releases', lambda *a, **k: pytest.fail('Retired query reached the archive'))
    response = TestClient(main.app).get(f'/api/{endpoint}', params={'ra': 10, 'dec': -5, 'release': 'qr2'})
    assert response.status_code == 410
    assert 'DR1' in response.json()['detail'] and 'QR3' in response.json()['detail']


def test_retired_comparison_is_rejected_before_job_submission(monkeypatch):
    from backend.app import comparison_api
    monkeypatch.setattr(comparison_api._pool, 'submit', lambda *a: pytest.fail('Retired job was submitted'))
    response = TestClient(main.app).post('/api/detector-comparison', json={'ra': 10, 'dec': -5, 'release': 'qr2'})
    assert response.status_code == 410


@pytest.mark.parametrize('release', ['dr1', 'qr3'])
def test_r7_identity_comes_from_archive_not_version(calibrated_cutout, release):
    path, _, _, _ = calibrated_cutout
    upgrade_cutout(path)
    im = product(release)
    assert releases.product_release(im.access_url, im.survey) == release
    with fits.open(path) as hdul:
        provenance = releases.fits_provenance(hdul, release)
        assert provenance['data_release'] == release
        assert provenance['calibration_family'] == 'r7'
        assert provenance['data_doi'] == ('10.26131/IRSA678' if release == 'dr1' else '10.26131/IRSA662')
        assert provenance['gain_correction_applied'] is False
        with pytest.raises(ValueError, match='provenance'):
            releases.fits_provenance(hdul)
        with pytest.raises(ValueError, match='disagrees'):
            releases.fits_provenance(hdul, 'qr2')
    assert releases.spectral_calibration_version(fits.Header(), release) == 'cal-swcs-v5-2026-191'


def test_dr1_does_not_bypass_release_or_product_validation():
    with pytest.raises(ValueError, match='disagrees'):
        releases.product_release(product('dr1').access_url, 'spherex_qr3')
    with pytest.raises(ValueError):
        releases.product_release('https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/hips5_cube/Npix1_cube.fits')


def test_published_r7_range_is_validated_without_guessing_future_calibrations(calibrated_cutout):
    path, _, _, _ = calibrated_cutout
    upgrade_cutout(path)
    with fits.open(path) as hdul:
        hdul[0].header['VERSION'] = '7.2.0'
        assert releases.fits_provenance(hdul, 'dr1')['data_release'] == 'dr1'
        hdul[0].header['VERSION'] = '7.3.0'
        with pytest.raises(ValueError, match='Unsupported'):
            releases.fits_provenance(hdul, 'dr1')


def test_astrometry_retry_products_keep_their_processing_version():
    original = product('dr1', version=27)
    retry = replace(original, access_url=original.access_url.replace('l2b-v', 'l2b_retry-v'))
    rows = sx.query_releases(10, -5, release='dr1', query=lambda *a, **k: [retry])
    assert rows[0] is retry
    assert releases.processing_rank(retry.access_url, 'dr1') == releases.processing_rank(original.access_url, 'dr1')
    # A retry label alone cannot establish which of two conflicting products
    # passed astrometry. Do not silently pick one without that evidence.
    with pytest.raises(ValueError, match='Conflicting'):
        sx.query_releases(10, -5, release='dr1', query=lambda *a, **k: [original, retry])


def test_dr1_science_loader_preserves_native_values_and_wavelengths(calibrated_cutout):
    path, cal, wavelength, wcs = calibrated_cutout
    upgrade_cutout(path)
    s = dc.load_samples(path, product('dr1'), dc.Recipe(ra=10, dec=-5, release='dr1'),
                        wcs, 4, lambda d: (cal, 'synthetic', 'fixture'))
    j = np.where(s.index == 0)[0][0]
    assert s.intensity[j] == -1 and s.variance[j] == 4
    assert s.wavelength[j] == pytest.approx(wavelength[5, 3], abs=1e-7)
    assert s.metadata['data_release'] == 'dr1'
    assert s.metadata['gain_correction_applied'] is False


def test_compatible_coadd_preserves_signed_intensity_and_statistical_variance():
    a, b = exposure('dr1', 61000, -1), exposure('qr3', 61000.01, 3)
    a.var[:] = b.var[:] = 4
    result, variance, coverage, _, _ = cx.combine([a, b], sigma=None)
    np.testing.assert_allclose(result, 1)
    np.testing.assert_allclose(variance, 2)
    np.testing.assert_array_equal(coverage, 2)
    np.testing.assert_allclose(a.sci, -1)
    for incompatible in ('qr2', 'unknown'):
        with pytest.raises(ValueError, match='release'):
            cx.combine([a, exposure(incompatible, 61000, 100)])
    with pytest.raises(ValueError, match='release'):
        cx.combine([exposure('unknown', 61000, 1), exposure('unrecognized', 61000, 2)])


@pytest.mark.parametrize('minimum', [1, 2])
@pytest.mark.parametrize('tied_times', [False, True])
def test_dr1_qr3_interleaving_forms_one_complete_visit(epoch_api, minimum, tied_times):
    observations = [observation('dr1' if i % 2 == 0 else 'qr3', (i // 2 if tied_times else i) * .01,
                               4 if i % 4 < 2 else 6, i) for i in range(8)]
    result = epoch_api(observations, min_channel_exposures=minimum)
    assert result['count'] == 1
    frame = result['frames'][0]
    m = frame['metadata']
    assert m['channels'] == 'color'
    assert m['data_release'] == 'dr1+qr3' and m['data_releases'] == ['dr1', 'qr3']
    assert m['calibration_family'] == 'r7'
    assert m['n_exposures'] == 8
    assert m['short_channel']['n_exposures'] == m['long_channel']['n_exposures'] == 4
    assert {r['obs_id'] for r in m['input_calibrations']} == {im.obs_id for im, _ in observations}
    assert result == epoch_api(list(reversed(observations)), min_channel_exposures=minimum)


def test_static_coadd_combines_current_releases_and_lists_each_input(monkeypatch):
    rows = [product('dr1', obs='a'), product('qr3', obs='b')]
    a, b = exposure('dr1', 61000, -1), exposure('qr3', 61000.1, 3)
    a.var[:] = b.var[:] = 4
    monkeypatch.setattr(main, '_query_sorted_images', lambda *a: rows)
    monkeypatch.setattr(main, '_fetch_aligned', lambda *_args: ([a, b], 0))
    response = TestClient(main.app).get('/api/coadd', params={'ra': 10, 'dec': -5, 'radius_arcsec': 12.4, 'sigma': 0})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['count'] == 1
    m = result['coadds'][0]['metadata']
    assert m['data_releases'] == ['dr1', 'qr3'] and m['n_exposures_used'] == 2
    assert m['calibration_family'] == 'r7'
    assert {e['data_release'] for e in m['input_calibrations']} == {'dr1', 'qr3'}


def test_modern_deep_windows_assign_boundary_inputs_once(epoch_api):
    observations = [observation('dr1' if j % 2 == 0 else 'qr3', j * 5.072916666666667, d, 2*j + d)
                    for j in range(13) for d in (4, 6)]
    result = epoch_api(observations, bin_months=1, min_channel_exposures=2)
    assert result['count'] == 2
    inputs = [r['obs_id'] for f in result['frames'] for r in f['metadata']['input_calibrations']]
    assert len(inputs) == len(set(inputs)) == len(observations)
    assert set(inputs) == {im.obs_id for im, _ in observations}
    assert all(f['metadata']['channels'] == 'color' for f in result['frames'])


def test_dropped_channel_is_not_reported_as_a_contributing_release(epoch_api):
    observations = [observation('dr1', 0, 4, 0), observation('qr3', .01, 6, 1), observation('qr3', .02, 6, 2)]
    result = epoch_api(observations, min_channel_exposures=2)
    m = result['frames'][0]['metadata']
    assert m['channels'] == 'long-only'
    assert m['data_release'] == 'qr3' and m['n_exposures'] == 2
    assert {r['data_release'] for r in m['input_calibrations']} == {'qr3'}


def test_dr1_only_api_selects_release_before_loading(epoch_api):
    observations = [observation(rel, i * .01, 4, i) for i, rel in enumerate(['dr1', 'qr3'])]
    result = epoch_api(observations, release='dr1')
    assert result['n_exposures_input'] == 1
    assert result['frames'][0]['metadata']['data_release'] == 'dr1'


@pytest.mark.parametrize('grouping', ['visit', 'fixed'])
def test_comparison_groups_compatible_releases_but_preserves_real_time_boundaries(grouping):
    rows = [product('dr1', obs='a'), product('qr3', mjd=61000.1, obs='b'),
            product('dr1', mjd=61061, obs='c'), product('qr2', obs='legacy')]
    recipe = dc.Recipe(ra=10, dec=-5, grouping=grouping, epoch_origin_mjd=61000, bin_months=1)
    memberships = {frozenset(im.obs_id for im in group[0]) for group in dc.group_epochs(rows, recipe)}
    assert memberships == {frozenset(['a', 'b']), frozenset(['c']), frozenset(['legacy'])}


def test_comparison_fits_records_both_releases_and_native_units(tmp_path):
    rows = [product('dr1', obs='a'), product('qr3', obs='b', mjd=61000.1)]
    def query(*args, collection, **kwargs):
        return [im for im in rows if im.survey == collection]
    result = dc.build(dc.Recipe(ra=10, dec=-5, size_arcsec=24.8), tmp_path, lambda *a: None,
                      threading.Event(), query=query, downloader=lambda u: 'synthetic',
                      loader=lambda p, im, *a: samples(intensity=(-2,), mjd=im.mjd_mid))
    assert len(result['epochs']) == 1
    with fits.open(tmp_path / 'epoch-0.fits', checksum=True) as hdul:
        assert hdul[0].header['RELEASE'] == 'dr1+qr3'
        assert hdul[0].header['CALFAM'] == 'r7'
        assert hdul[0].header['GAINCONV'] is False
        assert hdul['D1_INTENSITY'].data[0, 0] == -2
        assert hdul['D1_VARIANCE'].data[0, 0] == 2
        assert hdul['D1_INTENSITY'].header['BUNIT'] == 'MJy sr-1'
        manifest = json.loads(hdul['MANIFEST'].data.tobytes())
        assert manifest['epoch']['data_releases'] == ['dr1', 'qr3']
        assert {r['data_release'] for r in manifest['inputs']} == {'dr1', 'qr3'}


def test_spectrum_dr1_filter_keeps_flux_error_flags_and_legacy_rows(monkeypatch):
    table = {'columns': ['data_collection', 'flux', 'flux_err', 'flags'], 'units': {'flux': 'uJy'},
             'rows': [{'data_collection': release, 'flux': -2., 'flux_err': .3, 'flags': 2**33}
                      for release in ['DR1', 'spherex_dr1_deep', 'qr3', 'qr2', None]], 'count': 5}
    monkeypatch.setattr(sp, 'fetch_result_votable', lambda job: b'synthetic')
    monkeypatch.setattr(sp, 'flatten_votable', lambda body: table)
    client = TestClient(main.app)
    result = client.get('/api/spectra/download/synthetic-job', params={'fmt':'json', 'release':'dr1'})
    assert result.status_code == 200
    result = result.json()
    assert result['count'] == 2
    assert result['release_counts'] == {'dr1':2, 'qr3':1, 'qr2':1, 'unknown':1}
    assert result['rows'] == table['rows'][:2]
    assert sp.filter_release(table)['count'] == 5
    assert sp.filter_release(table, 'qr2')['rows'] == table['rows'][3:4]
    csv = client.get('/api/spectra/download/synthetic-job', params={'fmt':'csv', 'release':'dr1'})
    assert csv.status_code == 200 and 'spherex_dr1_deep' in csv.text and 'qr3' not in csv.text
