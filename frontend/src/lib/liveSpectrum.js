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

export function spectrumAt(epoch, index, subtractSky = false) {
  if (index === null || index === undefined) return [];
  return (epoch?.spectra || []).flatMap(s => {
    const a = s.arrays;
    const flux = a?.[subtractSky ? 'sky_flux' : 'flux']?.[index], variance = a?.[subtractSky ? 'sky_variance' : 'variance']?.[index];
    if (!Number.isFinite(flux) || !(variance >= 0) || !(a.wavelength[index] > 0)) return [];
    return [{ detector: s.detector, obs_id: s.obs_id, mjd: s.mjd, release: s.data_release,
      flux, error: Math.sqrt(variance), wavelength: a.wavelength[index], local_sky_subtracted: subtractSky,
      bandwidth: a.bandwidth[index], lambda_min: a.lambda_min[index], lambda_max: a.lambda_max[index],
      aperture_coverage: a.aperture_coverage[index], sky_coverage: a.sky_coverage[index] }];
  }).sort((a, b) => a.wavelength - b.wavelength || a.mjd - b.mjd);
}

export const frequencyTHz = wavelength => 299.792458 / wavelength;

export function spectrumCsv(points, sky, recipe, epoch, subtractSky = false) {
  const quote = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const columns = ['detector', 'obs_id', 'mjd', 'release', 'wavelength', 'bandwidth', 'lambda_min', 'lambda_max', 'flux', 'error', 'aperture_coverage', 'sky_coverage'];
  return [
    '# SPHERExView aperture F_nu, not PSF-corrected total source flux',
    `# ICRS grid center: ${sky.ra}, ${sky.dec} deg; epoch ${epoch.index + 1}; ${epoch.data_release}`,
    `# aperture radius ${recipe.aperture_radius_arcsec} arcsec; annulus ${1.5 * recipe.aperture_radius_arcsec}-${2.5 * recipe.aperture_radius_arcsec} arcsec; supplied background: ${recipe.background}`,
    `# Local annulus subtraction: ${subtractSky ? 'yes' : 'no; local sky remains'}`,
    '# wavelength/bandwidth/range: um; flux/error: uJy; MJD: UTC; coverage: fraction; formal independent-pixel errors only',
    '# No interpolation, missing samples omitted; wavelength-dependent PSF losses and non-simultaneity can change spectral shape',
    columns.join(','), ...points.map(p => columns.map(c => quote(p[c])).join(',')),
  ].join('\n');
}
