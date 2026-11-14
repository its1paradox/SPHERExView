import test from 'node:test';
import assert from 'node:assert/strict';
import { spectrumGuides, spectrumCsv } from '../src/lib/liveSpectrum.js';
test('separate release guides do not average two source brightness states', () => {
  const points = ['dr1','qr3'].flatMap((release,r) => [1,1.05,1.1].map(wavelength => ({release,detector:1,wavelength,bandwidth:.03,flux:r?20:2})));
  const guides=spectrumGuides(points);
  assert.equal(guides.length,2);
  assert.deepEqual(guides.map(g=>g.anchors.map(a=>a.flux)),[[2,2,2],[20,20,20]]);
});
test('CSV describes spectrum contributors independently of the coadd', () => {
  const csv=spectrumCsv([], {ra:1,dec:2}, {aperture_radius_arcsec:12.4},
    {index:0,data_release:'qr3',spectrum_release_summary:{data_release:'dr1+qr3'}});
  assert.match(csv,/epoch 1; dr1\+qr3/);
});
