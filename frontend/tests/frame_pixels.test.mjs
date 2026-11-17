import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedPixels, rememberPixels, PIXEL_CACHE_SIZE } from '../src/lib/framePixels.js';

test('decoded pixels are bounded while every frame remains addressable', () => {
  const payload = {data_b64: Buffer.from(new Float32Array([1,-2,3,4]).buffer).toString('base64')};
  const frames = Array.from({length: 1007}, (_, i) => ({data_url:`/static/cutouts/test-${i}.json`,id:i}));
  for (const frame of frames) rememberPixels(frame.data_url, payload);
  assert.equal(frames.filter(f => cachedPixels(f).data).length, PIXEL_CACHE_SIZE);
  assert.equal(cachedPixels(frames[0]).data, undefined);
  rememberPixels(frames[0].data_url, payload);
  assert.deepEqual([...cachedPixels(frames[0]).data], [1,-2,3,4]);
  assert.equal(cachedPixels(frames.at(-1)).id,1006);
});
