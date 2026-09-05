import { Resolver } from 'node:dns/promises';
import CacheableLookup from 'cacheable-lookup';
import { Agent } from 'undici';

export function createScanNetwork({ resolver = new Resolver({ timeout: 2000, tries: 2 }) } = {}) {
  // Public DNS only: an OS lookup fallback would put failed names back into the
  // shared libuv queue. Preserve the URL hostname for HTTP Host and TLS/SNI.
  const dns = new CacheableLookup({ resolver, lookup: false, maxTtl: 300, errorTtl: 30 });
  const dispatcher = new Agent({
    connect: { lookup: dns.lookup },
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
  });
  return { dns, dispatcher };
}

export const scanNetwork = createScanNetwork();
