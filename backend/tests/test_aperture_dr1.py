"""Mixed-release aperture integration, contributor provenance and images-only builds."""
import json
import threading
from contextlib import nullcontext
from types import SimpleNamespace
import numpy as np
import pytest
from astropy.io import fits
from fastapi.testclient import TestClient
from backend.app import aperture_spectrum as sp, detector_comparison as dc
from test_dr1 import product
from test_detector_comparison import samples, image, calibrated_cutout

def test_dr1_solid_angle_dispatch(monkeypatch):
    calls = []
    monkeypatch.setattr(sp, 'solid_angle_file', lambda d,r,v: (calls.append((d,r,v)) or ('fixture','url','hash')))
    monkeypatch.setattr(sp.fits, 'open', lambda p: nullcontext({'IMAGE': SimpleNamespace(data=np.ones((2,2))*38.,header={'BUNIT':'arcsec2'})}))
    omega, meta = sp.solid_angles(fits.Header(), 1, 'dr1', np.array([0]), np.array([0]))
    assert omega[0] > 0 and calls == [(1,'dr1','cal-sapm-v3-2026-191')]

def build_pair(tmp_path, spectrum_only=False, include_spectra=True, calls=None):
    rows = [product('dr1',obs='first'), product('qr3',obs='second',mjd=61000.1)]
    def query(*a,collection,**kw):
        if calls is not None:
            calls.append(('query', kw['radius_deg']))
        return [im for im in rows if im.survey == collection]
    def download(url):
        if calls is not None:
            calls.append(('download', url))
        return 'fixture'
    def loader(path,im,recipe,wcs,n):
        empty = spectrum_only and im.obs_id == 'first'
        s = samples(index=() if empty else (0,),intensity=() if empty else (1,),
                    variance=() if empty else (4,),wavelength=() if empty else (1,),mjd=im.mjd_mid)
        s.metadata['coadd_status'] = 'no_valid_samples' if empty else 'ready'
        s.spectrum = {k:np.ones((n,n),dtype='<f4') for k in sp.UNITS}
        return s
    return dc.build(dc.Recipe(ra=10,dec=-5,size_arcsec=24.8,include_spectra=include_spectra),tmp_path,lambda *a:None,
                    threading.Event(),query=query,downloader=download,loader=loader)

def test_joint_epoch_retains_each_spectrum_release(tmp_path):
    result = build_pair(tmp_path)
    epoch = result['epochs'][0]
    assert len(epoch['spectra']) == 2, result['inputs']
    assert [s['data_release'] for s in epoch['spectra']] == ['dr1','qr3']
    assert all(r['status']=='accepted' for r in result['inputs'])
    assert epoch['data_release'] == 'dr1+qr3'
    with fits.open(tmp_path/'spectrum-0.fits',checksum=True) as hdul:
        provenance = json.loads(hdul['PROVENANCE'].data.tobytes())
        assert [s['data_release'] for s in provenance['samples']] == ['dr1','qr3']
        assert list(hdul['EXPOSURES'].data['RELEASE']) == ['dr1', 'qr3']
        assert provenance['releases']['data_dois'] == {'dr1': '10.26131/IRSA678', 'qr3': '10.26131/IRSA662'}
        inputs = {r['input_index']: r for r in provenance['inputs']}
        assert all(inputs[s['input_index']]['obs_id'] == s['obs_id'] for s in provenance['samples'])
        assert all(hdu.verify_checksum() == 1 and hdu.verify_datasum() == 1 for hdu in hdul)

def test_spectrum_only_release_does_not_claim_coadd_contribution(tmp_path):
    result = build_pair(tmp_path,spectrum_only=True)
    epoch = result['epochs'][0]
    assert epoch['tiles'][0]['n_accepted'] == 1
    assert epoch['tiles'][0]['data_releases'] == ['qr3']
    assert epoch['data_releases'] == ['qr3']
    assert len(epoch['spectra']) == 2
    assert {s['data_release'] for s in epoch['spectra']} == {'dr1','qr3'}
    with fits.open(tmp_path/'spectrum-0.fits') as hdul:
        assert hdul[0].header['RELEASE'] == 'dr1+qr3'


def test_images_only_skips_spectral_budget_and_preserves_all_coadd_arrays(tmp_path, monkeypatch):
    enabled = build_pair(tmp_path / 'enabled')
    monkeypatch.setattr(sp, 'MAX_SPECTRAL_CELLS', 0)
    calls = []
    disabled = build_pair(tmp_path / 'disabled', include_spectra=False, calls=calls)
    assert [t.get('maps') for t in enabled['epochs'][0]['tiles']] == [t.get('maps') for t in disabled['epochs'][0]['tiles']]
    assert disabled['epochs'][0]['spectra'] == []
    assert disabled['epochs'][0]['spectra_enabled'] is False
    assert not (tmp_path / 'disabled/spectrum-0.fits').exists()
    assert all(value == pytest.approx(24.8 / 7200) for kind, value in calls if kind == 'query')
    from urllib.parse import urlsplit, parse_qs
    sizes = [parse_qs(urlsplit(value).query)['size'][0] for kind, value in calls if kind == 'download']
    assert sizes and all(float(s.removesuffix('arcsec')) == pytest.approx(24.8 * 1.45) for s in sizes)


def test_images_only_loader_never_requests_area_calibration_or_extracts(calibrated_cutout, monkeypatch):
    path, cal, _, wcs = calibrated_cutout
    def forbidden(*a, **kw):
        pytest.fail('Images-only mode must skip all aperture work')
    monkeypatch.setattr(sp, 'solid_angles', forbidden)
    monkeypatch.setattr(sp, 'aperture_maps', forbidden)
    result = dc.load_samples(path, image(), dc.Recipe(ra=10,dec=-5,include_spectra=False),wcs,4,
                             lambda d:(cal,'synthetic','fixture'))
    assert result.spectrum is None and result.metadata['spectrum_status'] == 'disabled'
    assert result.index.size > 0


def test_area_failure_preserves_coadd_and_explains_unavailable_spectrum(calibrated_cutout, monkeypatch):
    path, cal, _, wcs = calibrated_cutout
    def unavailable(*a, **kw):
        raise ValueError('Solid-angle calibration unavailable')
    monkeypatch.setattr(sp, 'solid_angles', unavailable)
    result = dc.load_samples(path, image(), dc.Recipe(ra=10,dec=-5),wcs,4,
                             lambda d:(cal,'synthetic','fixture'))
    assert result.index.size > 0 and result.spectrum is None
    assert result.metadata['spectrum_status'] == 'unavailable'
    assert 'Solid-angle' in result.metadata['spectrum_reason']


def test_spectrum_download_is_immutable_and_legacy_images_remain_readable(tmp_path, monkeypatch):
    from backend.app import spherex_client as sx, main
    monkeypatch.setattr(sx, 'CACHE_DIR', str(tmp_path))
    job = 'a' * 32
    path = tmp_path / 'managed' / 'outputs' / 'public' / 'public' / 'comparisons' / job
    result = build_pair(path)
    (path / 'result.json').write_text(json.dumps(result))
    client = TestClient(main.app)
    response = client.get(f'/api/detector-comparison/{job}/spectra/0.fits')
    assert response.status_code == 200 and response.content == (path / 'spectrum-0.fits').read_bytes()
    old = 'b' * 32
    oldpath = path.parent / old
    oldpath.mkdir()
    (oldpath / 'result.json').write_text('{"legacy": true}')
    assert client.get(f'/api/detector-comparison/{old}/result').json() == {'legacy': True}
    assert client.get(f'/api/detector-comparison/{old}/spectra/0.fits').status_code == 404
