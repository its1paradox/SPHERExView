"""Native-pixel science checks: units, sky removal, masks, variance and WCS."""
import base64
import json
import threading
from contextlib import nullcontext
from types import SimpleNamespace

import numpy as np
import pytest
from astropy.io import fits
from photutils.aperture import CircularAperture

from backend.app import aperture_spectrum as sp
from backend.app import detector_comparison as dc
from test_detector_comparison import image, samples, calibrated_cutout


def scene(n=1):
    _, native = dc.cx.output_grid(359.999, 72, 31 * 6.2, 6.2)
    _, out = dc.cx.output_grid(359.999, 72, n * 6.2, 6.2)
    out.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    shape = (31, 31)
    return dict(sci=np.full(shape, 7.), variance=np.full(shape, .04), wavelength=np.full(shape, 2.),
                bandwidth=np.full(shape, .03), valid=np.ones(shape, bool), sky_valid=np.ones(shape, bool),
                omega=np.full(shape, (6.2 / 206264.80624709636) ** 2), sky_wcs=native, wcs_out=out, n=n, radius=12.4)


def test_flux_units_signed_source_sky_and_nonuniform_solid_angles():
    a = scene()
    a['omega'] *= np.linspace(.95, 1.05, 31)[None, :]
    a['sci'][15, 15] += 100
    a['sky_valid'][15, 15] = False  # SOURCE flag must not remove aperture source.
    a['sci'][15, 19] += 500; a['sky_valid'][15, 19] = False
    maps = sp.aperture_maps(**a)
    assert maps['sky_flux'][0, 0] == pytest.approx(100 * a['omega'][15, 15] * 1e12, rel=1e-6)
    assert maps['flux'][0, 0] == pytest.approx((100 + 7 * np.pi * 4) * a['omega'][15, 15] * 1e12, rel=1e-6)
    assert maps['wavelength'][0, 0] == 2
    a['sci'][15, 15] -= 200
    assert sp.aperture_maps(**a)['sky_flux'][0, 0] == pytest.approx(-maps['sky_flux'][0, 0], rel=1e-6)


def test_no_partial_aperture_extrapolation_or_bad_background():
    a = scene(); a['valid'][15, 15] = False
    assert np.isnan(sp.aperture_maps(**a)['flux']).all()
    a = scene(); a['sky_valid'][:] = False
    result = sp.aperture_maps(**a)
    assert np.isnan(result['sky_flux']).all()
    assert np.isfinite(result['flux']).all(), 'Aperture flux without sky subtraction remains explicitly available'
    a = scene(); a['sky_wcs'].wcs.crpix -= 14
    result = sp.aperture_maps(**a)
    assert np.isnan(result['flux']).all()
    assert result['aperture_coverage'][0, 0] < 1


def test_usable_pixels_preserve_masked_core_loss_and_signed_flux():
    a = scene()
    a['sci'][15, 15] = 10000  # Bright flagged core must never be reconstructed.
    a['valid'][15, 15] = False
    ap = CircularAperture((15, 15), 2).to_mask(method='exact').to_image((31, 31))
    coeff = 1e12 * ap * a['omega'] * a['valid']
    result = sp.aperture_maps(**a)
    assert result['usable_flux'][0, 0] == pytest.approx(np.sum(coeff * a['sci']), rel=1e-6)
    assert result['usable_variance'][0, 0] == pytest.approx(np.sum(coeff**2 * a['variance']), rel=1e-6)
    assert result['aperture_coverage'][0, 0] == pytest.approx(1 - 1/(4*np.pi), rel=1e-6)
    assert abs(result['usable_sky_flux'][0, 0]) < 1e-5, 'Uniform background cancels over the usable area only'
    assert np.isnan(result['flux'][0, 0]), 'Strict flux continues to reject incomplete apertures'
    assert result['wavelength'][0, 0] == 2
    a['sci'] *= -1
    assert sp.aperture_maps(**a)['usable_flux'][0, 0] == pytest.approx(-result['usable_flux'][0, 0], rel=1e-6)
    a['valid'][:] = False
    empty = sp.aperture_maps(**a)
    assert np.isnan(empty['usable_flux']).all()
    assert np.isnan(empty['wavelength']).all()


