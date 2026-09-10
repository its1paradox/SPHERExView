// Synthetic API/React checks; these do not substitute for visual browser review.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { DEFAULT_VIEW, parseHash, buildHash } from '../src/lib/urlstate.js';

const compiled = build({ entryPoints: ['src/main.jsx'], bundle: true, format: 'iife',
  jsx: 'automatic', write: false, loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' } });
const data = Buffer.from(new Float32Array(Array.from({ length: 16 }, (_, i) => i + 1)).buffer).toString('base64');
const wcs = { height: 4, crpix1: 2.5, crpix2: 2.5, crval1: 10, crval2: -5,
  cd11: -6.2 / 3600, cd12: 0, cd21: 0, cd22: 6.2 / 3600 };
const frame = { width: 4, height: 4, wcs, data_b64: data };
const raw = [0, 1].map(i => ({ ...frame, id: `sx-${i}`, metadata: {
  band: 'SPHEREx-D6', mjd_mid: 61000 + i, datetime_utc: `2025-11-${21 + i}T00:00:00`, target_covered: true,
} }));
const wise = [0, 1].map(i => ({ ...frame, id: `wise-${i}`, band: 'W2', epoch: i,
  mjd: 55200 + i * 180, datetime_utc: `2010-0${1 + i * 6}-01T00:00:00`, gaia_markers: [] }));

async function settle(check) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The expected React state did not appear');
}

async function mount(hash = '', responseOverride) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: `http://localhost/${hash}`, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, requests = [], opened = [], errors = [], copied = [];
  w.structuredClone = structuredClone;
  w.console.error = (...args) => errors.push(args.join(' '));
  w.open = (...args) => opened.push(args);
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async text => copied.push(text) } });
  w.HTMLCanvasElement.prototype.getContext = () => Object.fromEntries([
    ...['fillRect', 'clearRect', 'drawImage', 'putImageData', 'beginPath', 'moveTo', 'lineTo', 'arc',
      'stroke', 'fillText', 'save', 'restore', 'setTransform', 'fill', 'closePath', 'strokeRect', 'setLineDash']
      .map(name => [name, () => {}]),
    ['createImageData', (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) })],
  ]);
  w.fetch = async url => {
    requests.push(url);
    const parsed = new URL(url, 'http://localhost');
    let result;
    if (parsed.pathname === '/api/epoch-stack') result = { count: raw.length, cutouts: raw };
    else if (parsed.pathname === '/api/wise-stack') result = { count: wise.length, frames: wise };
    else if (parsed.pathname === '/api/epoch-coadds') {
      const gray = parsed.searchParams.get('ref') === 'none';
      result = { count: 2, frames: [0, 1].map(i => ({ ...frame, id: `coadd-${i}`,
        ...(gray ? {} : { data2_b64: data }), metadata: {
          channels: gray ? 'gray' : 'color', n_exposures: 4, mjd_min: 61000 + i * 20, mjd_max: 61001 + i * 20,
          datetime_min_utc: '2025-11-21T00:00:00', datetime_max_utc: '2025-11-22T00:00:00',
          short_channel: { detectors: [4], n_exposures: 2, sky_sigma_mjy_sr: 1 },
          long_channel: { detectors: [6], n_exposures: 2, sky_sigma_mjy_sr: 1 },
        } })) };
    } else throw new Error(`Unexpected request: ${url}`);
    if (responseOverride) result = responseOverride(parsed, result);
    return { ok: true, json: async () => structuredClone(result) };
  };
  vm.runInContext((await compiled).outputFiles[0].text, dom.getInternalVMContext());
  await settle(() => w.document.querySelector('.panel-switch'));
  const q = selector => w.document.querySelector(selector);
  const button = name => [...w.document.querySelectorAll('button')].find(b => b.textContent.trim() === name);
  const toggle = name => [...w.document.querySelectorAll('.panel-switch label')].find(l => l.textContent.trim() === name).querySelector('input').click();
  return { dom, w, q, button, toggle, requests, opened, errors, copied };
}

