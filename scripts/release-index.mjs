import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'krotname/rf-credential-relationships';
export const assetUrl = (version, name) => `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;
export function gh(args, { encoding = 'utf8' } = {}) {
  return execFileSync('gh', args, { encoding, maxBuffer: 32 * 1024 * 1024 });
}
export function nextVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Некорректная версия');
  const parts = version.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part)) || parts[2] === Number.MAX_SAFE_INTEGER) {
    throw new Error('Версия вне допустимого диапазона');
  }
  parts[2] += 1;
  return parts.join('.');
}
export function requiredReleaseAssetNames(version) {
  nextVersion(version);
  return [`rf-credential-relationships-v${version}.json`, `rf-scan-evidence-v${version}.json`,
    `vaultwarden-equivalent-domains-v${version}.txt`, 'SHA256SUMS.txt', 'releases.json'];
}

// Проверка метаданных — только первый барьер. resume=true выдаётся после readback и полной валидации.
export function shouldResumeDraft(release, version) {
  if (release && !release.draft) throw new Error('Следующая версия уже опубликована: проверьте latest');
  if (!release) return false;
  const names = requiredReleaseAssetNames(version);
  return release.tag_name === `v${version}` && release.assets?.length === names.length
    && names.every((name) => release.assets.filter((asset) => asset.name === name
      && asset.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0).length === 1);
}

export function selectDraftRelease(releases, tag) {
  const matches = releases.filter((release) => release.tag_name === tag);
  if (matches.some((release) => !release.draft)) throw new Error(`Выпуск ${tag} уже опубликован; перезапись запрещена`);
  const populated = matches.filter((release) => release.assets.length > 0);
  if (populated.length > 1) throw new Error(`Несколько непустых черновиков ${tag}: требуется проверка`);
  return populated[0] ?? matches.sort((left, right) => left.id - right.id)[0];
}

export function readReleaseAsset(asset, run = gh) {
  return Buffer.from(run(['api', `repos/${REPOSITORY}/releases/assets/${asset.id}`,
    '-H', 'Accept: application/octet-stream'], { encoding: null }));
}

export async function downloadReleaseAssets(release, directory, { run = gh } = {}) {
  await fs.mkdir(directory, { recursive: true });
  const names = new Set();
  for (const asset of release.assets) {
    if (!asset.name || path.basename(asset.name) !== asset.name || asset.name.includes('\\')
        || ['.', '..'].includes(asset.name) || names.has(asset.name)) throw new Error('Некорректное имя файла черновика');
    names.add(asset.name);
    const bytes = readReleaseAsset(asset, run);
    if (asset.state !== 'uploaded' || bytes.length !== asset.size
        || (asset.digest && asset.digest !== `sha256:${sha256(bytes)}`)) {
      throw new Error(`Readback ${asset.name}: размер, состояние или SHA-256 не совпадает`);
    }
    await fs.writeFile(path.join(directory, asset.name), bytes);
  }
}

export async function restoreDraftRelease({ release, version, releaseDir = '.local/release', run = gh,
  verify = async (directory) => (await import('./prepare-release.mjs')).verifyPreparedRelease(directory) } = {}) {
  // Не смешиваем скачанный пакет с остатками прежней попытки в workspace.
  await fs.rm(releaseDir, { recursive: true, force: true });
  if (!shouldResumeDraft(release, version)) {
    if (release) process.stdout.write(`Draft v${version} incomplete; preparing a fresh snapshot\n`);
    return false;
  }
  try {
    await downloadReleaseAssets(release, releaseDir, { run });
    await verify(releaseDir);
    return true;
  } catch (error) {
    await fs.rm(releaseDir, { recursive: true, force: true });
    process.stdout.write(`Draft v${version} cannot resume: ${error.message}; preparing a fresh snapshot\n`);
    return false;
  }
}
export function validateIndex(baseline, index, tag) {
  if (index.schemaVersion !== baseline.schemaVersion || index.baseUrl !== baseline.baseUrl
      || !Array.isArray(index.releases) || index.releases.length < baseline.releases.length
      || JSON.stringify(index.releases.slice(0, baseline.releases.length)) !== JSON.stringify(baseline.releases)
      || `v${index.releases.at(-1)?.version}` !== tag) {
    throw new Error('Индекс релиза изменяет историю или не соответствует тегу');
  }
  let previous;
  for (const release of index.releases) {
    const parts = release.version.split('.').map(Number);
    nextVersion(release.version);
    if (previous && !(parts[0] > previous[0] || (parts[0] === previous[0]
      && (parts[1] > previous[1] || (parts[1] === previous[1] && parts[2] > previous[2]))))) {
      throw new Error('Версии индекса не возрастают');
    }
    previous = parts;
    for (const artifact of [release.relationships, ...Object.values(release.releaseAssets)]) {
      const url = new URL(artifact.url);
      if (!artifact.url.startsWith(assetUrl(release.version, '')) || url.search || url.hash
          || url.pathname.split('/').at(-1) === '' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
        throw new Error('Некорректный адрес или hash артефакта');
      }
    }
  }
}

export async function syncReleaseIndex({ outPath = '.local/releases.json', weekly = false } = {}) {
  const baseline = JSON.parse(await fs.readFile('api/releases.json', 'utf8'));
  const latest = JSON.parse(gh(['api', `repos/${REPOSITORY}/releases/latest`]));
  const asset = latest.assets.find((entry) => entry.name === 'releases.json');
  let index = baseline;
  if (asset) {
    const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Индекс релиза: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (asset.digest && asset.digest !== `sha256:${sha256(bytes)}`) throw new Error('Hash индекса не совпадает');
    index = JSON.parse(bytes);
  }
  validateIndex(baseline, index, latest.tag_name);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, jsonBytes(index));
  const startOfWeek = new Date();
  startOfWeek.setUTCHours(0, 0, 0, 0);
  startOfWeek.setUTCDate(startOfWeek.getUTCDate() - startOfWeek.getUTCDay());
  const skip = weekly && Boolean(asset) && new Date(latest.published_at) >= startOfWeek;
  const version = nextVersion(index.releases.at(-1).version);
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `skip=${skip}\nversion=${version}\n`);
  return { index, skip, version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await syncReleaseIndex({ weekly: process.argv.includes('--weekly') });
  if (process.argv.includes('--prepare') && !result.skip) {
    const releases = JSON.parse(gh(['api', `repos/${REPOSITORY}/releases?per_page=100`]));
    const existing = selectDraftRelease(releases, `v${result.version}`);
    const resume = await restoreDraftRelease({ release: existing, version: result.version });
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `resume=${resume}\n`);
  }
  process.stdout.write(`Latest: ${result.index.releases.at(-1).version}; skip: ${result.skip}\n`);
}
