import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchApi } from '../src/lib/api.js';

test('public admission retry preserves request and returns accepted response once', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return new Response('{}', {status: calls.length === 1 ? 429 : 202, headers: {'Retry-After': '0'}});
  };
  try {
    let waiting=0,resuming=0;
    const options = {method:'POST', body:'{"ra":1,"dec":2}',onResearchWait:async()=>{waiting++;},onResearchAttempt:async()=>{resuming++;}};
    assert.equal((await fetchApi('/api/detector-comparison', options)).status, 202);
    assert.equal(waiting,1,'dashboard receives admission-wait progress');
    assert.equal(resuming,1,'accepted retries must leave the waiting state');
    assert.deepEqual(calls, [['/api/detector-comparison', options], ['/api/detector-comparison', options]]);
  } finally { globalThis.fetch = original; }
});

test('busy retries are bounded and preserve the final error response', async () => {
  const original = globalThis.fetch;
  let calls=0;
  globalThis.fetch = async () => { calls++; return new Response('busy', {status:429, headers:{'Retry-After':'0'}}); };
  try {
    const response=await fetchApi('/api/wise-stack', {}, 2);
    assert.equal(calls, 3);
    assert.equal(await response.text(), 'busy');
  } finally { globalThis.fetch = original; }
});

test('other failures are not automatically repeated', async () => {
  const original = globalThis.fetch;
  let calls=0;
  globalThis.fetch=async () => {calls++; return new Response('{}',{status:503});};
  try { assert.equal((await fetchApi('/api/epoch-stack')).status,503); assert.equal(calls,1); }
  finally {globalThis.fetch=original;}
});

test('cancellation during admission wait prevents another request', async () => {
  const original = globalThis.fetch;
  const controller=new AbortController();
  let calls=0;
  globalThis.fetch=async () => {
    calls++;
    setTimeout(() => controller.abort(), 1);
    return new Response('{}',{status:429,headers:{'Retry-After':'15'}});
  };
  try {
    await assert.rejects(fetchApi('/api/epoch-stack',{signal:controller.signal}),{name:'AbortError'});
    assert.equal(calls,1);
  } finally {globalThis.fetch=original;}
});
