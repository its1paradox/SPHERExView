import test from 'node:test';
import assert from 'node:assert/strict';
import { pairSample, colorFrame, colorPixel } from '../src/lib/color.js';
import { readState, stateHash, zoomAt, screenToImage } from '../src/lib/comparison.js';

const options = { reference: 4, referenceGain: 1, colorSigma: 3 };
const tile = (intensity, variance = 1, detector = 1, coverage = 1) => ({ detector,
  arrays: { intensity: Float64Array.of(intensity), variance: Float64Array.of(variance), coverage: Float64Array.of(coverage) } });

test('equal flux stays neutral while opposite detector contrasts reverse hue', () => {
  const a = tile(20), b = tile(10, 1, 4);
  const warm = pairSample(a, b, 0, options);
  const cool = pairSample(b, a, 0, options);
  assert.equal(warm.contrast, 1 / 3);
  assert.equal(cool.contrast, -1 / 3);
  const wp = colorPixel(warm.intensity, warm.contrast, warm.colored, 30, 'asinh');
  const cp = colorPixel(cool.intensity, cool.contrast, cool.colored, 30, 'asinh');
  assert.ok(wp[0] > wp[2] && cp[0] < cp[2]);
  const equal = pairSample(a, tile(20, 1, 4), 0, options);
  assert.equal(equal.difference, 0); assert.equal(equal.colored, false);
  const gray = colorPixel(equal.intensity, equal.contrast, true, 30, 'asinh');
  assert.equal(gray[0], gray[1]); assert.equal(gray[1], gray[2]);
});

test('one scalar gain preserves hue across brightness, stretch and saturation', () => {
  const ratios = [];
  for (const brightness of [1, 10, 100, 10000]) for (const stretch of ['linear', 'asinh']) {
    const p = colorPixel(brightness, .5, true, 4, stretch);
    ratios.push(p[2] / p[0]);
    assert.ok(Math.max(...p) <= 255);
  }
  for (const r of ratios) assert.ok(Math.abs(r - 1 / 3) < .01);
  const gray = colorPixel(100, 1, true, 4, 'asinh', 0);
  assert.deepEqual(gray, [255, 255, 255]);
});

test('formal gate suppresses weak color and uses reference gain squared in variance', () => {
  const weak = pairSample(tile(10), tile(11, 1, 4), 0, options);
  assert.equal(weak.colored, false);
  const sample = pairSample(tile(12, 4), tile(2, 9, 4), 0, { ...options, referenceGain: 2 });
  assert.equal(sample.reference, 4); assert.equal(sample.difference, 8);
  assert.equal(sample.variance, 40); assert.equal(sample.z, 8 / Math.sqrt(40));
  const raw = colorPixel(weak.intensity, weak.contrast, weak.colored, 20, 'linear');
  assert.equal(raw[0], raw[2]);
});

test('missing coverage is unavailable, never a zero-valued reference', () => {
  const a = tile(30);
  for (const b of [null, tile(0, 1, 4, 0), tile(NaN, 1, 4), tile(4, NaN, 4)]) {
    assert.equal(pairSample(a, b, 0, options), null);
    const frame = colorFrame(a, b, options, 1);
    assert.ok(Number.isNaN(frame.brightness[0]));
  }
});

test('self-reference is neutral with zero difference variance, even with a nonunit gain', () => {
  const a = tile(6, 4, 4);
  const s = pairSample(a, a, 0, { ...options, referenceGain: 9 }, true);
  assert.equal(s.intensity, 6); assert.equal(s.difference, 0); assert.equal(s.variance, 0);
  assert.equal(s.colored, false); assert.ok(Number.isNaN(s.z));
});

test('nonpositive clipping is display-only and signed differences are retained', () => {
  const a = tile(5), b = tile(-4, 1, 4);
  const s = pairSample(a, b, 0, options);
  assert.equal(s.difference, 9); assert.equal(s.contrast, 1);
  assert.equal(s.referenceNonpositive, true);
  assert.equal(b.arrays.intensity[0], -4);
  const frame = colorFrame(tile(-5), b, options, 1);
  assert.equal(frame.brightness[0], 0);
  assert.deepEqual(colorPixel(0, 0, false, 1, 'asinh'), [0, 0, 0]);
});

test('color choices and extended zoom survive a share-link round trip', () => {
  const s = readState('#ra=12&dec=30');
  Object.assign(s.display, { mode: 'color', reference: 6, referenceGain: 1.25, colorSigma: 4.5, colorStrength: .65, colorWhite: '12.5', zoom: 12 });
  assert.deepEqual(readState(stateHash(s.form, s.display, 1, null)).display, s.display);
  const malformed = readState('#reference=999&refgain=-1&colorsigma=NaN&zoom=999');
  assert.equal(malformed.display.reference, 6); assert.equal(malformed.display.referenceGain, .01);
  assert.equal(malformed.display.colorSigma, 3); assert.equal(malformed.display.zoom, 16);
});

test('cursor-anchored linked zoom preserves the sky point and clamps magnification', () => {
  const view = { zoom: 2, panX: .1, panY: -.1 };
  const point = [.75, .3];
  const before = screenToImage(point[0] * 600, point[1] * 600, 600, 80, view);
  const after = zoomAt(view, 3, ...point);
  const recovered = screenToImage(point[0] * 600, point[1] * 600, 600, 80, after);
  before.forEach((v, i) => assert.ok(Math.abs(v - recovered[i]) < 1e-12));
  assert.equal(zoomAt(view, 1e6).zoom, 16); assert.equal(zoomAt(view, 0).zoom, .5);
});
