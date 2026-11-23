import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assetUrl, jsonBytes, requiredReleaseAssetNames, sha256 } from '../scripts/release-index.mjs';
import { buildStaticApi } from '../scripts/build-static-api.mjs';
import { verifyPreparedRelease } from '../scripts/prepare-release.mjs';

const currentVersion = '2.0.3';
const previousVersion = '2.0.2';
const now = new Date('2026-11-24T01:00:00Z');

function snapshot(generatedAt) {
  return {
    schemaVersion: 1, generatedAt,
    ranking: { source: 'https://example.test/ranking.csv', domains: 100 },
    statistics: { totalRelations: 1, relationsByType: {
      dal_web_credentials: 1, dal_android_credentials: 0, apple_webcredentials: 0, webauthn_related_origin: 0,
    } },
    relations: [{ type: 'dal_web_credentials', source: 'https://a.example', target: 'https://b.example',
      evidenceUrl: 'https://a.example/.well-known/assetlinks.json', observedAt: generatedAt, reciprocal: true }],
  };
}

async function writePayloads(directory, version, dataset) {
  await fs.mkdir(directory, { recursive: true });
  const names = requiredReleaseAssetNames(version);
  const payloads = new Map([
    [names[0], Buffer.from(jsonBytes(dataset))],
    [names[1], Buffer.from(jsonBytes({ generatedAt: dataset.generatedAt, catalogErrors: [],
      statistics: { totalTypedRelations: dataset.relations.length } }))],
    [names[2], Buffer.from('a.example, b.example\n')],
  ]);
  payloads.set('SHA256SUMS.txt', Buffer.from([...payloads]
    .map(([name, bytes]) => `${sha256(bytes)}  ${name}`).join('\n') + '\n'));
  for (const [name, bytes] of payloads) await fs.writeFile(path.join(directory, name), bytes);
  const releaseAssets = Object.fromEntries(['relationships', 'evidence', 'vaultwarden', 'checksums']
    .map((key, index) => [key, { url: assetUrl(version, names[index]), sha256: sha256(payloads.get(names[index])) }]));
  return { version, publishedAt: dataset.generatedAt, relationships: releaseAssets.relationships,
    expectedCounts: dataset.statistics, releaseAssets };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rf-prepared-validation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const releaseDir = path.join(root, 'release');
  const priorDir = path.join(root, 'prior');
  const prior = await writePayloads(priorDir, previousVersion, snapshot('2026-11-17T00:00:00Z'));
  const candidate = await writePayloads(releaseDir, currentVersion, snapshot('2026-11-24T00:00:00Z'));
  const baselinePath = path.join(root, 'baseline.json');
  const baseline = { schemaVersion: 1, baseUrl: 'https://krotname.github.io/rf-credential-relationships', releases: [prior] };
  const sourceOverrides = new Map([[previousVersion, path.join(priorDir, requiredReleaseAssetNames(previousVersion)[0])]]);
  await fs.writeFile(baselinePath, jsonBytes(baseline));
  const firstBuild = await buildStaticApi({ configPath: baselinePath, outDir: path.join(root, 'old-site'),
    sourceOverrides, verifyArtifactLocks: false });
  prior.apiArtifacts = firstBuild.artifactLocks[previousVersion];
  await fs.writeFile(baselinePath, jsonBytes(baseline));
  const indexPath = path.join(releaseDir, 'releases.json');
  const index = { ...baseline, releases: [...baseline.releases, candidate] };
  await fs.writeFile(indexPath, jsonBytes(index));
  const built = await buildStaticApi({ configPath: indexPath, outDir: path.join(root, 'initial-site'),
    sourceOverrides: new Map([...sourceOverrides,
      [currentVersion, path.join(releaseDir, requiredReleaseAssetNames(currentVersion)[0])]]), verifyArtifactLocks: false });
  candidate.apiArtifacts = built.artifactLocks[currentVersion];
  await fs.writeFile(indexPath, jsonBytes(index));
  return { root, releaseDir, index, indexPath, baseline,
    verifyOptions: { baselinePath, siteDir: path.join(root, 'verified-site'), now, sourceOverrides } };
}

