"""Opt-in validation using public DR1/QR3 archive data (network required).

Run from the repository root with the backend environment. Downloads twelve
small image cutouts and twelve full-resolution calibrations (~400 MB cached).
Exercises the production discovery, science loaders, coaddition and FITS export.
Optional completed spectrum jobs are read, never submitted. A failed assertion
exits nonzero; the JSON records tested files, hashes and the limits of this check.
"""
import argparse
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
import requests
from astropy.io import fits
from astropy.io.votable import parse_single_table
from backend.app import coadd as cx, detector_comparison as dc, releases
from backend.app import spectra_client as sp, spherex_client as sx


def api_smoke(spectrum_jobs):
    """Use real archive calls through the actual FastAPI routes (small previews)."""
    from fastapi.testclient import TestClient
    from backend.app.main import app
    client = TestClient(app)
    records = []
    params = {'ra': 304.693508808, 'dec': 42.4436872991, 'radius_arcsec': 62,
              'release': 'all', 'limit': 8}
    for endpoint in ('cutouts', 'epoch-stack', 'coadd', 'epoch-coadds'):
        response = client.get(f'/api/{endpoint}', params={**params, 'release': 'qr2'})
        assert response.status_code == 410, response.text
        response = client.get(f'/api/{endpoint}', params=params)
        assert response.status_code == 200, response.text
        data = response.json()
        frames = data.get('frames', data.get('coadds', data.get('cutouts', [])))
        assert frames and data['count'] == len(frames)
        present = {rel for frame in frames for rel in frame['metadata']['data_release'].split('+')}
        assert present == set(releases.CURRENT_RELEASES), present
        records.append({'endpoint': endpoint, 'parameters': params, 'status': 200,
                        'count': data['count'], 'data_releases': sorted(present),
                        'retired_qr2_status': 410})
        print(f'Validated /api/{endpoint}: {data["count"]} products', file=sys.stderr, flush=True)
    for job in spectrum_jobs:
        response = client.get(f'/api/spectra/table/{job}')
        assert response.status_code == 200, response.text
        table = response.json()
        for rel in releases.CURRENT_RELEASES:
            response = client.get(f'/api/spectra/download/{job}', params={'fmt': 'json', 'release': rel})
            assert response.status_code == 200
            assert response.json()['count'] == table['release_counts'][rel]
            response = client.get(f'/api/spectra/download/{job}', params={'fmt': 'csv', 'release': rel})
            assert response.status_code == 200
        response = client.get(f'/api/spectra/download/{job}', params={'fmt': 'votable'})
        assert response.status_code == 200 and response.content == sp.fetch_result_votable(job)
        records.append({'endpoint': 'spectra', 'job_id': job, 'count': table['count'],
                        'checks': ['result JSON', 'release-filtered JSON and CSV', 'original VOTable byte identity']})
    return records


def deep_discovery():
    """Bounded service probes complement the production wide-field inventory."""
    records = []
    for rel, times in [('dr1', '61000 61001'), ('qr3', '61300 61301')]:
        collection = releases.RELEASES[rel]['deep']
        params = {'COLLECTION': collection, 'POS': 'CIRCLE 270 66.56 0.00001',
                  'TIME': times, 'MAXREC': 1000}
        response = requests.get('https://irsa.ipac.caltech.edu/SIA', params=params, timeout=120)
        response.raise_for_status()
        root = ET.fromstring(response.content)
        status = [node.get('value') for node in root.iter()
                  if node.tag.rsplit('}', 1)[-1] == 'INFO' and node.get('name') == 'QUERY_STATUS']
        assert status and all(value == 'OK' for value in status), status
        table = parse_single_table(BytesIO(response.content)).to_table(use_names_over_ids=True)
        assert len(table) > 0 and set(table['obs_collection']) == {collection}
        assert all(releases.product_release(str(row['access_url']), collection) == rel for row in table)
        records.append({'collection': collection, 'parameters': params, 'url': response.url,
                        'count': len(table), 'query_status': status,
                        'votable_sha256': hashlib.sha256(response.content).hexdigest()})
    return records


