import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStaticApi } from '../scripts/build-static-api.mjs';
import { validateStaticApi } from '../scripts/validate-static-api.mjs';
import { prepareRelease } from '../scripts/prepare-release.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

for (const scenario of ['substituted relation', 'dataset statistics', 'filtered statistics']) {
  test(`rejects inconsistent API: ${scenario}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rf-static-consistency-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const release = await fixtureRelease(root, '1.0.0', relations);
    const configPath = path.join(root, 'releases.json');
    await fs.writeFile(configPath, JSON.stringify({
      schemaVersion: 1, baseUrl: 'https://example.test/project', releases: [release.config],
    }));
    const siteDir = path.join(root, 'site');
    await buildStaticApi({
      configPath, outDir: siteDir, sourceOverrides: new Map([['1.0.0', release.file]]),
      verifyArtifactLocks: false,
    });
    const manifestPath = path.join(siteDir, 'api/v1.0.0/manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const artifact = scenario === 'dataset statistics' ? manifest.dataset : manifest.types['dal-web'];
    const artifactPath = path.join(siteDir, new URL(artifact.url).pathname.split('/project/')[1]);
    const value = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
    if (scenario === 'substituted relation') value.relations[0].target = 'https://unrelated.example';
    else {
      value.statistics.relationsByType.dal_web_credentials -= 1;
      value.statistics.relationsByType.dal_android_credentials += 1;
    }
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    await fs.writeFile(artifactPath, bytes);
    artifact.sha256 = sha256(bytes);
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(validateStaticApi({ siteDir }), scenario === 'substituted relation'
      ? /не совпадает с фильтром dataset/ : /Statistics .* не согласованы/);
  });
}

function counts(relations) {
  const relationsByType = {
    dal_web_credentials: 0,
    dal_android_credentials: 0,
    apple_webcredentials: 0,
    webauthn_related_origin: 0,
  };
  for (const relation of relations) relationsByType[relation.type] += 1;
  return { totalRelations: relations.length, relationsByType };
}

function dataset(relations) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-05T00:00:00.000Z',
    ranking: { source: 'https://example.test/ranking.csv', domains: 4 },
    statistics: counts(relations),
    relations,
  };
}

const relations = [
  {
    type: 'dal_web_credentials', source: 'https://a.example', target: 'https://b.example',
    evidenceUrl: 'https://a.example/.well-known/assetlinks.json', observedAt: '2026-09-05T00:00:00.000Z', reciprocal: true,
  },
  {
    type: 'dal_android_credentials', source: 'https://a.example', target: 'androidapp://com.example.app',
    evidenceUrl: 'https://a.example/.well-known/assetlinks.json', observedAt: '2026-09-05T00:00:00.000Z',
    fingerprints: ['00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F'],
  },
  {
    type: 'apple_webcredentials', source: 'https://a.example', target: 'appleapp://ABCDE12345.com.example.app',
    evidenceUrl: 'https://a.example/.well-known/apple-app-site-association', observedAt: '2026-09-05T00:00:00.000Z',
  },
  {
    type: 'webauthn_related_origin', source: 'https://a.example', target: 'https://login.example',
    evidenceUrl: 'https://a.example/.well-known/webauthn', observedAt: '2026-09-05T00:00:00.000Z',
  },
];

async function fixtureRelease(root, version, releaseRelations) {
  const value = dataset(releaseRelations);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const file = path.join(root, `${version}.json`);
  await fs.writeFile(file, bytes);
  return {
    config: {
      version,
      publishedAt: '2026-09-05T00:00:00.000Z',
      relationships: { url: `https://example.test/${version}.json`, sha256: sha256(bytes) },
      expectedCounts: value.statistics,
      releaseAssets: {
        relationships: { url: `https://example.test/${version}.json`, sha256: sha256(bytes) },
      },
    },
    file,
  };
}

test('prepares a patch release with preserved historical locks and a valid API', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rf-release-prepare-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await fixtureRelease(root, '1.0.0', relations);
  const configPath = path.join(root, 'releases.json');
  const config = { schemaVersion: 1, baseUrl: 'https://example.test/project', releases: [first.config] };
  await fs.writeFile(configPath, JSON.stringify(config));
  const siteDir = path.join(root, 'site');
  const initial = await buildStaticApi({ configPath, outDir: siteDir,
    sourceOverrides: new Map([['1.0.0', first.file]]), verifyArtifactLocks: false });
  first.config.apiArtifacts = initial.artifactLocks['1.0.0'];
  await fs.writeFile(configPath, JSON.stringify(config));
  const firstBytes = await fs.readFile(first.file);
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, first.config.relationships.url);
    return new Response(firstBytes);
  });
  const scanDir = path.join(root, 'scan');
  await fs.mkdir(scanDir);
  await fs.writeFile(path.join(scanDir, 'relationships.json'), firstBytes);
  await fs.writeFile(path.join(scanDir, 'evidence.json'), JSON.stringify({
    generatedAt: '2026-09-05T00:00:00.000Z', catalogErrors: [], statistics: { totalTypedRelations: 4 },
  }));
  await fs.writeFile(path.join(scanDir, 'vaultwarden-equivalent-domains.txt'), 'a.example, b.example\n');
  const result = await prepareRelease({ configPath, scanDir, siteDir,
    releaseDir: path.join(root, 'release'), now: new Date('2026-09-05T01:00:00Z') });
  assert.equal(result.version, '1.0.1');
  const index = JSON.parse(await fs.readFile(result.releaseConfigPath, 'utf8'));
  assert.deepEqual(index.releases[0], first.config);
  assert.equal(index.releases[1].apiArtifacts.relationships.sha256, sha256(firstBytes));
  assert.deepEqual(await validateStaticApi({ siteDir: `${siteDir}-candidate` }), { version: '1.0.1', count: 4 });
});

