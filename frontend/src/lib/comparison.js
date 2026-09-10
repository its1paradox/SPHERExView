// Science arrays are never stretched or normalized in place.
export const DETECTORS = [1, 2, 3, 4, 5, 6];
export const NOMINAL_RANGES = ['0.75–1.09', '1.10–1.62', '1.63–2.41', '2.42–3.82', '3.83–4.41', '4.42–5.00'];
export const LAYERS = {
  intensity: ['Intensity', 'MJy/sr'], uncertainty: ['Formal uncertainty', 'MJy/sr'],
  coverage: ['Valid exposures', 'exposures'], hits: ['Input pixel hits', 'samples'],
  snr: ['Intensity / formal σ', 'I/σ'], wavelength: ['Mean sampled wavelength', 'µm'],
  spread: ['Wavelength span', 'µm'], bandwidth: ['Mean pixel bandwidth', 'µm'],
};

export function comparisonUrl(ra, dec, size, survey) {
  return `compare.html#${new URLSearchParams({ ra, dec, size, survey })}`;
}

export function readState(hash = '') {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  let ranges = {};
  try { ranges = JSON.parse(p.get('ranges') || '{}'); } catch { /* validated at build */ }
  const form = {
    coords: p.has('ra') && p.has('dec') ? `${p.get('ra')} ${p.get('dec')}` : '',
    size_arcsec: p.get('size') || '240', survey: p.get('survey') || 'wide',
    bin_months: p.get('months') || '6', grouping: p.get('grouping') || 'visit',
    epoch_origin_mjd: p.get('origin') || '60000', mjd_start: p.get('start') || '', mjd_end: p.get('end') || '',
    max_per_tile: p.get('cap') || '0', pixscale_arcsec: p.get('pixels') || '6.2',
    resampling: p.get('resampling') || 'bin', background: p.get('background') || 'zodi',
    weighting: p.get('weighting') || 'equal', min_exposures: p.get('minexp') || '1', ranges,
  };
  const bounded = (key, fallback, lo, hi) => {
    const x = Number(p.get(key));
    return p.has(key) && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : fallback;
  };
  return { form, display: {
    mode: ['color', 'wavelength'].includes(p.get('mode')) ? p.get('mode') : 'gray',
    wavelengthStrength: bounded('wavestrength', 1, 0, 1),
    wavelengthWhite: p.get('wavewhite') || '',
    reference: Math.round(bounded('reference', 4, 1, 6)),
    referenceGain: bounded('refgain', 1, 0.01, 100),
    colorSigma: bounded('colorsigma', 3, 0, 10),
    colorStrength: bounded('colorstrength', 1, 0, 1),
    colorWhite: p.get('colorwhite') || '',
    layer: Object.hasOwn(LAYERS, p.get('layer')) ? p.get('layer') : 'intensity',
    stretch: p.get('stretch') === 'linear' ? 'linear' : 'asinh',
    invert: p.get('invert') === '1', smooth: p.get('smooth') === '1',
    zoom: bounded('zoom', 1, 0.5, 16), panX: bounded('panx', 0, -1, 1), panY: bounded('pany', 0, -1, 1),
    vmin: p.get('vmin') || '', vmax: p.get('vmax') || '',
  }, epoch: Math.floor(bounded('epoch', 0, 0, 10000)), pin: p.has('pinra') && p.has('pindec') ? { ra: bounded('pinra', 0, 0, 360), dec: bounded('pindec', 0, -90, 90) } : null };
}

export function recipeFromForm(f) {
  const coords = f.coords.trim().split(/[\s,;]+/).map(Number);
  if (coords.length !== 2 || !coords.every(Number.isFinite) || coords[0] < 0 || coords[0] >= 360 || Math.abs(coords[1]) > 90) throw new Error('Enter RA and Dec in decimal degrees (ICRS).');
  const numeric = (key) => {
    if (String(f[key]).trim() === '' || !Number.isFinite(Number(f[key]))) throw new Error(`Invalid ${key.replaceAll('_', ' ')}.`);
    return Number(f[key]);
  };
  const r = { ra: coords[0], dec: coords[1], survey: f.survey, grouping: f.grouping, background: f.background, resampling: f.resampling, weighting: f.weighting, wavelength_ranges: {} };
  for (const key of ['size_arcsec', 'bin_months', 'epoch_origin_mjd', 'max_per_tile', 'pixscale_arcsec', 'min_exposures']) r[key] = numeric(key);
  for (const key of ['mjd_start', 'mjd_end']) r[key] = f[key] === '' ? null : numeric(key);
  for (const d of DETECTORS) {
    const [lo = '', hi = ''] = f.ranges[d] || [];
    if (lo === '' && hi === '') continue;
    if (lo === '' || hi === '' || !Number.isFinite(Number(lo)) || !Number.isFinite(Number(hi)) || Number(lo) <= 0 || Number(hi) <= Number(lo) || Number(hi) > 10) throw new Error(`D${d}: enter both wavelength bounds with 0 < lower < upper ≤ 10 µm.`);
    r.wavelength_ranges[d] = [Number(lo), Number(hi)];
  }
  return r;
}

