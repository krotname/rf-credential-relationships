#!/usr/bin/env node

import { promises as fs, createReadStream } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { domainToASCII, fileURLToPath } from 'node:url';
import { getDomain } from 'tldts';

export const LOGIN_RELATION = 'delegate_permission/common.get_login_creds';

const MAJESTIC_URL = 'https://downloads.majestic.com/majestic_million.csv';
const CLOUDFLARE_URL = 'https://api.cloudflare.com/client/v4/radar/ranking/top';
const BITWARDEN_GLOBAL_URL =
  'https://raw.githubusercontent.com/bitwarden/server/main/src/Core/Utilities/StaticStore.cs';
const APPLE_SHARED_URL =
  'https://raw.githubusercontent.com/apple/password-manager-resources/main/quirks/shared-credentials.json';
const RUSSIAN_SUFFIXES = new Set(['ru', 'su', 'xn--p1ai']);
const MAX_ASSETLINKS_BYTES = 1024 * 1024;
const CACHE_VERSION = 1;
const BLOCKED_APP_PARTS = new Set([
  'acceptance', 'alpha', 'beta', 'broteam', 'canary', 'corplogin', 'debug', 'demo', 'dev',
  'development', 'dogfood', 'internal', 'pr', 'preprod', 'preview', 'proddebug',
  'qa', 'sample', 'sandbox', 'stage', 'staging', 'teamfood', 'teamfood2', 'test',
  'testing', 'uat',
]);

function usage() {
  return `
Сборщик эквивалентных доменов для Vaultwarden

Использование:
  node collect-rf-equivalent-domains.mjs [параметры]

Источники кандидатов:
  --source majestic       Majestic Million, только .ru/.su/.рф (по умолчанию)
  --source cloudflare     Cloudflare Radar с location=RU; нужен API-токен
  --source file           Домены из --input (txt/csv/json)
  --domains a.ru,b.ru     Проверить конкретные домены вместо рейтинга

Параметры:
  --limit N               Число доменов рейтинга (по умолчанию 1000)
  --concurrency N         Параллельные HTTPS-запросы (по умолчанию 20)
  --timeout-ms N          Тайм-аут запроса (по умолчанию 7000)
  --out PATH              Каталог результата (по умолчанию ./out)
  --input PATH            Файл для --source file
  --token-env NAME        Переменная токена Cloudflare (CLOUDFLARE_API_TOKEN)
  --cache-hours N         Срок кэша (по умолчанию 24)
  --max-discovered N      Дополнительные origins для взаимной проверки
  --check-www             Отдельно проверять www для каждого домена
  --refresh               Не использовать прежний кэш
  --no-catalogs           Не сверять Bitwarden и Apple
  --allow-prerelease-apps Не отбрасывать debug/beta/test Android-пакеты
  --help                   Эта справка
`;
}

function readValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Для ${option} требуется значение`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    source: 'majestic',
    limit: 1000,
    concurrency: 20,
    timeoutMs: 7000,
    out: path.resolve('out'),
    input: null,
    domains: null,
    tokenEnv: 'CLOUDFLARE_API_TOKEN',
    cacheHours: 24,
    maxDiscovered: null,
    checkWww: false,
    refresh: false,
    catalogs: true,
    allowPrereleaseApps: false,
    help: false,
  };

  const stringOptions = new Map([
    ['--source', 'source'], ['--out', 'out'], ['--input', 'input'],
    ['--domains', 'domains'], ['--token-env', 'tokenEnv'],
  ]);
  const numberOptions = new Map([
    ['--limit', 'limit'], ['--concurrency', 'concurrency'],
    ['--timeout-ms', 'timeoutMs'], ['--cache-hours', 'cacheHours'],
    ['--max-discovered', 'maxDiscovered'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help' || option === '-h') options.help = true;
    else if (option === '--refresh') options.refresh = true;
    else if (option === '--check-www') options.checkWww = true;
    else if (option === '--no-catalogs') options.catalogs = false;
    else if (option === '--allow-prerelease-apps') options.allowPrereleaseApps = true;
    else if (stringOptions.has(option)) {
      options[stringOptions.get(option)] = readValue(argv, index, option);
      index += 1;
    } else if (numberOptions.has(option)) {
      const value = Number(readValue(argv, index, option));
      if (!Number.isFinite(value) || value < 0) throw new Error(`Некорректное число для ${option}`);
      options[numberOptions.get(option)] = value;
      index += 1;
    } else {
      throw new Error(`Неизвестный параметр: ${option}`);
    }
  }

  if (!['majestic', 'cloudflare', 'file'].includes(options.source)) {
    throw new Error('Источник должен быть majestic, cloudflare или file');
  }
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('--limit должен быть целым числом >= 1');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 100) {
    throw new Error('--concurrency должен быть целым числом от 1 до 100');
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 500) throw new Error('--timeout-ms должен быть >= 500');
  if (options.source === 'file' && !options.input && !options.domains) {
    throw new Error('Для --source file укажите --input');
  }
  options.out = path.resolve(options.out);
  if (options.input) options.input = path.resolve(options.input);
  options.maxDiscovered ??= 0;
  return options;
}

export function normalizeHostname(value) {
  if (typeof value !== 'string') return null;
  let candidate = value.trim().toLowerCase();
  if (!candidate) return null;
  try {
    if (candidate.includes('://')) candidate = new URL(candidate).hostname;
  } catch {
    return null;
  }
  candidate = candidate.replace(/^\.+|\.+$/g, '');
  const ascii = domainToASCII(candidate);
  if (!ascii || ascii.length > 253 || isIP(ascii)) return null;
  if (ascii === 'localhost' || ascii.endsWith('.localhost')) return null;
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(ascii)) {
    return null;
  }
  return ascii;
}

export function registrableDomain(value) {
  const hostname = normalizeHostname(value);
  if (!hostname) return null;
  return getDomain(hostname, { allowPrivateDomains: false }) || null;
}

export function normalizeWebOrigin(value) {
  try {
    const url = new URL(value);
    const authority = url.href.slice(url.protocol.length + 2).split('/')[0];
    if (url.protocol !== 'https:' || authority.includes('@') || url.port) return null;
    if (!normalizeHostname(url.hostname)) return null;
    if (url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else field += character;
  }
  fields.push(field);
  return fields;
}

async function fetchWithTimeout(url, { timeoutMs, headers = {}, maxBytes = 8 * 1024 * 1024, jsonOnly = false } = {}) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'rf-vaultwarden-domain-rules/1.0', ...headers },
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (response.status >= 300 && response.status < 400) throw new Error(`redirect ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > maxBytes) throw new Error(`ответ больше ${maxBytes} байт`);
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (jsonOnly && !contentType.includes('json')) throw new Error(`неверный Content-Type: ${contentType || 'пусто'}`);
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new Error(`ответ больше ${maxBytes} байт`);
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
}