test('prepared release verifies all files, real schemas, historical locks and freshness offline', async (t) => {
  const value = await fixture(t);
  assert.equal(await verifyPreparedRelease(value.releaseDir, value.verifyOptions), currentVersion);
  await assert.rejects(verifyPreparedRelease(value.releaseDir, { ...value.verifyOptions,
    now: new Date('2026-11-25T01:00:00Z') }), /не свежий/);
  assert.deepEqual(JSON.parse(await fs.readFile(value.verifyOptions.baselinePath, 'utf8')), value.baseline);
});

test('every required file is checked before a prepared draft can be published', async (t) => {
  const value = await fixture(t);
  for (const name of requiredReleaseAssetNames(currentVersion)) {
    const filename = path.join(value.releaseDir, name);
    const bytes = await fs.readFile(filename);
    await fs.rm(filename);
    await assert.rejects(verifyPreparedRelease(value.releaseDir, value.verifyOptions), undefined, name);
    await fs.writeFile(filename, bytes);
  }
  assert.equal(await verifyPreparedRelease(value.releaseDir, value.verifyOptions), currentVersion);
});

test('a missing manifest asset or inconsistent relationships pointer cannot bypass verification', async (t) => {
  const value = await fixture(t);
  const original = await fs.readFile(value.indexPath);
  for (const mutate of [
    (latest) => { delete latest.releaseAssets.vaultwarden; },
    (latest) => { delete latest.releaseAssets.checksums; },
    (latest) => { latest.relationships = latest.releaseAssets.evidence; },
  ]) {
    const invalid = JSON.parse(original);
    mutate(invalid.releases.at(-1));
    await fs.writeFile(value.indexPath, jsonBytes(invalid));
    await assert.rejects(verifyPreparedRelease(value.releaseDir, value.verifyOptions));
  }
});

test('downloaded payload corruption and false SHA256SUMS entries are rejected', async (t) => {
  const value = await fixture(t);
  const filename = path.join(value.releaseDir, requiredReleaseAssetNames(currentVersion)[0]);
  const original = await fs.readFile(filename);
  await fs.appendFile(filename, 'corrupt');
  await assert.rejects(verifyPreparedRelease(value.releaseDir, value.verifyOptions), /SHA|[Hh]ash/);
  await fs.writeFile(filename, original);
  const checksumPath = path.join(value.releaseDir, 'SHA256SUMS.txt');
  const checksums = (await fs.readFile(checksumPath, 'utf8')).replace(/^[a-f0-9]{64}/, '0'.repeat(64));
  await fs.writeFile(checksumPath, checksums);
  value.index.releases.at(-1).releaseAssets.checksums.sha256 = sha256(checksums);
  await fs.writeFile(value.indexPath, jsonBytes(value.index));
  await assert.rejects(verifyPreparedRelease(value.releaseDir, value.verifyOptions), /SHA256SUMS|контроль/);
});

test('prepared verification retains historical index and API immutability checks', async (t) => {
  const value = await fixture(t);
  const original = await fs.readFile(value.indexPath);
  value.index.releases[0].expectedCounts.totalRelations += 1;
  await fs.writeFile(value.indexPath, jsonBytes(value.index));
  await assert.rejects(verifyPreparedRelease(value.releaseDir, value.verifyOptions), /историю/);
  const changedLock = JSON.parse(original);
  changedLock.releases.at(-1).apiArtifacts.manifest.sha256 = '0'.repeat(64);
  await fs.writeFile(value.indexPath, jsonBytes(changedLock));
  await assert.rejects(verifyPreparedRelease(value.releaseDir, value.verifyOptions), /immutable lock/);
});
