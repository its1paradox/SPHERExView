"""Opt-in, read-only validation against public IRSA products (network required).

Run from the repository root with the backend environment. The first run
downloads four cutouts and four full-resolution wavelength calibrations.
An optional completed spectrum job is read, never submitted by this script.
Prints a JSON record; failures raise and exit nonzero.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from astropy.io import fits
from backend.app import coadd as cx, detector_comparison as dc, releases
from backend.app import spectra_client as sp, spherex_client as sx


def run(local_data=None, spectrum_job=None):
    ra, dec = 232.651627115, -10.7387224253
    inventory = sx.query_releases(ra, dec, radius_deg=.0003, band='SPHEREx-D4')
    counts = {r: sum(releases.product_release(im.access_url) == r for im in inventory) for r in releases.RELEASES}
    assert all(counts.values()), counts
    inputs = []
    # Samples span the wavelength range and both focal-plane orientations.
    for rel, d, x, y, mjd, period, version, obs in [
        ('qr2', 4, ra, dec, 61085.992582, '2026W07_2A', 'l2b-v24-2026-089', '2026W07_2A_0465_2'),
        ('qr3', 1, 232.663579354, -10.7213238583, 61241.005450564, '2026W30_1B', 'l2b-v27-2026-222', '2026W30_1B_0001_1'),
        ('qr3', 4, ra, dec, 61241.005450576, '2026W30_1B', 'l2b-v27-2026-222', '2026W30_1B_0001_1'),
        ('qr3', 6, 240.323997297, -12.5763204121, 61241.005450564, '2026W30_1B', 'l2b-v27-2026-222', '2026W30_1B_0001_1'),
    ]:
        url = f'https://irsa.ipac.caltech.edu/ibe/data/spherex/{rel}/level2/{period}/{version}/{d}/level2_{obs}D{d}_spx_{version}.fits'
        cutout_url = sx.get_cutout_url(url, x, y, 180)
        path = Path(local_data) / f'{rel}-D{d}-cutout.fits' if local_data else sx.download_cutout(cutout_url)
        im = sx.SpherexImage(url, f'SPHEREx-D{d}', f'spherex_{rel}', obs, mjd, mjd, None, None, None, x, y)
        recipe = dc.Recipe(ra=x, dec=y, size_arcsec=124, release=rel)
        n, wcs = cx.output_grid(x, y, 124)
        science = dc.load_samples(path, im, recipe, wcs, n)
        aligned = cx.load_aligned_exposure(path, x, y, 124, expected_release=rel)
        assert len(science.index) > 0 and aligned.valid.any()
        assert np.isfinite(science.intensity).all() and (science.variance > 0).all()
        assert science.metadata['gain_correction_applied'] is False
        assert science.metadata['data_release'] == aligned.extras['data_release'] == rel
        with fits.open(path) as hdul:
            psf = hdul[science.metadata['psf_extension']]
            assert psf.data is not None
            shape = list(hdul['IMAGE'].data.shape)
        inputs.append({
            'url': url, 'cutout_url': cutout_url, 'ra': x, 'dec': y, 'detector': d,
            'image_shape': shape, 'aligned_valid_pixels': int(aligned.valid.sum()),
            'checks': ['release/pipeline agreement', 'FITS units and masks', 'full-resolution CWAVE/CBAND',
                       'active-pixel coordinate mapping', 'spectral WCS agreement', 'UTC midpoint', 'finite positive variance',
                       'PSF extension present', 'native calibration retained'],
            **science.metadata,
        })
    result = {
        'checked_utc': datetime.now(timezone.utc).isoformat(),
        'kind': 'live public IRSA integration check; not an independent absolute-photometry validation',
        'inventory': {'ra': ra, 'dec': dec, 'radius_deg': .0003, 'detector': 4, 'release_counts': counts},
        'inputs': inputs,
    }
    if spectrum_job:
        content = sp.fetch_result_votable(spectrum_job)
        table = sp.filter_release(sp.flatten_votable(content))
        selected = sp.filter_release(table, 'qr3')
        assert selected['count'] > 0
        assert any(row['flags'] >= 2 ** 32 for row in selected['rows'])
        assert any(row['flux'] < 0 for row in selected['rows'])
        assert all(row['flux_err'] > 0 for row in selected['rows'])
        result['spectrum'] = {'job_id': spectrum_job, 'votable_sha256': hashlib.sha256(content).hexdigest(),
                              'count': table['count'], 'release_counts': table['release_counts'], 'units': table['units'],
                              'max_flags': max(row['flags'] for row in table['rows']),
                              'checks': ['completed IRSA job', 'packed release labels', 'negative flux retained',
                                         'positive flux uncertainty', 'flags above bit 31 retained', 'QR3 result filter']}
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--local-data', help='Optional directory of previously downloaded sample cutouts')
    parser.add_argument('--spectrum-job', help='Optional completed, public IRSA spectrum job to inspect')
    args = parser.parse_args()
    print(json.dumps(run(args.local_data, args.spectrum_job), indent=2, allow_nan=False))