async function majesticCandidates(limit, timeoutMs) {
  const response = await fetch(MAJESTIC_URL, {
    headers: { 'user-agent': 'rf-vaultwarden-domain-rules/1.0' },
    redirect: 'follow',
    signal: AbortSignal.timeout(Math.max(timeoutMs, 120000)),
  });
  if (!response.ok || !response.body) throw new Error(`Majestic Million: HTTP ${response.status}`);
  const stream = Readable.fromWeb(response.body);
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const candidates = [];
  const seen = new Set();
  let headers = null;
  try {
    for await (const line of lines) {
      const fields = parseCsvLine(line);
      if (!headers) {
        headers = fields.map((field) => field.trim().toLowerCase());
        continue;
      }
      const domainIndex = headers.indexOf('domain');
      const tldIndex = headers.indexOf('tld');
      const domain = registrableDomain(fields[domainIndex]);
      const suffix = (fields[tldIndex] || '').trim().toLowerCase();
      if (domain && RUSSIAN_SUFFIXES.has(suffix) && !seen.has(domain)) {
        seen.add(domain);
        candidates.push(domain);
      }
      if (candidates.length >= limit) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return candidates;
}

async function cloudflareCandidates(limit, timeoutMs, tokenEnv) {
  const token = process.env[tokenEnv];
  if (!token) throw new Error(`Не задана переменная ${tokenEnv} с API-токеном Cloudflare`);
  const url = new URL(CLOUDFLARE_URL);
  url.searchParams.set('location', 'RU');
  url.searchParams.set('rankingType', 'POPULAR');
  url.searchParams.set('format', 'JSON');
  url.searchParams.set('limit', String(limit));
  const text = await fetchWithTimeout(url, {
    timeoutMs,
    headers: { authorization: `Bearer ${token}` },
    jsonOnly: true,
  });
  const payload = JSON.parse(text);
  if (!payload.success) throw new Error('Cloudflare Radar вернул success=false');
  return (payload.result?.top_0 || []).map((entry) => normalizeHostname(entry.domain)).filter(Boolean);
}

function domainsFromJson(payload) {
  const values = Array.isArray(payload) ? payload : payload.domains;
  if (!Array.isArray(values)) throw new Error('JSON должен быть массивом доменов или объектом {"domains": [...]}');
  return values.map((item) => normalizeHostname(typeof item === 'string' ? item : item?.domain)).filter(Boolean);
}

async function fileCandidates(filePath, limit) {
  const text = await fs.readFile(filePath, 'utf8');
  if (filePath.toLowerCase().endsWith('.json')) return domainsFromJson(JSON.parse(text)).slice(0, limit);
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
  if (!lines.length) return [];
  const firstFields = parseCsvLine(lines[0]).map((field) => field.trim().toLowerCase());
  const headerDomainIndex = firstFields.indexOf('domain');
  const start = headerDomainIndex >= 0 ? 1 : 0;
  const domains = [];
  for (let index = start; index < lines.length && domains.length < limit; index += 1) {
    const fields = parseCsvLine(lines[index]);
    let raw = headerDomainIndex >= 0 ? fields[headerDomainIndex] : fields[0];
    if (headerDomainIndex < 0 && /^\d+$/.test((fields[0] || '').trim()) && fields[1]) raw = fields[1];
    const domain = normalizeHostname(raw);
    if (domain) domains.push(domain);
  }
  return domains;
}

async function loadCandidates(options) {
  let values;
  let source;
  if (options.domains) {
    values = options.domains.split(',').map(normalizeHostname).filter(Boolean);
    source = 'explicit-domains';
  } else if (options.source === 'majestic') {
    values = await majesticCandidates(options.limit, options.timeoutMs);
    source = MAJESTIC_URL;
  } else if (options.source === 'cloudflare') {
    values = await cloudflareCandidates(options.limit, options.timeoutMs, options.tokenEnv);
    source = `${CLOUDFLARE_URL}?location=RU`;
  } else {
    values = await fileCandidates(options.input, options.limit);
    source = options.input;
  }
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const domain = registrableDomain(value);
    if (domain && !seen.has(domain)) {
      seen.add(domain);
      unique.push(domain);
    }
    if (unique.length >= options.limit) break;
  }
  if (!unique.length) throw new Error('Источник не дал ни одного корректного домена');
  return { domains: unique, source };
}

export function extractCredentialDeclarations(payload, sourceOrigin) {
  if (!Array.isArray(payload)) throw new Error('assetlinks.json должен содержать JSON-массив');
  const web = [];
  const android = [];
  for (const statement of payload) {
    const relations = Array.isArray(statement?.relation) ? statement.relation : [];
    if (!relations.includes(LOGIN_RELATION)) continue;
    const target = statement?.target;
    if (target?.namespace === 'web') {
      const origin = normalizeWebOrigin(target.site);
      if (origin) web.push({ origin, sourceOrigin });
    } else if (target?.namespace === 'android_app') {
      const packageName = typeof target.package_name === 'string' ? target.package_name.trim() : '';
      const fingerprints = Array.isArray(target.sha256_cert_fingerprints)
        ? target.sha256_cert_fingerprints.filter((value) => typeof value === 'string' && value.trim())
        : [];
      if (/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(packageName) && fingerprints.length) {
        android.push({ packageName, fingerprints, sourceOrigin });
      }
    }
  }
  return {
    web: [...new Map(web.map((item) => [item.origin, item])).values()],
    android: [...new Map(android.map((item) => [item.packageName, item])).values()],
  };
}

function cacheFresh(entry, cacheHours) {
  if (!entry?.checkedAt) return false;
  const age = Date.now() - Date.parse(entry.checkedAt);
  return Number.isFinite(age) && age >= 0 && age <= cacheHours * 60 * 60 * 1000;
}

async function readCache(cachePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    if (parsed.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') process.stderr.write(`Кэш проигнорирован: ${error.message}\n`);
  }
  return { version: CACHE_VERSION, entries: {} };
}

async function atomicWrite(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, text, 'utf8');
  await fs.rename(temporary, filePath);
}

