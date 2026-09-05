import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELATION_TYPES = {
  'dal-web': 'dal_web_credentials',
  'dal-android': 'dal_android_credentials',
  'aasa-webcredentials': 'apple_webcredentials',
  'webauthn-related-origins': 'webauthn_related_origin',
};
const SCHEMA_FILES = [
  'relationships-v1.schema.json',
  'manifest-v1.schema.json',
  'latest-v1.schema.json',
  'delta-v1.schema.json',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function compareSemanticVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function assertArtifactLock(release, actual) {
  if (!release.apiArtifacts) throw new Error(`Для ${release.version} отсутствует apiArtifacts lock`);
  if (canonical(release.apiArtifacts) !== canonical(actual)) {
    throw new Error(`API artifacts ${release.version} не совпадают с immutable lock`);
  }
}

async function writeBytes(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  return { sha256: sha256(bytes), bytes: bytes.length };
}

function endpoint(baseUrl, pathname) {
  return `${baseUrl.replace(/\/$/, '')}/${pathname.replace(/^\//, '')}`;
}

function countTypes(relations) {
  const counts = Object.fromEntries(Object.values(RELATION_TYPES).map((type) => [type, 0]));
  for (const relation of relations) {
    if (!(relation.type in counts)) throw new Error(`Неподдерживаемый тип связи: ${relation.type}`);
    counts[relation.type] += 1;
  }
  return counts;
}

function assertExpectedCounts(release, dataset) {
  const actual = {
    totalRelations: dataset.relations.length,
    relationsByType: countTypes(dataset.relations),
  };
  if (canonical(actual) !== canonical(release.expectedCounts)) {
    throw new Error(`Counts ${release.version} не совпадают с api/releases.json`);
  }
  if (canonical(actual) !== canonical(dataset.statistics)) {
    throw new Error(`Внутренние statistics ${release.version} не совпадают с relations`);
  }
}

async function loadSource(release, sourceOverrides, fetchImpl) {
  const override = sourceOverrides.get(release.version);
  let bytes;
  if (override) {
    bytes = await fs.readFile(override);
  } else {
    const sourceUrl = new URL(release.relationships.url);
    if (sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password) {
      throw new Error(`Release asset ${release.version} должен использовать HTTPS без credentials`);
    }
    const response = await fetchImpl(release.relationships.url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Не удалось скачать ${release.relationships.url}: HTTP ${response.status}`);
    if (response.url && new URL(response.url).protocol !== 'https:') {
      throw new Error(`Release asset ${release.version} перенаправлен вне HTTPS`);
    }
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 20 * 1024 * 1024) throw new Error(`Release asset ${release.version} больше 20 MiB`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 20 * 1024 * 1024) throw new Error(`Release asset ${release.version} больше 20 MiB`);
  }
  const actualHash = sha256(bytes);
  if (actualHash !== release.relationships.sha256) {
    throw new Error(`SHA-256 ${release.version}: ожидался ${release.relationships.sha256}, получен ${actualHash}`);
  }
  const dataset = JSON.parse(bytes.toString('utf8'));
  if (dataset.schemaVersion !== 1 || !Array.isArray(dataset.relations)) {
    throw new Error(`Неподдерживаемая структура relationships ${release.version}`);
  }
  assertExpectedCounts(release, dataset);
  return { bytes, dataset };
}

function filteredDataset(dataset, selectedType) {
  const relations = dataset.relations.filter((relation) => relation.type === selectedType);
  return {
    ...dataset,
    statistics: {
      totalRelations: relations.length,
      relationsByType: countTypes(relations),
    },
    relations,
  };
}

function createDelta(previous, current, currentVersion, previousVersion) {
  const previousByKey = new Map((previous?.relations ?? []).map((relation) => [canonical(relation), relation]));
  const currentByKey = new Map(current.relations.map((relation) => [canonical(relation), relation]));
  const added = current.relations.filter((relation) => !previousByKey.has(canonical(relation)));
  const removed = (previous?.relations ?? []).filter((relation) => !currentByKey.has(canonical(relation)));
  return {
    schemaVersion: 1,
    fromVersion: previousVersion,
    toVersion: currentVersion,
    bootstrap: previous === null,
    baseline: previous === null ? 'empty' : 'previous-release',
    statistics: { added: added.length, removed: removed.length },
    added,
    removed,
  };
}

export async function buildStaticApi({
  configPath = path.join(PROJECT_ROOT, 'api', 'releases.json'),
  outDir = path.join(PROJECT_ROOT, 'site'),
  schemaDir = path.join(PROJECT_ROOT, 'schemas'),
  sourceOverrides = new Map(),
  fetchImpl = fetch,
  verifyArtifactLocks = true,
} = {}) {
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  if (config.schemaVersion !== 1 || !config.baseUrl || !Array.isArray(config.releases) || config.releases.length === 0) {
    throw new Error('Некорректный api/releases.json');
  }
  const baseUrl = new URL(config.baseUrl);
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('baseUrl должен быть HTTPS URL без credentials, query и fragment');
  }
  const versions = new Set();
  for (let index = 0; index < config.releases.length; index += 1) {
    const release = config.releases[index];
    if (!/^\d+\.\d+\.\d+$/.test(release.version) || versions.has(release.version)) {
      throw new Error(`Некорректная или повторная версия: ${release.version}`);
    }
    if (index > 0 && compareSemanticVersions(config.releases[index - 1].version, release.version) >= 0) {
      throw new Error('Версии в api/releases.json должны строго возрастать по SemVer');
    }
    versions.add(release.version);
  }

  outDir = path.resolve(outDir);
  if (outDir === path.parse(outDir).root || outDir === PROJECT_ROOT) {
    throw new Error(`Небезопасный каталог --out: ${outDir}`);
  }
  await fs.rm(outDir, { recursive: true, force: true });
  const apiDir = path.join(outDir, 'api');
  const schemaOut = path.join(apiDir, 'schema');
  await fs.mkdir(schemaOut, { recursive: true });
  for (const name of SCHEMA_FILES) await fs.copyFile(path.join(schemaDir, name), path.join(schemaOut, name));

  const loaded = [];
  for (const release of config.releases) loaded.push({ release, ...(await loadSource(release, sourceOverrides, fetchImpl)) });

  const manifests = [];
  const artifactLocks = {};
  for (let index = 0; index < loaded.length; index += 1) {
    const { release, bytes, dataset } = loaded[index];
    const versionDir = path.join(apiDir, `v${release.version}`);
    const datasetPath = path.join(versionDir, 'relationships.json');
    const datasetMeta = await writeBytes(datasetPath, bytes);
    const types = {};

    for (const [slug, relationType] of Object.entries(RELATION_TYPES)) {
      const filtered = filteredDataset(dataset, relationType);
      const filteredBytes = jsonBytes(filtered);
      const meta = await writeBytes(path.join(versionDir, 'types', `${slug}.json`), filteredBytes);
      types[slug] = {
        relationshipType: relationType,
        url: endpoint(config.baseUrl, `api/v${release.version}/types/${slug}.json`),
        sha256: meta.sha256,
        count: filtered.relations.length,
      };
    }

    const previous = index === 0 ? null : loaded[index - 1].dataset;
    const previousVersion = index === 0 ? null : loaded[index - 1].release.version;
    const delta = createDelta(previous, dataset, release.version, previousVersion);
    const deltaBytes = jsonBytes(delta);
    const deltaMeta = await writeBytes(path.join(versionDir, 'delta-from-previous.json'), deltaBytes);
    const manifest = {
      apiVersion: 1,
      version: release.version,
      publishedAt: release.publishedAt,
      schema: endpoint(config.baseUrl, 'api/schema/relationships-v1.schema.json'),
      dataset: {
        url: endpoint(config.baseUrl, `api/v${release.version}/relationships.json`),
        sha256: datasetMeta.sha256,
        count: dataset.relations.length,
      },
      types,
      delta: {
        url: endpoint(config.baseUrl, `api/v${release.version}/delta-from-previous.json`),
        sha256: deltaMeta.sha256,
        count: delta.statistics.added + delta.statistics.removed,
        fromVersion: previousVersion,
        bootstrap: delta.bootstrap,
        added: delta.statistics.added,
        removed: delta.statistics.removed,
      },
      releaseAssets: release.releaseAssets,
    };
    const manifestMeta = await writeBytes(path.join(versionDir, 'manifest.json'), jsonBytes(manifest));
    const actualLock = {
      relationships: datasetMeta.sha256,
      manifest: manifestMeta.sha256,
      delta: deltaMeta.sha256,
      types: Object.fromEntries(Object.entries(types).map(([slug, artifact]) => [slug, artifact.sha256])),
    };
    artifactLocks[release.version] = actualLock;
    if (verifyArtifactLocks) assertArtifactLock(release, actualLock);
    manifests.push(manifest);
  }

  const latestManifest = manifests.at(-1);
  const latest = {
    apiVersion: 1,
    version: latestManifest.version,
    publishedAt: latestManifest.publishedAt,
    manifest: endpoint(config.baseUrl, `api/v${latestManifest.version}/manifest.json`),
    schema: latestManifest.schema,
    dataset: latestManifest.dataset.url,
    types: Object.fromEntries(Object.entries(latestManifest.types).map(([slug, value]) => [slug, value.url])),
    delta: latestManifest.delta.url,
    releaseAssets: latestManifest.releaseAssets,
  };
  await writeBytes(path.join(apiDir, 'latest.json'), jsonBytes(latest));
  await writeBytes(path.join(outDir, '.nojekyll'), Buffer.alloc(0));
  const html = `<!doctype html>\n<meta charset="utf-8">\n<title>RF credential relationships API</title>\n<h1>RF credential relationships API</h1>\n<p><a href="api/latest.json">latest.json</a> · <a href="${latest.manifest}">v${latest.version} manifest</a> · <a href="https://github.com/krotname/rf-credential-relationships">documentation</a></p>\n`;
  await writeBytes(path.join(outDir, 'index.html'), Buffer.from(html, 'utf8'));
  return { outDir, latest, manifests, artifactLocks };
}

function parseCli(argv) {
  const options = { sourceOverrides: new Map(), printLocks: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--out') options.outDir = path.resolve(argv[++index]);
    else if (argument === '--config') options.configPath = path.resolve(argv[++index]);
    else if (argument === '--no-verify-locks') options.verifyArtifactLocks = false;
    else if (argument === '--print-locks') options.printLocks = true;
    else if (argument === '--source') {
      const [version, ...fileParts] = argv[++index].split('=');
      if (!version || fileParts.length === 0) throw new Error('--source ожидает VERSION=FILE');
      options.sourceOverrides.set(version, path.resolve(fileParts.join('=')));
    } else throw new Error(`Неизвестный аргумент: ${argument}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = parseCli(process.argv.slice(2));
  const result = await buildStaticApi(options);
  process.stdout.write(`Static API: ${result.outDir}\nLatest: ${result.latest.version}\n`);
  if (options.printLocks) process.stdout.write(`${JSON.stringify(result.artifactLocks, null, 2)}\n`);
}
