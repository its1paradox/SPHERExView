// Record actual React canvas commands, so an empty Lines plot fails even when
// its measurement counter and table are correct. No remote jobs are submitted.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const compiled = build({ entryPoints: ['src/spectrum.jsx'], bundle: true, format: 'iife',
  jsx: 'automatic', write: false, loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });

async function settle(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Spectrum did not reach the expected render state');
}

async function mount(rows) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/spectrum.html#ra=10&dec=-5&job=synthetic-job&release=all',
    runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, errors = [], requests = [], downloads = [];
  // Keep the responsive initialization at a fixed viewport while comparing
  // the Points and Lines coordinates; jsdom otherwise reports zero width.
  Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get: () => 900 });
  let drawing = [], path = [], renders = 0;
  const ctx = new Proxy({
    fillRect() { drawing = []; renders++; },
    beginPath() { path = []; },
    moveTo(x, y) { path.push(['moveTo', x, y]); },
    lineTo(x, y) { path.push(['lineTo', x, y]); },
    arc(x, y, radius) { path.push(['arc', x, y, radius]); },
    stroke() { drawing.push({ kind: 'stroke', style: this.strokeStyle, width: this.lineWidth, path: [...path] }); },
    fill() { drawing.push({ kind: 'fill', style: this.fillStyle, path: [...path] }); },
    measureText() { return { width: 10 }; },
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.console.error = (...args) => errors.push(args.join(' '));
  w.HTMLCanvasElement.prototype.getContext = () => ctx;
  w.HTMLCanvasElement.prototype.toDataURL = () => { downloads.push(structuredClone(drawing)); return 'data:image/png;base64,fixture'; };
  w.HTMLAnchorElement.prototype.click = () => {};
  w.fetch = async url => {
    requests.push(url);
    return { ok: true, json: async () => url.includes('/status/') ? { phase: 'COMPLETED' } : {
      columns: Object.keys(rows[0]), rows, units: { flux: 'uJy' }, count: rows.length,
    } };
  };
  vm.runInContext((await compiled).outputFiles[0].text, dom.getInternalVMContext());
  await settle(() => w.document.querySelector('.spectrum-downloads') && drawing.some(d => d.path[0]?.[0] === 'arc'));
  const change = async action => { const before = renders; action(); await settle(() => renders > before); };
  const select = async (selector, value) => change(() => {
    const el = w.document.querySelector(selector); el.value = value;
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
  });
  const toggle = async label => change(() => [...w.document.querySelectorAll('label')]
    .find(l => l.textContent.trim().startsWith(label)).querySelector('input').click());
  const segments = () => drawing.filter(d => d.kind === 'stroke' && [1.2, 1.6].includes(d.width)
    && /^#2f6fd4(ff|aa)$/.test(d.style) && d.path.length === 2 && d.path[0][0] === 'moveTo' && d.path[1][0] === 'lineTo');
  const markers = () => drawing.filter(d => d.path.length === 1 && d.path[0][0] === 'arc');
  const errorBars = () => drawing.filter(d => d.width === 1.4 && d.style === '#2f6fd4aa');
  return { w, errors, requests, downloads, segments, markers, errorBars, select, toggle,
    readout: () => w.document.querySelector('.spectrum-readout').textContent };
}

const point = (wavelength, flux, release, flags = 0) => Object.freeze({
  wavelength, flux, flux_err: .25, data_collection: release, flags, det_id: 1,
});
const edgeKey = points => points.flat().map(x => Number(x.toFixed(6))).join(',');

for (const tiedWavelengths of [false, true]) {
  for (const errorsOn of [false, true]) {
    test(`interleaved releases draw independent traces (equal wavelengths=${tiedWavelengths}, errors=${errorsOn})`, async () => {
      const sorted = Array.from({ length: 6 }, (_, i) => point(.8 + (tiedWavelengths ? Math.floor(i / 2) : i) * .01,
        [-3, -1, 0, 1, 4, 2][i], i % 2 ? 'qr3' : 'qr2'));
      const rows = Object.freeze([sorted[4], sorted[1], sorted[0], sorted[5], sorted[2], sorted[3]]);
      const original = JSON.stringify(rows), app = await mount(rows);
      try {
        if (!errorsOn) await app.toggle('Error bars');
        const coordinates = new Map(rows.map((row, i) => [row, app.markers()[i].path[0].slice(1, 3)]));
        const expected = [[0, 2], [2, 4], [1, 3], [3, 5]].map(([a, b]) => edgeKey([coordinates.get(sorted[a]), coordinates.get(sorted[b])])).sort();
        await app.select('.trace-style select', 'lines');
        assert.equal(app.segments().length, 4, 'Two three-point releases must each draw two segments');
        assert.equal(app.markers().length, 0);
        assert.equal(app.errorBars().length, errorsOn ? 6 : 0);
        assert.deepEqual(app.segments().map(s => edgeKey(s.path.map(p => p.slice(1, 3)))).sort(), expected,
          'Each segment must connect the actual same-release measurements, without cross-release edges');
        assert.match(app.readout(), /6 of 6 measurements shown/);
        [...app.w.document.querySelectorAll('button')].find(b => b.textContent.trim() === 'PNG of plot').click();
        assert.equal(app.downloads.length, 1);
        assert.equal(app.downloads[0].filter(d => d.width === 1.6 && d.style === '#2f6fd4ff').length, 4);
        await app.select('.trace-style select', 'connected');
        assert.equal(app.segments().length, 4);
        assert.equal(app.markers().length, 6);
        await app.select('.trace-style select', 'points');
        assert.equal(app.segments().length, 0);
        assert.equal(app.markers().length, 6);
        await app.select('.trace-style select', 'lines');
        await app.select('.spectrum-toolbar label:first-child select', 'qr2');
        assert.equal(app.segments().length, 2);
        assert.match(app.readout(), /3 of 6 measurements shown/);
        assert.ok(app.w.document.querySelector('a[href$="fmt=json&release=qr2"]'));
        assert.equal(app.requests.length, 2);
        assert.equal(JSON.stringify(rows), original, 'Rendering must not mutate fluxes, errors or row order');
        assert.deepEqual(app.errors, []);
      } finally { app.w.close(); }
    });
  }
}

test('Lines mode retains isolated and unknown-release measurements after filters', async () => {
  const rows = Object.freeze([point(.8, -2, 'qr2'), point(.81, -1, 'qr3'),
    point(.82, 0, null, 2 ** 32), point(.83, 3, 'qr3', 2 ** 21)]);
  const app = await mount(rows);
  try {
    await app.toggle('Error bars');
    await app.select('.trace-style select', 'lines');
    assert.equal(app.segments().length, 1);
    assert.equal(app.markers().length, 2, 'Each one-point release needs a marker in Lines mode');
    assert.equal(app.markers().filter(d => d.kind === 'stroke').length, 1, 'Flagged isolated point stays hollow');
    await app.toggle('Hide flagged');
    assert.equal(app.markers().length, 1);
    assert.equal(app.segments().length, 1);
    await app.toggle('Log flux');
    assert.equal(app.segments().length, 0);
    assert.equal(app.markers().length, 1, 'Filtering a series to one positive flux must keep that point visible');
    assert.match(app.readout(), /1 of 4 measurements shown/);
    await app.toggle('D1');
    assert.equal(app.segments().length, 0);
    assert.equal(app.markers().length, 0);
    assert.match(app.readout(), /0 of 4 measurements shown/);
    await app.toggle('D1');
    assert.equal(app.markers().length, 1);
    assert.deepEqual(app.errors, []);
  } finally { app.w.close(); }
});
