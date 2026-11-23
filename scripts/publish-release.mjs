import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { gh, REPOSITORY, sha256 } from './release-index.mjs';
import { verifyPreparedRelease } from './prepare-release.mjs';

// После неоднозначного ответа сначала перечитываем сервер, затем повторяем запись.
export async function ensureDraftAssets({ tag, names, releaseDir = '.local/release',
  target = process.env.GITHUB_SHA, notes, run = gh, wait = setTimeout }) {
  const list = () => JSON.parse(run(['api', `repos/${REPOSITORY}/releases?per_page=100`]));
  const read = () => {
    const matches = list().filter((entry) => entry.tag_name === tag);
    if (matches.length > 1) throw new Error(`Найдено несколько черновиков ${tag}: требуется ручная очистка`);
    const release = matches[0];
    if (release && !release.draft) throw new Error(`Выпуск ${tag} уже опубликован; перезапись запрещена`);
    if (release?.assets.some((asset) => !names.includes(asset.name))) throw new Error('Посторонние файлы в черновике');
    return release;
  };
  const ensure = async (done, action) => {
    let state = read();
    for (let attempt = 0; !done(state); attempt++) {
      if (attempt === 3) throw new Error('Не удалось подтвердить запись в GitHub после трёх попыток');
      try { action(); } catch (error) {
        // Не повторяем запись вслепую: ошибка чтения ниже также останавливает процесс.
        state = read();
        if (done(state)) return state;
        if (attempt === 2) throw error;
        await wait(5000);
        continue;
      }
      state = read();
    }
    return state;
  };
  const draft = await ensure(Boolean, () => run(['release', 'create', tag, '--repo', REPOSITORY,
    '--target', target, '--draft', '--title', `${tag} — еженедельный снимок`,
    '--notes-file', '.local/release-notes.md']));
  if (draft.assets.length === 0 && notes !== undefined) {
    await ensure((release) => release?.target_commitish === target && release.body === notes,
      () => run(['release', 'edit', tag, '--repo', REPOSITORY, '--target', target,
        '--notes-file', '.local/release-notes.md']));
  }
  // Индекс загружаем последним; существующие файлы никогда не перезаписываем.
  for (const name of [...names.filter((name) => name !== 'releases.json'), 'releases.json']) {
    await ensure((release) => release?.assets.some((asset) => asset.name === name),
      () => run(['release', 'upload', tag, path.join(releaseDir, name), '--repo', REPOSITORY]));
  }
}

export function expectedLocalNames(config) {
  const latest = config.releases.at(-1);
  const assetNames = Object.values(latest.releaseAssets).map((asset) => new URL(asset.url).pathname.split('/').at(-1));
  return [...assetNames, 'releases.json'].sort();
}

export async function publishRelease() {
  const version = await verifyPreparedRelease();
  const tag = `v${version}`;
  const config = JSON.parse(await fs.readFile(path.join('.local/release', 'releases.json'), 'utf8'));
  const names = expectedLocalNames(config);
  const localNames = (await fs.readdir('.local/release')).sort();
  const missingLocal = names.filter((name) => !localNames.includes(name));
  if (missingLocal.length > 0) throw new Error(`Неполный .local/release: нет ${missingLocal.join(', ')} (обрыв загрузки)`);
  const extraLocal = localNames.filter((name) => !names.includes(name));
  if (extraLocal.length > 0) throw new Error(`Посторонние файлы в .local/release: ${extraLocal.join(', ')}`);
  const notes = await fs.readFile('.local/release-notes.md', 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    // У полного возобновляемого черновика описание уже сохранено на GitHub.
    return undefined;
  });
  await ensureDraftAssets({ tag, names, notes });
  // До публикации перечитываем реальные загруженные файлы, включая индекс.
  await fs.rm('.local/readback', { recursive: true, force: true });
  await fs.mkdir('.local/readback', { recursive: true });
  gh(['release', 'download', tag, '--repo', REPOSITORY, '--dir', '.local/readback']);
  const readbackNames = (await fs.readdir('.local/readback')).sort();
  const missingRemote = names.filter((name) => !readbackNames.includes(name));
  if (missingRemote.length > 0) throw new Error(`Загрузка неполна: на GitHub нет ${missingRemote.join(', ')} (обрыв загрузки)`);
  for (const name of names) {
    let localBytes;
    let remoteBytes;
    try {
      localBytes = await fs.readFile(path.join('.local/release', name));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Неполный .local/release: нет ${name} (обрыв загрузки)`);
      throw error;
    }
    try {
      remoteBytes = await fs.readFile(path.join('.local/readback', name));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Загрузка неполна: нет ${name} в .local/readback (обрыв загрузки)`);
      throw error;
    }
    if (sha256(remoteBytes) !== sha256(localBytes)) throw new Error(`Readback ${name} не совпадает`);
  }
  gh(['release', 'edit', tag, '--repo', REPOSITORY, '--draft=false', '--latest']);
  const existing = JSON.parse(gh(['api', `repos/${REPOSITORY}/releases/tags/${tag}`]));
  const existingNames = new Set((existing.assets ?? []).map((asset) => asset.name));
  if (existing.draft || existingNames.size !== names.length || !names.every((name) => existingNames.has(name))) {
    throw new Error('Публикация не подтверждена');
  }
  process.stdout.write(`Published ${existing.html_url}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await publishRelease();
}
