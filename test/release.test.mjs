import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { nextVersion, validateIndex } from '../scripts/release-index.mjs';
import { checkScan } from '../scripts/prepare-release.mjs';

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
