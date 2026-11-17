// DOM integration uses explicitly synthetic data; it does not claim visual QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { readState, recipeFromForm } from '../src/lib/comparison.js';
import { pixelToWorld } from '../src/lib/render.js';

const encode = values => ({ dtype: '<f4', data_b64: Buffer.from(new Float32Array(values).buffer).toString('base64') });
const fixture = {
  width: 4, height: 4, n_selected: 12, n_unique_inventory: 12, preview_subset: false,
  recipe: { ra: 10, dec: -5, pixscale_arcsec: 6.2, min_exposures: 1, background: 'zodi', weighting: 'equal', resampling: 'bin' },
  wcs: { height: 4, crpix1: 2.5, crpix2: 2.5, crval1: 10, crval2: -5, cd11: -6.2/3600, cd12: 0, cd21: 0, cd22: 6.2/3600 },
  inputs: [], epochs: [0, 1].map(epoch => ({ index: epoch, grouping: 'visit', datetime_start: '2026-01-01T00:00:00', datetime_end: '2026-01-02T00:00:00', complete_six: epoch === 0,
    tiles: [1,2,3,4,5,6].map(d => ({ detector: d, status: epoch === 1 && d === 6 ? 'missing' : 'ok', n_inventory: 1, n_selected: 1, n_accepted: 1, failures: {}, mjd_start: 61000 + epoch, mjd_end: 61000 + epoch,
      maps: epoch === 1 && d === 6 ? undefined : Object.fromEntries(['intensity','variance','coverage','hits','wavelength','lambda_min','lambda_max','bandwidth','mjd','mjd_min','mjd_max'].map(key => [key, encode(Array.from({length:16}, (_, i) => key === 'intensity' ? i + d : key === 'variance' ? 4 : key.startsWith('mjd') ? 61000 + epoch : key === 'bandwidth' ? .03 : 1))])) })) }))
};