def test_complete_and_usable_estimators_agree_when_unmasked():
    result = sp.aperture_maps(**scene())
    for key in ('flux', 'variance', 'sky_flux', 'sky_variance'):
        np.testing.assert_array_equal(result[key], result['usable_' + key])


@pytest.mark.parametrize('resampling', ['bin', 'nearest'])
def test_aperture_survives_without_a_valid_coadd_center(calibrated_cutout, resampling, tmp_path, monkeypatch):
    path, cal, _, native = calibrated_cutout
    # The only output center is the flagged native (1, 1) pixel. Its
    # 12.4-arcsec aperture still contains usable neighbouring pixels.
    out = native.deepcopy()
    out.wcs.crpix -= 1
    recipe = dc.Recipe(ra=10, dec=-5, size_arcsec=24.8, resampling=resampling)
    s = dc.load_samples(path, image(), recipe, out, 1, lambda d: (cal, 'synthetic', 'fixture'))
    assert s.index.size == 0
    assert s.metadata['accepted_samples'] == 0
    assert s.metadata['field_sample_median_wavelength_um'] is None
    assert np.isfinite(s.spectrum['usable_flux'][0, 0])
    assert np.isnan(s.spectrum['flux'][0, 0])
    # Preserve the spectrum in the build, without counting an empty coadd
    # as an exposure used by the detector tile.
    monkeypatch.setattr(dc.cx, 'output_grid', lambda *a: (1, out))
    result = dc.build(recipe, tmp_path / resampling, lambda *a: None, threading.Event(),
        query=lambda *a, **k: [image()], downloader=lambda u: path, loader=lambda *a: s)
    epoch = result['epochs'][0]
    assert len(epoch['spectra']) == 1
    assert epoch['tiles'][0]['n_accepted'] == 0
    assert epoch['tiles'][0]['status'] == 'unavailable'
    assert result['inputs'][0]['coadd_status'] == 'no_valid_samples'


def test_empty_coadd_and_empty_aperture_still_rejected(calibrated_cutout):
    path, cal, _, out = calibrated_cutout
    with fits.open(path, mode='update') as hdul:
        hdul['FLAGS'].data[:] |= 1 << 15
    with pytest.raises(dc.InputError, match='No valid coadd pixels or usable aperture'):
        dc.load_samples(path, image(), dc.Recipe(ra=10, dec=-5, size_arcsec=24.8), out, 4,
            lambda d: (cal, 'synthetic', 'fixture'))


def test_fractional_weight_variance_against_monte_carlo_and_wavelength_range():
    a = scene()
    a['wavelength'] += np.indices((31, 31))[1] * .001
    result = sp.aperture_maps(**a)
    ap = CircularAperture((15, 15), 2).to_mask(method='exact').to_image((31, 31))
    sky = CircularAperture((15, 15), 5).to_mask(method='exact').to_image((31, 31)) - CircularAperture((15, 15), 3).to_mask(method='exact').to_image((31, 31))
    coeff = (ap - ap.sum() * sky / sky.sum()) * a['omega'] * 1e12
    rng = np.random.default_rng(821)
    noise = rng.normal(0, .2, (15000, 31 * 31)) @ coeff.ravel()
    assert noise.var() == pytest.approx(float(result['sky_variance'][0, 0]), rel=.04)
    assert result['wavelength'][0, 0] == pytest.approx(2.015, rel=1e-6)
    assert result['lambda_min'][0, 0] < result['wavelength'][0, 0] < result['lambda_max'][0, 0]


def test_sky_registration_at_ra_wrap_with_rotated_native_pixels():
    a = scene(3)
    a['sky_wcs'].wcs.cd = a['sky_wcs'].wcs.cd @ np.array([[0, -1], [1, 0]])
    a['sci'][15, 14] += 100
    result = sp.aperture_maps(**a)
    # Sky centers, not native indices, define the aperture; rotation leaves a
    # fully enclosed source's flux unchanged, even across RA=0 at high Dec.
    assert result['sky_flux'][1, 1] == pytest.approx(100 * a['omega'][15, 14] * 1e12, rel=1e-6)


