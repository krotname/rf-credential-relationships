import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildStaticApi } from './build-static-api.mjs';
import { validateStaticApi } from './validate-static-api.mjs';
import { assetUrl, jsonBytes, nextVersion, requiredReleaseAssetNames, sha256, validateIndex } from './release-index.mjs';

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

export function checkFreshness(dataset, now = new Date()) {
  const age = now - new Date(dataset.generatedAt);
  if (!Number.isFinite(age) || age < -60000 || age > 24 * 60 * 60 * 1000) throw new Error('Снимок не свежий');
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
  checkFreshness(dataset, now);
  await fs.rm(releaseDir, { recursive: true, force: true });
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

export async function verifyPreparedRelease(releaseDir = '.local/release', {
  baselinePath = '.local/releases.json', siteDir = 'site-candidate', now = new Date(), sourceOverrides = new Map(),
} = {}) {
  const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') throw new Error(`Нет ${baselinePath}: сначала выполните Resolve release state`);
    throw error;
  }));
  const version = nextVersion(baseline.releases.at(-1).version);
  const names = requiredReleaseAssetNames(version);
  const actualNames = await fs.readdir(releaseDir).catch((error) => {
    if (error.code === 'ENOENT') throw new Error(`Черновик неполон: нет каталога ${releaseDir}; требуется повторная подготовка`);
    throw error;
  });
  const missing = names.filter((name) => !actualNames.includes(name));
  const extra = actualNames.filter((name) => !names.includes(name));
  if (missing.length) throw new Error(`Черновик неполон: нет ${missing.join(', ')}; требуется повторная подготовка`);
  if (extra.length) throw new Error(`Посторонние файлы в черновике: ${extra.join(', ')}`);
  const config = JSON.parse(await fs.readFile(path.join(releaseDir, 'releases.json'), 'utf8'));
  const latest = config.releases.at(-1);
  if (!latest || latest.version !== version || config.releases.length !== baseline.releases.length + 1) {
    throw new Error('Неожиданная версия черновика');
  }
  validateIndex(baseline, config, `v${latest.version}`);
  const keys = ['relationships', 'evidence', 'vaultwarden', 'checksums'];
  if (Object.keys(latest.releaseAssets).length !== keys.length
      || keys.some((key, index) => latest.releaseAssets[key]?.url !== assetUrl(version, names[index]))
      || latest.relationships.url !== latest.releaseAssets.relationships.url
      || latest.relationships.sha256 !== latest.releaseAssets.relationships.sha256) {
    throw new Error('Индекс не описывает полный обязательный комплект артефактов');
  }
  for (const [index, key] of keys.entries()) {
    const bytes = await fs.readFile(path.join(releaseDir, names[index]));
    if (sha256(bytes) !== latest.releaseAssets[key].sha256) {
      throw new Error(`Hash подготовленного артефакта ${names[index]} не совпадает`);
    }
  }
  const checksums = await fs.readFile(path.join(releaseDir, 'SHA256SUMS.txt'), 'utf8');
  const entries = checksums.trimEnd().split('\n').map((line) => /^([a-f0-9]{64})  (.+)$/.exec(line));
  if (entries.length !== 3 || entries.some((entry) => !entry)
      || names.slice(0, 3).some((name, index) => entries.filter((entry) =>
        entry[2] === name && entry[1] === latest.releaseAssets[keys[index]].sha256).length !== 1)) {
    throw new Error('SHA256SUMS.txt не соответствует полному комплекту данных');
  }
  const sources = new Map(sourceOverrides);
  sources.set(latest.version, path.join(releaseDir, names[0]));
  await buildStaticApi({ configPath: path.join(releaseDir, 'releases.json'), outDir: siteDir, sourceOverrides: sources });
  await validateStaticApi({ siteDir });
  const dataset = JSON.parse(await fs.readFile(sources.get(latest.version), 'utf8'));
  const evidence = JSON.parse(await fs.readFile(path.join(releaseDir,
    new URL(latest.releaseAssets.evidence.url).pathname.split('/').at(-1)), 'utf8'));
  const previous = JSON.parse(await fs.readFile(path.join(siteDir,
    `api/v${baseline.releases.at(-1).version}/relationships.json`), 'utf8'));
  checkScan(previous, dataset, evidence);
  checkFreshness(dataset, now);
  return latest.version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--verify')) await verifyPreparedRelease();
  else process.stdout.write(`Prepared v${(await prepareRelease()).version}\n`);
}
