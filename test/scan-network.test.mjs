import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Resolver } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createScanNetwork } from '../scripts/scan-network.mjs';
import { fetchWithTimeout } from '../collect-rf-equivalent-domains.mjs';

function notFound() {
  return Object.assign(new Error('not found'), { code: 'ENODATA' });
}

test('scanner uses async DNS and preserves the requested HTTP hostname', async () => {
  const lookups = [];
  const network = createScanNetwork({ resolver: Object.assign(new Resolver(), {
    async resolve4(hostname) { lookups.push(hostname); return [{ address: '127.0.0.1', ttl: 60 }]; },
    async resolve6() { throw notFound(); },
  }) });
  const server = createServer((request, response) => {
    response.end(request.headers.host);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const host = `dns-test.example.ru:${server.address().port}`;
    assert.equal(await fetchWithTimeout(`http://${host}`, { dispatcher: network.dispatcher, resolveUrl: network.resolveUrl }), host);
    assert.equal(await fetchWithTimeout(`http://${host}`, { dispatcher: network.dispatcher, resolveUrl: network.resolveUrl }), host);
    assert.deepEqual(lookups, ['dns-test.example.ru']);
  } finally {
    await network.dispatcher.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('cold DNS queries stay bounded without spending the HTTPS request timeout', async () => {
  let active = 0;
  let peak = 0;
  const resolve = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await delay(20);
    active -= 1;
    return [{ address: '192.0.2.1', ttl: 60 }];
  };
  const network = createScanNetwork({ dnsConcurrency: 2, resolver: Object.assign(new Resolver(), {
    resolve4: resolve,
    async resolve6() { await resolve(); throw notFound(); },
  }) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, { signal }) => { signal.throwIfAborted(); return new Response('{}'); };
  try {
    await Promise.all(Array.from({ length: 5 }, (_, i) => fetchWithTimeout(`https://dns${i}.ru`, {
      dispatcher: network.dispatcher, resolveUrl: network.resolveUrl, timeoutMs: 5,
    })));
    assert.equal(peak, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await network.dispatcher.close();
  }
});

test('slow DNS does not block another domain and missing names do not fall back to OS lookup', async () => {
  let finishSlow;
  const network = createScanNetwork({ resolver: Object.assign(new Resolver(), {
    async resolve4(hostname) {
      if (hostname === 'slow.example.ru') await new Promise((resolve) => { finishSlow = resolve; });
      if (hostname === 'localhost') throw notFound();
      return [{ address: '192.0.2.1', ttl: 60 }];
    },
    async resolve6() { throw notFound(); },
  }) });
  try {
    const slow = network.dns.lookupAsync('slow.example.ru', { family: 4 });
    const fast = await network.dns.lookupAsync('fast.example.ru', { family: 4 });
    assert.equal(fast.address, '192.0.2.1');
    await assert.rejects(network.dns.lookupAsync('localhost'), { code: 'ENOTFOUND' });
    finishSlow();
    assert.equal((await slow).address, '192.0.2.1');
  } finally {
    finishSlow?.();
    await network.dispatcher.close();
  }
});