def test_exposure_spectra_retained_separately_and_fits_api_orientation(tmp_path):
    rows = [image(1, 61000, 'first'), image(1, 61000.1, 'second')]
    def loader(path, im, recipe, wcs, n):
        s = samples(mjd=im.mjd_mid)
        s.spectrum = {key: np.arange(n*n, dtype='<f4').reshape(n, n) + j for j, key in enumerate(sp.UNITS)}
        return s
    r = dc.Recipe(ra=1, dec=2, size_arcsec=24.8)
    result = dc.build(r, tmp_path, lambda *a: None, threading.Event(), query=lambda *a, **k: rows, downloader=lambda u: 'synthetic', loader=loader)
    spectra = result['epochs'][0]['spectra']
    assert len(spectra) == 2 and spectra[0]['mjd'] != spectra[1]['mjd']
    with fits.open(tmp_path / 'spectrum-0.fits', checksum=True) as hdul:
        assert hdul['FLUX'].header['BUNIT'] == 'uJy'
        assert hdul[0].header['PSFCORR'] is False
        for i, s in enumerate(spectra):
            for key, m in s['maps'].items():
                decoded = np.frombuffer(base64.b64decode(m['data_b64']), dtype=m['dtype']).reshape(4, 4)
                np.testing.assert_array_equal(decoded, np.flipud(hdul[key.upper()].data[i]))
    manifest = json.loads((tmp_path / 'manifest.json').read_text())
    assert 'maps' not in manifest['epochs'][0]['spectra'][0]
    assert manifest['spectrum_method']['version'] == sp.METHOD['version']


def test_precompute_budget_rejects_instead_of_silently_thinning(tmp_path, monkeypatch):
    monkeypatch.setattr(sp, 'MAX_SPECTRAL_CELLS', 1)
    with pytest.raises(ValueError, match='Precomputed spectra'):
        dc.build(dc.Recipe(ra=1, dec=2), tmp_path, lambda *a: None, threading.Event(), query=lambda *a, **k: [image()], downloader=lambda u: pytest.fail('download before budget check'))


def test_500_arcsec_spectral_budget_accepts_full_workload_and_refuses_overflow(tmp_path, monkeypatch):
    recipe = dc.Recipe(ra=1, dec=2, size_arcsec=500)
    n, _ = dc.cx.output_grid(1, 2, 500, recipe.pixscale_arcsec)
    assert n == 81 and recipe.max_per_tile == 0
    maximum = sp.MAX_SPECTRAL_CELLS // (n * n)
    assert maximum >= 300
    rows = [image(obs=f'field500-{i}') for i in range(maximum + 1)]
    with pytest.raises(ValueError, match=f'{sp.MAX_SPECTRAL_CELLS:,}'):
        dc.build(recipe, tmp_path, lambda *a: None, threading.Event(), query=lambda *a, **k: rows, downloader=lambda u: pytest.fail('download before budget check'))
    def admitted(images, *args):
        assert len(images) == 300
        raise dc.Cancelled()  # Stop after admission; no external data in this test.
    monkeypatch.setattr(dc, 'prefetch_downloads', admitted)
    with pytest.raises(dc.Cancelled):
        dc.build(recipe, tmp_path, lambda *a: None, threading.Event(), query=lambda *a, **k: rows[:300])


@pytest.mark.parametrize('identity,good', [({'ARRAY': 1}, True), ({'ARRAY': 1, 'DETECTOR': '1'}, True),
    ({'ARRAY': 2}, False), ({'ARRAY': 1, 'DETECTOR': '2'}, False), ({}, False)])
def test_area_calibration_qr2_array_and_qr3_detector_contract(tmp_path, monkeypatch, identity, good):
    path = tmp_path / 'calibration'; path.write_bytes(b'synthetic-calibration')
    monkeypatch.setattr(sp.sx, 'download_cutout', lambda url: path)
    hdu = SimpleNamespace(data=SimpleNamespace(shape=(2040, 2040)), header={**identity, 'DETCOORD': 'sky', 'BUNIT': 'arcsec2'})
    monkeypatch.setattr(sp.fits, 'open', lambda path: nullcontext({'IMAGE': hdu}))
    sp.solid_angle_file.cache_clear()
    try:
        if good:
            assert sp.solid_angle_file(1, 'qr2', sp.AREA_VERSIONS['qr2'])[0] == path
        else:
            with pytest.raises(ValueError, match='incompatible'):
                sp.solid_angle_file(1, 'qr2', sp.AREA_VERSIONS['qr2'])
    finally:
        sp.solid_angle_file.cache_clear()
