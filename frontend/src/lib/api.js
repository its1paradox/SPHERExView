import { localResearchFetch } from './research.js';
// Retry only explicit admission refusals; accepted jobs are never resubmitted.
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function fetchApi(url, options, maxRetries = Infinity) {
  return localResearchFetch(url, options, (url, opts) => networkFetch(url, opts, maxRetries));
}

async function networkFetch(url, options, maxRetries) {
  for (let attempt = 0; ; attempt += 1) {
    if (options?.signal?.aborted) throw options?.signal.reason ?? new DOMException('Aborted', 'AbortError');
    const response = await fetch(url, options);
    if (response.status !== 429 || attempt >= maxRetries) return response;
    const seconds = Number(response.headers.get('Retry-After') ?? 15);
    const delay = Number.isFinite(seconds) ? Math.max(0, Math.min(30, seconds)) : 15;
    await response.body?.cancel();
    await wait(delay * 1000, options?.signal);
  }
}
