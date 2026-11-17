"""Check AstroToolBox native coordinates and wavelength lookup against Astropy."""
import argparse
import csv
import json
from pathlib import Path
import sys
import warnings
import subprocess
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from astropy.coordinates import SkyCoord

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.app import coadd, imaging

parser=argparse.ArgumentParser()
parser.add_argument('--cutouts',type=Path,required=True)
parser.add_argument('--evidence',type=Path,required=True)
args=parser.parse_args()
rows=[]
for row in csv.DictReader((args.evidence/'astrotoolbox-raw.csv').open()):
    with fits.open(args.cutouts/row['file']) as h:
        header=h['IMAGE'].header
        x,y=map(float,(row['x'],row['y']))
        expected=np.array(WCS(header).world_to_pixel_values(133.7599588,-7.2449993))
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            wave=WCS(coadd._strip_sip(header),h,key='W');wave.sip=None
            correct=float(wave.pixel_to_world_values(x,y)[0])
            shifted=float(wave.pixel_to_world_values(x-1,y-1)[0])
        rows.append(dict(file=row['file'],detector=int(row['detector']),native_xy_difference_pixels=float(np.max(np.abs(expected-[x,y]))),
                         atb_wavelength_um=float(row['wavelength']),astropy_wavelength_um=correct,astropy_minus_one_pixel_um=shifted))
result={'reference_count':len(rows),'maximum_celestial_pixel_difference':max(r['native_xy_difference_pixels'] for r in rows),
        'maximum_atb_minus_shifted_um':max(abs(r['atb_wavelength_um']-r['astropy_minus_one_pixel_um']) for r in rows),
        'detectors':[{'detector':d,'median_atb_minus_correct_nm':float(np.median([(r['atb_wavelength_um']-r['astropy_wavelength_um'])*1000 for r in rows if r['detector']==d]))} for d in range(1,7)],'measurements':rows}
# Independent oracle for display orientation, pixel centers and TAN transforms.
rng=np.random.default_rng(443);cases=[]
for ra,dec in [(0.001,0),(359.999,72),(180,-88),(133.7599588,-7.2449993)]:
    n,w=coadd.output_grid(ra,dec,124,6.2)
    w.wcs.cd=w.wcs.cd @ np.array([[.8,-.55],[.6,.91]])
    for x,y in rng.uniform(.5,n-.5,(50,2)):
        a,d=w.pixel_to_world_values(x-.5,n-y-.5)
        cases.append(dict(wcs=imaging.wcs_to_dict(w,n),x=x,y=y,ra=float(a),dec=float(d)))
js="""import fs from 'node:fs'; import {pixelToWorld,worldToPixel} from './frontend/src/lib/render.js';
const cases=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(cases.map(c=>({sky:pixelToWorld(c.wcs,c.x,c.y),pixel:worldToPixel(c.wcs,c.ra,c.dec)}))));"""
actual=json.loads(subprocess.check_output(['node','--input-type=module','-e',js],input=json.dumps(cases),text=True))
angular=[];spatial=[]
for c,a in zip(cases,actual):
    angular.append(SkyCoord(c['ra'],c['dec'],unit='deg').separation(SkyCoord(*a['sky'],unit='deg')).arcsec)
    spatial.append(float(np.max(np.abs(np.array(a['pixel'])-[c['x'],c['y']]))))
result['frontend_wcs']={'points':len(cases),'maximum_error_arcsec':float(max(angular)),'maximum_error_pixels':max(spatial)}
assert max(angular)<1e-6 and max(spatial)<1e-6
(args.evidence/'wcs-audit.json').write_text(json.dumps(result,indent=2))
print(json.dumps({k:v for k,v in result.items() if k!='measurements'}))
