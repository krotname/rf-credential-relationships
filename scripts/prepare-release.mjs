import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildStaticApi } from './build-static-api.mjs';
import { validateStaticApi } from './validate-static-api.mjs';
import { assetUrl, jsonBytes, nextVersion, sha256, validateIndex } from './release-index.mjs';

export function checkScan(previous, dataset, evidence) {
  if (dataset.ranking.domains < previous.ranking.domains * 0.9
      || dataset.relations.length < previous.relations.length * 0.7
      || dataset.relations.length === 0
      || Object.entries(previous.statistics.relationsByType).some(([type, count]) =>
        (dataset.statistics.relationsByType[type] ?? 0) < count * 0.7)) {
    throw new Error('Сбор неполон: падение охвата рейтинга >10% или связей >30%');
  }
  if (evidence.catalogErrors.length || evidence.generatedAt !== dataset.generatedAt
      || evidence.statistics.totalTypedRelations !== dataset.relations.length) {
    throw new Error('Доказательства не согласованы или каталоги недоступны');
  }
}

export async function prepareRelease({ configPath = '.local/releases.json', scanDir = 'out',
  releaseDir = '.local/release', siteDir = 'site', now = new Date() } = {}) {
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  // Проверяем прежние immutable locks до добавления нового снимка.
  await buildStaticApi({ configPath, outDir: siteDir });
  await validateStaticApi({ siteDir });
  const previousVersion = config.releases.at(-1).version;
  const previous = JSON.parse(await fs.readFile(path.join(siteDir, `api/v${previousVersion}/relationships.json`), 'utf8'));
  const version = nextVersion(previousVersion);
  const bytes = await fs.readFile(path.join(scanDir, 'relationships.json'));
  const dataset = JSON.parse(bytes);
  const evidenceBytes = await fs.readFile(path.join(scanDir, 'evidence.json'));
  const evidence = JSON.parse(evidenceBytes);
  checkScan(previous, dataset, evidence);
  const age = now - new Date(dataset.generatedAt);
  if (!Number.isFinite(age) || age < -60000 || age > 24 * 60 * 60 * 1000) throw new Error('Снимок не свежий');
  await fs.mkdir(releaseDir, { recursive: true });
  const payloads = {
    [`rf-credential-relationships-v${version}.json`]: bytes,
    [`rf-scan-evidence-v${version}.json`]: evidenceBytes,
    [`vaultwarden-equivalent-domains-v${version}.txt`]: await fs.readFile(path.join(scanDir, 'vaultwarden-equivalent-domains.txt')),
  };
  const checksums = Object.entries(payloads).map(([name, content]) => `${sha256(content)}  ${name}`).join('\n') + '\n';
  payloads['SHA256SUMS.txt'] = Buffer.from(checksums);
  for (const [name, content] of Object.entries(payloads)) await fs.writeFile(path.join(releaseDir, name), content);
  const names = Object.keys(payloads);
  const releaseAssets = Object.fromEntries(['relationships', 'evidence', 'vaultwarden', 'checksums'].map((key, index) =>
    [key, { url: assetUrl(version, names[index]), sha256: sha256(payloads[names[index]]) }]));
  const release = {
    version, publishedAt: now.toISOString(), relationships: releaseAssets.relationships,
    expectedCounts: dataset.statistics, releaseAssets,
  };
  config.releases.push(release);
  const releaseConfigPath = path.join(releaseDir, 'releases.json');
  await fs.writeFile(releaseConfigPath, jsonBytes(config));
  const sourceOverrides = new Map(config.releases.map((entry) => [entry.version,
    entry.version === version ? path.resolve(scanDir, 'relationships.json')
      : path.resolve(siteDir, `api/v${entry.version}/relationships.json`)]));
  // Второй каталог сохраняет источники предыдущих выпусков во время сборки.
  const candidateSite = `${siteDir}-candidate`;
  const built = await buildStaticApi({ configPath: releaseConfigPath, outDir: candidateSite, sourceOverrides, verifyArtifactLocks: false });
  for (const entry of config.releases.slice(0, -1)) {
    if (JSON.stringify(entry.apiArtifacts) !== JSON.stringify(built.artifactLocks[entry.version])) {
      throw new Error(`Изменён immutable lock ${entry.version}`);
    }
  }
  release.apiArtifacts = built.artifactLocks[version];
  await fs.writeFile(releaseConfigPath, jsonBytes(config));
  await validateStaticApi({ siteDir: candidateSite });
  await fs.writeFile(path.join(path.dirname(releaseDir), 'release-notes.md'), `Еженедельный проверенный снимок данных.\n\nВерсия: v${version}. Наблюдение: ${dataset.generatedAt}.\n\nСвязей: ${dataset.relations.length}; доменов рейтинга: ${dataset.ranking.domains}.\n\nJSON, доказательства, правила Vaultwarden и SHA-256 приложены. API содержит delta относительно v${previousVersion}.\n\n[API](https://krotname.github.io/rf-credential-relationships/api/latest.json) · [Методология](https://github.com/krotname/rf-credential-relationships/blob/main/docs/methodology.md)\n`);
  return { version, releaseConfigPath };
}

export async function verifyPreparedRelease(releaseDir = '.local/release') {
  const baseline = JSON.parse(await fs.readFile('.local/releases.json', 'utf8'));
  const config = JSON.parse(await fs.readFile(path.join(releaseDir, 'releases.json'), 'utf8'));
  const latest = config.releases.at(-1);
  if (latest.version !== nextVersion(baseline.releases.at(-1).version)) throw new Error('Неожиданная версия черновика');
  validateIndex(baseline, config, `v${latest.version}`);
  for (const asset of Object.values(latest.releaseAssets)) {
    const bytes = await fs.readFile(path.join(releaseDir, new URL(asset.url).pathname.split('/').at(-1)));
    if (sha256(bytes) !== asset.sha256) throw new Error('Hash подготовленного артефакта не совпадает');
  }
  const sourceOverrides = new Map([[latest.version,
    path.join(releaseDir, new URL(latest.relationships.url).pathname.split('/').at(-1))]]);
  await buildStaticApi({ configPath: path.join(releaseDir, 'releases.json'), outDir: 'site-candidate', sourceOverrides });
  await validateStaticApi({ siteDir: 'site-candidate' });
  return latest.version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--verify')) await verifyPreparedRelease();
  else process.stdout.write(`Prepared v${(await prepareRelease()).version}\n`);
}