for (const scenario of ['match', 'different recipe', 'missing result']) test(`saved comparison: ${scenario}`, async () => {
  const bundle = await build({ entryPoints: ['src/compare.jsx'], bundle: true, format: 'iife', jsx: 'automatic', write: false, loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const hash = `#ra=10&dec=-5&epoch=1&pinra=10&pindec=-5&result=${'a'.repeat(32)}`;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: `http://localhost/compare.html${hash}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, requests = [];
  w.structuredClone = structuredClone;
  w.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, clearRect() {}, drawImage() {}, putImageData() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, stroke() {}, fillText() {}, createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }) });
  w.fetch = async (url, options) => {
    requests.push([url, options]);
    const saved = structuredClone(fixture);
    saved.recipe = recipeFromForm(readState(hash).form);
    if (scenario === 'different recipe') saved.recipe.ra = 30;
    return { ok: scenario !== 'missing result', status: 404, json: async () => scenario === 'missing result' ? { detail: 'Result no longer exists' } : saved };
  };
  try {
    vm.runInContext(bundle.outputFiles[0].text, dom.getInternalVMContext());
    if (scenario === 'match') {
      await settle(() => w.document.querySelector('.compare-status')?.textContent.includes('saved result'));
      assert.equal(w.document.querySelectorAll('.detector-grid canvas').length, 7);
      assert.match(w.document.querySelector('.epoch-slider').textContent, /2 \/ 2/);
      assert.match(w.document.querySelector('.spectrum-heading').textContent, /PINNED/);
      assert.ok(w.location.hash.includes(`result=${'a'.repeat(32)}`));
    } else {
      await settle(() => w.document.querySelector('.compare-error'));
      assert.equal(w.document.querySelectorAll('.detector-grid canvas').length, 0, 'Never show a mismatched saved field');
    }
    assert.equal(requests.length, 1, 'Restoring or rejecting a saved link must not trigger a build');
    assert.equal(requests[0][1], undefined);
  } finally { dom.window.close(); }
});

fixture.recipe.aperture_radius_arcsec = 12.4;
for (const e of fixture.epochs) {
  e.data_release = 'qr3';
  e.spectra = Array.from({length:12}, (_, j) => ({detector:j%6+1, obs_id:`sample${j}`, mjd:61000+j, data_release:'qr3',
    maps: Object.fromEntries(['flux','sky_flux','variance','sky_variance','wavelength','bandwidth','lambda_min','lambda_max','aperture_coverage','sky_coverage'].map(key=>[key, encode(Array.from({length:16}, (_,i)=>['flux','sky_flux'].includes(key)?100*j+i: ['variance','sky_variance'].includes(key)?4:key==='wavelength'?1+j*.3:key==='lambda_min'?.99+j*.3:key==='lambda_max'?1.01+j*.3:key==='bandwidth'?.03:1))]))}));
}

async function settle(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('DOM did not reach the expected state');
}

test('real React entry builds seven tiles with a local spectrum, links pins and epochs, and keeps pending recipes separate', async () => {
  const bundle = await build({ entryPoints: ['src/compare.jsx'], bundle: true, format: 'iife', jsx: 'automatic', write: false, loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/compare.html#ra=10&dec=-5', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, requests = [], errors = [];
  w.structuredClone = structuredClone;
  w.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); };
  w.console.error = (...args) => errors.push(args.join(' '));
  w.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, clearRect() {}, drawImage() {}, putImageData() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, stroke() {}, fillText() {}, createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }) });
  w.fetch = async (url, options) => {
    requests.push([url, options]);
    const data = options?.method === 'POST' ? { job_id: 'abc' } : url.endsWith('/result') ? structuredClone(fixture) : { status: 'complete', message: 'Synthetic fixture ready' };
    return { ok: true, json: async () => data };
  };
  const click = selector => w.document.querySelector(selector).click();
  try {
    vm.runInContext(bundle.outputFiles[0].text, dom.getInternalVMContext());
    await settle(() => w.document.querySelectorAll('canvas').length === 7);
    assert.equal(requests.filter(([, o]) => o?.method === 'POST').length, 1);
    assert.equal(JSON.parse(requests[0][1].body).max_per_tile, 0);
    assert.equal(JSON.parse(requests[0][1].body).include_spectra, true);
    assert.equal(w.document.querySelectorAll('.detector-key .active').length, 6);
    const settingsButton = w.document.querySelector('.workspace-actions button');
    settingsButton.focus(); settingsButton.click();
    await settle(() => w.document.querySelector('.workspace-settings[open]'));
    assert.equal(w.document.body.style.overflow, 'hidden');
    const beforeModal = w.location.hash;
    w.document.querySelector('dialog').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(w.location.hash, beforeModal, 'Workspace shortcuts must not change epochs behind settings');
    [...w.document.querySelectorAll('.settings-navigation button')].find(b=>b.textContent==='Image display').click();
    await settle(() => w.document.querySelector('form[data-settings-section]').parentElement.hidden);
    w.document.querySelector('dialog').dispatchEvent(new w.Event('cancel', {cancelable:true}));
    await settle(() => !w.document.querySelector('.workspace-settings[open]'));
    assert.equal(w.document.activeElement, settingsButton);
    assert.equal(w.document.body.style.overflow, '');
    assert.equal(requests.filter(([,o])=>o?.method==='POST').length, 1);
    const canvas = w.document.querySelector('canvas');
    canvas.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(() => w.document.querySelector('.source-title').textContent.includes('Pinned source'));
    assert.equal(w.document.querySelectorAll('tbody tr').length, 6);
    assert.ok(w.location.hash.includes('pinra='));
    assert.ok(!w.document.body.textContent.includes('Generate spectrum'));
    assert.ok(w.document.querySelector('[aria-label="Live aperture spectrum"]').textContent.includes('12 exposure samples'));
    const options = [...w.document.querySelectorAll('.spectrum-options input')];
    assert.equal(options[0].checked, false, 'Median guide defaults off');
    assert.equal(options[1].checked, false, 'Measurement rings default off');
    options[0].click(); options[1].click();
    await settle(() => w.location.hash.includes('speclines=1') && w.location.hash.includes('apertureoverlay=1'));
    assert.ok(w.document.querySelector('.spectrum-guides'));
    options[0].click();
    await settle(()=>!w.document.querySelector('.spectrum-guides'));
    const apertureSelect = w.document.querySelector('[aria-label="Aperture pixels"]');
    assert.equal(apertureSelect.value,'complete');
    assert.equal(w.document.querySelector('[aria-label="Spectrum background"]').value, 'annulus');
    apertureSelect.value='usable'; apertureSelect.dispatchEvent(new w.Event('change',{bubbles:true}));
    await settle(()=>w.location.hash.includes('speccomplete=0'));
    [...w.document.querySelectorAll('button')].find(b=>b.textContent==='Use field center').click();
    await settle(()=>w.location.hash.includes('pinra=10'));
    assert.ok(w.document.querySelector('.spectrum-heading').textContent.includes('from field center'));
    const advanced = new URL(w.document.querySelector('.advanced-photometry a').href);
    assert.equal(advanced.pathname, '/spectrum.html');
    assert.equal(Number(new URLSearchParams(advanced.hash.slice(1)).get('ra')), 10);
    assert.match(w.document.querySelector('.advanced-photometry').textContent, /different measurement/);
    const targetInput = w.document.querySelector('.quick-target [aria-label="Target coordinates"]');
    assert.ok(targetInput && !targetInput.closest('dialog'));
    const fieldInput = w.document.querySelector('.quick-target [aria-label="Field width (arcsec)"]');
    assert.ok(fieldInput && !fieldInput.closest('dialog'));
    const callsBeforeHover = requests.length;
    [...w.document.querySelectorAll('button')].find(b=>b.textContent==='RGB composite').click();
    await settle(()=>w.document.querySelector('.image-workspace').dataset.imageView==='rgb');
    assert.equal(w.document.querySelector('.image-workspace .compare-scale').closest('.image-deck-view').getAttribute('aria-hidden'), 'true', 'RGB must not expose the grayscale scale');
    assert.ok(w.document.querySelector('[data-view=detectors]').hasAttribute('inert'));
    assert.ok(!w.document.querySelector('[data-view=rgb]').hasAttribute('inert'));
    assert.equal(readState(w.location.hash).display.imageView, 'rgb');
    assert.match(w.document.querySelector('.rgb-legend').textContent, /peak-channel brightness/);
    const scientificReadout = w.document.querySelector('.source-readout').textContent;
    const spectrumPlot = w.document.querySelector('.spectrum-plot').innerHTML;
    const fitsLink = w.document.querySelector('a[href$="epochs/0.fits"]').href;
    const pinnedBeforeLayout = readState(w.location.hash).pin;
    assert.equal(w.document.querySelector('[aria-label="Image area"]'), null, 'No detached layout slider');
    const workspace = w.document.querySelector('.analysis-workspace');
    workspace.getBoundingClientRect = () => ({width:1000,top:160});
    const resize = w.document.querySelector('[aria-label="Resize image panel e"]');
    resize.dispatchEvent(new w.KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true}));
    await settle(() => readState(w.location.hash).display.imageFraction === 52);
    assert.equal(w.document.querySelector('.spectrum-plot').innerHTML, spectrumPlot);
    resize.dispatchEvent(new w.KeyboardEvent('keydown', {key:'Home',bubbles:true}));
    await settle(() => readState(w.location.hash).display.imageFraction === 50);
    assert.equal(w.document.querySelectorAll('.panel-resize').length,10);
    resize.setPointerCapture = () => {}; resize.hasPointerCapture = () => true; resize.releasePointerCapture = () => {};
    const pointer = (type,x) => {const e=new w.Event(type,{bubbles:true});Object.assign(e,{button:0,clientX:x,clientY:300,pointerId:1});resize.dispatchEvent(e);};
    pointer('pointerdown',500); pointer('pointermove',600);
    await settle(() => readState(w.location.hash).display.imageFraction === 60);
    pointer('pointercancel',600); pointer('pointermove',700);
    await new Promise(r=>setTimeout(r,20));
    assert.equal(readState(w.location.hash).display.imageFraction,60,'Cancelled drag cannot keep resizing');
    [...w.document.querySelectorAll('button')].find(b => b.textContent === 'Fit workspace').click();
    await settle(() => readState(w.location.hash).display.imageFraction === 50);

    const workspaceButtons = [...w.document.querySelectorAll('.workspace-view-switch button')];
    for (const [label, value] of [['Images only', 'images'], ['Spectrum only', 'spectrum'], ['Images + spectrum', 'split']]) {
      workspaceButtons.find(b => b.textContent === label).click();
      await settle(() => readState(w.location.hash).display.workspaceLayout === value);
      assert.equal(w.document.querySelector('.image-workspace').hidden, value === 'spectrum');
      assert.equal(w.document.querySelector('.spectrum-workspace').hidden, value === 'images');
      assert.equal(w.document.querySelector('.spectrum-plot').innerHTML, spectrumPlot);
      assert.deepEqual(readState(w.location.hash).pin, pinnedBeforeLayout);
      assert.equal(w.document.querySelectorAll('.detector-grid canvas').length, 7);
      assert.equal(requests.length, callsBeforeHover, 'Focus modes must not rebuild or fetch');
    }

    const rgbBackground = w.document.querySelector('.view-toolbar [aria-label="RGB background"]');
    rgbBackground.value='neutral'; rgbBackground.dispatchEvent(new w.Event('change',{bubbles:true}));
    await settle(()=>w.location.hash.includes('rgbbg=neutral'));
    assert.equal(w.document.querySelector('.source-readout').textContent, scientificReadout);
    assert.equal(w.document.querySelector('.spectrum-plot').innerHTML, spectrumPlot);
    assert.equal(w.document.querySelector('a[href$="epochs/0.fits"]').href,fitsLink);
    assert.equal(requests.length,callsBeforeHover,'RGB changes must make no archive, extraction or rebuild request');
    assert.equal(w.document.querySelector('.rgb-legend details').open, false, 'RGB explanatory content stays collapsed by default');
    rgbBackground.value='shared'; rgbBackground.dispatchEvent(new w.Event('change',{bubbles:true}));
    await settle(()=>w.location.hash.includes('rgbbg=shared'));
    const rgb = w.document.querySelector('canvas[aria-label^="RGB"]');
    rgb.getBoundingClientRect = () => ({left:0,top:0,width:600,height:600});
    rgb.dispatchEvent(new w.MouseEvent('pointermove', {clientX:80,clientY:80,bubbles:true}));
    await settle(() => w.document.querySelector('.spectrum-heading').textContent.includes('HOVER'));
    rgb.dispatchEvent(new w.MouseEvent('pointerout', {bubbles:true}));
    await settle(() => w.document.querySelector('.spectrum-heading').textContent.includes('PINNED'));
    rgb.dispatchEvent(new w.KeyboardEvent('keydown', {key:'Enter',bubbles:true}));
    assert.equal(requests.length, callsBeforeHover, 'Hover and pins never request another spectrum');
    click('button[aria-label="Next epoch"]');
    await settle(() => w.document.querySelector('.epoch-slider').textContent.includes('2 / 2'));
    assert.ok(w.document.body.textContent.includes('No observations in this epoch'));
    const inputs = [...w.document.querySelectorAll('.compare-toolbar input[type="checkbox"]')];
    inputs[0].click();
    await settle(() => w.document.querySelector('.epoch-slider').textContent.includes('1 / 2'));
    const layer = [...w.document.querySelectorAll('select')].find(e => e.querySelector('option[value="coverage"]'));
    layer.value = 'coverage'; layer.dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle(() => w.location.hash.includes('layer=coverage'));
    assert.equal(requests.filter(([, o]) => o?.method === 'POST').length, 1, 'Display changes must not rebuild coadds');
    const survey = [...w.document.querySelectorAll('select')].find(e => e.querySelector('option[value="deep"]'));
    survey.value = 'deep'; survey.dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle(() => !!w.document.querySelector('.compare-pending'));
    assert.ok(w.location.hash.includes('survey=wide'), 'Shared result link keeps the displayed recipe');
    assert.equal(w.document.querySelector('a[href$="epochs/0.fits"]').getAttribute('href'), '/api/detector-comparison/abc/epochs/0.fits');
    assert.deepEqual(errors, []);
  } finally { dom.window.close(); }
});

for (const legacy of [false, true]) {
  test(`${legacy ? 'older saved' : 'images-only'} results keep seven images without a broken spectrum download`, async () => {
    const bundle = await build({ entryPoints: ['src/compare.jsx'], bundle: true, format: 'iife', jsx: 'automatic', write: false, loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
    const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/compare.html#ra=10&dec=-5&release=dr1&spectra=0', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window, requests = [], errors = [];
    w.structuredClone = structuredClone;
    w.console.error = (...args) => errors.push(args.join(' '));
    w.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, clearRect() {}, drawImage() {}, putImageData() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, stroke() {}, fillText() {}, createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }) });
    const result = structuredClone(fixture);
    for (const e of result.epochs) { delete e.spectra; if (!legacy) e.spectra_enabled = false; }
    if (!legacy) result.recipe.include_spectra = false;
    w.fetch = async (url, options) => {
      requests.push([url, options]);
      return { ok: true, json: async () => options?.method === 'POST' ? {job_id:'abc'} : url.endsWith('/result') ? structuredClone(result) : {status:'complete',message:'Images ready'} };
    };
    try {
      vm.runInContext(bundle.outputFiles[0].text, dom.getInternalVMContext());
      await settle(() => w.document.querySelectorAll('canvas').length === 7);
      assert.equal(JSON.parse(requests[0][1].body).include_spectra, false);
      assert.equal(JSON.parse(requests[0][1].body).release, 'dr1');
      assert.equal(w.document.querySelector('[aria-label="Precompute aperture spectra"]').checked, false);
      assert.equal(w.document.querySelector('a[href*="/spectra/"]'), null);
      assert.ok(w.document.querySelector('a[href$="epochs/0.fits"]'));
      w.document.querySelector('canvas').dispatchEvent(new w.KeyboardEvent('keydown', {key:'Enter',bubbles:true}));
      await settle(() => w.document.querySelector('.spectrum-empty').textContent.includes(legacy ? 'No precomputed' : 'Images-only'));
      const before = requests.length;
      w.document.querySelector('[aria-label="Precompute aperture spectra"]').click();
      await settle(() => !!w.document.querySelector('.compare-pending'));
      assert.equal(requests.length, before, 'Changing a pending recipe must not submit a build');
      assert.ok(w.location.hash.includes('spectra=0'), 'The shared URL still describes the displayed result');
      assert.deepEqual(errors, []);
    } finally { dom.window.close(); }
  });
}

test('expanded detector navigation, three color modes, wheel navigation and exports preserve the coadds', async () => {
  const bundle = await build({ entryPoints: ['src/compare.jsx'], bundle: true, format: 'iife', jsx: 'automatic', write: false, loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost:8001/#ra=10&dec=-5&colorsigma=0', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, requests = [], errors = [], blobs = [], pixels = [];
  w.structuredClone = structuredClone; w.Blob = Blob;
  w.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); };
  w.console.error = (...args) => errors.push(args.join(' '));
  w.URL.createObjectURL = blob => { blobs.push(blob); return 'blob:test'; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = () => {};
  w.HTMLCanvasElement.prototype.toBlob = function(callback) { callback(new Blob(['synthetic-canvas'], { type: 'image/png' })); };
  w.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 600 });
  w.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, clearRect() {}, drawImage() {}, putImageData(data) { pixels.push([...data.data]); }, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, stroke() {}, fillText() {}, createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }) });
  w.fetch = async (url, options) => {
    requests.push([url, options]);
    const data = options?.method === 'POST' ? { job_id: 'abc' } : url.endsWith('/result') ? structuredClone(fixture) : { status: 'complete', message: 'Synthetic fixture ready' };
    return { ok: true, json: async () => data };
  };
  const button = name => [...w.document.querySelectorAll('button')].find(e => e.textContent === name);
  const params = () => new URLSearchParams(w.location.hash.slice(1));
  try {
    vm.runInContext(bundle.outputFiles[0].text, dom.getInternalVMContext());
    await settle(() => w.document.querySelectorAll('canvas').length === 7);
    assert.equal(w.document.querySelector('[aria-label="Zoom in"]'), null, 'No duplicate zoom toolbar');
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: '+', bubbles: true }));
    await settle(() => Number(params().get('zoom')) > 1);
    const oldZoom = Number(params().get('zoom'));
    const wheel = new w.WheelEvent('wheel', { deltaY: -100, clientX: 450, clientY: 150, bubbles: true, cancelable: true });
    w.document.querySelector('canvas').dispatchEvent(wheel);
    assert.equal(wheel.defaultPrevented, true);
    await settle(() => Number(params().get('zoom')) > oldZoom);
    assert.ok(Number(params().get('panx')) < 0);
    button('Reset field of view').click();
    await settle(() => params().get('zoom') === '1' && params().get('panx') === '0');
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: '-', bubbles: true }));
    await settle(() => Number(params().get('zoom')) < 1);
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: '0', bubbles: true }));
    await settle(() => params().get('zoom') === '1');
    const expand = w.document.querySelector('[aria-label="Expand D3"]');
    expand.click();
    await settle(() => !!w.document.querySelector('dialog[open]'));
    assert.ok(w.document.querySelector('#expanded-title').textContent.startsWith('D3'));
    assert.equal(w.document.querySelector('.expanded-tile canvas').width, 1200);
    assert.equal(w.document.querySelectorAll('.detector-grid canvas').length, 7);
    const savedEpoch = params().get('epoch');
    w.document.querySelector('[aria-label="Next detector"]').click();
    await settle(() => w.document.querySelector('#expanded-title').textContent.startsWith('D4'));
    w.document.querySelector('[aria-label="Previous detector"]').click();
    await settle(() => w.document.querySelector('#expanded-title').textContent.startsWith('D3'));
    w.document.querySelector('[aria-label="View D6"]').click();
    await settle(() => w.document.querySelector('#expanded-title').textContent.startsWith('D6'));
    w.document.querySelector('.expanded-tile canvas').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settle(() => w.document.querySelector('#expanded-title').textContent.startsWith('RGB'));
    w.document.querySelector('[aria-label="Next detector"]').click();
    await settle(() => w.document.querySelector('#expanded-title').textContent.startsWith('D1'));
    assert.equal(params().get('epoch'), savedEpoch, 'Expanded arrows change detector, never epoch');
    assert.equal(params().get('zoom'), '1', 'Expansion never changes magnification');
    const bigCanvas = w.document.querySelector('.expanded-tile canvas');
    bigCanvas.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(() => params().has('pinra'));
    assert.ok(Math.abs(Number(params().get('pinra')) - pixelToWorld(fixture.wcs, 2.5, 2.5)[0]) < 1e-8);
    assert.ok(Math.abs(Number(params().get('pindec')) - pixelToWorld(fixture.wcs, 2.5, 2.5)[1]) < 1e-8);
    bigCanvas.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100, clientX: 450, clientY: 150, bubbles: true, cancelable: true }));
    await settle(() => Number(params().get('zoom')) > 1);
    const savedView = ['zoom', 'panx', 'pany'].map(k => params().get(k));
    w.document.querySelector('[aria-label="Next detector"]').click();
    await settle(() => w.document.querySelector('#expanded-title').textContent.startsWith('D2'));
    assert.deepEqual(['zoom', 'panx', 'pany'].map(k => params().get(k)), savedView);
    w.document.querySelector('.expanded-dialog').dispatchEvent(new w.Event('cancel', { bubbles: false, cancelable: true }));
    await settle(() => !w.document.querySelector('.expanded-dialog'));
    assert.equal(w.document.activeElement, expand, 'Return focus to the tile that opened the modal');
    assert.equal(w.document.body.style.overflow, '');
    pixels.length = 0;
    button('Color comparison').click();
    await settle(() => w.document.querySelectorAll('.tile-color-key').length === 7);
    assert.equal(w.document.querySelector('[aria-label="Color meaning"]').textContent.includes('formal σ'), true);
    assert.ok(pixels.some(p => p[0] !== p[2]), 'Color rendering must differ from grayscale on the synthetic contrast');
    const reference = w.document.querySelector('.color-options select');
    reference.value = '6'; reference.dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle(() => params().get('reference') === '6');
    w.document.querySelector('[aria-label="Next epoch"]').click();
    await settle(() => w.document.body.textContent.includes('Reference D6 unavailable'));
    assert.equal(w.document.querySelectorAll('.detector-empty').length, 7);
    reference.value = '4'; reference.dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle(() => w.document.querySelectorAll('.detector-empty').length === 2);
    button('Export tiles PNG + settings').click();
    await settle(() => blobs.some(b => b.type === 'application/json'));
    const exported = JSON.parse(await blobs.find(b => b.type === 'application/json').text());
    assert.equal(exported.display.mode, 'color'); assert.equal(exported.display.reference, 4);
    assert.equal(exported.display.color_method, 'two-channel-common-gain-v1');
    assert.ok(exported.display.color_white > 0);
    assert.equal(exported.epoch, 1); assert.equal(exported.epochs[0].tiles.length, 6);
    pixels.length = 0; blobs.length = 0;
    button('Wavelength color').click();
    await settle(() => params().get('mode') === 'wavelength');
    assert.ok(w.document.querySelector('[aria-label="Wavelength color meaning"]').textContent.includes('CWAVE'));
    assert.ok(pixels.some(p => p[0] !== p[2]), 'Calibrated wavelength renders hue');
    assert.equal(w.document.querySelectorAll('.detector-empty').length, 2, 'Missing reference does not affect wavelength mode');
    w.document.querySelector('[aria-label="Expand D6"]').click();
    await settle(() => !!w.document.querySelector('.expanded-dialog'));
    assert.ok(w.document.querySelector('.expanded-tile').textContent.includes('No observations in this epoch'), 'Keep a missing detector empty in expanded view');
    w.document.querySelector('.expanded-dialog').dispatchEvent(new w.Event('cancel', { cancelable: true }));
    await settle(() => !w.document.querySelector('.expanded-dialog'));
    button('Export tiles PNG + settings').click();
    await settle(() => blobs.some(b => b.type === 'application/json'));
    const waveExport = JSON.parse(await blobs.find(b => b.type === 'application/json').text());
    assert.ok(waveExport.display.rgb.white_mjy_sr > 0);
    assert.deepEqual(waveExport.display.rgb.background.offsets_mjy_sr, [0,0,0]);
    assert.equal(waveExport.display.rgb.epoch_backgrounds.length, fixture.epochs.length);
    assert.equal(waveExport.display.wavelength_color.method, 'cwave-mean-equal-luminance-v1');
    assert.equal(waveExport.display.wavelength_color.palette_stops_srgb8.length, 7);
    assert.ok(waveExport.display.wavelength_color.white_mjy_sr > 0);
    assert.equal(waveExport.display.color_method, null, 'Do not label wavelength colors as detector differences');
    button('Grayscale').click();
    await settle(() => !w.document.querySelector('.color-legend'));
    assert.equal(requests.filter(([, o]) => o?.method === 'POST').length, 1);
    assert.deepEqual(errors, []);
  } finally { w.close(); }
});
