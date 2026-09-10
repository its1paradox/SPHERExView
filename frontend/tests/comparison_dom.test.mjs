// DOM integration uses explicitly synthetic data; it does not claim visual QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const encode = values => ({ dtype: '<f4', data_b64: Buffer.from(new Float32Array(values).buffer).toString('base64') });
const fixture = {
  width: 4, height: 4, n_selected: 12, n_unique_inventory: 12, preview_subset: false,
  recipe: { ra: 10, dec: -5, pixscale_arcsec: 6.2, min_exposures: 1, background: 'zodi', weighting: 'equal', resampling: 'bin' },
  wcs: { height: 4, crpix1: 2.5, crpix2: 2.5, crval1: 10, crval2: -5, cd11: -6.2/3600, cd12: 0, cd21: 0, cd22: 6.2/3600 },
  inputs: [], epochs: [0, 1].map(epoch => ({ index: epoch, grouping: 'visit', datetime_start: '2026-01-01T00:00:00', datetime_end: '2026-01-02T00:00:00', complete_six: epoch === 0,
    tiles: [1,2,3,4,5,6].map(d => ({ detector: d, status: epoch === 1 && d === 6 ? 'missing' : 'ok', n_inventory: 1, n_selected: 1, n_accepted: 1, failures: {}, mjd_start: 61000 + epoch, mjd_end: 61000 + epoch,
      maps: epoch === 1 && d === 6 ? undefined : Object.fromEntries(['intensity','variance','coverage','hits','wavelength','lambda_min','lambda_max','bandwidth','mjd','mjd_min','mjd_max'].map(key => [key, encode(Array.from({length:16}, (_, i) => key === 'intensity' ? i + d : key === 'variance' ? 4 : key.startsWith('mjd') ? 61000 + epoch : key === 'bandwidth' ? .03 : 1))])) })) }))
};

async function settle(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('DOM did not reach the expected state');
}

test('real React entry builds six tiles, links pins and epochs, and keeps pending recipes separate', async () => {
  const bundle = await build({ entryPoints: ['src/compare.jsx'], bundle: true, format: 'iife', jsx: 'automatic', write: false, loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/compare.html#ra=10&dec=-5', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, requests = [], errors = [];
  w.structuredClone = structuredClone;
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
    await settle(() => w.document.querySelectorAll('canvas').length === 6);
    assert.equal(requests.filter(([, o]) => o?.method === 'POST').length, 1);
    assert.equal(JSON.parse(requests[0][1].body).max_per_tile, 0);
    assert.equal(w.document.querySelectorAll('.detector-key .active').length, 6);
    const canvas = w.document.querySelector('canvas');
    canvas.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(() => w.document.querySelector('.source-title').textContent.includes('Pinned source'));
    assert.equal(w.document.querySelectorAll('tbody tr').length, 6);
    assert.ok(w.location.hash.includes('pinra=10'));
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
    await settle(() => w.document.querySelectorAll('canvas').length === 6);
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
    assert.equal(w.document.querySelectorAll('.detector-grid canvas').length, 6);
    const savedEpoch = params().get('epoch');
    w.document.querySelector('[aria-label="Next detector"]').click();
    await settle(() => w.document.querySelector('#expanded-title').textContent.startsWith('D4'));
    w.document.querySelector('[aria-label="Previous detector"]').click();
    await settle(() => w.document.querySelector('#expanded-title').textContent.startsWith('D3'));
    w.document.querySelector('[aria-label="View D6"]').click();
    await settle(() => w.document.querySelector('#expanded-title').textContent.startsWith('D6'));
    w.document.querySelector('.expanded-tile canvas').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settle(() => w.document.querySelector('#expanded-title').textContent.startsWith('D1'));
    assert.equal(params().get('epoch'), savedEpoch, 'Expanded arrows change detector, never epoch');
    assert.equal(params().get('zoom'), '1', 'Expansion never changes magnification');
    const bigCanvas = w.document.querySelector('.expanded-tile canvas');
    bigCanvas.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(() => params().has('pinra'));
    assert.ok(Math.abs(Number(params().get('pinra')) - 10) < 1e-8);
    assert.ok(Math.abs(Number(params().get('pindec')) + 5) < 1e-8);
    bigCanvas.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100, clientX: 450, clientY: 150, bubbles: true, cancelable: true }));
    await settle(() => Number(params().get('zoom')) > 1);
    const savedView = ['zoom', 'panx', 'pany'].map(k => params().get(k));
    w.document.querySelector('[aria-label="Next detector"]').click();
    await settle(() => w.document.querySelector('#expanded-title').textContent.startsWith('D2'));
    assert.deepEqual(['zoom', 'panx', 'pany'].map(k => params().get(k)), savedView);
    w.document.querySelector('dialog').dispatchEvent(new w.Event('cancel', { bubbles: false, cancelable: true }));
    await settle(() => !w.document.querySelector('dialog'));
    assert.equal(w.document.activeElement, expand, 'Return focus to the tile that opened the modal');
    assert.equal(w.document.body.style.overflow, '');
    pixels.length = 0;
    button('Color comparison').click();
    await settle(() => w.document.querySelectorAll('.tile-color-key').length === 6);
    assert.equal(w.document.querySelector('[aria-label="Color meaning"]').textContent.includes('formal σ'), true);
    assert.ok(pixels.some(p => p[0] !== p[2]), 'Color rendering must differ from grayscale on the synthetic contrast');
    const reference = w.document.querySelector('.color-options select');
    reference.value = '6'; reference.dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle(() => params().get('reference') === '6');
    w.document.querySelector('[aria-label="Next epoch"]').click();
    await settle(() => w.document.body.textContent.includes('Reference D6 unavailable'));
    assert.equal(w.document.querySelectorAll('.detector-empty').length, 6);
    reference.value = '4'; reference.dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle(() => w.document.querySelectorAll('.detector-empty').length === 1);
    button('Export six-panel PNG + settings').click();
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
    assert.equal(w.document.querySelectorAll('.detector-empty').length, 1, 'Missing reference does not affect wavelength mode');
    w.document.querySelector('[aria-label="Expand D6"]').click();
    await settle(() => !!w.document.querySelector('dialog'));
    assert.ok(w.document.querySelector('.expanded-tile').textContent.includes('No observations in this epoch'), 'Keep a missing detector empty in expanded view');
    w.document.querySelector('dialog').dispatchEvent(new w.Event('cancel', { cancelable: true }));
    await settle(() => !w.document.querySelector('dialog'));
    button('Export six-panel PNG + settings').click();
    await settle(() => blobs.some(b => b.type === 'application/json'));
    const waveExport = JSON.parse(await blobs.find(b => b.type === 'application/json').text());
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