async function fetchAssetLinks(origin, options, cache) {
  const url = `${origin}/.well-known/assetlinks.json`;
  const cached = cache.entries[url];
  if (!options.refresh && cacheFresh(cached, options.cacheHours)) return { ...cached, cached: true };
  const checkedAt = new Date().toISOString();
  let entry;
  try {
    const text = await fetchWithTimeout(url, {
      timeoutMs: options.timeoutMs,
      maxBytes: MAX_ASSETLINKS_BYTES,
      jsonOnly: true,
    });
    const declarations = extractCredentialDeclarations(JSON.parse(text), origin);
    entry = { checkedAt, status: 'ok', declarations };
  } catch (error) {
    entry = { checkedAt, status: 'rejected', error: error.message };
  }
  cache.entries[url] = entry;
  return { ...entry, cached: false };
}

async function mapLimit(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function crawlAssetLinks(candidateDomains, options, cache) {
  const records = new Map();
  const pending = [];
  const queued = new Set();
  for (const domain of candidateDomains) {
    const origins = options.checkWww ? [`https://${domain}`, `https://www.${domain}`] : [`https://${domain}`];
    for (const origin of origins) {
      if (!queued.has(origin)) {
        queued.add(origin);
        pending.push(origin);
      }
    }
  }
  const initialOrigins = queued.size;
  const totalOriginLimit = initialOrigins + options.maxDiscovered;
  const batchSize = Math.max(100, options.concurrency * 10);
  process.stderr.write(
    `План: доменов рейтинга — ${candidateDomains.length}; первичных HTTPS-origin — ${initialOrigins}; ` +
    `до ${options.maxDiscovered} дополнительных для взаимной проверки\n`,
  );
  let fetched = 0;
  while (pending.length) {
    const batch = pending.splice(0, batchSize);
    const batchResults = await mapLimit(batch, options.concurrency, async (origin) => {
      const result = await fetchAssetLinks(origin, options, cache);
      fetched += 1;
      if (fetched % 100 === 0) {
        process.stderr.write(`Проверено HTTPS-origin: ${fetched}; в очереди: ${pending.length}\r`);
      }
      return [origin, result];
    });
    for (const [origin, result] of batchResults) records.set(origin, result);
    await atomicWrite(options.cachePath, `${JSON.stringify(cache)}\n`);

    for (const [, result] of batchResults) {
      if (result.status !== 'ok') continue;
      for (const declaration of result.declarations.web) {
        const target = declaration.origin;
        if (!queued.has(target) && queued.size < totalOriginLimit) {
          queued.add(target);
          pending.push(target);
        }
      }
    }
  }
  if (fetched >= 100) process.stderr.write('\n');
  return records;
}

export function isPrereleasePackage(packageName) {
  return packageName.split(/[._-]/).some((part) => BLOCKED_APP_PARTS.has(part.toLowerCase()));
}

class UnionFind {
  constructor() { this.parent = new Map(); }
  add(value) { if (!this.parent.has(value)) this.parent.set(value, value); }
  find(value) {
    this.add(value);
    const parent = this.parent.get(value);
    if (parent !== value) this.parent.set(value, this.find(parent));
    return this.parent.get(value);
  }
  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }
}

function edgeKey(source, target) { return `${source}\u0000${target}`; }

export function buildDalGroups(records, candidateRanks, { allowPrereleaseApps = false } = {}) {
  const directed = new Map();
  const apps = [];
  const rejectedApps = [];
  for (const [sourceOrigin, record] of records) {
    if (record.status !== 'ok') continue;
    const sourceDomain = registrableDomain(new URL(sourceOrigin).hostname);
    if (!sourceDomain) continue;
    for (const declaration of record.declarations.web) {
      const targetDomain = registrableDomain(new URL(declaration.origin).hostname);
      if (targetDomain && targetDomain !== sourceDomain) {
        directed.set(edgeKey(sourceOrigin, declaration.origin), { sourceOrigin, targetOrigin: declaration.origin, sourceDomain, targetDomain });
      }
    }
    for (const declaration of record.declarations.android) {
      const item = { sourceOrigin, sourceDomain, packageName: declaration.packageName };
      if (!allowPrereleaseApps && isPrereleasePackage(declaration.packageName)) rejectedApps.push(item);
      else apps.push(item);
    }
  }

  const unionFind = new UnionFind();
  const reciprocalEdges = [];
  const nonReciprocal = [];
  for (const edge of directed.values()) {
    if (directed.has(edgeKey(edge.targetOrigin, edge.sourceOrigin))) {
      unionFind.union(edge.sourceDomain, edge.targetDomain);
      if (edge.sourceOrigin.localeCompare(edge.targetOrigin) < 0) reciprocalEdges.push(edge);
    } else if (candidateRanks.has(edge.sourceDomain) || candidateRanks.has(edge.targetDomain)) nonReciprocal.push(edge);
  }
  for (const app of apps) unionFind.add(app.sourceDomain);

  const byRoot = new Map();
  const ensure = (domain) => {
    const root = unionFind.find(domain);
    if (!byRoot.has(root)) byRoot.set(root, { domains: new Set(), apps: new Set(), webEvidence: [], appEvidence: [] });
    const group = byRoot.get(root);
    group.domains.add(domain);
    return group;
  };
  for (const edge of reciprocalEdges) {
    const group = ensure(edge.sourceDomain);
    group.domains.add(edge.targetDomain);
    group.webEvidence.push({ source: edge.sourceOrigin, target: edge.targetOrigin });
  }
  for (const app of apps) {
    const group = ensure(app.sourceDomain);
    group.apps.add(`androidapp://${app.packageName}`);
    group.appEvidence.push({ source: app.sourceOrigin, package: app.packageName });
  }

  const groups = [];
  for (const group of byRoot.values()) {
    if (![...group.domains].some((domain) => candidateRanks.has(domain))) continue;
    const members = [...group.domains, ...group.apps];
    if (members.length < 2) continue;
    groups.push({
      members,
      sources: ['digital-asset-links'],
      evidence: { reciprocalWeb: group.webEvidence, siteDeclaredAndroid: group.appEvidence },
    });
  }
  return { groups, nonReciprocal, rejectedApps };
}

