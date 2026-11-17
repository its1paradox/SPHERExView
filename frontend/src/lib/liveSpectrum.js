import { displayFraction } from './comparison.js';

export const DETECTOR_COLORS = ['#8cc9ff', '#78d8de', '#a6dcac', '#ebd68c', '#eab082', '#e98d99'];
export const RGB_METHOD = 'Equal detector means: R=(D5+D6)/2, G=(D3+D4)/2, B=(D1+D2)/2. All six must be valid. One hue-preserving stretch and scale across epochs. Negative channels clip only for display. Native PSFs; mixed wavelengths, not fixed filters.';

export function rgbFrame(epoch, count) {
  const channels = [0, 1, 2].map(() => new Float64Array(count).fill(NaN));
  const brightness = new Float64Array(count).fill(NaN), coverage = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    if (!epoch.tiles.every(t => t.arrays?.coverage[i] > 0 && Number.isFinite(t.arrays.intensity[i]))) continue;
    [[4, 5], [2, 3], [0, 1]].forEach(([a, b], c) => { channels[c][i] = (epoch.tiles[a].arrays.intensity[i] + epoch.tiles[b].arrays.intensity[i]) / 2; });
    brightness[i] = Math.max(0, ...channels.map(c => c[i])); coverage[i] = 1;
  }
  return { channels, brightness, coverage };
}

export function rgbPixel(frame, i, white, stretch) {
  const values = frame.channels.map(c => Math.max(0, c[i]));
  const peak = Math.max(...values);
  if (!(peak > 0)) return [0, 0, 0];
  const scale = displayFraction(peak, 0, Math.max(white, 1e-9), stretch) / peak;
  return values.map(v => Math.round(255 * v * scale));
}

export const RGB_BACKGROUND_METHOD = 'Display only: per-epoch, full-field RGB medians on common six-detector coverage; joint symmetric 3-sigma clipping using 1.4826 MAD, up to 5 iterations. At least 16 pixels and 25% of the common coverage must remain. Offsets do not depend on pin, pan or zoom. This is not a source-masked sky model and can remove diffuse emission and background variability.';

// Work exclusively on derived RGB copies. Never change coadds, their coverage,
// spectra or the native arrays used by readouts and scientific exports.
export function rgbDisplay(frame, mode = 'shared') {
  const common = Array.from(frame.coverage.keys()).filter(i => frame.coverage[i] > 0 && frame.channels.every(c => Number.isFinite(c[i])));
  let retained = common, offsets = [0, 0, 0], applied = false;
  if (mode === 'neutral' && common.length >= 16) {
    for (let iteration = 0; iteration < 5; iteration++) {
      const centers = frame.channels.map(c => median(retained.map(i => c[i])));
      const sigmas = frame.channels.map((c, j) => 1.4826 * median(retained.map(i => Math.abs(c[i] - centers[j]))));
      const next = retained.filter(i => frame.channels.every((c, j) => sigmas[j] === 0 || Math.abs(c[i] - centers[j]) <= 3 * sigmas[j]));
      if (next.length === retained.length) break;
      retained = next;
      if (retained.length < Math.max(16, Math.ceil(common.length / 4))) break;
    }
    if (retained.length >= Math.max(16, Math.ceil(common.length / 4))) {
      offsets = frame.channels.map(c => median(retained.map(i => c[i])));
      applied = true;
    }
  }
  const channels = frame.channels.map((c, j) => c.map(v => v - offsets[j]));
  const brightness = frame.brightness.map((v, i) => frame.coverage[i] ? Math.max(0, ...channels.map(c => c[i])) : NaN);
  return { channels, brightness, coverage: frame.coverage.slice(), background: {
    requested: mode, applied, offsets_mjy_sr: offsets, common_pixels: common.length,
    retained_pixels: retained.length, method: RGB_BACKGROUND_METHOD,
    status: mode !== 'neutral' ? 'Shared physical zero' : applied ? 'Background neutralized — display only' : 'Neutralization unavailable: too few background pixels; showing shared physical zero',
  } };
}

function measurementKeys(arrays, subtractSky, completeOnly) {
  // Older saved results contain only complete-aperture fields. Never fall back
  // from a missing local-sky measurement to a different background estimator.
  const prefix = !completeOnly && arrays?.usable_flux ? 'usable_' : '';
  return [prefix + (subtractSky ? 'sky_flux' : 'flux'), prefix + (subtractSky ? 'sky_variance' : 'variance')];
}

function validMeasurement(arrays, index, fluxKey, varianceKey) {
  return Number.isFinite(arrays?.[fluxKey]?.[index]) &&
    Number.isFinite(arrays?.[varianceKey]?.[index]) && arrays[varianceKey][index] >= 0 &&
    Number.isFinite(arrays?.wavelength?.[index]) && arrays.wavelength[index] > 0;
}

export function spectrumAt(epoch, index, subtractSky = false, completeOnly = false) {
  if (index === null || index === undefined) return [];
  return (epoch?.spectra || []).flatMap(s => {
    const a = s.arrays;
    const [fk, vk] = measurementKeys(a, subtractSky, completeOnly);
    const [totalKey] = measurementKeys(a, false, completeOnly);
    const [skyKey] = measurementKeys(a, true, completeOnly);
    const flux = a?.[fk]?.[index], variance = a?.[vk]?.[index];
    if (!validMeasurement(a, index, fk, vk)) return [];
    return [{ detector: s.detector, obs_id: s.obs_id, mjd: s.mjd, release: s.data_release,
      flux, error: Math.sqrt(variance), wavelength: a.wavelength[index], local_sky_subtracted: subtractSky,
      background_flux: Number.isFinite(a?.[totalKey]?.[index]) && Number.isFinite(a?.[skyKey]?.[index]) ? a[totalKey][index] - a[skyKey][index] : NaN,
      partial: a.aperture_coverage[index] < .999999,
      bandwidth: a.bandwidth[index], lambda_min: a.lambda_min[index], lambda_max: a.lambda_max[index],
      aperture_coverage: a.aperture_coverage[index], sky_coverage: a.sky_coverage[index] }];
  }).sort((a, b) => a.wavelength - b.wavelength || a.mjd - b.mjd);
}

