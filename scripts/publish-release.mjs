import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gh, REPOSITORY, sha256 } from './release-index.mjs';
import { verifyPreparedRelease } from './prepare-release.mjs';

const version = await verifyPreparedRelease();
const tag = `v${version}`;
const releases = JSON.parse(gh(['api', `repos/${REPOSITORY}/releases?per_page=100`]));
let existing = releases.find((release) => release.tag_name === tag);
const names = (await fs.readdir('.local/release')).sort();
if (existing && !existing.draft) throw new Error(`Выпуск ${tag} уже опубликован; перезапись запрещена`);
if (!existing) {
  gh(['release', 'create', tag, '--repo', REPOSITORY, '--target', process.env.GITHUB_SHA,
    '--draft', '--title', `${tag} — еженедельный снимок`, '--notes-file', '.local/release-notes.md',
    ...names.map((name) => path.join('.local/release', name))]);
}
// До публикации перечитываем реальные загруженные файлы, включая индекс.
await fs.mkdir('.local/readback', { recursive: true });
gh(['release', 'download', tag, '--repo', REPOSITORY, '--dir', '.local/readback']);
for (const name of names) {
  if (sha256(await fs.readFile(path.join('.local/readback', name)))
      !== sha256(await fs.readFile(path.join('.local/release', name)))) throw new Error(`Readback ${name} не совпадает`);
}
gh(['release', 'edit', tag, '--repo', REPOSITORY, '--draft=false', '--latest']);
existing = JSON.parse(gh(['api', `repos/${REPOSITORY}/releases/tags/${tag}`]));
if (existing.draft || existing.assets.length !== names.length) throw new Error('Публикация не подтверждена');
process.stdout.write(`Published ${existing.html_url}\n`);