export function parseBitwardenGlobal(text) {
  const groups = [];
  const expression = /GlobalDomains\.Add\([^,]+,\s*new List<string>\s*\{([^}]+)\}\s*\);/g;
  for (const match of text.matchAll(expression)) {
    const domains = [...match[1].matchAll(/"([^"]+)"/g)]
      .map((item) => registrableDomain(item[1]))
      .filter(Boolean);
    const unique = [...new Set(domains)];
    if (unique.length > 1) groups.push(unique);
  }
  return groups;
}

export function parseAppleShared(text) {
  const payload = JSON.parse(text);
  if (!Array.isArray(payload)) throw new Error('Неожиданный формат Apple shared-credentials.json');
  return payload
    .filter((entry) => Array.isArray(entry.shared))
    .map((entry) => [...new Set(entry.shared.map(registrableDomain).filter(Boolean))])
    .filter((group) => group.length > 1);
}

async function loadCatalogs(options) {
  if (!options.catalogs) return { bitwarden: [], apple: [], errors: [] };
  const errors = [];
  const [bitwardenResult, appleResult] = await Promise.allSettled([
    fetchWithTimeout(BITWARDEN_GLOBAL_URL, { timeoutMs: Math.max(options.timeoutMs, 15000) }),
    fetchWithTimeout(APPLE_SHARED_URL, { timeoutMs: Math.max(options.timeoutMs, 15000) }),
  ]);
  let bitwarden = [];
  let apple = [];
  if (bitwardenResult.status === 'fulfilled') bitwarden = parseBitwardenGlobal(bitwardenResult.value);
  else errors.push(`Bitwarden: ${bitwardenResult.reason.message}`);
  if (appleResult.status === 'fulfilled') apple = parseAppleShared(appleResult.value);
  else errors.push(`Apple: ${appleResult.reason.message}`);
  return { bitwarden, apple, errors };
}

function mergeGroups(groups) {
  const unionFind = new UnionFind();
  for (const group of groups) {
    const [first, ...rest] = group.members;
    unionFind.add(first);
    for (const member of rest) unionFind.union(first, member);
  }
  const merged = new Map();
  for (const group of groups) {
    const root = unionFind.find(group.members[0]);
    if (!merged.has(root)) merged.set(root, { members: new Set(), sources: new Set(), evidence: [] });
    const target = merged.get(root);
    group.members.forEach((member) => target.members.add(member));
    group.sources.forEach((source) => target.sources.add(source));
    if (group.evidence) target.evidence.push(group.evidence);
  }
  return [...merged.values()].map((group) => ({
    members: [...group.members],
    sources: [...group.sources],
    evidence: group.evidence,
  }));
}

function rankForMember(member, candidateRanks) {
  if (member.startsWith('androidapp://')) return Number.POSITIVE_INFINITY;
  return candidateRanks.get(member) ?? Number.POSITIVE_INFINITY;
}