export const frequencyTHz = wavelength => 299.792458 / wavelength;

const median = values => {
  const sorted = [...values].sort((a, b) => a - b), m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};

// Display-only medians. At least three samples per anchor prevent a single
// exposure becoming an anchor; straight segments cannot introduce extrema.
// Raw measurements, their errors, and CSV exports are never clipped or binned.
export function spectrumGuides(points) {
  const groups = new Map();
  for (const p of points) {
    if (p.partial || !Number.isFinite(p.wavelength) || !Number.isFinite(p.flux)) continue;
    const release = p.release || 'unknown';
    if (!groups.has(release)) groups.set(release, []);
    groups.get(release).push(p);
  }
  return [...groups].flatMap(([release, series]) => {
    const runs = [];
    for (const p of [...series].sort((a,b) => a.wavelength-b.wavelength)) {
      const last = runs.at(-1)?.at(-1);
      const gap = Math.max(.2, 3*Math.max(last?.bandwidth || 0, p.bandwidth || 0));
      if (!last || p.wavelength-last.wavelength > gap) runs.push([p]);
      else runs.at(-1).push(p);
    }
    return runs.flatMap(run => {
      const candidates = [];
      for (let detector=1; detector<=6; detector++) {
        const samples = run.filter(p => p.detector === detector);
        const bins = Math.min(8, Math.floor(samples.length/3));
        for (let bin=0; bin<bins; bin++) {
          const chunk = samples.slice(Math.floor(bin*samples.length/bins), Math.floor((bin+1)*samples.length/bins));
          candidates.push({wavelength:median(chunk.map(p=>p.wavelength)), flux:median(chunk.map(p=>p.flux))});
        }
      }
      const grouped = new Map();
      for (const a of candidates) grouped.set(a.wavelength,[...(grouped.get(a.wavelength)||[]),a.flux]);
      const anchors = [...grouped].sort(([a],[b])=>a-b).map(([wavelength,fluxes])=>({wavelength,flux:median(fluxes)}));
      return anchors.length < 2 ? [] : [{release, anchors, curve:anchors}];
    });
  });
}

export function separationArcsec(a, b) {
  if (!a || !b) return NaN;
  const rad = Math.PI/180, d = (a.dec-b.dec)*rad/2, r = (a.ra-b.ra)*rad/2;
  const h = Math.sin(d)**2 + Math.cos(a.dec*rad)*Math.cos(b.dec*rad)*Math.sin(r)**2;
  return 2*Math.asin(Math.sqrt(Math.max(0,Math.min(1,h))))/rad*3600;
}

export function spectrumDiagnostics(epoch, index, subtractSky = false, completeOnly = false) {
  const summary = { total: 0, usable: 0, partial: 0, aperture: 0, sky: 0, other: 0 };
  if (index === null || index === undefined) return summary;
  const valid = (a, local) => {
    const [fk, vk] = measurementKeys(a, local, completeOnly);
    return validMeasurement(a, index, fk, vk);
  };
  for (const s of epoch?.spectra || []) {
    const a = s.arrays; summary.total++;
    if (valid(a, subtractSky)) { summary.usable++; if (a.aperture_coverage[index] < .999999) summary.partial++; }
    else if (subtractSky && valid(a, false)) summary.sky++;
    else if (a?.aperture_coverage?.[index] < .999999) summary.aperture++;
    else summary.other++;
  }
  return summary;
}

export function spectrumCsv(points, sky, recipe, epoch, subtractSky = false, completeOnly = false) {
  const quote = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const columns = ['detector', 'obs_id', 'mjd', 'release', 'wavelength', 'bandwidth', 'lambda_min', 'lambda_max', 'flux', 'error', 'background_flux', 'aperture_coverage', 'sky_coverage', 'partial'];
  return [
    '# SPHERExView aperture F_nu, not PSF-corrected total source flux',
    `# ICRS grid center: ${sky.ra}, ${sky.dec} deg; epoch ${epoch.index + 1}; ${epoch.spectrum_release_summary?.data_release || epoch.data_release}`,
    `# aperture radius ${recipe.aperture_radius_arcsec} arcsec; annulus ${1.5 * recipe.aperture_radius_arcsec}-${2.5 * recipe.aperture_radius_arcsec} arcsec; supplied background: ${recipe.background}`,
    `# Local annulus subtraction: ${subtractSky ? 'yes' : 'no; local sky remains'}`,
    `# Aperture selection: ${completeOnly ? 'complete only' : 'usable pixels, including partial apertures'}; partial=${points.filter(p => p.partial).length}; no missing-area rescaling`,
    '# Coverage is usable aperture area, not recovered source flux. Masked cores can bias flux and spectral shape. The optional median guide is not exported as measurements.',
    '# wavelength/bandwidth/range: um; flux/error: uJy; MJD: UTC; coverage: fraction; formal independent-pixel errors only',
    '# No interpolation, missing samples omitted; wavelength-dependent PSF losses and non-simultaneity can change spectral shape',
    columns.join(','), ...points.map(p => columns.map(c => quote(p[c])).join(',')),
  ].join('\n');
}