export function stateHash(form, display, epoch, pin) {
  const p = new URLSearchParams();
  const coords = form.coords.trim().split(/[\s,;]+/);
  if (coords.length === 2) { p.set('ra', coords[0]); p.set('dec', coords[1]); }
  for (const [key, field] of Object.entries({ size: 'size_arcsec', survey: 'survey', months: 'bin_months', grouping: 'grouping', origin: 'epoch_origin_mjd', start: 'mjd_start', end: 'mjd_end', cap: 'max_per_tile', pixels: 'pixscale_arcsec', resampling: 'resampling', background: 'background', weighting: 'weighting', minexp: 'min_exposures' })) if (form[field] !== '') p.set(key, form[field]);
  p.set('ranges', JSON.stringify(form.ranges));
  for (const key of ['layer', 'stretch', 'zoom', 'vmin', 'vmax', 'mode', 'reference']) if (display[key] !== '') p.set(key, display[key]);
  for (const [key, field] of Object.entries({ refgain: 'referenceGain', colorsigma: 'colorSigma', colorstrength: 'colorStrength', colorwhite: 'colorWhite', wavestrength: 'wavelengthStrength', wavewhite: 'wavelengthWhite' })) if (display[field] !== '' && display[field] !== undefined) p.set(key, display[field]);
  p.set('invert', display.invert ? '1' : '0'); p.set('smooth', display.smooth ? '1' : '0');
  p.set('panx', display.panX); p.set('pany', display.panY); p.set('epoch', epoch);
  if (pin) { p.set('pinra', pin.ra); p.set('pindec', pin.dec); }
  return `#${p}`;
}

export function decodeMap(map, count) {
  const binary = atob(map.data_b64);
  const types = { '<f4': [4, 'getFloat32'], '<f8': [8, 'getFloat64'], '<u4': [4, 'getUint32'] };
  const type = types[map.dtype];
  if (!type || binary.length !== count * type[0]) throw new Error('Comparison array shape or type is invalid.');
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer), out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = view[type[1]](i * type[0], true);
  return out;
}

export function decodeResult(result) {
  if (!result.epochs?.every(e => e.tiles.length === 6 && e.tiles.every((t, i) => t.detector === i + 1))) throw new Error('Comparison must contain six ordered detector slots in every epoch.');
  return { ...result, epochs: result.epochs.map(e => ({ ...e, tiles: e.tiles.map(t => ({ ...t, arrays: t.maps ? Object.fromEntries(Object.entries(t.maps).map(([key, map]) => [key, decodeMap(map, result.width * result.height)])) : null })) })) };
}

export function layerArray(tile, layer) {
  if (!tile.arrays) return null;
  const a = tile.arrays;
  if (a[layer]) return a[layer];
  if (layer === 'uncertainty') return a.variance.map(x => x >= 0 ? Math.sqrt(x) : NaN);
  if (layer === 'snr') return a.intensity.map((x, i) => a.variance[i] > 0 ? x / Math.sqrt(a.variance[i]) : NaN);
  if (layer === 'spread') return a.lambda_max.map((x, i) => x - a.lambda_min[i]);
  return null;
}

export function pooledLimits(arrays, layer) {
  const values = [];
  for (const arr of arrays) if (arr) for (const value of arr) if (Number.isFinite(value)) values.push(value);
  values.sort((a, b) => a - b);
  if (!values.length) return [0, 1];
  const at = p => values[Math.floor((values.length - 1) * p)];
  const lo = ['intensity', 'snr'].includes(layer) ? Math.min(0, at(.005)) : Math.max(0, at(.005));
  const hi = ['coverage', 'hits'].includes(layer) ? values.at(-1) : at(.995);
  return [lo, hi > lo ? hi : lo + Math.max(Math.abs(lo) * .01, 1e-6)];
}

export function displayFraction(value, lo, hi, stretch) {
  const transform = stretch === 'asinh' ? x => Math.asinh(x / Math.max((hi - lo) / 10, 1e-30)) : x => x;
  // Signed transform about physical zero. Negative intensities remain data.
  const a = transform(lo), b = transform(hi);
  return Math.max(0, Math.min(1, (transform(value) - a) / (b - a)));
}

export function screenToImage(x, y, side, n, display) {
  const scale = side * display.zoom / n;
  return [(x - side / 2) / scale + n / 2 - display.panX * n, (y - side / 2) / scale + n / 2 - display.panY * n];
}

export function imageToScreen(x, y, side, n, display) {
  const scale = side * display.zoom / n;
  return [(x - n / 2 + display.panX * n) * scale + side / 2, (y - n / 2 + display.panY * n) * scale + side / 2];
}

// x/y are fractions of the displayed square. Keep this image position fixed
// during wheel or button zoom; shared state links every panel.
export function zoomAt(display, factor, x = 0.5, y = 0.5) {
  const zoom = Math.max(0.5, Math.min(16, display.zoom * factor));
  const shift = 1 / zoom - 1 / display.zoom;
  return { ...display, zoom,
    panX: Math.max(-1, Math.min(1, display.panX + (x - 0.5) * shift)),
    panY: Math.max(-1, Math.min(1, display.panY + (y - 0.5) * shift)),
  };
}

export function sampleAt(tile, x, y, width, height) {
  const col = Math.floor(x), row = Math.floor(y);
  if (!tile.arrays || col < 0 || row < 0 || col >= width || row >= height) return null;
  const i = row * width + col;
  return Object.fromEntries(Object.entries(tile.arrays).map(([key, values]) => [key, values[i]]));
}
