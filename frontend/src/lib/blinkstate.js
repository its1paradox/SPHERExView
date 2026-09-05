const VALID_BANDS = new Set([
  'all',
  'custom',
  'SPHEREx-D1',
  'SPHEREx-D2',
  'SPHEREx-D3',
  'SPHEREx-D4',
  'SPHEREx-D5',
  'SPHEREx-D6',
]);

const parseDetectors = (text, fallback) => {
  if (!text) return fallback;
  const detectors = [...new Set(text.split(',').map(Number))]
    .filter((detector) => Number.isInteger(detector) && detector >= 1 && detector <= 6)
    .sort((a, b) => a - b);
  return detectors.length ? detectors : fallback;
};

export function parseBlinkHash(hashText = '') {
  const p = new URLSearchParams(hashText.replace(/^#\/?/, ''));
  // Links created before configurable recipes did not carry these keys.
  // Preserve their historical API defaults instead of silently rebuilding
  // them at the newer high-clarity display settings.
  const legacyLink = p.has('ra') && p.has('dec') && !p.has('pixscale') && !p.has('resampling');
  const requestedBand = p.get('band') || 'all';
  const band = VALID_BANDS.has(requestedBand) ? requestedBand : 'all';
  let shortDetectors = parseDetectors(p.get('short'), [1, 2, 3, 4]);
  let longDetectors = parseDetectors(p.get('long'), [5, 6]);
  if (shortDetectors.some((detector) => longDetectors.includes(detector))) {
    shortDetectors = [1, 2, 3, 4];
    longDetectors = [5, 6];
  }
  return {
    coords: p.get('ra') && p.get('dec') ? `${p.get('ra')} ${p.get('dec')}` : '',
    size: p.get('size') || '240',
    survey: ['wide', 'deep'].includes(p.get('survey')) ? p.get('survey') : 'wide',
    months: p.get('months') || '6',
    maxframes: p.get('maxframes') || '500',
    band,
    ref: ['auto', 'excess', 'broad', 'none'].includes(p.get('ref')) ? p.get('ref') : 'auto',
    shortDetectors,
    longDetectors,
    background: ['zodi', 'none'].includes(p.get('background')) ? p.get('background') : 'zodi',
    sigma: p.get('sigma') || '5',
    maxiters: p.get('maxiters') || '2',
    minChannelExposures: p.get('minexp') || '1',
    pixscale: p.get('pixscale') || (legacyLink ? '6.2' : '3.1'),
    resampling: ['nearest', 'bilinear'].includes(p.get('resampling'))
      ? p.get('resampling')
      : legacyLink
        ? 'nearest'
        : 'bilinear',
  };
}

export function validateBlinkGrid(sizeArcsec, pixscaleArcsec) {
  const size = Number(sizeArcsec);
  const pixscale = Number(pixscaleArcsec);
  if (!Number.isFinite(size) || !Number.isFinite(pixscale) || pixscale <= 0) return null;
  const pixels = Math.max(4, Math.round(size / pixscale));
  return pixels <= 1024
    ? null
    : `This field would create a ${pixels}×${pixels} coadd. Reduce it to ${Math.floor(
        1024 * pixscale,
      )} arcsec or less at ${pixscale} arcsec/pixel.`;
}

export function buildBlinkParams(form, coords) {
  const params = new URLSearchParams({
    ra: coords.ra,
    dec: coords.dec,
    radius_arcsec: Number(form.size) / 2,
    survey: form.survey,
    bin_months: Number(form.months),
    limit: Number(form.maxframes),
    background: form.background,
    sigma: Number(form.sigma),
    maxiters: Number(form.maxiters),
    min_channel_exposures: Number(form.minChannelExposures),
    pixscale_arcsec: Number(form.pixscale),
    resampling: form.resampling,
  });
  if (form.band === 'custom') {
    params.set('short_detectors', form.shortDetectors.join(','));
    params.set('long_detectors', form.longDetectors.join(','));
  } else if (form.band !== 'all') {
    params.set('band', form.band);
    params.set('ref', form.ref || 'auto');
  }
  return params;
}

export function buildBlinkDataKey(form, coords) {
  const dataForm =
    form.ref === 'excess' ? { ...form, ref: 'auto' } : form;
  return buildBlinkParams(dataForm, coords).toString();
}

export function buildBlinkHash(form, coords) {
  return new URLSearchParams({
    ra: coords.ra,
    dec: coords.dec,
    size: form.size,
    survey: form.survey,
    months: form.months,
    maxframes: form.maxframes,
    band: form.band,
    ...(form.band === 'custom'
      ? { short: form.shortDetectors.join(','), long: form.longDetectors.join(',') }
      : form.band !== 'all'
        ? { ref: form.ref || 'auto' }
        : {}),
    background: form.background,
    sigma: form.sigma,
    maxiters: form.maxiters,
    minexp: form.minChannelExposures,
    pixscale: form.pixscale,
    resampling: form.resampling,
  }).toString();
}
