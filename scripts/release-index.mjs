import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'krotname/rf-credential-relationships';
export const assetUrl = (version, name) => `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;
export function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
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
    const existing = releases.find((release) => release.tag_name === `v${result.version}`);
    if (existing && !existing.draft) throw new Error('Следующая версия уже опубликована: проверьте latest');
    if (existing) {
      await fs.mkdir('.local/release', { recursive: true });
      gh(['release', 'download', `v${result.version}`, '--repo', REPOSITORY, '--dir', '.local/release']);
    }
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `resume=${Boolean(existing)}\n`);
  }
  process.stdout.write(`Latest: ${result.index.releases.at(-1).version}; skip: ${result.skip}\n`);
}
