import test from 'node:test';
import assert from 'node:assert/strict';
import { rgbFrame, rgbDisplay, rgbPixel, spectrumAt, frequencyTHz, spectrumCsv, spectrumGuides, spectrumDiagnostics, separationArcsec } from '../src/lib/liveSpectrum.js';
import { decodeResult, readState, stateHash, recipeFromForm } from '../src/lib/comparison.js';

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

test('RGB neutralization removes known offsets on copies, preserves source differences and is reversible', () => {
  const epoch = { tiles: [1,2,3,4,5,6].map(d => ({ arrays: {
    intensity: Float64Array.from({length:101}, (_,i) => d + (i < 100 ? (i%10-4.5)*.01 : 100)),
    coverage: new Uint32Array(101).fill(1), variance: new Float64Array(101).fill(.04),
  } })), spectra: [] };
  const before = structuredClone(epoch), raw = rgbFrame(epoch,101), rawBefore = structuredClone(raw);
  const neutral = rgbDisplay(raw,'neutral');
  assert.equal(neutral.background.applied,true);
  assert.deepEqual(neutral.background.offsets_mjy_sr,[5.5,3.5,1.5]);
  assert.equal(neutral.background.retained_pixels,100);
  assert.deepEqual(neutral.channels.map(c=>c[100]),[100,100,100]);
  assert.deepEqual(rgbPixel(neutral,100,100,'linear'),[255,255,255]);
  assert.deepEqual(neutral.coverage,raw.coverage);
  assert.deepEqual(raw,rawBefore); assert.deepEqual(epoch,before);
  const restored=rgbDisplay(raw,'shared');
  assert.deepEqual(restored.channels,raw.channels);
  assert.deepEqual(restored.brightness,raw.brightness);
  neutral.channels[0][0]=999; neutral.coverage[0]=0;
  assert.deepEqual(raw,rawBefore,'Derived display arrays must not alias even RGB input arrays');
});

test('RGB neutralization refuses insufficient coverage and never fills missing pixels', () => {
  const epoch={tiles:[1,2,3,4,5,6].map(d=>({arrays:{intensity:new Float64Array(16).fill(d),coverage:Uint32Array.from({length:16},(_,i)=>i===15&&d===6?0:1)}}))};
  const raw=rgbFrame(epoch,16), neutral=rgbDisplay(raw,'neutral');
  assert.equal(neutral.background.applied,false);
  assert.equal(neutral.background.common_pixels,15);
  assert.deepEqual(neutral.background.offsets_mjy_sr,[0,0,0]);
  assert.equal(neutral.coverage[15],0); assert.ok(Number.isNaN(neutral.brightness[15]));
  assert.deepEqual(neutral.channels,raw.channels);
});

test('RGB background URL round trips without changing the scientific recipe', () => {
  const initial=readState('#ra=10&dec=-5');
  const changed=readState(stateHash(initial.form,{...initial.display,rgbBackground:'neutral'},0,null));
  assert.equal(changed.display.rgbBackground,'neutral');
  assert.deepEqual(recipeFromForm(changed.form),recipeFromForm(initial.form));
  assert.equal(readState('#rgbbg=invalid').display.rgbBackground,'shared');
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

test('sparse median guide resists the screenshot outlier without altering data or adding extrema', () => {
  const points=Array.from({length:13},(_,i)=>({detector:1,release:'dr1',wavelength:.75+i*.026,bandwidth:.03,flux:i===12?21975.914:100}));
  const copy=structuredClone(points), [guide]=spectrumGuides(points);
  assert.equal(guide.anchors.length,4);
  assert.ok(guide.curve.every(p=>p.flux===100));
  assert.deepEqual(points,copy);
  assert.deepEqual(spectrumGuides(points.slice(0,2)),[]);
  assert.deepEqual(spectrumGuides(points.map(p=>({...p,partial:true}))),[]);
  const mixed=[...points,...points.map(p=>({...p,release:'qr3',flux:200}))];
  assert.equal(spectrumGuides(mixed).length,2);
  assert.ok(spectrumGuides(mixed).every(g=>g.curve.every(p=>p.flux===(g.release==='dr1'?100:200))));
});

test('median guide preserves negative flux, leaves large gaps and cannot overshoot', () => {
  const points=Array.from({length:12},(_,i)=>({detector:1,wavelength:1+i*.01,bandwidth:.03,flux:i<6?-10:20}));
  const [guide]=spectrumGuides(points);
  assert.ok(guide.curve.every(p=>p.flux>=-10&&p.flux<=20));
  assert.equal(guide.curve[0].flux,-10);
  assert.equal(spectrumGuides([...points,...points.map(p=>({...p,wavelength:p.wavelength+1}))]).length,2);
});

test('coordinate discrepancy is measured on the sphere including RA wrap', () => {
  assert.ok(Math.abs(separationArcsec({ra:133.7599588,dec:-7.2449993},{ra:133.7599588,dec:-7.2432771})-6.19992)<1e-7);
  assert.ok(Math.abs(separationArcsec({ra:359.999,dec:0},{ra:.001,dec:0})-7.2)<1e-6);
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

// Background diagnostics follow the selected usable/complete estimator.
test('reported local background equals the raw minus local-sky aperture sum', () => {
  const arrays={flux:[21975.914],variance:[4],sky_flux:[1109.5135],sky_variance:[9],wavelength:[1.08905],bandwidth:[.03],lambda_min:[1.08],lambda_max:[1.10],aperture_coverage:[1],sky_coverage:[1]};
  for (const subtract of [false,true]) {
    const [point]=spectrumAt({spectra:[{arrays}]},0,subtract,true);
    assert.ok(Math.abs(point.background_flux-20866.4005)<1e-8);
  }
});
