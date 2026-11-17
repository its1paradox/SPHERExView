// Exercise the exact browser display functions on a saved real result.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { decodeResult, pooledLimits } from '../frontend/src/lib/comparison.js';
import { rgbFrame, rgbDisplay, rgbPixel, spectrumAt, spectrumCsv } from '../frontend/src/lib/liveSpectrum.js';
const [input, output] = process.argv.slice(2);
const bytes = fs.readFileSync(input), result = decodeResult(JSON.parse(bytes));
const hash = () => {
  const h=crypto.createHash('sha256');
  for(const e of result.epochs) for(const t of [...e.tiles,...e.spectra]) for(const a of Object.values(t.arrays || {})) h.update(Buffer.from(a.buffer));
  return h.digest('hex');
};
const before=hash(), raw=result.epochs.map(e=>rgbFrame(e,result.width*result.height));
const e=result.epochs[1], index=20*result.width+19, sky={ra:133.7599588,dec:-7.243277077778297};
const csv=()=>spectrumCsv(spectrumAt(e,index,true,true),sky,result.recipe,e);
const csvBefore=csv(), sharedWhite=pooledLimits(raw.map(f=>f.brightness),'intensity')[1];
const neutral=raw.map(f=>rgbDisplay(f,'neutral'));
const neutralWhite=pooledLimits(neutral.map(f=>f.brightness),'intensity')[1];
for(const frame of neutral) for(let i=0;i<frame.coverage.length;i++) if(frame.coverage[i]) rgbPixel(frame,i,neutralWhite,'asinh');
assert.equal(hash(),before);assert.equal(csv(),csvBefore);
for(const f of raw) assert.deepEqual(rgbDisplay(f,'shared').channels,f.channels);
assert.deepEqual(fs.readFileSync(input),bytes);
const report={science_arrays_sha256:before,arrays_identical:true,spectrum_csv_identical:true,result_file_identical:true,
  shared_white_mjy_sr:sharedWhite,neutral_white_mjy_sr:neutralWhite,
  epochs:neutral.map((f,i)=>({epoch:i,...f.background}))};
fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
