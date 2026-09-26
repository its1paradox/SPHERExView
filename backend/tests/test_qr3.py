"""Release contracts and numerical regressions; all fixtures are synthetic."""
from dataclasses import replace
import json
import threading
import warnings

import numpy as np
import pytest
from astropy.io import fits
from astropy.table import Table
from fastapi.testclient import TestClient

from backend.app import coadd as cx, detector_comparison as dc, releases
from backend.app import main, spectra_client as sp, spherex_client as sx
from test_detector_comparison import calibrated_cutout, image, samples


def qr3(im=None):
    im = im or image()
    return replace(im, access_url=im.access_url.replace('/qr2/', '/qr3/'), survey='spherex_qr3', extra={})


def modern_flags():
    h = fits.Header()
    names = dict(zip(cx.FATAL_FLAG_NAMES, cx.FATAL_FLAG_FALLBACK_BITS))
    names.update(MP_SOURCE=21, MP_FULLSAMPLE=12, MP_GHOST=22, MP_CROSSTALK=29)
    for name, bit in names.items():
        if name in ('MP_PHANTOM', 'MP_REFERENCE'):
            continue
        h[f'MSKN{bit:04d}'] = name[3:]
        h[f'MSKM{bit:04d}'] = 1 << bit
    return h


def upgrade_cutout(path):
    with fits.open(path, mode='update') as hdul:
        hdul[0].header['VERSION'] = '7.0.5'
        for key in list(hdul['FLAGS'].header):
            if key.startswith('MP_'):
                del hdul['FLAGS'].header[key]
        hdul['FLAGS'].header.update(modern_flags())
        hdul['FLAGS'].data[0, 1] = 1 << 22
        hdul['FLAGS'].data[0, 2] = 1 << 12
        hdul.append(fits.BinTableHDU.from_columns([
            fits.Column(name='PSF', format='9E', dim='(3,3)', array=np.ones((1, 3, 3)))
        ], name='EPSF'))


@pytest.mark.parametrize('survey', ['wide', 'deep'])
def test_discovery_queries_both_releases_and_preserves_newest_processing(survey):
    old, new = image(), qr3(image(version=27))
    calls = []
    def query(*a, collection, **kw):
        calls.append(collection)
        return [new, new] if 'qr3' in collection else [old]
    rows = sx.query_releases(10, -5, survey=survey, query=query)
    assert calls == releases.collections(survey, 'all')
    assert len(rows) == 1 and rows[0].access_url == new.access_url
    assert rows[0].extra['superseded_products'] == [old.access_url]
    assert rows[0].to_dict()['data_release'] == 'qr3'


def test_partial_archive_failure_and_overflow_are_not_empty_coverage(monkeypatch):
    def query(*a, collection, **kw):
        if 'qr3' in collection:
            raise ConnectionError('Synthetic unavailable release')
        return [image()]
    with pytest.raises(ConnectionError):
        sx.query_releases(10, -5, query=query)
    def overflow(**kw):
        warnings.warn('QUERY_STATUS=OVERFLOW')
        return Table()
    monkeypatch.setattr(sx.Irsa, 'query_sia', overflow)
    with pytest.raises(ValueError, match='truncated'):
        sx.query_sia2(10, -5)


def test_unexpected_archive_collection_fails(monkeypatch):
    table = Table(rows=[('image/fits', qr3().access_url, 'spherex_qr2', 'SPHEREx-D1')],
                  names=['access_format', 'access_url', 'obs_collection', 'energy_bandpassname'])
    monkeypatch.setattr(sx.Irsa, 'query_sia', lambda **kw: table)
    with pytest.raises(ValueError, match='unexpected collection'):
        sx.query_sia2(10, -5, collection='spherex_qr3')


def test_preview_samples_the_whole_timeline():
    rows = [image(mjd=61000 + i, obs=str(i)) for i in range(100)] + [qr3(image(mjd=61200, obs='new'))]
    selected = sx.preview_order(rows, 3)
    assert [im.obs_id for im in selected[:3]] == ['0', '50', 'new']
    assert len({im.obs_id for im in selected}) == len(rows)
    assert sx.preview_order(rows, 1)[0].obs_id == 'new'


