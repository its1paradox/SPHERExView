import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBlinkDataKey,
  buildBlinkHash,
  buildBlinkParams,
  parseBlinkHash,
  validateBlinkGrid,
} from '../src/lib/blinkstate.js';

test('custom blink recipes roundtrip through the URL', () => {
  const form = {
    ...parseBlinkHash(''),
    band: 'custom',
    shortDetectors: [1, 3],
    longDetectors: [4, 6],
    background: 'none',
    sigma: '4',
    maxiters: '3',
    minChannelExposures: '2',
    pixscale: '6.2',
    resampling: 'nearest',
  };
  const hash = buildBlinkHash(form, { ra: 10, dec: -5 });
  const restored = parseBlinkHash(hash);

  assert.deepEqual(restored.shortDetectors, [1, 3]);
  assert.deepEqual(restored.longDetectors, [4, 6]);
  assert.equal(restored.background, 'none');
  assert.equal(restored.sigma, '4');
  assert.equal(restored.maxiters, '3');
  assert.equal(restored.minChannelExposures, '2');
  assert.equal(restored.pixscale, '6.2');
  assert.equal(restored.resampling, 'nearest');
});

test('invalid overlapping detector recipes reset to safe defaults', () => {
  const restored = parseBlinkHash('#band=custom&short=1,2&long=2,6');
  assert.deepEqual(restored.shortDetectors, [1, 2, 3, 4]);
  assert.deepEqual(restored.longDetectors, [5, 6]);
});

test('custom API params include every scientific recipe control', () => {
  const form = {
    ...parseBlinkHash(''),
    band: 'custom',
    shortDetectors: [2, 4],
    longDetectors: [5, 6],
  };
  const params = buildBlinkParams(form, { ra: 10, dec: -5 });

  assert.equal(params.get('short_detectors'), '2,4');
  assert.equal(params.get('long_detectors'), '5,6');
  assert.equal(params.get('background'), 'zodi');
  assert.equal(params.get('sigma'), '5');
  assert.equal(params.get('maxiters'), '2');
  assert.equal(params.get('min_channel_exposures'), '1');
  assert.equal(params.get('pixscale_arcsec'), '3.1');
  assert.equal(params.get('resampling'), 'bilinear');
  assert.equal(params.has('band'), false);
});

test('focused recipes preserve band and reference semantics', () => {
  const form = { ...parseBlinkHash(''), band: 'SPHEREx-D6', ref: 'none' };
  const params = buildBlinkParams(form, { ra: 10, dec: -5 });

  assert.equal(params.get('band'), 'SPHEREx-D6');
  assert.equal(params.get('ref'), 'none');
  assert.equal(params.has('short_detectors'), false);
});

test('legacy blink links retain native pixel-preserving defaults', () => {
  const restored = parseBlinkHash('#ra=10&dec=-5&band=SPHEREx-D6&ref=auto');
  assert.equal(restored.pixscale, '6.2');
  assert.equal(restored.resampling, 'nearest');
});

test('new and explicitly configured links use their selected clarity recipe', () => {
  assert.equal(parseBlinkHash('').pixscale, '3.1');
  assert.equal(parseBlinkHash('').resampling, 'bilinear');
  const restored = parseBlinkHash(
    '#ra=10&dec=-5&pixscale=3.1&resampling=bilinear&band=SPHEREx-D6&ref=excess',
  );
  assert.equal(restored.ref, 'excess');
  assert.equal(buildBlinkHash(restored, { ra: 10, dec: -5 }).includes('ref=excess'), true);
});

test('grid validation mirrors the backend 1024-pixel side limit', () => {
  assert.equal(validateBlinkGrid(3174, 3.1), null);
  assert.match(validateBlinkGrid(4000, 3.1), /1290×1290/);
  assert.equal(validateBlinkGrid(6348, 6.2), null);
  assert.match(validateBlinkGrid(7200, 6.2), /1161×1161/);
});

test('only auto and excess share an identical fetched-data recipe', () => {
  const base = {
    ...parseBlinkHash(''),
    coords: '10 -5',
    band: 'SPHEREx-D6',
    ref: 'auto',
  };
  const coords = { ra: 10, dec: -5 };
  assert.equal(
    buildBlinkDataKey(base, coords),
    buildBlinkDataKey({ ...base, ref: 'excess' }, coords),
  );
  assert.notEqual(
    buildBlinkDataKey(base, coords),
    buildBlinkDataKey({ ...base, coords: '11 -5' }, { ra: 11, dec: -5 }),
  );
  assert.notEqual(
    buildBlinkDataKey(base, coords),
    buildBlinkDataKey({ ...base, band: 'SPHEREx-D5' }, coords),
  );
});