def run(spectrum_jobs=(), output=None, check_api=False):
    ra, dec = 304.693508808, 42.4436872991
    inventory = sx.query_releases(ra, dec, radius_deg=.000278)
    identities = {(im.obs_id, dc.detector_of(im)) for im in inventory}
    assert len(identities) == len(inventory)
    counts = {r: sum(releases.product_release(im.access_url) == r for im in inventory)
              for r in releases.CURRENT_RELEASES}
    assert all(counts.values()), counts
    result = {
        'checked_utc': datetime.now(timezone.utc).isoformat(),
        'kind': 'Live public IRSA integration check; not independent absolute-photometry validation',
        'inventory': {'ra': ra, 'dec': dec, 'radius_deg': .000278,
                      'release_counts': counts, 'unique_observation_detectors': len(identities)},
        'inputs': [], 'spectra': [],
        'source_sha256': {name: dc.sha256_file(Path(dc.__file__).with_name(name)) for name in
                          ('releases.py', 'spherex_client.py', 'coadd.py', 'detector_comparison.py',
                           'spectra_client.py', 'main.py')},
        'deep_discovery': deep_discovery(),
    }
    def checkpoint():
        if output:
            Path(output).parent.mkdir(parents=True, exist_ok=True)
            Path(output).write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
    checkpoint()
    calibrations = {}
    for rel in releases.CURRENT_RELEASES:
        for detector in range(1, 7):
            im = next(im for im in inventory if dc.detector_of(im) == detector
                      and releases.product_release(im.access_url) == rel)
            # Detector-center cutouts test all focal-plane orientations without
            # relying on a cone-search target falling inside the rotated footprint.
            x, y = im.s_ra, im.s_dec
            recipe = dc.Recipe(ra=x, dec=y, size_arcsec=124, release=rel)
            n, wcs = cx.output_grid(x, y, 124)
            url = sx.get_cutout_url(im.access_url, x, y, 180)
            path = sx.download_cutout(url)
            science = dc.load_samples(path, im, recipe, wcs, n)
            aligned = cx.load_aligned_exposure(path, x, y, 124, expected_release=rel)
            assert len(science.index) > 0 and aligned.valid.any()
            assert np.isfinite(science.intensity).all() and (science.variance > 0).all()
            assert science.metadata['data_release'] == aligned.extras['data_release'] == rel
            assert science.metadata['calibration_family'] == 'r7'
            assert science.metadata['gain_correction_applied'] is False
            with fits.open(path) as hdul:
                # Independent value-preservation check: native MJy/sr values
                # minus the supplied ZODI model, with unchanged input variance.
                native = hdul['IMAGE'].data.astype(float) - hdul['ZODI'].data.astype(float)
                assert np.isin(science.intensity, native).all()
                assert np.isin(science.variance, hdul['VARIANCE'].data).all()
                epsf = hdul['EPSF'].data
                assert epsf['EPSF'].shape[1:] == (33, 33)
                assert len(epsf) == (451 if detector == 3 else 441)
                image_shape, psf_shape = list(hdul['IMAGE'].data.shape), list(epsf['EPSF'].shape)
            # Exercise the actual accumulator and round-trip scientific export.
            accumulator = dc.Accumulator(n)
            accumulator.add(science)
            maps = accumulator.finish(1)
            assert np.isfinite(maps['intensity']).any()
            epoch = {'index': 0, 'mjd_start': im.t_min, 'mjd_end': im.t_max,
                     **releases.release_summary([rel])}
            export = Path(sx.CACHE_DIR) / f'validation-{rel}-D{detector}.fits'
            dc.save_epoch(export, epoch, {detector: maps}, wcs, recipe, [science.metadata])
            with fits.open(export, checksum=True) as hdul:
                for hdu in hdul:
                    assert hdu.verify_checksum() == 1 and hdu.verify_datasum() == 1
                assert hdul[0].header['RELEASE'] == rel
                assert hdul[0].header['CALFAM'] == 'r7'
                assert not hdul[0].header['GAINCONV']
                for key, values in maps.items():
                    np.testing.assert_array_equal(hdul[f'D{detector}_{key.upper()}'].data, values)
            calibrations[(rel, detector)] = science.metadata['calibration_sha256']
            result['inputs'].append({
                'url': im.access_url, 'cutout_url': url, 'ra': x, 'dec': y, 'detector': detector,
                'image_shape': image_shape, 'epsf_shape': psf_shape,
                'aligned_valid_pixels': int(aligned.valid.sum()),
                'checks': ['archive/pipeline identity', 'native signed intensity and variance retained',
                           'FITS units and mask dictionary', 'full-resolution CWAVE/CBAND',
                           'active detector coordinates and spectral WCS agreement', 'UTC midpoint',
                           'EPSF table and detector-specific grid', 'accumulator and all FITS maps round-trip',
                           'FITS checksums and release/DOI provenance'],
                **science.metadata,
            })
            checkpoint()
            print(f'Validated {rel.upper()} D{detector}: {len(science.index)} samples', file=sys.stderr, flush=True)
    assert all(calibrations[('dr1', d)] == calibrations[('qr3', d)] for d in range(1, 7))
    result['shared_spectral_calibration_sha256'] = {str(d): calibrations[('dr1', d)] for d in range(1, 7)}
    for job in spectrum_jobs:
        content = sp.fetch_result_votable(job)
        table = sp.filter_release(sp.flatten_votable(content))
        assert table['count'] > 0
        assert table['release_counts']['dr1'] + table['release_counts']['qr3'] == table['count']
        for rel in releases.CURRENT_RELEASES:
            selected = sp.filter_release(table, rel)
            assert selected['count'] == table['release_counts'][rel]
            assert all(any(row is original for original in table['rows']) for row in selected['rows'])
        result['spectra'].append({
            'job_id': job, 'votable_sha256': hashlib.sha256(content).hexdigest(),
            'count': table['count'], 'release_counts': table['release_counts'], 'units': table['units'],
            'negative_flux_count': sum(row['flux'] < 0 for row in table['rows'] if row.get('flux') is not None),
            'max_flags': max(row.get('flags') or 0 for row in table['rows']),
            'checks': ['completed IRSA job', 'packed release labels', 'DR1/QR3 filters preserve original rows',
                       'flux, flux uncertainty and flags unchanged; no extra systematic error added'],
        })
        checkpoint()
    if check_api:
        result['api_smoke'] = api_smoke(spectrum_jobs)
    result['complete'] = True
    checkpoint()
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spectrum-job', action='append', default=[], help='Completed public job; may be repeated')
    parser.add_argument('--output', help='Write JSON evidence, including progress if interrupted')
    parser.add_argument('--api-smoke', action='store_true', help='Also test live FastAPI routes (requires httpx)')
    args = parser.parse_args()
    print(json.dumps(run(args.spectrum_job, args.output, args.api_smoke), indent=2, allow_nan=False))
