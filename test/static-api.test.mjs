import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStaticApi } from '../scripts/build-static-api.mjs';
import { validateStaticApi } from '../scripts/validate-static-api.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

test('builds and validates filtered static endpoints with bootstrap delta', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rf-static-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const release = await fixtureRelease(root, '1.0.0', relations);
  const configPath = path.join(root, 'releases.json');
  await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, baseUrl: 'https://example.test/project', releases: [release.config] }));
  const siteDir = path.join(root, 'site');
  await buildStaticApi({ configPath, outDir: siteDir, sourceOverrides: new Map([['1.0.0', release.file]]) });
  const result = await validateStaticApi({ siteDir });
  assert.deepEqual(result, { version: '1.0.0', count: 4 });
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
  });
  const delta = JSON.parse(await fs.readFile(path.join(siteDir, 'api', 'v1.1.0', 'delta-from-previous.json'), 'utf8'));
  assert.equal(delta.bootstrap, false);
  assert.equal(delta.fromVersion, '1.0.0');
  assert.equal(delta.baseline, 'previous-release');
  assert.deepEqual(delta.statistics, { added: 1, removed: 1 });
});
