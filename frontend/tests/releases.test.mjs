import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseValue, spectrumRelease, hasQualityFlags } from '../src/lib/releases.js';
import { parseHash, buildHash } from '../src/lib/urlstate.js';
import { comparisonUrl, readState, recipeFromForm, stateHash } from '../src/lib/comparison.js';

test('release travels through bookmarks, comparison launch and processing recipes', () => {
  for (const release of ['all', 'qr2', 'qr3']) {
    const state = parseHash(`#ra=10&dec=-5&release=${release}`);
    assert.equal(parseHash(buildHash(state.form, state.view)).form.release, release);
    const comparison = readState(comparisonUrl(10, -5, 240, 'deep', release).split('#')[1]);
    assert.equal(recipeFromForm(comparison.form).release, release);
    assert.equal(readState(stateHash(comparison.form, comparison.display, 0, null)).form.release, release);
  }
  assert.equal(releaseValue('qr1'), 'all');
  assert.equal(parseHash('#ra=10&dec=-5').form.release, 'all');
});

test('spectrum release comes from provenance, never from an observation date', () => {
  assert.equal(spectrumRelease({ data_collection: 'spherex_qr3_deep' }), 'qr3');
  assert.equal(spectrumRelease({ data_collection: 'QR2' }), 'qr2');
  assert.equal(spectrumRelease({ mjd: 61241 }), 'unknown');
});

test('64-bit photometry flags preserve bits 32 and 33 and benign source/fullsample bits', () => {
  assert.equal(hasQualityFlags(0), false);
  assert.equal(hasQualityFlags(2 ** 21 + 2 ** 12), false);
  assert.equal(hasQualityFlags(2 ** 32), true);
  assert.equal(hasQualityFlags(String(2 ** 33 + 2 ** 21)), true);
  assert.equal(hasQualityFlags(-1), true);
  assert.equal(hasQualityFlags('invalid'), true);
});
