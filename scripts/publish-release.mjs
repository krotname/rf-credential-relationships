import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { gh, REPOSITORY, sha256 } from './release-index.mjs';
import { verifyPreparedRelease } from './prepare-release.mjs';

// После неоднозначного ответа сначала перечитываем сервер, затем повторяем запись.
export async function ensureDraftAssets({ tag, names, releaseDir = '.local/release',
  target = process.env.GITHUB_SHA, run = gh, wait = setTimeout }) {
  const read = () => {
    const release = JSON.parse(run(['api', `repos/${REPOSITORY}/releases?per_page=100`]))
      .find((entry) => entry.tag_name === tag);
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
  await ensure(Boolean, () => run(['release', 'create', tag, '--repo', REPOSITORY,
    '--target', target, '--draft', '--title', `${tag} — еженедельный снимок`,
    '--notes-file', '.local/release-notes.md']));
  // Индекс загружаем последним; существующие файлы никогда не перезаписываем.
  for (const name of [...names.filter((name) => name !== 'releases.json'), 'releases.json']) {
    await ensure((release) => release?.assets.some((asset) => asset.name === name),
      () => run(['release', 'upload', tag, path.join(releaseDir, name), '--repo', REPOSITORY]));
  }
}

export async function publishRelease() {
  const version = await verifyPreparedRelease();
  const tag = `v${version}`;
  const names = (await fs.readdir('.local/release')).sort();
  await ensureDraftAssets({ tag, names });
  // До публикации перечитываем реальные загруженные файлы, включая индекс.
  await fs.mkdir('.local/readback', { recursive: true });
  gh(['release', 'download', tag, '--repo', REPOSITORY, '--dir', '.local/readback']);
  for (const name of names) {
    if (sha256(await fs.readFile(path.join('.local/readback', name)))
        !== sha256(await fs.readFile(path.join('.local/release', name)))) throw new Error(`Readback ${name} не совпадает`);
  }
  gh(['release', 'edit', tag, '--repo', REPOSITORY, '--draft=false', '--latest']);
  const existing = JSON.parse(gh(['api', `repos/${REPOSITORY}/releases/tags/${tag}`]));
  if (existing.draft || existing.assets.length !== names.length) throw new Error('Публикация не подтверждена');
  process.stdout.write(`Published ${existing.html_url}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await publishRelease();
}