function sortGroup(group, candidateRanks) {
  group.members.sort((left, right) => {
    const leftApp = left.startsWith('androidapp://');
    const rightApp = right.startsWith('androidapp://');
    if (leftApp !== rightApp) return leftApp ? 1 : -1;
    return rankForMember(left, candidateRanks) - rankForMember(right, candidateRanks) || left.localeCompare(right);
  });
  group.rank = Math.min(...group.members.map((member) => rankForMember(member, candidateRanks)));
  return group;
}

function coveredByGlobal(group, bitwardenGroups) {
  if (group.members.some((member) => member.startsWith('androidapp://'))) return false;
  const members = new Set(group.members);
  return bitwardenGroups.some((globalGroup) => [...members].every((member) => globalGroup.includes(member)));
}

function fetchStatusCounts(records) {
  const counts = {};
  for (const record of records.values()) counts[record.status] = (counts[record.status] || 0) + 1;
  return counts;
}

async function writeResults(options, metadata, candidateRanks, records, analysis, catalogs) {
  const appleGroups = catalogs.apple
    .filter((members) => members.some((member) => candidateRanks.has(member)))
    .map((members) => ({ members, sources: ['apple-shared-credentials'], evidence: null }));
  const merged = mergeGroups([...analysis.groups, ...appleGroups])
    .map((group) => sortGroup(group, candidateRanks))
    .sort((left, right) => left.rank - right.rank || left.members[0].localeCompare(right.members[0]));
  const ready = merged.filter((group) => !coveredByGlobal(group, catalogs.bitwarden));
  const alreadyGlobal = merged.filter((group) => coveredByGlobal(group, catalogs.bitwarden));

  await fs.mkdir(options.out, { recursive: true });
  const readyPath = path.join(options.out, 'vaultwarden-equivalent-domains.txt');
  const jsonPath = path.join(options.out, 'vaultwarden-equivalent-domains.json');
  const evidencePath = path.join(options.out, 'evidence.json');
  await atomicWrite(readyPath, ready.map((group) => group.members.join(', ')).join('\n') + (ready.length ? '\n' : ''));
  await atomicWrite(jsonPath, `${JSON.stringify(ready.map((group) => group.members), null, 2)}\n`);
  const evidence = {
    generatedAt: new Date().toISOString(),
    ranking: metadata,
    options: {
      limit: options.limit,
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
      catalogs: options.catalogs,
      checkWww: options.checkWww,
      maxDiscovered: options.maxDiscovered,
      allowPrereleaseApps: options.allowPrereleaseApps,
    },
    statistics: {
      rankingDomains: candidateRanks.size,
      checkedOrigins: records.size,
      fetchStatuses: fetchStatusCounts(records),
      readyGroups: ready.length,
      alreadyInBitwardenGlobal: alreadyGlobal.length,
      bitwardenGlobalGroups: catalogs.bitwarden.length,
      appleSharedGroups: catalogs.apple.length,
      nonReciprocalWebLinks: analysis.nonReciprocal.length,
      rejectedPrereleaseApps: analysis.rejectedApps.length,
    },
    groups: ready,
    alreadyInBitwardenGlobal: alreadyGlobal,
    nonReciprocalWebLinks: analysis.nonReciprocal,
    rejectedPrereleaseApps: analysis.rejectedApps,
    catalogErrors: catalogs.errors,
  };
  await atomicWrite(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return { readyPath, jsonPath, evidencePath, ready, evidence };
}

export async function run(options) {
  await fs.mkdir(options.out, { recursive: true });
  options.cachePath = path.join(options.out, 'assetlinks-cache.json');
  const cache = await readCache(options.cachePath);
  const candidateResult = await loadCandidates(options);
  const candidateRanks = new Map(candidateResult.domains.map((domain, index) => [domain, index + 1]));
  process.stderr.write(`Кандидатов: ${candidateRanks.size}; источник: ${candidateResult.source}\n`);
  const [records, catalogs] = await Promise.all([
    crawlAssetLinks(candidateResult.domains, options, cache),
    loadCatalogs(options),
  ]);
  const analysis = buildDalGroups(records, candidateRanks, options);
  const result = await writeResults(
    options,
    { source: candidateResult.source, domains: candidateRanks.size },
    candidateRanks,
    records,
    analysis,
    catalogs,
  );
  process.stdout.write(`Готовых пользовательских групп: ${result.ready.length}\n`);
  process.stdout.write(`${result.readyPath}\n${result.jsonPath}\n${result.evidencePath}\n`);
  return result;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(usage());
    else await run(options);
  } catch (error) {
    process.stderr.write(`Ошибка: ${error.message}\n`);
    process.exitCode = 1;
  }
}
