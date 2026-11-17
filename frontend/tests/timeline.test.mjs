import { localWindow } from './localWindow.mjs';
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
  for (let i = 0; i < 2000; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The expected React state did not appear');
}

async function mount(hash = '', responseOverride) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: `http://localhost/timeline.html${hash}`, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, requests = [], opened = [], errors = [], copied = [];
  localWindow(w);
  w.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); };
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
    } else if (parsed.pathname.startsWith('/static/cutouts/')) result = {data_b64: data};
    else throw new Error(`Unexpected request: ${url}`);
    if (responseOverride) result = responseOverride(parsed, result);
    return Response.json(structuredClone(result));
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
  assert.equal(legacy.form.limit, '0', 'Historical frame caps are ignored');
  assert.equal(legacy.form.wiseBand, 'w2');
  for (const mode of ['exposures', 'd6', 'wise', 'custom']) {
    const state = parseHash(`#ra=10&dec=-5&spherex=1&wise=1&combined=1&cmode=${mode}&sxstretch=log&wcontrast=67`);
    assert.equal(state.view.showSpherex, true);
    assert.equal(state.view.sxStretch, 'log');
    assert.equal(state.view.wiseContrast, 67);
    assert.deepEqual(parseHash(buildHash(state.form, state.view)), state);
  }
});

test('settings preserve the loaded timeline, restore focus and keep hidden controls out of the active section', async () => {
  const app = await mount('#ra=10&dec=-5&cmode=exposures');
  try {
    await settle(() => app.q('.combined-viewer canvas'));
    app.q('[aria-label="Next timeline frame"]').click();
    await settle(() => app.q('[aria-label="Timeline frame"]').value === '1');
    app.button('Use current as reference').click();
    await settle(() => app.q('.timeline-reference figcaption span').textContent.includes('2010-07-01'));
    const referenceLabel = app.q('.timeline-reference figcaption').textContent;
    app.q('[aria-label="Next timeline frame"]').click();
    await settle(() => app.q('[aria-label="Timeline frame"]').value === '2');
    assert.equal(app.q('.timeline-reference figcaption').textContent, referenceLabel, 'Reference stays fixed while playback advances');
    app.q('[aria-label="Previous timeline frame"]').click();
    await settle(() => app.q('[aria-label="Timeline frame"]').value === '1');
    const referenceCanvas = app.q('[aria-label="Reference epoch image"]');
    referenceCanvas.getBoundingClientRect = () => ({left:0,top:0,width:225,height:225});
    referenceCanvas.dispatchEvent(new app.w.MouseEvent('click',{clientX:112.5,clientY:112.5,bubbles:true}));
    await settle(() => app.q('.timeline-pin'));
    assert.match(app.q('.timeline-pin').textContent, /10.0000000°, -5.0000000°/, 'CSS fitting must preserve sky coordinates on the reference canvas');
    const opener = app.button('Display settings'), before = app.requests.length;
    opener.focus(); opener.click();
    await settle(() => app.q('.workspace-settings[open]'));
    assert.equal(app.w.document.body.style.overflow, 'hidden');
    assert.equal(app.q('form[data-settings-section="target"]').parentElement.hidden, true);
    app.q('.settings-navigation button').click();
    await settle(() => !app.q('form[data-settings-section="target"]').parentElement.hidden);
    app.q('.workspace-settings').dispatchEvent(new app.w.Event('cancel', {cancelable:true}));
    await settle(() => !app.q('.workspace-settings[open]'));
    assert.equal(app.w.document.activeElement, opener);
    assert.equal(app.w.document.body.style.overflow, '');
    assert.equal(app.q('[aria-label="Timeline frame"]').value, '1');
    assert.equal(app.requests.length, before);
    assert.deepEqual(app.errors, []);
  } finally { app.dom.window.close(); }
});

