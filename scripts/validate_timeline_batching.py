"""Offline numerical comparison using a recorded manifest and cached IRSA FITS.

python scripts/validate_timeline_batching.py --manifest manifest.json --cache CACHE --output report.json
No archive requests are made. Source FITS files are read, never modified.
"""
import argparse
from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.app import batching, coadd


def run(manifest_path, cache, output):
    manifest = json.loads(Path(manifest_path).read_text())
    recipe = manifest['recipe']
    rows, excluded = [], []
    started = time.monotonic()
    for i, item in enumerate(manifest['inputs']):
        url = item.get('cutout_url')
        if not url:
            excluded.append({'obs_id': item['obs_id'], 'reason': 'no recorded cutout URL'})
            continue
        path = Path(cache) / (hashlib.md5(url.encode()).hexdigest() + '.fits')
        try:
            if item.get('cutout_sha256'):
                assert hashlib.sha256(path.read_bytes()).hexdigest() == item['cutout_sha256']
            exp = coadd.load_aligned_exposure(str(path), recipe['ra'], recipe['dec'],
                120, background='zodi', pixscale_arcsec=3.1, resampling='bilinear',
                expected_release=item['data_release'])
            exp.obs_id = item['obs_id']
            rows.append(exp)
        except Exception as exc:
            excluded.append({'obs_id': item['obs_id'], 'reason': str(exc)})
        if i % 50 == 0:
            print(f'Loaded {i + 1}/{len(manifest["inputs"])}', flush=True)
    records = []
    with tempfile.TemporaryDirectory(dir=Path(output).resolve().parent) as work:
        os.environ['SPHEREX_CACHE_DIR'] = work
        @batching.workspace
        def compare(group):
            expected = coadd.combine(group)
            actual = batching.combine([batching.spill(replace(e), i) for i, e in enumerate(group)])
            for a, b in zip(actual[:2], expected[:2]):
                np.testing.assert_allclose(a, b, rtol=2e-14, atol=2e-14, equal_nan=True)
            np.testing.assert_array_equal(actual[2], expected[2])
            assert actual[3:] == expected[3:]
            return {'detector': group[0].detector, 'inputs': len(group),
                    'rejected_pixels': actual[3], 'wavelength': actual[4],
                    'max_image_difference': float(np.nanmax(np.abs(actual[0] - expected[0]))),
                    'max_variance_difference': float(np.nanmax(np.abs(actual[1] - expected[1])))}
        for detector in sorted({e.detector for e in rows}):
            records.append(compare([e for e in rows if e.detector == detector]))
    report = {'mode': 'offline cached real DR1/QR3 FITS; full-array reference versus disk batching',
              'inventory': len(manifest['inputs']), 'accepted': len(rows), 'excluded': excluded,
              'field_arcsec': 120, 'pixel_scale_arcsec': 3.1, 'groups': records,
              'seconds': round(time.monotonic() - started, 2)}
    Path(output).write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--cache', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    run(args.manifest, args.cache, args.output)
