// WiseView-style URL state: every query + display attribute lives in the
// hash fragment (e.g. #ra=133.786&dec=-7.245&size=240&zoom=450&invert=1),
// so any view can be bookmarked, shared, and restored exactly.

// Adjustable display defaults.
//
// SPHEREx: inverted grayscale, sqrt stretch, manual black/white points at
// 0.5% / 95% (per-frame percentile limits).
//
// WISE: AstroToolBox's algorithm with brightness=1, contrast=75, linear
// stretch, inverted grayscale (dark sources on a light background).
export const DEFAULT_DISPLAY = {
  displaySize: 450,
  speedMs: 300,
  sxScaleMode: 'percentile',
  sxBlackPct: 0.5,
  sxWhitePct: 95,
  sxStretch: 'sqrt',
  sxInvert: true,
  sxSmooth: false,
  sxOuter: false,
  wiseBrightness: 1,
  wiseContrast: 75,
  wiseStretch: 'linear',
  wiseInvert: true,
  wiseSmooth: false,
};

export const DEFAULT_FORM = {
  coords: '133.786 -7.245',
  fov: '240',
  survey: 'wide',
  bands: [], // empty = all bands
  limit: '20',
  wiseBand: 'w2',
};

export const DEFAULT_VIEW = {
  ...DEFAULT_DISPLAY,
  showWise: true,
  showMarkers: false,
  showCombined: true,
  showCoadd: true,
};

// hash key -> [read(form|view) , write(value, form, view)]
// Bands travel as "1,4,6" (SPHEREx-D1 etc.); booleans as 0/1.
const bandsToHash = (bands) => bands.map((b) => b.replace('SPHEREx-D', '')).join(',');
const bandsFromHash = (text) =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[1-6]$/.test(s))
    .map((n) => `SPHEREx-D${n}`);

const num = (v) => {
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : undefined;
};
const bool01 = (v) => (v === '1' ? true : v === '0' ? false : undefined);

export function parseHash(hashText) {
  const raw = (hashText || '').replace(/^#\/?/, '');
  const params = new URLSearchParams(raw);
  const get = (k) => (params.has(k) ? params.get(k) : undefined);

  const form = { ...DEFAULT_FORM };
  const view = { ...DEFAULT_VIEW };
  let hasTarget = false;

  const ra = num(get('ra'));
  const dec = num(get('dec'));
  if (ra !== undefined && dec !== undefined && ra >= 0 && ra < 360 && dec >= -90 && dec <= 90) {
    form.coords = `${ra} ${dec}`;
    hasTarget = true;
  }
  if (num(get('size')) !== undefined) form.fov = String(num(get('size')));
  if (get('survey') === 'wide' || get('survey') === 'deep') form.survey = get('survey');
  if (get('bands') !== undefined) form.bands = bandsFromHash(get('bands'));
  if (num(get('maxframes')) !== undefined) form.limit = String(Math.round(num(get('maxframes'))));
  if (['w1', 'w2', 'w1w2'].includes(get('wiseband'))) form.wiseBand = get('wiseband');

  const setB = (key, hk) => {
    const v = bool01(get(hk));
    if (v !== undefined) view[key] = v;
  };
  const setN = (key, hk, lo, hi) => {
    const v = num(get(hk));
    if (v !== undefined && v >= lo && v <= hi) view[key] = v;
  };
  setB('showWise', 'wise');
  setB('showMarkers', 'gaia');
  setB('showCombined', 'combined');
  setB('showCoadd', 'coadd');
  setN('displaySize', 'zoom', 150, 900);
  setN('speedMs', 'speed', 60, 1200);
  if (['percentile', 'zscale'].includes(get('sxscale'))) view.sxScaleMode = get('sxscale');
  setN('sxBlackPct', 'sxblack', 0, 50);
  setN('sxWhitePct', 'sxwhite', 80, 100);
  if (['sqrt', 'asinh', 'linear', 'log'].includes(get('sxstretch'))) view.sxStretch = get('sxstretch');
  setB('sxInvert', 'sxinvert');
  setB('sxSmooth', 'sxsmooth');
  setB('sxOuter', 'outer_epochs');
  setN('wiseBrightness', 'wbright', 1, 100);
  setN('wiseContrast', 'wcontrast', 1, 100);
  if (['linear', 'asinh', 'sqrt', 'log'].includes(get('wstretch'))) view.wiseStretch = get('wstretch');
  setB('wiseInvert', 'winvert');
  setB('wiseSmooth', 'wsmooth');

  return { form, view, hasTarget };
}

export function buildHash(form, view) {
  const parts = [];
  const push = (k, v) => parts.push(`${k}=${encodeURIComponent(v)}`);

  const m = form.coords.trim().split(/[\s,;]+/);
  if (m.length === 2 && Number.isFinite(parseFloat(m[0])) && Number.isFinite(parseFloat(m[1]))) {
    push('ra', parseFloat(m[0]));
    push('dec', parseFloat(m[1]));
  }
  push('size', form.fov);
  push('survey', form.survey);
  if (form.bands.length > 0) push('bands', bandsToHash(form.bands));
  push('maxframes', form.limit);
  push('wiseband', form.wiseBand);
  push('wise', view.showWise ? 1 : 0);
  push('gaia', view.showMarkers ? 1 : 0);
  push('combined', view.showCombined ? 1 : 0);
  push('coadd', view.showCoadd ? 1 : 0);
  push('zoom', view.displaySize);
  push('speed', view.speedMs);
  push('sxscale', view.sxScaleMode);
  push('sxblack', view.sxBlackPct);
  push('sxwhite', view.sxWhitePct);
  push('sxstretch', view.sxStretch);
  push('sxinvert', view.sxInvert ? 1 : 0);
  push('sxsmooth', view.sxSmooth ? 1 : 0);
  push('outer_epochs', view.sxOuter ? 1 : 0);
  push('wbright', view.wiseBrightness);
  push('wcontrast', view.wiseContrast);
  push('wstretch', view.wiseStretch);
  push('winvert', view.wiseInvert ? 1 : 0);
  push('wsmooth', view.wiseSmooth ? 1 : 0);
  return '#' + parts.join('&');
}