test('a fresh launch shows the timeline tile with mission panels and their controls hidden', async () => {
  const app = await mount();
  try {
    assert.match(app.q('.combined-viewer h2').textContent, /Combined timeline/);
    assert.equal(app.button('Generate spectrum at target'), undefined);
    assert.match(app.q('.timeline-placeholder').textContent, /Awaiting target/);
    assert.equal(app.q('[data-testid="wise-panel-controls"]'), null);
    assert.equal(app.q('[data-testid="spherex-panel-controls"]'), null);
    assert.equal(app.q('.timeline-appearance').open, false);
    assert.equal(app.q('.input-options').open, false);
    assert.equal(app.requests.length, 0, 'Changing launch presentation must not start a new query');
    assert.equal(app.q('.input-options input[type="number"]'), null);
    assert.equal(app.q('.input-options select').value, 'w1w2');
    assert.equal(app.q('[data-testid="select-combined-mode"]').value, 'wise');
    for (const [name, path] of [['Epoch blink sequence', 'blink.html'], ['Detector & spectrum explorer', 'compare.html']]) {
      app.button(name).click();
      assert.ok(app.opened.at(-1)[0].startsWith(path + '#'));
    }
    app.button('Fetch images').click();
    await settle(() => app.q('.combined-viewer canvas'));
    const queries = app.requests.map(u => new URL(u, 'http://localhost'));
    assert.equal(queries.find(u => u.pathname === '/api/epoch-stack').searchParams.get('limit'), null);
    assert.ok(queries.filter(u => u.pathname === '/api/wise-stack').every(u => u.searchParams.get('band') === 'w1w2'));
    const coadd = queries.find(u => u.pathname === '/api/epoch-coadds');
    assert.equal(coadd.searchParams.get('band'), 'SPHEREx-D6');
    assert.equal(coadd.searchParams.get('ref'), 'auto');
    assert.deepEqual(app.errors, []);
  } finally { app.dom.window.close(); }
});

