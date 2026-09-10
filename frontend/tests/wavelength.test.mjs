import test from 'node:test';
import assert from 'node:assert/strict';
import { wavelengthFrame, wavelengthPixel, srgbToLinear } from '../src/lib/wavelength.js';
import { readState, stateHash, pooledLimits } from '../src/lib/comparison.js';

test('hue follows calibrated wavelength rather than detector number or image row', () => {
  const arrays = { intensity: [2, 2, 2, 2], coverage: [1, 1, 1, 1], wavelength: [.9, 2, 4.8, .9] };
  const before = structuredClone(arrays), a = wavelengthFrame({ detector: 1, arrays }, 4), b = wavelengthFrame({ detector: 6, arrays }, 4);
  assert.deepEqual(a, b);
  const colors = [...a.wavelength].map(w => wavelengthPixel(2, w, 10, 'asinh'));
  assert.deepEqual(colors[0], colors[3]);
  assert.ok(colors[0][2] > colors[0][0] && colors[2][0] > colors[2][2]);
  assert.notDeepEqual(colors[0], colors[1]); assert.deepEqual(arrays, before);
});

test('equal intensity has equal sRGB relative luminance at every wavelength, including highlights', () => {
  for (const stretch of ['linear', 'asinh']) for (const signal of [.01, .1, .35, .7, .98, 1, 10]) {
    const neutral = wavelengthPixel(signal, 2, 1, stretch, 0);
    const expected = srgbToLinear(neutral[0] / 255);
    for (let lambda = .75; lambda <= 5; lambda += .05) {
      const pixel = wavelengthPixel(signal, lambda, 1, stretch);
      const y = pixel.map(v => srgbToLinear(v / 255)).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
      assert.ok(Math.abs(y - expected) < .007, 'Only 8-bit quantization may change relative luminance');
      assert.ok(pixel.every(x => Number.isInteger(x) && x >= 0 && x <= 255));
    }
  }
  assert.deepEqual(wavelengthPixel(10, 4.8, 1, 'asinh'), [255, 255, 255]);
});

test('missing intensity, wavelength or coverage remains unavailable and negatives are display-only', () => {
  const arrays = { intensity: [-4, 0, NaN, 8, 8, 8, 8], coverage: [2, 2, 2, 0, 2, 2, 2], wavelength: [1, 1, 1, 1, NaN, 0, Infinity] };
  const before = structuredClone(arrays), frame = wavelengthFrame({ arrays }, 7);
  assert.deepEqual([...frame.brightness].slice(0, 2), [0, 0]);
  assert.ok([...frame.brightness].slice(2).every(Number.isNaN));
  assert.deepEqual(arrays, before);
  assert.ok([...wavelengthFrame(null, 2).brightness].every(Number.isNaN));
  assert.deepEqual(wavelengthPixel(-1, 2, 10, 'asinh'), [0, 0, 0]);
  assert.equal(wavelengthPixel(10, NaN, 10, 'asinh'), null);
  assert.equal(wavelengthPixel(10, 2, 0, 'asinh'), null);
});

test('endpoint hues clamp visibly out-of-range calibrated wavelengths without altering their values', () => {
  assert.deepEqual(wavelengthPixel(.1, .7, 1, 'linear'), wavelengthPixel(.1, .75, 1, 'linear'));
  assert.deepEqual(wavelengthPixel(.1, 5.1, 1, 'linear'), wavelengthPixel(.1, 5, 1, 'linear'));
  assert.equal(wavelengthFrame({ arrays: { intensity: [1], wavelength: [5.1], coverage: [1] } }, 1).wavelength[0], 5.1);
});

test('one pooled white scale spans epochs and wavelength settings round trip independently', () => {
  const frames = [1, 3].map(signal => wavelengthFrame({ arrays: { intensity: [signal, signal], coverage: [1, 1], wavelength: [1, 4.5] } }, 2));
  const white = pooledLimits(frames.map(f => f.brightness), 'intensity')[1];
  assert.equal(white, 3);
  const s = readState('#ra=10&dec=-5&mode=wavelength&wavestrength=0.75&wavewhite=3.5&colorwhite=9');
  assert.equal(s.display.wavelengthWhite, '3.5'); assert.equal(s.display.colorWhite, '9');
  assert.deepEqual(readState(stateHash(s.form, s.display, 0, null)).display, s.display);
  assert.equal(readState('#wavestrength=2').display.wavelengthStrength, 1);
});
