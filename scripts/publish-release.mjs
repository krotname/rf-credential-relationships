import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { downloadReleaseAssets, gh, readReleaseAsset, REPOSITORY, requiredReleaseAssetNames,
  selectDraftRelease, sha256 } from './release-index.mjs';
import { verifyPreparedRelease } from './prepare-release.mjs';

function sameAssets(left, right) {
  return left.length === right.length && left.every((asset) => right.some((other) =>
    ['id', 'name', 'size', 'state', 'digest'].every((key) => asset[key] === other[key])));
}

// После неоднозначного ответа сначала перечитываем сервер, затем повторяем запись.
export async function ensureDraftAssets({ tag, names, releaseDir = '.local/release',
  target = process.env.GITHUB_SHA, notes, run = gh, wait = setTimeout }) {
  const required = requiredReleaseAssetNames(tag.replace(/^v/, ''));
  if (names.length !== required.length || required.some((name) => !names.includes(name))) {
    throw new Error('Неполный обязательный комплект файлов публикации');
  }
  const expected = new Map(await Promise.all(names.map(async (name) => {
    const bytes = await fs.readFile(path.join(releaseDir, name));
    return [name, { size: bytes.length, sha256: sha256(bytes) }];
  })));
  let releaseId;
  const read = () => {
    const releases = JSON.parse(run(['api', `repos/${REPOSITORY}/releases?per_page=100`]));
    // Список может запаздывать после успешного POST. Известный ID проверяем напрямую,
    // иначе отсутствие в списке провоцирует повторное создание пустого дубля.
    if (releaseId !== undefined) {
      const current = JSON.parse(run(['api', `repos/${REPOSITORY}/releases/${releaseId}`]));
      if (current.id !== releaseId) throw new Error('Ответ GitHub не соответствует ID черновика');
      const index = releases.findIndex((release) => release.id === releaseId);
      if (index === -1) releases.push(current);
      else releases[index] = current;
    }
    const release = selectDraftRelease(releases, tag);
    if (releaseId !== undefined && release?.id !== releaseId) throw new Error('Черновик изменился во время публикации');
    if (release?.assets.some((asset) => !names.includes(asset.name))) throw new Error('Посторонние файлы в черновике');
    if (release && new Set(release.assets.map((asset) => asset.name)).size !== release.assets.length) {
      throw new Error('Повторные имена файлов в черновике');
    }
    return release && { ...release, duplicates: releases.filter((entry) => entry.tag_name === tag && entry.id !== release.id) };
  };
  const matches = (asset, name) => {
    const file = expected.get(name);
    if (!asset || asset.state !== 'uploaded' || asset.size !== file.size) return false;
    return asset.digest ? asset.digest === `sha256:${file.sha256}` : sha256(readReleaseAsset(asset, run)) === file.sha256;
  };
  const ensure = async (done, action, { retryWrites = true } = {}) => {
    let state = read();
    for (let attempt = 0; !done(state); attempt++) {
      if (attempt === 3) throw new Error('Не удалось подтвердить запись в GitHub после трёх попыток');
      try { await action(state); } catch (error) {
        // Не повторяем запись вслепую: ошибка чтения ниже также останавливает процесс.
        state = read();
        if (done(state)) return state;
        if (attempt === 2) throw error;
        await wait(5000);
        state = read();
        // При потере ответа create неизвестно, был ли создан объект. Повторный POST
        // не идемпотентен: завершаем попытку, сохраняя возможность безопасного нового запуска.
        if (!retryWrites && !done(state)) throw error;
        continue;
      }
      state = read();
    }
    return state;
  };
  const targetFields = target ? ['-f', `target_commitish=${target}`] : [];
  const draft = await ensure(Boolean, () => {
    const created = JSON.parse(run(['api', '-X', 'POST', `repos/${REPOSITORY}/releases`,
      '-f', `tag_name=${tag}`, ...targetFields, '-F', 'draft=true',
      '-f', `name=${tag} — еженедельный снимок`, '-f', `body=${notes ?? ''}`]));
    if (!Number.isSafeInteger(created.id) || created.tag_name !== tag || !created.draft) {
      throw new Error('Некорректный ответ создания черновика');
    }
    releaseId = created.id;
  }, { retryWrites: false });
  releaseId = draft.id;
  // При неоднозначном create могли остаться пустые дубли. Непустые дубли требуют проверки.
  const removeEmptyDuplicates = async () => {
    for (const duplicate of read().duplicates) {
      await ensure((release) => !release.duplicates.some((entry) => entry.id === duplicate.id), (release) => {
        const current = JSON.parse(run(['api', `repos/${REPOSITORY}/releases/${duplicate.id}`]));
        if (current.id !== duplicate.id || current.tag_name !== tag || !current.draft || current.assets.length) {
          throw new Error('Удаление непустого или опубликованного дубля запрещено');
        }
        run(['api', '-X', 'DELETE', `repos/${REPOSITORY}/releases/${current.id}`]);
      });
    }
  };
  await removeEmptyDuplicates();
  if (notes !== undefined) {
    await ensure((release) => (!target || release.target_commitish === target) && release.body === notes,
      (release) => run(['api', '-X', 'PATCH', `repos/${REPOSITORY}/releases/${release.id}`,
        ...targetFields, '-f', `body=${notes}`]));
  }
  const removeAsset = (name) => ensure((release) => !release.assets.some((asset) => asset.name === name), (release) => {
    const asset = release.assets.find((entry) => entry.name === name);
    run(['api', '-X', 'DELETE', `repos/${REPOSITORY}/releases/assets/${asset.id}`]);
  });
  const state = read();
  if (names.some((name) => name !== 'releases.json' && !matches(state.assets.find((asset) => asset.name === name), name))) {
    // Индекс является завершающим маркером пакета и не должен пережить замену данных.
    await removeAsset('releases.json');
  }
  // Изменяем только черновик, по точным ID. Совпадающие файлы сохраняем, индекс загружаем последним.
  for (const name of required) {
    const current = read().assets.find((asset) => asset.name === name);
    if (current && !matches(current, name)) await removeAsset(name);
    await ensure((release) => matches(release.assets.find((asset) => asset.name === name), name), async (release) => {
      // Неудачный POST может оставить новый starter: перечитываем и удаляем его перед повтором.
      if (release.assets.some((asset) => asset.name === name)) {
        await removeAsset(name);
        release = read();
      }
      return run(['api', '-X', 'POST',
        `https://uploads.github.com/repos/${REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
        '-H', 'Content-Type: application/octet-stream', '--input', path.join(releaseDir, name)]);
    });
  }
  await removeEmptyDuplicates();
  const complete = read();
  if (complete.duplicates.length) throw new Error('Обнаружен новый дубликат черновика; повторите проверку перед публикацией');
  return complete;
}

export async function publishRelease() {
  const version = await verifyPreparedRelease();
  const tag = `v${version}`;
  const names = (await fs.readdir('.local/release')).sort();
  const notes = await fs.readFile('.local/release-notes.md', 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    // У полного возобновляемого черновика описание уже сохранено на GitHub.
    return undefined;
  });
  const draft = await ensureDraftAssets({ tag, names, notes });
  // До публикации перечитываем реальные загруженные файлы, включая индекс.
  await fs.rm('.local/readback', { recursive: true, force: true });
  await downloadReleaseAssets(draft, '.local/readback');
  for (const name of names) {
    if (sha256(await fs.readFile(path.join('.local/readback', name)))
        !== sha256(await fs.readFile(path.join('.local/release', name)))) throw new Error(`Readback ${name} не совпадает`);
  }
  const endpoint = `repos/${REPOSITORY}/releases/${draft.id}`;
  const before = JSON.parse(gh(['api', endpoint]));
  if (!before.draft || before.tag_name !== tag || !sameAssets(before.assets, draft.assets)) {
    throw new Error('Черновик изменился после readback; публикация остановлена');
  }
  let publishError;
  try { gh(['api', '-X', 'PATCH', endpoint, '-F', 'draft=false', '-f', 'make_latest=true']); }
  catch (error) { publishError = error; }
  // Ошибка ответа PATCH могла произойти уже после успешной публикации; сначала перечитываем.
  const existing = JSON.parse(gh(['api', endpoint]));
  if (existing.draft || existing.tag_name !== tag || !sameAssets(existing.assets, draft.assets)) {
    throw publishError ?? new Error('Публикация не подтверждена');
  }
  process.stdout.write(`Published ${existing.html_url}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await publishRelease();
}
