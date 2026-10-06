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

function measurementKeys(arrays, subtractSky, completeOnly) {
  // Older saved results contain only complete-aperture fields. Never fall back
  // from a missing local-sky measurement to a different background estimator.
  const prefix = !completeOnly && arrays?.usable_flux ? 'usable_' : '';
  return [prefix + (subtractSky ? 'sky_flux' : 'flux'), prefix + (subtractSky ? 'sky_variance' : 'variance')];
}

export function spectrumAt(epoch, index, subtractSky = false, completeOnly = false) {
  if (index === null || index === undefined) return [];
  return (epoch?.spectra || []).flatMap(s => {
    const a = s.arrays;
    const [fk, vk] = measurementKeys(a, subtractSky, completeOnly);
    const flux = a?.[fk]?.[index], variance = a?.[vk]?.[index];
    if (!Number.isFinite(flux) || !(variance >= 0) || !(a.wavelength[index] > 0)) return [];
    return [{ detector: s.detector, obs_id: s.obs_id, mjd: s.mjd, release: s.data_release,
      flux, error: Math.sqrt(variance), wavelength: a.wavelength[index], local_sky_subtracted: subtractSky,
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

// AstroToolBox's broad-shape guide uses up to eight equal-count median bins
// per detector. See THIRD_PARTY_NOTICES.md. This is display-only interpolation,
// never an additional flux measurement or a peak estimator.
export function spectrumGuides(points) {
  const runs = [];
  for (const p of [...points].sort((a, b) => a.wavelength - b.wavelength)) {
    const run = runs.at(-1), last = run?.at(-1);
    // Deliberate departure from the reference: leave unsupported large gaps
    // open. The 0.2 um / three-CBAND threshold is a display convention.
    const gap = Math.max(.2, 3 * Math.max(last?.bandwidth || 0, p.bandwidth || 0));
    if (!last || p.wavelength - last.wavelength > gap) runs.push([p]);
    else run.push(p);
  }
  return runs.flatMap(run => {
    const candidates = [];
    for (let detector = 1; detector <= 6; detector++) {
      const samples = run.filter(p => p.detector === detector), bins = Math.min(8, samples.length);
      if (bins < 3) continue;
      for (let bin = 0; bin < bins; bin++) {
        const chunk = samples.slice(Math.floor(bin * samples.length / bins), Math.floor((bin + 1) * samples.length / bins));
        candidates.push({ wavelength: median(chunk.map(p => p.wavelength)), flux: median(chunk.map(p => p.flux)) });
      }
    }
    // A spline requires strictly increasing x, including at detector overlaps.
    const grouped = new Map();
    for (const a of candidates) grouped.set(a.wavelength, [...(grouped.get(a.wavelength) || []), a.flux]);
    const anchors = [...grouped].sort(([a], [b]) => a - b).map(([wavelength, fluxes]) => ({ wavelength, flux: median(fluxes) }));
    if (anchors.length < 3) return [];
    const n = anchors.length, second = new Array(n).fill(0), rhs = new Array(n).fill(0);
    // Natural cubic spline: second derivatives vanish at the two endpoints.
    for (let i = 1; i < n - 1; i++) {
      const h0 = anchors[i].wavelength - anchors[i - 1].wavelength, h1 = anchors[i + 1].wavelength - anchors[i].wavelength;
      const ratio = h0 / (h0 + h1), pivot = ratio * second[i - 1] + 2;
      second[i] = (ratio - 1) / pivot;
      const slopeChange = (anchors[i + 1].flux - anchors[i].flux) / h1 - (anchors[i].flux - anchors[i - 1].flux) / h0;
      rhs[i] = (6 * slopeChange / (h0 + h1) - ratio * rhs[i - 1]) / pivot;
    }
    for (let i = n - 2; i >= 0; i--) second[i] = second[i] * second[i + 1] + rhs[i];
    const curve = [];
    for (let i = 0; i < n - 1; i++) {
      const lo = anchors[i], hi = anchors[i + 1], h = hi.wavelength - lo.wavelength;
      for (let j = 0; j < 12; j++) {
        const b = j / 12, a = 1 - b;
        curve.push({ wavelength: lo.wavelength + b * h,
          flux: a * lo.flux + b * hi.flux + ((a ** 3 - a) * second[i] + (b ** 3 - b) * second[i + 1]) * h * h / 6 });
      }
    }
    curve.push(anchors.at(-1));
    return [{ anchors, curve }];
  });
}

export function spectrumDiagnostics(epoch, index, subtractSky = false, completeOnly = false) {
  const summary = { total: 0, usable: 0, partial: 0, aperture: 0, sky: 0, other: 0 };
  if (index === null || index === undefined) return summary;
  const valid = (a, local) => {
    const [fk, vk] = measurementKeys(a, local, completeOnly);
    return Number.isFinite(a?.[fk]?.[index]) && Number.isFinite(a?.[vk]?.[index]) && a[vk][index] >= 0 && a.wavelength?.[index] > 0;
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
  const columns = ['detector', 'obs_id', 'mjd', 'release', 'wavelength', 'bandwidth', 'lambda_min', 'lambda_max', 'flux', 'error', 'aperture_coverage', 'sky_coverage', 'partial'];
  return [
    '# SPHERExView aperture F_nu, not PSF-corrected total source flux',
    `# ICRS grid center: ${sky.ra}, ${sky.dec} deg; epoch ${epoch.index + 1}; ${epoch.data_release}`,
    `# aperture radius ${recipe.aperture_radius_arcsec} arcsec; annulus ${1.5 * recipe.aperture_radius_arcsec}-${2.5 * recipe.aperture_radius_arcsec} arcsec; supplied background: ${recipe.background}`,
    `# Local annulus subtraction: ${subtractSky ? 'yes' : 'no; local sky remains'}`,
    `# Aperture selection: ${completeOnly ? 'complete only' : 'usable pixels, including partial apertures'}; partial=${points.filter(p => p.partial).length}; no missing-area rescaling`,
    '# Coverage is usable aperture area, not recovered source flux. Masked cores can bias flux and spectral shape. The displayed spline is not exported as measurements.',
    '# wavelength/bandwidth/range: um; flux/error: uJy; MJD: UTC; coverage: fraction; formal independent-pixel errors only',
    '# No interpolation, missing samples omitted; wavelength-dependent PSF losses and non-simultaneity can change spectral shape',
    columns.join(','), ...points.map(p => columns.map(c => quote(p[c])).join(',')),
  ].join('\n');
}