test('persistent target bar edits the shared draft and submits the current coordinates and width', async () => {
  const app = await mount();
  const edit = async (selector, value) => {
    const input = app.q(selector);
    Object.getOwnPropertyDescriptor(app.w.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new app.w.Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
  };
  try {
    const bar = app.q('.timeline-target-bar');
    assert.ok(bar && !bar.closest('dialog'), 'Target must be usable with every settings dialog closed');
    assert.equal(bar.querySelectorAll('input').length, 2);
    assert.equal(app.requests.length, 0);
    await edit('.timeline-target-bar input[aria-label="Target coordinates"]', 'invalid');
    bar.requestSubmit();
    await settle(() => app.q('.timeline-target-bar input[aria-invalid="true"]'));
    assert.equal(app.requests.length, 0, 'Invalid coordinates must not query either archive');
    await edit('.timeline-target-bar input[aria-label="Target coordinates"]', '12.5, -8.25');
    await edit('.timeline-target-bar input[type="number"]', '120');
    assert.equal(app.q('.timeline-target-bar input[aria-invalid="true"]'), null);
    await edit('.timeline-target-bar input[type="number"]', '');
    assert.equal(bar.checkValidity(), false, 'An empty field width must not submit');
    await edit('.timeline-target-bar input[type="number"]', '120');
    app.button('Target & images').click();
    await settle(() => app.q('dialog[open]'));
    assert.equal(app.q('dialog input[aria-label="Target coordinates"]').value, '12.5, -8.25');
    assert.equal(app.q('dialog input[aria-label="Field width (arcsec)"]').value, '120');
    await edit('dialog input[aria-label="Field width (arcsec)"]', '90');
    app.q('[aria-label="Close settings"]').click();
    await settle(() => !app.q('dialog[open]'));
    assert.equal(bar.querySelector('input[type="number"]').value, '90');
    assert.equal(app.requests.length, 0, 'Editing the draft must not fetch until submitted');
    bar.requestSubmit();
    await settle(() => app.q('.combined-viewer canvas'));
    const queries = app.requests.map(url => new URL(url, 'http://localhost'));
    for (const query of queries) {
      assert.equal(query.searchParams.get('ra'), '12.5');
      assert.equal(query.searchParams.get('dec'), '-8.25');
      assert.equal(query.searchParams.get(query.pathname === '/api/wise-stack' ? 'size_arcsec' : 'radius_arcsec'), query.pathname === '/api/wise-stack' ? '90' : '45');
    }
    assert.equal(queries.filter(u => u.pathname === '/api/epoch-stack').length, 1);
    assert.equal(queries.filter(u => u.pathname === '/api/wise-stack').length, 1, 'Matched-color mode reuses the same W1+W2 local recipe');
    assert.equal(new URLSearchParams(app.w.location.hash.slice(1)).get('size'), '90');
    app.toggle('Combined timeline');
    await settle(() => !app.q('.timeline-primary'));
    assert.ok(app.q('.timeline-target-bar'), 'Target remains available with every panel hidden');
    assert.equal(app.q('.timeline-target-bar button').disabled, false);
    assert.deepEqual(app.errors, []);
  } finally { app.dom.window.close(); }
});

for (const release of ['dr1', 'qr3']) {
  test(`${release.toUpperCase()} selection reaches image queries and all auxiliary tools`, async () => {
    const app = await mount(`#ra=10&dec=-5&release=${release}`);
    try {
      await settle(() => app.q('.combined-viewer canvas'));
      const queries = app.requests.map(u => new URL(u, 'http://localhost'));
      for (const path of ['/api/epoch-stack', '/api/epoch-coadds']) {
        assert.equal(queries.find(u => u.pathname === path).searchParams.get('release'), release);
      }
      for (const name of ['Epoch blink sequence', 'Detector & spectrum explorer']) {
        app.button(name).click();
        assert.equal(new URLSearchParams(app.opened.at(-1)[0].split('#')[1]).get('release'), release);
      }
      assert.deepEqual(app.errors, []);
    } finally { app.dom.window.close(); }
  });
}

test('a legacy QR2 bookmark stays explicit instead of silently selecting current data', async () => {
  const app = await mount('#ra=10&dec=-5&release=qr2');
  try {
    await settle(() => app.q('.combined-viewer canvas'));
    const option = app.w.document.querySelector('option[value="qr2"]');
    assert.ok(option.selected && option.disabled);
    assert.match(option.textContent, /retired/);
    const select = option.parentElement;
    assert.ok(select.querySelector('option[value="dr1"]'));
    assert.ok(select.querySelector('option[value="qr3"]'));
    assert.deepEqual(app.errors, []);
  } finally { app.dom.window.close(); }
});

test('hidden panels still supply the timeline; toggles retain playback, settings and shared pins', async () => {
  const app = await mount('#ra=10&dec=-5&cmode=exposures&speed=1200');
  try {
    await settle(() => app.q('.combined-viewer canvas'));
    assert.equal(app.requests.filter(u => u.startsWith('/api/epoch-stack')).length, 1);
    assert.equal(app.requests.filter(u => u.startsWith('/api/wise-stack')).length, 1);
    assert.equal(app.w.document.querySelectorAll('canvas').length, 2);
    assert.match(app.q('.combined-viewer .frame-count').textContent, /1\/4/);
    app.q('[aria-label="Next timeline frame"]').click();
    await settle(() => app.q('[aria-label="Timeline frame"]').value === '1');
    app.q('[aria-label="Next timeline frame"]').click();
    await settle(() => app.q('.combined-viewer .mission-tag').textContent === 'SPHEREx');
    const current = app.q('[aria-label="Timeline frame"]').value;

    app.toggle('WISE panel');
    app.toggle('SPHEREx panel');
    await settle(() => app.w.document.querySelectorAll('canvas').length === 4);
    assert.ok(app.q('[data-testid="wise-panel-controls"]'));
    assert.ok(app.q('[data-testid="spherex-panel-controls"]'));
    assert.equal(app.q('[aria-label="Timeline frame"]').value, current);
    assert.equal(app.requests.length, 2, 'Visibility toggles must reuse the loaded data');
    app.toggle('WISE panel');
    app.toggle('SPHEREx panel');
    await settle(() => app.w.document.querySelectorAll('canvas').length === 2);

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
    app.button('Explore spectrum at pin').click();
    const pinUrl = new URL(app.opened.at(-1)[0], 'http://localhost/');
    assert.equal(pinUrl.pathname, '/compare.html');
    assert.equal(new URLSearchParams(pinUrl.hash.slice(1)).get('pinra'), '10');
    assert.equal(new URLSearchParams(pinUrl.hash.slice(1)).get('pindec'), '-5');
    assert.equal(new URLSearchParams(pinUrl.hash.slice(1)).get('ra'), '10');
    app.button('Clear pin').click();
    await settle(() => !app.q('.timeline-pin'));
    app.button('Reset display settings').click();
    await settle(() => app.w.location.hash.includes('sxstretch=sqrt'));
    assert.equal(app.w.document.querySelectorAll('canvas').length, 2);
    assert.equal(app.requests.length, 2);
    assert.deepEqual(app.errors, []);
  } finally { app.dom.window.close(); }
});

test('all coadd modes and scientific recipe parameters remain available with individual panels hidden', async () => {
  const app = await mount('#ra=10&dec=-5&cmode=d6&speed=1200&cmonths=3&climit=87&cbg=none&csigma=3&citers=1&cminexp=2&cpix=6.2&cresample=nearest');
  try {
    await settle(() => app.q('.combined-viewer canvas'));
    const first = new URL(app.requests.find(u => u.startsWith('/api/epoch-coadds')), 'http://localhost');
    assert.equal(first.searchParams.get('limit'), null, 'Legacy coadd cap must not survive');
    for (const [key, value] of Object.entries({ band: 'SPHEREx-D6', ref: 'none', bin_months: '3', background: 'none', sigma: '3', maxiters: '1', min_channel_exposures: '2', pixscale_arcsec: '6.2', resampling: 'nearest' })) {
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

test('all 1007 frames are saved locally and decoded pixels remain bounded', async () => {
  const app = await mount('#ra=10&dec=-5&cmode=exposures&speed=5000&maxframes=1', (url, result) => {
    if (url.pathname !== '/api/epoch-stack') return result;
    return {count:1007, n_attempted:1008, n_exposures_skipped:1,
      omissions:[{obs_id:'missing',reason:'download failed'}],
      cutouts:Array.from({length:1007}, (_, i) => ({...raw[0],data_b64:undefined,
        id:`lazy-${i}`,data_url:`/static/cutouts/lazy-${i}.json`,
        metadata:{...raw[0].metadata,mjd_mid:61000+i}}))};
  });
  try {
    await settle(() => app.q('.combined-viewer canvas'));
    assert.match(app.q('.processing-details').textContent, /download failed/);
    assert.equal(app.requests.filter(u => u.startsWith('/static/')).length,1007,'Every frame is saved locally before publishing the snapshot');
    // Let the initial frame-set effect reset playback before scrubbing.
    await new Promise(resolve => setTimeout(resolve, 40));
    const slider = app.q('[aria-label="Timeline frame"]');
    assert.equal(slider.max,'1008');
    Object.getOwnPropertyDescriptor(app.w.HTMLInputElement.prototype,'value').set.call(slider,'1008');
    slider.dispatchEvent(new app.w.Event('input',{bubbles:true}));
    await settle(() => app.requests.includes('/static/cutouts/lazy-1006.json'));
    await settle(() => app.q('.combined-viewer .frame-count').textContent === '1009/1009' && !app.q('.combined-viewer [role="status"]'));
    assert.equal(app.q('.combined-viewer .frame-count').textContent,'1009/1009');
    app.button('Use current as reference').click();
    app.q('[aria-label="Previous timeline frame"]').click();
    await settle(() => app.requests.includes('/static/cutouts/lazy-1005.json'));
    assert.equal(app.requests.filter(u => u.startsWith('/static/')).length,1007,'Scrubbing uses local pixels without server requests');
    app.toggle('SPHEREx panel');
    await settle(() => app.q('.viewer-row canvas'));
    await new Promise(resolve => setTimeout(resolve, 40));
    const rawSlider = app.q('.viewer-row input[type="range"]');
    for (let index = 1; index <= 15; index++) {
      Object.getOwnPropertyDescriptor(app.w.HTMLInputElement.prototype,'value').set.call(rawSlider,String(index));
      rawSlider.dispatchEvent(new app.w.Event('input',{bubbles:true}));
      await settle(() => app.requests.includes(`/static/cutouts/lazy-${index}.json`));
    }
    app.q('[aria-label="Next timeline frame"]').click();
    await settle(() => app.q('.combined-viewer .frame-count').textContent === '1009/1009');
    assert.equal(app.requests.filter(u => u === '/static/cutouts/lazy-1006.json').length,1,
      'The reference pixels stay pinned while another panel churns the cache');
    assert.ok(app.q('.timeline-target-bar'));
    assert.deepEqual(app.errors,[]);
  } finally { app.dom.window.close(); }
});

test('failed lazy pixels show an error rather than silently advancing playback', async () => {
  const app = await mount('#ra=10&dec=-5&cmode=exposures&spherex=1', (url,result) => {
    if (url.pathname === '/api/epoch-stack') return {count:1,cutouts:[{...raw[0], data_b64:undefined,data_url:'/static/cutouts/unavailable.json'}]};
    if (url.pathname.startsWith('/static/')) throw new Error('Synthetic pixel download failed');
    return result;
  });
  try {
    await settle(() => app.q('[role="alert"]') || app.q('.error'));
    assert.match((app.q('[role="alert"]') || app.q('.error')).textContent,/Synthetic pixel download failed/);
    assert.ok(app.q('.timeline-target-bar'));
    assert.deepEqual(app.errors,[]);
  } finally { app.dom.window.close(); }
});
