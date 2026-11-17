import { useEffect, useState } from 'react';
import { decodeB64Float32, sortPixels } from './render.js';

// Metadata stays in the timeline; only a small working set of pixels is kept.
export const PIXEL_CACHE_SIZE = 12;
const cache = new Map();
const pinned = new Map();
export function cachedPixels(frame) {
  if (!frame?.data_url) return frame;
  const pixels = cache.get(frame.data_url);
  return pixels ? { ...frame, ...pixels } : frame;
}
export function rememberPixels(url, payload) {
  const data = decodeB64Float32(payload.data_b64);
  const pixels = { data, sorted: sortPixels(data) };
  cache.delete(url);
  cache.set(url, pixels);
  for (const key of cache.keys()) {
    if (cache.size <= PIXEL_CACHE_SIZE) break;
    if (!pinned.has(key)) cache.delete(key);
  }
  return pixels;
}
export function useFramePixels(frames) {
  const [state, setState] = useState({ revision: 0, error: null });
  const urls = [...new Set(frames.filter(Boolean).map(f => f.data_url).filter(Boolean))];
  const key = urls.join('|');
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    for (const url of urls) pinned.set(url, (pinned.get(url) || 0) + 1);
    setState(s => ({ ...s, error: null }));
    (async () => {
      for (const url of urls) {
        if (cache.has(url)) {
          const pixels = cache.get(url);
          cache.delete(url); cache.set(url, pixels);
          continue;
        }
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Image download failed (${response.status}). Select the frame again to retry.`);
        const payload = await response.json();
        if (!active) return;
        rememberPixels(url, payload);
        setState(s => ({ revision: s.revision + 1, error: null }));
      }
      // Another panel may have populated this cache. Recompute contrast as
      // well as pixels when selecting a cached frame; no request is necessary.
      if (active) setState(s => ({ revision: s.revision + 1, error: null }));
    })().catch(error => {
      if (active && error.name !== 'AbortError') setState(s => ({ ...s, error: error.message }));
    });
    return () => {
      active = false; controller.abort();
      for (const url of urls) {
        const count = pinned.get(url) - 1;
        if (count) pinned.set(url, count); else pinned.delete(url);
      }
    };
  }, [key]);
  return { ...state, loading: urls.some(url => !cache.has(url)), get: cachedPixels };
}
