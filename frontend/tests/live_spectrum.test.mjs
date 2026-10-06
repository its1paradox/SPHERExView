import test from 'node:test';
import assert from 'node:assert/strict';
import { rgbFrame, rgbPixel, spectrumAt, frequencyTHz, spectrumCsv } from '../src/lib/liveSpectrum.js';
import { decodeResult } from '../src/lib/comparison.js';

test('RGB includes all six, preserves channel ratios and never invents missing coverage', () => {
  const epoch = { tiles: [1,2,3,4,5,6].map(d => ({ arrays: { intensity: Float64Array.of(d, -d, d), coverage: [1,1,d === 6 ? 0 : 1] } })) };
  const rgb = rgbFrame(epoch, 3);
  assert.deepEqual(rgb.channels.map(c => c[0]), [5.5,3.5,1.5]);
  const pixel = rgbPixel(rgb, 0, 10, 'asinh');
  assert.ok(Math.abs(pixel[0] / pixel[2] - 5.5 / 1.5) < .06);
  assert.deepEqual(rgbPixel(rgb, 1, 10, 'asinh'), [0,0,0]);
  assert.equal(rgb.coverage[2], 0); assert.ok(Number.isNaN(rgb.brightness[2]));
  assert.equal(epoch.tiles[0].arrays.intensity[1], -1, 'Display must not clip science arrays');
});

test('spectrum retains separate exposures, signed flux, exact frequency and wavelength range', () => {
  const spectra = [2,1,3].map((wave, i) => ({ detector: i + 1, mjd: 61000 + i, obs_id: `obs,${i}`, data_release: 'qr3', arrays: { flux: [i === 2 ? NaN : -10 + 20*i], variance: [4], wavelength: [wave], bandwidth: [.04], lambda_min: [wave-.01], lambda_max: [wave+.01], aperture_coverage: [1], sky_coverage: [.9] } }));
  const points = spectrumAt({ spectra }, 0);
  assert.deepEqual(points.map(p => p.wavelength), [1,2]);
  assert.deepEqual(points.map(p => p.flux), [10,-10]);
  assert.equal(points[0].error, 2);
  assert.equal(frequencyTHz(1), 299.792458);
  assert.deepEqual(spectrumAt({ spectra }, null), []);
  assert.deepEqual(spectrumAt({ spectra }, 0, true), [], 'Never fall back to sky-contaminated flux when local sky is unavailable');
  spectra[0].arrays.sky_flux = [-7]; spectra[0].arrays.sky_variance = [9];
  const local = spectrumAt({ spectra }, 0, true);
  assert.equal(local.length, 1); assert.equal(local[0].flux, -7); assert.equal(local[0].error, 3);
  const csv = spectrumCsv(points, {ra:1,dec:2}, {aperture_radius_arcsec:12.4, background:'zodi'}, {index:0,data_release:'qr3'});
  assert.ok(csv.includes('"obs,1"')); assert.ok(csv.includes('not PSF-corrected')); assert.ok(csv.includes('um; flux/error: uJy'));
});

test('decode spectral maps in the same orientation as detector maps and discard encoded duplicates', () => {
  const map = {dtype:'<f4', data_b64:Buffer.from(Float32Array.of(1,2,3,4).buffer).toString('base64')};
  const r = decodeResult({width:2,height:2,epochs:[{tiles:[1,2,3,4,5,6].map(detector=>({detector})),spectra:[{detector:1,maps:{flux:map}}]}]});
  assert.deepEqual([...r.epochs[0].spectra[0].arrays.flux], [1,2,3,4]);
  assert.equal(r.epochs[0].spectra[0].maps, undefined);
});
