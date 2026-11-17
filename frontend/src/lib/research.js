// The capability stays in this browser. Shareable scientific URLs never carry it.
const KEY = 'spherex.research.key.v1';
const pending = new Map();
let activeTarget = null;

export function browserKey() {
  if (typeof window === 'undefined') return null;
  let key = window.localStorage.getItem(KEY);
  if (!/^[a-f0-9]{64}$/.test(key || '')) {
    const bytes = new Uint8Array(32);
    window.crypto.getRandomValues(bytes);
    key = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
    window.localStorage.setItem(KEY, key);
  }
  return key;
}

export async function researchRequest(path = '', options = {}) {
  const response = await fetch(`/api/research${path}`, { ...options, headers: {
    'Content-Type': 'application/json', 'X-Research-Key': browserKey(), ...options.headers,
  } });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `History request failed (${response.status}).`);
  return data;
}

export function targetSpec(value) {
  return { ra: Number(value.ra), dec: Number(value.dec),
    size: Number(value.size ?? value.size_arcsec ?? value.fov ?? Number(value.radius_arcsec) * 2),
    survey: value.survey || 'wide', release: value.release || 'all' };
}

async function ensureTarget(value, force = false) {
  const spec = targetSpec(value), key = JSON.stringify(spec);
  if (force || !pending.has(key)) {
    const promise = researchRequest('', { method: 'POST', body: JSON.stringify(spec) });
    pending.set(key, promise);
    promise.catch(() => pending.delete(key));
  }
  return pending.get(key);
}

export async function beginResearch(value) {
  if (typeof window === 'undefined') return null;
  const target = await ensureTarget(value, true);
  activeTarget = target.id;
  return target;
}

export async function researchOptions(url, options) {
  if (typeof window === 'undefined' || typeof url !== 'string' || !url.startsWith('/api/')) return options;
  const parsed = new URL(url, window.location.origin);
  let target = activeTarget;
  if (/^\/api\/(epoch-stack|cutouts|epoch-coadds|coadd|wise-stack)$/.test(parsed.pathname) && parsed.searchParams.has('ra')) {
    const values = Object.fromEntries(parsed.searchParams);
    // WISE has no release/survey parameters; associate it with the current field.
    if (parsed.pathname !== '/api/wise-stack' || !target) target = (await ensureTarget(values)).id;
  } else if (parsed.pathname === '/api/detector-comparison' && options?.method === 'POST') {
    target = (await beginResearch(JSON.parse(options.body))).id;
  }
  const headers = new Headers(options?.headers);
  headers.set('X-Research-Key', browserKey());
  if (target && !parsed.pathname.startsWith('/api/research')) headers.set('X-Research-Target', target);
  return { ...options, headers };
}

export async function saveResearchView(value, tool, hash) {
  const target = await ensureTarget(value);
  return researchRequest(`/${target.id}/view`, { method: 'PUT', body: JSON.stringify({tool, hash}) });
}

export function targetLink(target, tool) {
  const saved = target.tools?.[tool];
  const defaults = new URLSearchParams({ra: target.ra, dec: target.dec, size: target.size, survey: target.survey, release: target.release});
  const params = new URLSearchParams(saved?.hash?.slice(1) || defaults);
  // Job lookup is by the exact recipe; the server reuses it until refreshed.
  // Old explicit result links must not override a cache clear or refresh.
  params.delete('result');
  return `${tool === 'timeline' ? 'timeline.html' : 'compare.html'}#${params}`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`;
}
