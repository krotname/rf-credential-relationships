import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DestinationLimiter, DiscoveryBudget, describeFetchError } from '../scripts/scan-limits.mjs';
import { fetchWithTimeout } from '../collect-rf-equivalent-domains.mjs';

test('redirect fan-in shares a destination slot through body consumption', async () => {
  const limiter = new DestinationLimiter({ intervalMs: 20 });
  const originalFetch = globalThis.fetch;
  let active = 0;
  let peak = 0;
  const starts = [];
  globalThis.fetch = async (url) => {
    if (!url.includes('victim.ru')) return new Response(null, { status: 302, headers: { location: 'https://victim.ru/data' } });
    active += 1;
    peak = Math.max(peak, active);
    starts.push(Date.now());
    return new Response(new ReadableStream({
      async start(controller) {
        await delay(35);
        controller.enqueue(new TextEncoder().encode('{}'));
        active -= 1;
        controller.close();
      },
    }));
  };
  try {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      fetchWithTimeout(`https://source${i}.ru/`, { redirect: 'follow-https', limiter, resolveUrl: async () => {} })));
    assert.deepEqual(results, Array(5).fill('{}'));
    assert.equal(peak, 1);
    assert.ok(starts.slice(1).every((start, i) => start - starts[i] >= 20));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('subdomains share start spacing; unrelated sites remain independent', async () => {
  const limiter = new DestinationLimiter({ intervalMs: 30 });
  const signal = AbortSignal.timeout(1000);
  const starts = [];
  await Promise.all(['https://a.example.ru', 'https://b.example.ru', 'https://other.ru'].map((url) =>
    limiter.run(url, signal, () => starts.push([url, Date.now()]))));
  assert.equal(starts[1][0], 'https://other.ru');
  assert.ok(starts[2][1] - starts[0][1] >= 25);
});

test('destination queueing does not spend the following request network timeout', async () => {
  const limiter = new DestinationLimiter({ intervalMs: 100 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, { signal }) => {
    signal.throwIfAborted();
    return new Response('{}');
  };
  try {
    assert.deepEqual(await Promise.all([
      fetchWithTimeout('https://a.ru/aasa', { limiter, timeoutMs: 30, resolveUrl: async () => {} }),
      fetchWithTimeout('https://a.ru/webauthn', { limiter, timeoutMs: 30, resolveUrl: async () => {} }),
    ]), ['{}', '{}']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('failed and expired queued requests release the slot without issuing traffic', async () => {
  const limiter = new DestinationLimiter({ intervalMs: 0 });
  const longSignal = AbortSignal.timeout(1000);
  const first = limiter.run('https://a.ru', longSignal, async () => { await delay(30); throw new Error('failure'); });
  const second = limiter.run('https://a.ru', AbortSignal.timeout(5), () => assert.fail('expired operation ran'));
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal(await limiter.run('https://a.ru', longSignal, () => 'ok'), 'ok');
});

test('wildcards and descendant chains cannot reset the source discovery quota', () => {
  const budget = new DiscoveryBudget(['https://a.ru', 'https://www.a.ru', 'https://b.ru'], 10, 2);
  assert.equal(budget.accept('https://a.ru', 'https://x.attacker.ru'), true);
  assert.equal(budget.accept('https://www.a.ru', 'https://y.attacker.ru'), true);
  assert.equal(budget.accept('https://x.attacker.ru', 'https://unrelated.ru'), false);
  assert.equal(budget.accept('https://a.ru', 'https://z.attacker.ru'), false);
  assert.equal(budget.accept('https://b.ru', 'https://a.ru'), false);
  assert.equal(budget.accept('https://b.ru', 'https://z.attacker.ru'), true);
  const small = new DiscoveryBudget(['https://a.ru'], 1);
  assert.equal(small.accept('https://a.ru', 'https://b.ru'), true);
  assert.equal(small.accept('https://a.ru', 'https://c.ru'), false);
});

test('network diagnostics retain nested resolver and connection error codes', () => {
  const error = new TypeError('fetch failed', { cause: new AggregateError([
    Object.assign(new Error('dns'), { code: 'EAI_AGAIN' }),
    Object.assign(new Error('connect'), { code: 'ETIMEDOUT' }),
  ]) });
  assert.equal(describeFetchError(error), 'fetch failed [EAI_AGAIN, ETIMEDOUT]');
});