test('builds and validates filtered static endpoints with bootstrap delta', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rf-static-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const release = await fixtureRelease(root, '1.0.0', relations);
  const configPath = path.join(root, 'releases.json');
  const config = { schemaVersion: 1, baseUrl: 'https://example.test/project', releases: [release.config] };
  await fs.writeFile(configPath, JSON.stringify(config));
  const siteDir = path.join(root, 'site');
  const firstBuild = await buildStaticApi({
    configPath,
    outDir: siteDir,
    sourceOverrides: new Map([['1.0.0', release.file]]),
    verifyArtifactLocks: false,
  });
  config.releases[0].apiArtifacts = firstBuild.artifactLocks['1.0.0'];
  await fs.writeFile(configPath, JSON.stringify(config));
  await buildStaticApi({ configPath, outDir: siteDir, sourceOverrides: new Map([['1.0.0', release.file]]) });
  const result = await validateStaticApi({ siteDir });
  assert.deepEqual(result, { version: '1.0.0', count: 4 });
  assert.deepEqual(await validateStaticApi({ siteDir: path.relative(process.cwd(), siteDir) }), result);
  const latest = JSON.parse(await fs.readFile(path.join(siteDir, 'api', 'latest.json'), 'utf8'));
  assert.equal(Object.keys(latest.types).length, 4);
  const delta = JSON.parse(await fs.readFile(path.join(siteDir, 'api', 'v1.0.0', 'delta-from-previous.json'), 'utf8'));
  assert.equal(delta.bootstrap, true);
  assert.equal(delta.fromVersion, null);
  assert.equal(delta.baseline, 'empty');
  assert.equal(delta.added.length, 4);
  assert.equal(delta.removed.length, 0);
});

test('computes a delta against the previous supported release', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rf-static-api-delta-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await fixtureRelease(root, '1.0.0', relations.slice(0, 2));
  const second = await fixtureRelease(root, '1.1.0', [relations[0], relations[2]]);
  const configPath = path.join(root, 'releases.json');
  await fs.writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    baseUrl: 'https://example.test/project',
    releases: [first.config, second.config],
  }));
  const siteDir = path.join(root, 'site');
  await buildStaticApi({
    configPath,
    outDir: siteDir,
    sourceOverrides: new Map([['1.0.0', first.file], ['1.1.0', second.file]]),
    verifyArtifactLocks: false,
  });
  await validateStaticApi({ siteDir });
  const delta = JSON.parse(await fs.readFile(path.join(siteDir, 'api', 'v1.1.0', 'delta-from-previous.json'), 'utf8'));
  assert.equal(delta.bootstrap, false);
  assert.equal(delta.fromVersion, '1.0.0');
  assert.equal(delta.baseline, 'previous-release');
  assert.deepEqual(delta.statistics, { added: 1, removed: 1 });

  delta.added = [];
  delta.statistics.added = 0;
  const deltaBytes = Buffer.from(`${JSON.stringify(delta, null, 2)}\n`);
  await fs.writeFile(path.join(siteDir, 'api', 'v1.1.0', 'delta-from-previous.json'), deltaBytes);
  const manifestPath = path.join(siteDir, 'api', 'v1.1.0', 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.delta.sha256 = sha256(deltaBytes);
  manifest.delta.added = 0;
  manifest.delta.count = 1;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(validateStaticApi({ siteDir }), /не является точной разницей соседних datasets/);
});

test('rejects unlocked artifacts and non-increasing release order', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rf-static-api-order-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await fixtureRelease(root, '1.0.0', relations.slice(0, 1));
  const second = await fixtureRelease(root, '2.0.0', relations.slice(0, 2));
  const configPath = path.join(root, 'releases.json');
  await fs.writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    baseUrl: 'https://example.test/project',
    releases: [second.config, first.config],
  }));
  await assert.rejects(buildStaticApi({
    configPath,
    outDir: path.join(root, 'site'),
    sourceOverrides: new Map([['1.0.0', first.file], ['2.0.0', second.file]]),
  }), /строго возрастать по SemVer/);

  await fs.writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    baseUrl: 'https://example.test/project',
    releases: [first.config],
  }));
  await assert.rejects(buildStaticApi({
    configPath,
    outDir: path.join(root, 'site'),
    sourceOverrides: new Map([['1.0.0', first.file]]),
  }), /отсутствует apiArtifacts lock/);

  first.config.apiArtifacts = {
    relationships: { sha256: '0'.repeat(64) },
    manifest: { sha256: '0'.repeat(64) },
    delta: { sha256: '0'.repeat(64) },
    types: {},
  };
  await fs.writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    baseUrl: 'https://example.test/project',
    releases: [first.config],
  }));
  await assert.rejects(buildStaticApi({
    configPath,
    outDir: path.join(root, 'site'),
    sourceOverrides: new Map([['1.0.0', first.file]]),
  }), /не совпадают с immutable lock/);
});