test('timeline defaults and explicit bookmark panel choices survive URL round trips', () => {
  assert.equal(DEFAULT_VIEW.showCombined, true);
  assert.equal(DEFAULT_VIEW.showWise, false);
  assert.equal(DEFAULT_VIEW.showSpherex, false);
  const legacy = parseHash('#ra=10&dec=-5&wise=1&combined=0&cmode=exposures&maxframes=20&wiseband=w2&sxstretch=log&wcontrast=67');
  assert.equal(legacy.view.showWise, true);
  assert.equal(legacy.view.showCombined, false);
  assert.equal(legacy.view.combinedMode, 'exposures');
  assert.equal(legacy.form.limit, '20');
  assert.equal(legacy.form.wiseBand, 'w2');
  for (const mode of ['exposures', 'd6', 'wise', 'custom']) {
    const state = parseHash(`#ra=10&dec=-5&spherex=1&wise=1&combined=1&cmode=${mode}&sxstretch=log&wcontrast=67`);
    assert.equal(state.view.showSpherex, true);
    assert.equal(state.view.sxStretch, 'log');
    assert.equal(state.view.wiseContrast, 67);
    assert.deepEqual(parseHash(buildHash(state.form, state.view)), state);
  }
});

test('a fresh launch shows the timeline tile with mission panels and their controls hidden', async () => {
  const app = await mount();
  try {
    assert.match(app.q('.combined-viewer h2').textContent, /Combined timeline/);
    assert.match(app.q('.timeline-placeholder').textContent, /Awaiting target/);
    assert.equal(app.q('[data-testid="wise-panel-controls"]'), null);
    assert.equal(app.q('[data-testid="spherex-panel-controls"]'), null);
    assert.equal(app.q('.timeline-appearance').open, false);
    assert.equal(app.q('.input-options').open, false);
    assert.equal(app.requests.length, 0, 'Changing launch presentation must not start a new query');
    assert.equal(app.q('.input-options input[type="number"]').value, '1000');
    assert.equal(app.q('.input-options select').value, 'w1w2');
    assert.equal(app.q('[data-testid="select-combined-mode"]').value, 'wise');
    for (const [name, path] of [['Generate spectrum at target', 'spectrum.html'], ['Epoch blink sequence', 'blink.html'], ['Six-detector comparison', 'compare.html']]) {
      app.button(name).click();
      assert.ok(app.opened.at(-1)[0].startsWith(path + '#'));
    }
    app.button('Fetch images').click();
    await settle(() => app.q('.combined-viewer canvas'));
    const queries = app.requests.map(u => new URL(u, 'http://localhost'));
    assert.equal(queries.find(u => u.pathname === '/api/epoch-stack').searchParams.get('limit'), '1000');
    assert.ok(queries.filter(u => u.pathname === '/api/wise-stack').every(u => u.searchParams.get('band') === 'w1w2'));
    const coadd = queries.find(u => u.pathname === '/api/epoch-coadds');
    assert.equal(coadd.searchParams.get('band'), 'SPHEREx-D6');
    assert.equal(coadd.searchParams.get('ref'), 'auto');
    assert.deepEqual(app.errors, []);
  } finally { app.dom.window.close(); }
});

