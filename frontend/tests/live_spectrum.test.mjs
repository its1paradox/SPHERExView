import test from 'node:test';
import assert from 'node:assert/strict';
import { rgbFrame, rgbPixel, spectrumAt, frequencyTHz, spectrumCsv, spectrumGuides, spectrumDiagnostics } from '../src/lib/liveSpectrum.js';
import { decodeResult } from '../src/lib/comparison.js';

test('RGB includes all six, preserves channel ratios and never invents missing coverage', () => {
  const epoch = { tiles: [1,2,3,4,5,6].map(d => ({ arrays: { intensity: Float64Array.of(d, -d, d), coverage: [1,1,d === 6 ? 0 : 1] } })) };
  const rgb = rgbFrame(epoch, 3);
  assert.deepEqual(rgb.channels.map(c => c[0]), [5.5,3.5,1.5]);
  const pixel = rgbPixel(rgb, 0, 10, 'asinh');
  assert.ok(Math.abs(pixel[0] / pixel[2] - 5.5 / 1.5) < .06);
  assert.deepEqual(rgbPixel(rgb, 1, 10, 'asinh'), [0,0,0]);
  assert.equal(rgb.coverage[2], 0); assert.ok(Number.isNaN(rgb.brightness[2]));
  assert.equal(epoch.tiles[0].arrays.intensity[1], -1, 'Display must not clip science arrays');
});

test('spectrum retains separate exposures, signed flux, exact frequency and wavelength range', () => {
  const spectra = [2,1,3].map((wave, i) => ({ detector: i + 1, mjd: 61000 + i, obs_id: `obs,${i}`, data_release: 'qr3', arrays: { flux: [i === 2 ? NaN : -10 + 20*i], variance: [4], wavelength: [wave], bandwidth: [.04], lambda_min: [wave-.01], lambda_max: [wave+.01], aperture_coverage: [1], sky_coverage: [.9] } }));
  const points = spectrumAt({ spectra }, 0);
  assert.deepEqual(points.map(p => p.wavelength), [1,2]);
  assert.deepEqual(points.map(p => p.flux), [10,-10]);
  assert.equal(points[0].error, 2);
  assert.equal(frequencyTHz(1), 299.792458);
  assert.deepEqual(spectrumAt({ spectra }, null), []);
  assert.deepEqual(spectrumAt({ spectra }, 0, true), [], 'Never fall back to sky-contaminated flux when local sky is unavailable');
  spectra[0].arrays.sky_flux = [-7]; spectra[0].arrays.sky_variance = [9];
  const local = spectrumAt({ spectra }, 0, true);
  assert.equal(local.length, 1); assert.equal(local[0].flux, -7); assert.equal(local[0].error, 3);
  const csv = spectrumCsv(points, {ra:1,dec:2}, {aperture_radius_arcsec:12.4, background:'zodi'}, {index:0,data_release:'qr3'});
  assert.ok(csv.includes('"obs,1"')); assert.ok(csv.includes('not PSF-corrected')); assert.ok(csv.includes('um; flux/error: uJy'));
});

test('decode spectral maps in the same orientation as detector maps and discard encoded duplicates', () => {
  const map = {dtype:'<f4', data_b64:Buffer.from(Float32Array.of(1,2,3,4).buffer).toString('base64')};
  const r = decodeResult({width:2,height:2,epochs:[{tiles:[1,2,3,4,5,6].map(detector=>({detector})),spectra:[{detector:1,maps:{flux:map}}]}]});
  assert.deepEqual([...r.epochs[0].spectra[0].arrays.flux], [1,2,3,4]);
  assert.equal(r.epochs[0].spectra[0].maps, undefined);
});

test('nonfinite uncertainties and wavelengths are excluded consistently from plots and diagnostics', () => {
  const good = {flux:[2],variance:[4],wavelength:[1],bandwidth:[.03],lambda_min:[.99],lambda_max:[1.01],aperture_coverage:[1],sky_coverage:[1]};
  for (const invalid of [{variance:[Infinity]}, {variance:[NaN]}, {variance:[-1]}, {wavelength:[Infinity]}, {wavelength:[NaN]}]) {
    const epoch = {spectra:[{arrays:good},{arrays:{...good,...invalid}}]};
    assert.equal(spectrumAt(epoch,0).length,1);
    assert.equal(spectrumDiagnostics(epoch,0).usable,1);
    assert.equal(spectrumDiagnostics(epoch,0).other,1);
  }
});

