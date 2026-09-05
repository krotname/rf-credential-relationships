import { setTimeout as delay } from 'node:timers/promises';
import { getDomain } from 'tldts';

function siteKey(url) {
  const hostname = new URL(url).hostname;
  return getDomain(hostname, { allowPrivateDomains: false }) || hostname;
}

// Share limits across subdomains, ports and redirecting origins. Keep the slot
// until the body is consumed or cancelled, not merely until headers arrive.
export class DestinationLimiter {
  constructor({ intervalMs = 250 } = {}) {
    this.intervalMs = intervalMs;
    this.sites = new Map();
  }

  async run(url, signal, operation) {
    const key = siteKey(url);
    let state = this.sites.get(key);
    if (!state) {
      state = { tail: Promise.resolve(), nextStart: 0 };
      this.sites.set(key, state);
    }
    const previous = state.tail;
    let release;
    state.tail = new Promise((resolve) => { release = resolve; });
    try {
      await previous;
      signal.throwIfAborted();
      const wait = state.nextStart - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal });
      signal.throwIfAborted();
      state.nextStart = Date.now() + this.intervalMs;
      return await operation();
    } finally {
      release();
    }
  }
}

export class DiscoveryBudget {
  constructor(initialOrigins, maxAdditional, perSource = 100) {
    this.queued = new Set(initialOrigins);
    this.limit = this.queued.size + maxAdditional;
    this.perSource = perSource;
    this.roots = new Map(initialOrigins.map((origin) => [origin, siteKey(origin)]));
    this.counts = new Map();
  }

  accept(source, target) {
    if (this.queued.has(target) || this.queued.size >= this.limit) return false;
    const root = this.roots.get(source) || siteKey(source);
    const count = this.counts.get(root) || 0;
    if (count >= this.perSource) return false;
    this.counts.set(root, count + 1);
    this.queued.add(target);
    // Descendants cannot reset the originating site's discovery budget.
    this.roots.set(target, root);
    return true;
  }
}

export function describeFetchError(error) {
  const codes = new Set();
  function visit(value, depth = 0) {
    if (!value || depth > 5) return;
    if (value.code) codes.add(value.code);
    visit(value.cause, depth + 1);
    for (const nested of value.errors || []) visit(nested, depth + 1);
  }
  visit(error);
  return `${error.message}${codes.size ? ` [${[...codes].join(', ')}]` : ''}`;
}
