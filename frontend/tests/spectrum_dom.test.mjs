// Synthetic rows exercise UI filtering without submitting remote IRSA jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

test('spectrum release filters plot/table/exports and keeps high quality bits', async () => {
  const bundle = await build({ entryPoints: ['src/spectrum.jsx'], bundle: true, format: 'iife',
    jsx: 'automatic', write: false, loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/spectrum.html#ra=10&dec=-5&job=synthetic-job&release=qr3',
    runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, errors = [], requests = [];
  w.console.error = (...args) => errors.push(args.join(' '));
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: (_, key) => key === 'measureText' ? () => ({ width: 10 }) : () => {},
    set: () => true,
  });
  const rows = [
    { wavelength: 1, flux: -2, flux_err: .3, data_collection: 'qr2', flags: 0, det_id: 1 },
    { wavelength: 2, flux: 3, flux_err: .4, data_collection: 'qr3', flags: 2 ** 32, det_id: 2 },
    { wavelength: 3, flux: -4, flux_err: .5, data_collection: 'qr3', flags: 2 ** 21, det_id: 3 },
    { wavelength: 4, flux: 5, flux_err: .6, data_collection: null, flags: 0, det_id: 4 },
  ];
  w.fetch = async url => {
    requests.push(url);
    return { ok: true, json: async () => url.includes('/status/') ? { phase: 'COMPLETED' } : {
      columns: Object.keys(rows[0]), units: { flux: 'uJy' }, count: 4, rows,
    } };
  };
  const settle = async check => {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.fail('Expected spectrum state did not appear');
  };
  const button = name => [...w.document.querySelectorAll('button')].find(b => b.textContent.trim() === name);
  try {
    vm.runInContext(bundle.outputFiles[0].text, dom.getInternalVMContext());
    await settle(() => w.document.querySelector('.spectrum-downloads'));
    assert.match(w.document.querySelector('.spectrum-readout').textContent, /2 of 4/);
    assert.ok(w.document.querySelector('a[href$="fmt=json&release=qr3"]'));
    button('Table').click();
    await settle(() => w.document.querySelectorAll('tbody tr').length === 2);
    const hide = [...w.document.querySelectorAll('label')].find(l => l.textContent.includes('Hide flagged'));
    hide.querySelector('input').click();
    await settle(() => w.document.querySelectorAll('tbody tr').length === 1);
    assert.ok(w.document.querySelector('tbody').textContent.includes('-4'));
    const release = [...w.document.querySelectorAll('select')].find(s => s.querySelector('option[value="qr3"]'));
    release.value = 'qr2'; release.dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle(() => w.location.hash.includes('release=qr2'));
    assert.ok(w.document.querySelector('tbody').textContent.includes('-2'));
    assert.ok(w.document.querySelector('a[href$="fmt=json&release=qr2"]'));
    assert.ok(w.document.querySelector('a[href$="fmt=votable"]'));
    assert.equal(requests.length, 2, 'Filtering existing results must not submit another job');
    assert.deepEqual(errors, []);
  } finally { w.close(); }
});
