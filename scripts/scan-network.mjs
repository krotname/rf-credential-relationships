import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import CacheableLookup from 'cacheable-lookup';
import { Agent } from 'undici';
import pLimit from 'p-limit';

export function createScanNetwork({ resolver = new Resolver({ timeout: 2000, tries: 2 }), dnsConcurrency = 32 } = {}) {
  const limit = pLimit(dnsConcurrency);
  for (const method of ['resolve4', 'resolve6']) {
    const resolve = resolver[method].bind(resolver);
    resolver[method] = (...args) => limit(() => resolve(...args));
  }
  // Public DNS only: an OS lookup fallback would put failed names back into the
  // shared libuv queue. Preserve the URL hostname for HTTP Host and TLS/SNI.
  const dns = new CacheableLookup({ resolver, lookup: false, maxTtl: 300, errorTtl: 30 });
  const dispatcher = new Agent({
    connect: { lookup: dns.lookup },
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
  });
  const resolveUrl = async (url) => {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (!isIP(hostname)) await dns.query(hostname);
  };
  return { dns, dispatcher, resolveUrl };
}

export const scanNetwork = createScanNetwork();
