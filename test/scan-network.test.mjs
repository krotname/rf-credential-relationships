import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Resolver } from 'node:dns/promises';
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
    assert.equal(await fetchWithTimeout(`http://${host}`, { dispatcher: network.dispatcher }), host);
    assert.equal(await fetchWithTimeout(`http://${host}`, { dispatcher: network.dispatcher }), host);
    assert.deepEqual(lookups, ['dns-test.example.ru']);
  } finally {
    await network.dispatcher.close();
    await new Promise((resolve) => server.close(resolve));
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
