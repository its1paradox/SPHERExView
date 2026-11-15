"""Opt-in real DR1/QR3 aperture checks; never submits archive jobs.

Uses twelve recorded public input URLs (or an explicit --inputs record). Downloads and
caches native cutouts, spectral calibrations and solid-angle maps, then runs
the production loader and FITS exporter. This verifies integration and stated
estimator invariants, not absolute photometric accuracy or a survey-wide bound.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from astropy.io import fits
from backend.app import aperture_spectrum as sp, detector_comparison as dc
from backend.app import releases, spherex_client as sx


def run(args):
    root = Path(__file__).resolve().parents[1]
    input_record = Path(args.inputs) if args.inputs else root / 'docs/validation/dr1-2026-11-14.json'
    evidence = json.loads(input_record.read_text())
    rows = [r for r in evidence['inputs'] if r['detector'] in args.detectors]
    assert {(r['data_release'], r['detector']) for r in rows} == {(r, d) for r in releases.CURRENT_RELEASES for d in args.detectors}
    cache = Path(args.cache_dir or sx.CACHE_DIR).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    sx.CACHE_DIR = str(cache)
    original_download = sx.download_cutout
    def download(url):
        name = hashlib.md5(url.encode()).hexdigest() + '.fits'
        for directory in [cache, *map(Path, args.reuse_cache)]:
            path = directory / name
            if path.is_file() and path.stat().st_size >= 2880:
                return str(path)
        if args.offline:
            raise FileNotFoundError(f'Missing cached public product: {url}')
        return original_download(url)
    sx.download_cutout = download
    result = {'checked_utc': datetime.now(timezone.utc).isoformat(), 'algorithm': dc.ALGORITHM,
              'scope': 'Real native-image integration; not absolute-photometry validation',
              'input_record': input_record.name, 'input_record_sha256': dc.sha256_file(input_record),
              'source_sha256': {f: dc.sha256_file(root / 'backend/app' / f) for f in
                                ('aperture_spectrum.py', 'detector_comparison.py', 'releases.py')},
              'inputs': [], 'complete': False}
    def save():
        if args.output:
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
    try:
        # At most two public downloads at a time; production still handles retries.
        urls = []
        for r in rows:
            rel, d = r['data_release'], r['detector']
            version = sp.AREA_VERSIONS[rel]
            urls.extend([r['cutout_url'], r['calibration_url'],
                         f'https://irsa.ipac.caltech.edu/ibe/data/spherex/{rel}/solid_angle_pixel_map/{version}/{d}/solid_angle_pixel_map_D{d}_spx_{version}.fits'])
        def warm(url):
            path = download(url)
            print(f'Cached {url.rsplit("/", 1)[-1]}', file=sys.stderr, flush=True)
            return path
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(warm, dict.fromkeys(urls)))
        for r in rows:
            rel, d = r['data_release'], r['detector']
            recipe = dc.Recipe(ra=r['ra'], dec=r['dec'], size_arcsec=62, release=rel)
            n, wcs = dc.cx.output_grid(recipe.ra, recipe.dec, recipe.size_arcsec)
            obs = r['url'].rsplit('/', 1)[-1].split('_spx_')[0].removeprefix('level2_')[:-2]
            im = sx.SpherexImage(r['url'], f'SPHEREx-D{d}', f'spherex_{rel}', obs,
                                r['native_mjd_start'], r['native_mjd_end'], 100, None, None, r['ra'], r['dec'])
            path = download(r['cutout_url'])
            started = time.perf_counter()
            samples = dc.load_samples(path, im, recipe, wcs, n)
            elapsed = time.perf_counter() - started
            assert samples.metadata['spectrum_status'] == 'ready', samples.metadata
            assert samples.metadata['cutout_sha256'] == r['cutout_sha256']
            assert samples.metadata['calibration_sha256'] == r['calibration_sha256']
            maps = samples.spectrum
            usable = np.isfinite(maps['usable_flux'])
            assert usable.any() and np.isfinite(maps['usable_variance'][usable]).all()
            assert (maps['usable_variance'][usable] > 0).all()
            assert (maps['wavelength'][usable] > 0).all()
            complete = np.isfinite(maps['flux'])
            np.testing.assert_array_equal(maps['flux'][complete], maps['usable_flux'][complete])
            np.testing.assert_array_equal(maps['variance'][complete], maps['usable_variance'][complete])
            # Images-only mode must yield the same native samples on this cutout.
            images = dc.load_samples(path, im, recipe.model_copy(update={'include_spectra': False}), wcs, n)
            assert images.spectrum is None and images.metadata['spectrum_status'] == 'disabled'
            for key in ('index', 'intensity', 'variance', 'wavelength', 'bandwidth'):
                np.testing.assert_array_equal(getattr(samples, key), getattr(images, key))
            record = {**samples.metadata, 'input_index': 0, 'status': 'accepted', 'obs_id': obs, 'url': r['url']}
            spectrum = {'detector': d, 'obs_id': obs, 'mjd': samples.mjd, 'data_release': rel, 'input_index': 0, 'arrays': maps}
            epoch = {'index': 0, 'mjd_start': im.t_min, 'mjd_end': im.t_max}
            output = cache / f'validation-aperture-{rel}-D{d}.fits'
            sp.save_spectra(output, [spectrum], wcs, recipe, epoch, [record])
            with fits.open(output, checksum=True) as hdul:
                assert all(h.verify_checksum() == 1 and h.verify_datasum() == 1 for h in hdul)
                assert hdul[0].header['RELEASE'] == rel and hdul[0].header['CALFAM'] == 'r7'
                assert hdul['EXPOSURES'].data['RELEASE'][0] == rel
                for key, values in maps.items():
                    np.testing.assert_array_equal(hdul[key.upper()].data[0], values)
                provenance = json.loads(hdul['PROVENANCE'].data.tobytes())
                assert provenance['inputs'][0]['solid_angle_sha256'] == samples.metadata['solid_angle_sha256']
            result['inputs'].append({'release': rel, 'detector': d, 'url': r['url'], 'cutout_url': r['cutout_url'],
                'ra': r['ra'], 'dec': r['dec'], 'cutout_sha256': samples.metadata['cutout_sha256'],
                'grid_cells': n*n, 'usable_positions': int(usable.sum()),
                'complete_positions': int(complete.sum()), 'cached_load_and_extraction_seconds': elapsed,
                'solid_angle_sha256': samples.metadata['solid_angle_sha256'],
                'spectral_calibration_sha256': samples.metadata['calibration_sha256'],
                'checks': ['native extraction', 'positive formal variance', 'complete/usable estimator agreement',
                           'images-only native samples unchanged', 'all spectral FITS maps and checksums',
                           'per-exposure release and standalone calibration provenance']})
            save()
            print(f'Validated {rel.upper()} D{d}: {int(usable.sum())}/{n*n} usable positions', file=sys.stderr, flush=True)
        hashes = {(r['release'], r['detector']): r['solid_angle_sha256'] for r in result['inputs']}
        assert all(hashes[('dr1', d)] == hashes[('qr3', d)] for d in args.detectors)
        result['shared_solid_angle_hashes'] = {str(d): hashes[('dr1', d)] for d in args.detectors}
        result['complete'] = True
        save()
        return result
    finally:
        sx.download_cutout = original_download


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output')
    parser.add_argument('--inputs', help='JSON input record with one public product per release and detector')
    parser.add_argument('--cache-dir')
    parser.add_argument('--reuse-cache', action='append', default=[])
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--detectors', type=int, nargs='+', choices=range(1, 7), default=list(range(1, 7)))
    args = parser.parse_args()
    print(json.dumps(run(args), indent=2, allow_nan=False))
