import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { nextVersion, validateIndex, shouldResumeDraft } from '../scripts/release-index.mjs';
import { checkScan, checkFreshness } from '../scripts/prepare-release.mjs';
import { ensureDraftAssets } from '../scripts/publish-release.mjs';

test('empty drafts trigger fresh collection while populated drafts resume validation', () => {
  assert.equal(shouldResumeDraft(undefined), false);
  assert.equal(shouldResumeDraft({ draft: true, assets: [] }), false);
  assert.equal(shouldResumeDraft({ draft: true, assets: [{ name: 'releases.json' }] }), true);
  assert.throws(() => shouldResumeDraft({ draft: false, assets: [] }), /опубликована/);
});

test('publication recovers committed HTTP errors without duplicate creation or uploads', async () => {
  let release;
  const mutations = [];
  const run = (args) => {
    if (args[0] === 'api') return JSON.stringify(release ? [release] : []);
    mutations.push(args);
    if (args[1] === 'create') {
      release = { tag_name: 'v2.0.3', draft: true, assets: [] };
      throw new Error('HTTP 500 after creation');
    }
    assert.equal(args[1], 'upload');
    const name = args[3].split(/[\\/]/).at(-1);
    assert.ok(!release.assets.some((asset) => asset.name === name));
    release.assets.push({ name });
    throw new Error('connection lost after upload');
  };
  await ensureDraftAssets({ tag: 'v2.0.3', names: ['releases.json', 'data.json'], run });
  assert.deepEqual(mutations.map((args) => args[1]), ['create', 'upload', 'upload']);
  assert.deepEqual(release.assets.map((asset) => asset.name), ['data.json', 'releases.json']);
  await ensureDraftAssets({ tag: 'v2.0.3', names: ['releases.json', 'data.json'], run });
  assert.equal(mutations.length, 3);
});

test('upload retries are bounded and published or foreign assets block mutation', async () => {
  const release = { tag_name: 'v2.0.3', draft: true, assets: [] };
  let writes = 0;
  const run = (args) => {
    if (args[0] === 'api') return JSON.stringify([release]);
    writes++;
    throw new Error('HTTP 503');
  };
  const options = { tag: release.tag_name, names: ['releases.json'], run, wait: async () => {} };
  await assert.rejects(ensureDraftAssets(options), /503/);
  assert.equal(writes, 3);
  release.assets.push({ name: 'unexpected.txt' });
  await assert.rejects(ensureDraftAssets(options), /Посторонние/);
  release.draft = false;
  await assert.rejects(ensureDraftAssets(options), /опубликован/);
  assert.equal(writes, 3);
});

test('an empty recovered draft receives the current scan notes and build commit', async () => {
  const release = { tag_name: 'v2.0.3', draft: true, assets: [], target_commitish: 'old', body: 'old scan' };
  const writes = [];
  const run = (args) => {
    if (args[0] === 'api') return JSON.stringify([release]);
    writes.push(args[1]);
    if (args[1] === 'edit') {
      release.target_commitish = args[args.indexOf('--target') + 1];
      release.body = 'fresh scan';
      throw new Error('HTTP 500 after metadata update');
    }
    assert.equal(release.target_commitish, 'current');
    assert.equal(release.body, 'fresh scan');
    release.assets.push({ name: args[3].split(/[\\/]/).at(-1) });
  };
  await ensureDraftAssets({ tag: release.tag_name, names: ['releases.json'], target: 'current',
    notes: 'fresh scan', run });
  assert.deepEqual(writes, ['edit', 'upload']);
});

test('stale, invalid and future snapshots cannot be published on resume', () => {
  const now = new Date('2026-09-14T10:00:00Z');
  checkFreshness({ generatedAt: '2026-09-14T09:00:00Z' }, now);
  for (const generatedAt of ['2026-09-13T08:47:00Z', '2026-09-15T00:00:00Z', 'invalid']) {
    assert.throws(() => checkFreshness({ generatedAt }, now), /не свежий/);
  }
});

test('increments patch versions and rejects unsafe versions', () => {
  assert.equal(nextVersion('2.0.9'), '2.0.10');
  for (const value of ['v2.0.0', '2.0.0-beta', '2.0.9007199254740991']) {
    assert.throws(() => nextVersion(value));
  }
});

test('rejects release indices that rewrite history or redirect artifacts', async () => {
  const baseline = JSON.parse(await fs.readFile(new URL('../api/releases.json', import.meta.url), 'utf8'));
  const tag = `v${baseline.releases.at(-1).version}`;
  validateIndex(baseline, structuredClone(baseline), tag);
  const changed = structuredClone(baseline);
  changed.releases[0].expectedCounts.totalRelations = 0;
  assert.throws(() => validateIndex(baseline, changed, tag), /историю/);
  assert.throws(() => validateIndex(baseline, baseline, 'v99.0.0'), /тегу/);
  const appended = structuredClone(baseline);
  appended.releases.push({ ...structuredClone(baseline.releases[0]), version: '2.0.1' });
  assert.throws(() => validateIndex(baseline, appended, 'v2.0.1'), /адрес/);
});

test('blocks partial scans even when total relation count remains healthy', () => {
  const previous = { ranking: { domains: 100 }, relations: Array(100), statistics: { relationsByType: { web: 80, app: 20 } } };
  const dataset = { ...structuredClone(previous), generatedAt: '2026-09-05T00:00:00Z' };
  const evidence = { generatedAt: dataset.generatedAt, catalogErrors: [], statistics: { totalTypedRelations: 100 } };
  checkScan(previous, dataset, evidence);
  const missingType = structuredClone(dataset);
  missingType.statistics.relationsByType = { web: 100, app: 0 };
  assert.throws(() => checkScan(previous, missingType, evidence), /неполон/);
  assert.throws(() => checkScan(previous, { ...dataset, ranking: { domains: 89 } }, evidence), /неполон/);
  assert.throws(() => checkScan(previous, { ...dataset, relations: [] }, evidence), /неполон/);
  assert.throws(() => checkScan(previous, dataset, { ...evidence, catalogErrors: ['timeout'] }), /каталоги/);
});