test('hidden panels still supply the timeline; toggles retain playback, settings and shared pins', async () => {
  const app = await mount('#ra=10&dec=-5&cmode=exposures&speed=1200');
  try {
    await settle(() => app.q('.combined-viewer canvas'));
    assert.equal(app.requests.filter(u => u.startsWith('/api/epoch-stack')).length, 1);
    assert.equal(app.requests.filter(u => u.startsWith('/api/wise-stack')).length, 1);
    assert.equal(app.w.document.querySelectorAll('canvas').length, 1);
    assert.match(app.q('.combined-viewer .frame-count').textContent, /1\/4/);
    app.q('[aria-label="Next timeline frame"]').click();
    await settle(() => app.q('[aria-label="Timeline frame"]').value === '1');
    app.q('[aria-label="Next timeline frame"]').click();
    await settle(() => app.q('.combined-viewer .mission-tag').textContent === 'SPHEREx');
    const current = app.q('[aria-label="Timeline frame"]').value;

    app.toggle('WISE panel');
    app.toggle('SPHEREx panel');
    await settle(() => app.w.document.querySelectorAll('canvas').length === 3);
    assert.ok(app.q('[data-testid="wise-panel-controls"]'));
    assert.ok(app.q('[data-testid="spherex-panel-controls"]'));
    assert.equal(app.q('[aria-label="Timeline frame"]').value, current);
    assert.equal(app.requests.length, 2, 'Visibility toggles must reuse the loaded data');
    app.toggle('WISE panel');
    app.toggle('SPHEREx panel');
    await settle(() => app.w.document.querySelectorAll('canvas').length === 1);

    app.q('.timeline-appearance').open = true;
    // Choose the stretch selector by its supported log option (scale is a different selector).
    const stretchSelect = [...app.w.document.querySelectorAll('[aria-label="SPHEREx timeline appearance"] select')].find(s => s.querySelector('option[value="log"]'));
    stretchSelect.value = 'log'; stretchSelect.dispatchEvent(new app.w.Event('change', { bubbles: true }));
    await settle(() => app.w.location.hash.includes('sxstretch=log'));
    app.toggle('SPHEREx panel');
    await settle(() => app.q('[data-testid="spherex-panel-controls"]'));
    assert.equal([...app.w.document.querySelectorAll('[data-testid="spherex-panel-controls"] select')].find(s => s.querySelector('option[value="log"]')).value, 'log');
    app.toggle('SPHEREx panel');
    await settle(() => !app.q('[data-testid="spherex-panel-controls"]'));

    const canvas = app.q('.combined-viewer canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 450, height: 450 });
    canvas.dispatchEvent(new app.w.MouseEvent('click', { clientX: 225, clientY: 225, bubbles: true }));
    await settle(() => app.q('.timeline-pin'));
    assert.match(app.q('.timeline-pin').textContent, /10\.0000000°, -5\.0000000°/);
    app.button('Copy coordinates').click();
    await settle(() => app.copied.length === 1);
    assert.equal(app.copied[0], '10.0000000 -5.0000000');
    app.button('Generate spectrum at pin').click();
    const pinUrl = new URL(app.opened.at(-1)[0], 'http://localhost/');
    assert.equal(pinUrl.pathname, '/spectrum.html');
    assert.equal(new URLSearchParams(pinUrl.hash.slice(1)).get('ra'), '10.000000');
    app.button('Clear pin').click();
    await settle(() => !app.q('.timeline-pin'));
    app.button('Reset display settings').click();
    await settle(() => app.w.location.hash.includes('sxstretch=sqrt'));
    assert.equal(app.w.document.querySelectorAll('canvas').length, 1);
    assert.equal(app.requests.length, 2);
    assert.deepEqual(app.errors, []);
  } finally { app.dom.window.close(); }
});

test('all coadd modes and scientific recipe parameters remain available with individual panels hidden', async () => {
  const app = await mount('#ra=10&dec=-5&cmode=d6&speed=1200&cmonths=3&climit=87&cbg=none&csigma=3&citers=1&cminexp=2&cpix=6.2&cresample=nearest');
  try {
    await settle(() => app.q('.combined-viewer canvas'));
    const first = new URL(app.requests.find(u => u.startsWith('/api/epoch-coadds')), 'http://localhost');
    for (const [key, value] of Object.entries({ band: 'SPHEREx-D6', ref: 'none', bin_months: '3', limit: '87', background: 'none', sigma: '3', maxiters: '1', min_channel_exposures: '2', pixscale_arcsec: '6.2', resampling: 'nearest' })) {
      assert.equal(first.searchParams.get(key), value);
    }
    for (const mode of ['wise', 'custom']) {
      const select = app.q('[data-testid="select-combined-mode"]');
      select.value = mode; select.dispatchEvent(new app.w.Event('change', { bubbles: true }));
      await settle(() => app.q('.combined-viewer canvas') && app.requests.filter(u => u.startsWith('/api/epoch-coadds')).length === (mode === 'wise' ? 2 : 3));
      const params = new URL(app.requests.filter(u => u.startsWith('/api/epoch-coadds')).at(-1), 'http://localhost').searchParams;
      if (mode === 'wise') {
        assert.equal(params.get('band'), 'SPHEREx-D6');
        assert.equal(params.get('ref'), 'auto');
        assert.ok(app.requests.some(u => u.startsWith('/api/wise-stack') && u.includes('band=w1w2')));
      } else {
        assert.equal(params.get('short_detectors'), '1,2,3,4');
        assert.equal(params.get('long_detectors'), '5,6');
      }
      assert.equal(app.q('[data-testid="wise-panel-controls"]'), null);
      assert.equal(app.q('[data-testid="spherex-panel-controls"]'), null);
    }
    assert.deepEqual(app.errors, []);
  } finally { app.dom.window.close(); }
});

test('a missing mission leaves a useful timeline message and available individual frames', async () => {
  const app = await mount('#ra=10&dec=-5&cmode=exposures', (url, result) => url.pathname === '/api/wise-stack' ? { count: 0, frames: [] } : result);
  try {
    await settle(() => app.q('.timeline-placeholder h3')?.textContent === 'No combined timeline available');
    app.toggle('SPHEREx panel');
    await settle(() => app.q('.viewer-row canvas'));
    assert.equal(app.requests.length, 2);
    assert.deepEqual(app.errors, []);
  } finally { app.dom.window.close(); }
});