def test_release_identity_and_calibration_pins(calibrated_cutout):
    path, _, _, _ = calibrated_cutout
    with pytest.raises(ValueError, match='disagrees'):
        releases.product_release(qr3().access_url, 'spherex_qr2')
    with fits.open(path) as hdul:
        with pytest.raises(ValueError, match='disagrees'):
            releases.fits_provenance(hdul, 'qr3')
        hdul[0].header['VERSION'] = '7.0.5'
        with pytest.raises(ValueError, match='EPSF'):
            releases.fits_provenance(hdul, 'qr3')
    assert releases.spectral_calibration_version(fits.Header(), 'qr3') == 'cal-swcs-v5-2026-191'
    assert releases.spectral_calibration_version(fits.Header(), 'qr2') == 'cal-wcs-v4-2025-254'


def test_modern_masks_are_read_from_the_file_and_do_not_mask_sources():
    h = modern_flags()
    mask = cx._fatal_mask_value(h)
    assert mask & (1 << 22) and mask & (1 << 29)
    assert not mask & (1 << 21) and not mask & (1 << 12)
    assert cx.source_flag_bit(h) == 21
    h['MSKM0022'] = 1 << 23
    with pytest.raises(ValueError, match='Inconsistent'):
        cx.flag_bits(h)
    with pytest.raises(ValueError, match='Missing'):
        cx.flag_bits(fits.Header())


@pytest.mark.parametrize('legacy_first', [False, True])
def test_conflicting_mask_dictionaries_fail_in_either_order(legacy_first):
    h = modern_flags()
    h.insert(0 if legacy_first else len(h), ('HIERARCH MP_SOURCE', 20))
    with pytest.raises(ValueError, match='Conflicting'):
        cx.flag_bits(h)


def test_qr3_native_signed_flux_variance_and_full_resolution_wavelength(calibrated_cutout):
    path, cal, lam, wcs = calibrated_cutout
    upgrade_cutout(path)
    recipe = dc.Recipe(ra=10, dec=-5, size_arcsec=24.8, release='qr3')
    s = dc.load_samples(path, qr3(), recipe, wcs, 4, lambda d: (cal, 'synthetic', 'fixture'))
    assert s.metadata['data_release'] == 'qr3'
    assert s.metadata['psf_extension'] == 'EPSF'
    assert s.metadata['gain_correction_applied'] is False
    assert len(s.index) == 14 and 1 not in s.index and 5 not in s.index
    assert 0 in s.index and 2 in s.index
    j = np.where(s.index == 0)[0][0]
    assert s.intensity[j] == -1 and s.variance[j] == 4
    assert s.wavelength[j] == pytest.approx(lam[5, 3], abs=1e-7)
    aligned = cx.load_aligned_exposure(path, 10, -5, 24.8, expected_release='qr3')
    assert aligned.extras['data_release'] == 'qr3'
    assert aligned.mjd == 61000 and aligned.sci[0, 0] == -1
    assert not aligned.valid[0, 1] and aligned.valid[0, 2]


@pytest.mark.parametrize('grouping', ['fixed', 'visit'])
def test_overlapping_time_bins_never_mix_releases(grouping):
    rows = [image(obs='old'), qr3(image(mjd=61000.1, obs='new'))]
    groups = dc.group_epochs(rows, dc.Recipe(ra=1, dec=2, grouping=grouping))
    assert len(groups) == 2
    assert [len(g[0]) for g in groups] == [1, 1]


def exposure(rel, mjd, value):
    return cx.AlignedExposure(np.full((4, 4), value), np.ones((4, 4)), np.ones((4, 4), bool),
                              mjd, 1., .03, 1, extras={'data_release': rel})


def test_coadd_refuses_cross_release_inputs():
    with pytest.raises(ValueError, match='release'):
        cx.combine([exposure('qr2', 61000, 1), exposure('qr3', 61000, 100)])


