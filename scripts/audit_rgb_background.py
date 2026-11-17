"""Read-only reconstruction of the reported RGB field from cached native FITS.

No production coadd or aperture estimator is called. Reproduce the saved
native-pixel bin estimator, then quantify individual exposure contributions.
Only the report directory is written; no inputs or scientific products change.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import warnings

import astropy.units as u
from astropy.io import fits
from astropy.wcs import WCS
import numpy as np


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def decode(m):
    return np.frombuffer(base64.b64decode(m['data_b64']), dtype=m['dtype']).astype(float)


def stats(v):
    v = v[np.isfinite(v)]
    return dict(n=len(v), median=float(np.median(v)), p10=float(np.percentile(v, 10)),
                p90=float(np.percentile(v, 90))) if len(v) else dict(n=0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', type=Path, required=True)
    ap.add_argument('--job', default='a678c919d023428cbc63aa0f94469371')
    ap.add_argument('--output', type=Path, required=True)
    args = ap.parse_args()
    folder = args.cache/'comparisons'/args.job
    result = json.loads((folder/'result.json').read_text())
    originals = {p.name: sha(p) for p in folder.iterdir() if p.is_file()}
    assert result['recipe']['resampling'] == 'bin' and result['recipe']['weighting'] == 'equal'
    assert result['recipe']['background'] == 'zodi' and not result['recipe']['wavelength_ranges']
    n = result['width']; size = n*n
    report = dict(job=args.job, recipe=result['recipe'], input_hashes=originals, epochs=[])
    for epoch in result['epochs']:
        ei = epoch['index']
        # JSON arrays use browser row order (north at top); FITS uses native WCS
        # row order. Convert once before comparing pixel-by-pixel projections.
        maps = [np.flipud(decode(t['maps']['intensity']).reshape(n,n)).ravel() for t in epoch['tiles']]
        common = np.all(np.isfinite(maps), axis=0)
        channels = np.array([(maps[a]+maps[b])/2 for a,b in [(4,5),(2,3),(0,1)]])
        # A display estimator, not an independent source-free physical sky model.
        keep = common.copy()
        for _ in range(5):
            med = np.median(channels[:,keep],axis=1)
            sig = 1.4826*np.median(abs(channels[:,keep]-med[:,None]),axis=1)
            use = keep & np.all((sig[:,None] == 0) | (abs(channels-med[:,None]) <= 3*sig[:,None]),axis=0)
            if np.array_equal(use,keep): break
            keep=use
        summary = dict(epoch=ei, datetime_start=epoch['datetime_start'], common_pixels=int(common.sum()),
                       clipped_pixels=int(keep.sum()), rgb_medians=[float(np.median(c[keep])) for c in channels],
                       detectors=[], exposures=[])
        with fits.open(folder/f'epoch-{ei}.fits') as f:
            outw = WCS(f['D1_INTENSITY'].header)
        for detector in range(1,7):
            rows = [r for r in result['inputs'] if r['epoch']==ei and r['detector']==detector and r['status']=='accepted']
            sums=np.zeros(size); hits=np.zeros(size); contributions=[]
            for row in rows:
                path=args.cache/(hashlib.md5(row['cutout_url'].encode()).hexdigest()+'.fits')
                assert sha(path)==row['cutout_sha256']
                with fits.open(path) as f:
                    h=f['IMAGE'].header; raw=f['IMAGE'].data.astype(float)*u.Unit(h['BUNIT']).to(u.MJy/u.sr)
                    zodi=f['ZODI'].data.astype(float)*u.Unit(f['ZODI'].header['BUNIT']).to(u.MJy/u.sr)
                    variance=f['VARIANCE'].data.astype(float); flags=f['FLAGS'].data
                    residual=raw-zodi
                    fatal=sum(1<<v for k,v in row['mask_bits'].items() if k!='MP_SOURCE')
                    valid=np.isfinite(residual)&np.isfinite(variance)&(variance>0)&((flags&fatal)==0)
                    yy,xx=np.indices(raw.shape)
                    with warnings.catch_warnings():
                        warnings.simplefilter('ignore')
                        ra,dec=WCS(h).pixel_to_world_values(xx,yy)
                        xo,yo=outw.world_to_pixel_values(ra,dec)
                    finite=np.isfinite(xo)&np.isfinite(yo)
                    xi=np.floor(np.where(finite,xo,-100)+.5).astype(int); yi=np.floor(np.where(finite,yo,-100)+.5).astype(int)
                    use=valid&finite&(xi>=0)&(yi>=0)&(xi<n)&(yi<n)
                    ix=yi[use]*n+xi[use]; values=residual[use]
                    hs=np.bincount(ix,minlength=size); sm=np.bincount(ix,weights=values,minlength=size)
                    sums+=sm;hits+=hs
                    sky=use&((flags&(1<<row['mask_bits']['MP_SOURCE']))==0)
                    info=dict(epoch=ei,detector=detector,obs_id=row['obs_id'], wavelength_um=row['field_sample_median_wavelength_um'],
                        accepted_samples=int(use.sum()), source_masked_residual=stats(residual[sky]),
                        source_masked_image=stats(raw[sky]),source_masked_zodi=stats(zodi[sky]),
                        pipeline_version=row['pipeline_version'],cutout_sha256=row['cutout_sha256'],
                        background_headers={k:h[k] for k in h if any(x in k.upper() for x in ['HELI','HEAMP','HE_', 'ZODI','AUROR','BKG'])})
                    summary['exposures'].append(info);contributions.append((info,sm,hs))
            rebuilt=np.divide(sums,hits,out=np.full(size,np.nan),where=hits>0)
            delta=np.nanmax(abs(rebuilt-maps[detector-1]))
            assert delta < 1e-6, (ei,detector,delta)
            info=dict(detector=detector, reconstruction_max_abs_mjy_sr=float(delta),
                display_background=stats(maps[detector-1][keep]),whole_field=stats(maps[detector-1][common]))
            for row,sm,hs in contributions:
                contribution=np.divide(sm,hits,out=np.full(size,np.nan),where=hits>0)
                without=np.divide(sums-sm,hits-hs,out=np.full(size,np.nan),where=hits>hs)
                row['contribution_on_display_background']=stats(contribution[keep])
                row['coadd_without_this_exposure']=stats(without[keep])
                if detector == 1:
                    row['blue_channel_without_this_exposure']=stats(((without+maps[1])/2)[keep])
            info['largest_contributors']=[row['obs_id'] for row,_,_ in sorted(contributions,key=lambda r:r[0]['contribution_on_display_background'].get('median',0),reverse=True)[:3]]
            summary['detectors'].append(info)
        report['epochs'].append(summary)
    report['files_unchanged']=all(sha(folder/name)==value for name,value in originals.items())
    assert report['files_unchanged']
    args.output.mkdir(parents=True,exist_ok=True)
    (args.output/'native-audit.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    for e in report['epochs']:
        print('Epoch',e['epoch'],'RGB medians',e['rgb_medians'])
        for d in e['detectors']: print(d)
        print('Top D1',sorted([r for r in e['exposures'] if r['detector']==1],key=lambda r:r['contribution_on_display_background']['median'],reverse=True)[:2])


if __name__=='__main__': main()
