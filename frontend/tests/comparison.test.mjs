import test from 'node:test';
import assert from 'node:assert/strict';
import { readState, recipeFromForm, stateHash, comparisonUrl, decodeMap, decodeResult, pooledLimits, displayFraction, screenToImage, imageToScreen, sampleAt } from '../src/lib/comparison.js';
import { pixelToWorld, worldToPixel } from '../src/lib/render.js';

test('target launch preserves sky and survey, with no inherited single-detector filter', () => {
  const url = comparisonUrl(359.999, -80, 240, 'deep');
  const { form } = readState(url.split('#')[1]);
  const recipe = recipeFromForm(form);
  assert.equal(recipe.ra, 359.999); assert.equal(recipe.dec, -80); assert.equal(recipe.survey, 'deep');
  assert.equal(recipe.max_per_tile, 0); assert.deepEqual(recipe.wavelength_ranges, {});
});

test('recipe, display, epoch and sky pin survive a share-link round trip', () => {
  const state = readState('#ra=10&dec=-5');
  Object.assign(state.form, { ranges: { 6: ['4.6', '4.8'] }, grouping: 'fixed', mjd_start: '61000' });
  Object.assign(state.display, { vmin: '-.2', vmax: '4', invert: true, smooth: true, panX: .2, panY: -.1, zoom: 3.5 });
  const pin = { ra: 9.9, dec: -4.8 };
  const restored = readState(stateHash(state.form, state.display, 2, pin));
  assert.deepEqual(restored.form, state.form); assert.deepEqual(restored.display, state.display);
  assert.equal(restored.epoch, 2); assert.deepEqual(restored.pin, pin);
});

test('wavelength and coordinate validation reject partial or non-finite entries', () => {
  const { form } = readState('#ra=10&dec=5');
  assert.throws(() => recipeFromForm({ ...form, coords: '10oops 5' }));
  assert.throws(() => recipeFromForm({ ...form, ranges: { 2: ['', '1.5'] } }));
  assert.throws(() => recipeFromForm({ ...form, ranges: { 2: ['2', '1'] } }));
});

test('decoding preserves negative, zero, missing and precise UTC times', () => {
  const data = new Float64Array([61000.00000001, NaN, -1, 0]);
  const decoded = decodeMap({ dtype: '<f8', data_b64: Buffer.from(data.buffer).toString('base64') }, 4);
  assert.deepEqual(decoded, data);
  assert.throws(() => decodeMap({ dtype: '<f8', data_b64: Buffer.from(data.buffer).toString('base64') }, 3));
  assert.throws(() => decodeResult({ epochs: [{ tiles: [{ detector: 6 }] }] }));
});

test('one pooled scale makes equal intensity equal across detectors and epochs', () => {
  const arrays = [Float64Array.of(-2, 0, 3), Float64Array.of(-1, 3, 30)];
  const range = pooledLimits(arrays, 'intensity');
  assert.equal(displayFraction(arrays[0][2], ...range, 'asinh'), displayFraction(arrays[1][1], ...range, 'asinh'));
  assert.ok(displayFraction(-1, -2, 3, 'asinh') < displayFraction(0, -2, 3, 'asinh'));
  assert.deepEqual([...arrays[0]], [-2, 0, 3]);
});

test('linked navigation and sky pin respect canvas center/edge conventions', () => {
  const view = { zoom: 3, panX: .1, panY: -.2 };
  const xy = [7.5, 12.5];
  const screen = imageToScreen(...xy, 600, 40, view);
  const recovered = screenToImage(...screen, 600, 40, view);
  xy.forEach((v, i) => assert.ok(Math.abs(v - recovered[i]) < 1e-12));
  const wcs = { height: 40, crpix1: 20.5, crpix2: 20.5, crval1: 359.999, crval2: 80, cd11: -6.2 / 3600, cd12: 0, cd21: 0, cd22: 6.2 / 3600 };
  const sky = pixelToWorld(wcs, ...xy), back = worldToPixel(wcs, ...sky);
  xy.forEach((v, i) => assert.ok(Math.abs(v - back[i]) < 1e-6));
  assert.equal(sampleAt({ arrays: { intensity: Float64Array.of(1, 2, 3, 4) } }, .5, .5, 2, 2).intensity, 1);
  assert.equal(sampleAt({ arrays: {} }, 2, 0, 2, 2), null);
});