test('robust guide uses median anchors, joins adjacent detectors and preserves measurements', () => {
  const points = Array.from({length:32}, (_,i) => ({detector:1,wavelength:1+i*.005,bandwidth:.03,flux:i===1?10000:2,mjd:61000}));
  points.push(...Array.from({length:8}, (_,i)=>({detector:2,wavelength:1.17+i*.01,bandwidth:.03,flux:2,mjd:61000})));
  const original = structuredClone(points), guides = spectrumGuides(points);
  assert.equal(guides.length,1);
  assert.equal(guides[0].anchors.length,16);
  assert.ok(guides[0].anchors.every(p=>p.flux===2),'Median anchors resist an isolated outlier');
  assert.ok(guides[0].curve.every(p=>Math.abs(p.flux-2)<1e-10));
  assert.deepEqual(points,original,'Spline must not edit, reject or insert measurements');
  assert.deepEqual(spectrumGuides(points.slice(0,2)),[]);
});

test('natural cubic spline agrees with analytic midpoint and leaves large gaps open', () => {
  const points = [0,1,0].map((flux,i)=>({detector:1,wavelength:1+i*.1,bandwidth:.03,flux}));
  const [guide] = spectrumGuides(points);
  assert.ok(Math.abs(guide.curve[6].flux-.6875)<1e-12);
  assert.equal(guide.curve[0].flux,0); assert.equal(guide.curve.at(-1).flux,0);
  const separated = [...points,...points.map(p=>({...p,detector:3,wavelength:p.wavelength+1}))];
  assert.equal(spectrumGuides(separated).length,2);
  const repeated = spectrumGuides([...points,...points]);
  assert.equal(repeated[0].anchors.length,3);
  assert.ok(repeated[0].curve.every(p=>Number.isFinite(p.flux)));
});

test('partial pixel flux is explicit, never rescaled, and complete filtering keeps its old meaning', () => {
  const arrays = {flux:[NaN],variance:[NaN],usable_flux:[-7],usable_variance:[9],usable_sky_flux:[NaN],usable_sky_variance:[NaN],wavelength:[2],bandwidth:[.04],lambda_min:[1.99],lambda_max:[2.01],aperture_coverage:[.6],sky_coverage:[0]};
  const epoch = {index:0,data_release:'qr2',spectra:[{arrays,detector:2,mjd:61000}]};
  const points = spectrumAt(epoch,0);
  assert.equal(points[0].flux,-7); assert.equal(points[0].error,3); assert.equal(points[0].partial,true);
  assert.deepEqual(spectrumAt(epoch,0,false,true),[]);
  assert.deepEqual(spectrumAt(epoch,0,true),[]);
  assert.equal(spectrumDiagnostics(epoch,0).partial,1);
  assert.equal(spectrumDiagnostics(epoch,0,true).sky,1);
  const csv=spectrumCsv(points,{ra:1,dec:2},{aperture_radius_arcsec:12.4},epoch);
  assert.ok(csv.includes('usable pixels, including partial apertures'));
  assert.ok(csv.includes('no missing-area rescaling'));
  assert.ok(csv.includes('"0.6"'));
});

test('availability explains bad apertures and missing clean sky without substituting flux', () => {
  const arrays = {flux:[2],variance:[1],sky_flux:[1],sky_variance:[2],wavelength:[1],aperture_coverage:[1]};
  const epoch = {spectra:[
    {arrays},
    {arrays:{...arrays,flux:[NaN],sky_flux:[NaN],aperture_coverage:[.92]}},
    {arrays:{...arrays,sky_flux:[NaN]}},
    {arrays:{...arrays,flux:[NaN],sky_flux:[NaN],aperture_coverage:[NaN]}}
  ]};
  assert.deepEqual(spectrumDiagnostics(epoch,0),{total:4,usable:2,partial:0,aperture:1,sky:0,other:1});
  assert.deepEqual(spectrumDiagnostics(epoch,0,true),{total:4,usable:1,partial:0,aperture:1,sky:1,other:1});
  assert.equal(spectrumDiagnostics(epoch,null).total,0);
});