@pytest.mark.parametrize('endpoint', ['coadd', 'epoch-coadds'])
def test_coadd_api_keeps_release_groups_and_provenance(monkeypatch, endpoint):
    monkeypatch.setattr(main, '_query_sorted_images', lambda *a: [image(), qr3()])
    monkeypatch.setattr(main, '_fetch_aligned', lambda *a, **kw: ([exposure('qr2', 61000, 1), exposure('qr3', 61000.1, 100)], 0))
    response = TestClient(main.app).get(f'/api/{endpoint}', params={
        'ra': 10, 'dec': -5, 'radius_arcsec': 12.4, 'band': 'SPHEREx-D1', 'release': 'all'})
    assert response.status_code == 200, response.text
    body = response.json()
    frames = body['coadds'] if endpoint == 'coadd' else body['frames']
    assert len(frames) == 2
    assert {f['metadata']['data_release'] for f in frames} == {'qr2', 'qr3'}
    assert all(len(f['metadata']['input_calibrations']) == 1 for f in frames)


def test_comparison_fits_exports_release_without_gain_conversion(tmp_path):
    rows = [image(obs='old'), qr3(image(mjd=61000.1, obs='new'))]
    def query(*a, collection, **kw):
        return [im for im in rows if f'/{collection.removeprefix("spherex_")}/' in im.access_url]
    result = dc.build(dc.Recipe(ra=10, dec=-5, size_arcsec=24.8), tmp_path, lambda *a: None,
                      threading.Event(), query=query, downloader=lambda u: 'synthetic',
                      loader=lambda p, im, *a: samples(mjd=im.mjd_mid))
    assert [e['data_release'] for e in result['epochs']] == ['qr2', 'qr3']
    for i, rel in enumerate(['qr2', 'qr3']):
        with fits.open(tmp_path / f'epoch-{i}.fits', checksum=True) as hdul:
            assert hdul[0].header['RELEASE'] == rel
            assert hdul[0].header['GAINCONV'] is False
            manifest = json.loads(hdul['MANIFEST'].data.tobytes())
            assert {row['data_release'] for row in manifest['inputs']} == {rel}


VOTABLE = b'''<VOTABLE version="1.3" xmlns="http://www.ivoa.net/xml/VOTable/v1.3"><RESOURCE><TABLE>
<FIELD name="wavelength" datatype="double" arraysize="*" unit="um"/>
<FIELD name="flux" datatype="double" arraysize="*" unit="mJy"/>
<FIELD name="flux_err" datatype="double" arraysize="*" unit="mJy"/>
<FIELD name="flags" datatype="long" arraysize="*"/>
<FIELD name="data_collection" datatype="char" arraysize="12x*"/>
<DATA><TABLEDATA><TR><TD>2 1 3</TD><TD>5 -2 7</TD><TD>0.2 0.3 0.4</TD><TD>4294967296 2097152 0</TD><TD>spherex_qr3 spherex_qr2 unknown     </TD></TR></TABLEDATA></DATA>
</TABLE></RESOURCE></VOTABLE>'''


def test_spectrum_flatten_and_release_filtered_exports(monkeypatch):
    table = sp.filter_release(sp.flatten_votable(VOTABLE))
    assert table['release_counts'] == {'qr2': 1, 'qr3': 1, 'unknown': 1}
    monkeypatch.setattr(sp, 'fetch_result_votable', lambda _: VOTABLE)
    client = TestClient(main.app)
    url = '/api/spectra/download/synthetic-job'
    result = client.get(url, params={'fmt': 'json', 'release': 'qr3'}).json()
    assert result['count'] == 1
    assert result['rows'][0]['flags'] == 2 ** 32
    assert result['rows'][0]['flux'] == 5 and result['rows'][0]['flux_err'] == .2
    csv = client.get(url, params={'fmt': 'csv', 'release': 'qr2'})
    assert 'spherex_qr2' in csv.text and 'spherex_qr3' not in csv.text
    assert '-2.0' in csv.text
    assert client.get(url, params={'fmt': 'votable', 'release': 'qr3'}).status_code == 400
    assert client.get(url, params={'fmt': 'votable'}).content == VOTABLE


@pytest.mark.parametrize('endpoint', ['cutouts', 'epoch-stack', 'coadd', 'epoch-coadds'])
def test_invalid_release_rejected_before_network(endpoint):
    assert TestClient(main.app).get(f'/api/{endpoint}', params={'ra': 1, 'dec': 2, 'release': 'qr1'}).status_code == 422
