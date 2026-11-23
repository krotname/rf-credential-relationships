import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REPOSITORY, requiredReleaseAssetNames, restoreDraftRelease, sha256, shouldResumeDraft,
} from '../scripts/release-index.mjs';
import { ensureDraftAssets } from '../scripts/publish-release.mjs';

const version = '2.0.3';
const tag = `v${version}`;

async function files(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rf-release-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const releaseDir = path.join(root, 'release');
  await fs.mkdir(releaseDir);
  const names = requiredReleaseAssetNames(version);
  const payloads = new Map(names.map((name) => [name, Buffer.from(`fresh ${name}\n`)]));
  for (const [name, bytes] of payloads) await fs.writeFile(path.join(releaseDir, name), bytes);
  return { root, releaseDir, names, payloads };
}

function fakeGitHub() {
  let nextRelease = 100;
  let nextAsset = 1000;
  const data = new Map();
  const api = { releases: [], writes: [], reads: [], beforeMutation: undefined, afterMutation: undefined };
  api.draft = (properties = {}) => {
    const release = { id: nextRelease++, tag_name: tag, draft: true, assets: [],
      target_commitish: 'current', body: 'fresh scan', created_at: '2026-11-24T00:00:00Z', ...properties };
    api.releases.push(release);
    return release;
  };
  api.asset = (release, name, bytes, properties = {}) => {
    const asset = { id: nextAsset++, name, state: 'uploaded', size: bytes.length,
      digest: `sha256:${sha256(bytes)}`, ...properties };
    release.assets.push(asset);
    data.set(asset.id, Buffer.from(bytes));
    return asset;
  };
  api.bytes = (asset) => data.get(asset.id);
  api.run = (args) => {
    assert.equal(args[0], 'api');
    const endpoint = args.find((arg, index) => index > 0 && /^(repos\/|https:\/\/)/.test(arg));
    assert.ok(endpoint, `API endpoint absent: ${args.join(' ')}`);
    const url = new URL(endpoint, 'https://api.github.com/');
    const route = url.pathname.replace(/^\//, '');
    const methodFlag = args.findIndex((arg) => ['-X', '--method'].includes(arg));
    const method = methodFlag === -1 ? 'GET' : args[methodFlag + 1];
    const fields = {};
    for (let index = 1; index < args.length; index++) {
      if (['-f', '-F', '--field', '--raw-field'].includes(args[index])) {
        const field = args[++index];
        const split = field.indexOf('=');
        let value = field.slice(split + 1);
        if (value.startsWith('@')) value = readFileSync(value.slice(1), 'utf8');
        fields[field.slice(0, split)] = value === 'true' ? true : value === 'false' ? false : value;
      }
    }
    const assetMatch = route.match(/\/releases\/assets\/(\d+)$/);
    const releaseMatch = route.match(/\/releases\/(\d+)(?:\/assets)?$/);
    if (method === 'GET') {
      api.reads.push(route);
      if (route === `repos/${REPOSITORY}/releases`) return JSON.stringify(api.releases);
      if (assetMatch) {
        const bytes = data.get(Number(assetMatch[1]));
        assert.ok(bytes, 'download must use an existing exact asset ID');
        return Buffer.from(bytes);
      }
      if (releaseMatch) return JSON.stringify(api.releases.find((release) => release.id === Number(releaseMatch[1])));
      assert.fail(`Unexpected read: ${route}`);
    }
    const releaseId = releaseMatch && Number(releaseMatch[1]);
    const assetId = assetMatch && Number(assetMatch[1]);
    const release = assetId
      ? api.releases.find((entry) => entry.assets.some((asset) => asset.id === assetId))
      : api.releases.find((entry) => entry.id === releaseId);
    const name = url.searchParams.get('name') ?? release?.assets.find((asset) => asset.id === assetId)?.name;
    const kind = method === 'POST' && route.endsWith('/assets') ? 'upload'
      : method === 'POST' ? 'create' : method === 'PATCH' ? 'edit'
        : assetMatch ? 'deleteAsset' : 'deleteRelease';
    const event = { kind, name, releaseId: release?.id, assetId };
    api.writes.push(event);
    api.beforeMutation?.(event, release);
    let result;
    if (kind === 'create') result = api.draft(fields);
    else {
      assert.ok(release, 'mutation must address an existing exact release ID');
      assert.equal(release.draft, true, 'published releases must never be mutated');
      if (kind === 'edit') result = Object.assign(release, fields);
      else if (kind === 'upload') {
        assert.ok(!release.assets.some((asset) => asset.name === name), `duplicate upload of ${name}`);
        const input = args[args.indexOf('--input') + 1];
        result = api.asset(release, name, readFileSync(input));
      } else if (kind === 'deleteAsset') {
        release.assets = release.assets.filter((asset) => asset.id !== assetId);
        data.delete(assetId);
      } else {
        assert.equal(release.assets.length, 0, 'only an empty duplicate may be deleted');
        api.releases = api.releases.filter((entry) => entry.id !== release.id);
      }
    }
    api.afterMutation?.(event, release);
    return result ? JSON.stringify(result) : '';
  };
  return api;
}

function options(fixture, api) {
  return { tag, names: fixture.names, releaseDir: fixture.releaseDir,
    target: 'current', notes: 'fresh scan', run: api.run, wait: async () => {} };
}

test('resume requires every expected uploaded asset, including releases.json', async (t) => {
  const fixture = await files(t);
  const api = fakeGitHub();
  const release = api.draft();
  assert.equal(shouldResumeDraft(undefined, version), false);
  assert.equal(shouldResumeDraft(release, version), false);
  for (const [name, bytes] of fixture.payloads) {
    if (name !== 'releases.json') api.asset(release, name, bytes);
  }
  assert.equal(shouldResumeDraft(release, version), false);
  api.asset(release, 'releases.json', fixture.payloads.get('releases.json'));
  assert.equal(shouldResumeDraft(release, version), true);
  for (const change of [
    (entry) => { entry.assets[0].state = 'starter'; },
    (entry) => { entry.assets[0].size = 0; },
    (entry) => { entry.assets[0].name = entry.assets[1].name; },
    (entry) => { entry.assets.push({ name: 'unexpected.txt', size: 1 }); },
  ]) {
    const invalid = structuredClone(release);
    change(invalid);
    assert.equal(shouldResumeDraft(invalid, version), false);
  }
  assert.throws(() => shouldResumeDraft({ ...release, draft: false }, version), /опубликован/);
});

test('incomplete restore clears stale local assets and does not enter verification', async (t) => {
  const fixture = await files(t);
  const api = fakeGitHub();
  const release = api.draft();
  for (const [name, bytes] of fixture.payloads) {
    if (name !== 'releases.json') api.asset(release, name, bytes);
  }
  const resumed = await restoreDraftRelease({ release, version, releaseDir: fixture.releaseDir,
    run: api.run, verify: () => assert.fail('partial draft must not be verified as complete') });
  assert.equal(resumed, false);
  assert.deepEqual(await fs.readdir(fixture.releaseDir).catch(() => []), []);
  assert.equal(api.writes.length, 0);
});

test('restore verifies downloaded bytes before resume and discards invalid candidates', async (t) => {
  const fixture = await files(t);
  const api = fakeGitHub();
  const release = api.draft();
  for (const [name, bytes] of fixture.payloads) api.asset(release, name, bytes);
  let verified = 0;
  const restore = (extra = {}) => restoreDraftRelease({ release, version, releaseDir: fixture.releaseDir,
    run: api.run, verify: async (directory) => {
      verified++;
      for (const [name, bytes] of fixture.payloads) assert.deepEqual(await fs.readFile(path.join(directory, name)), bytes);
      return version;
    }, ...extra });
  assert.equal(await restore(), true);
  assert.equal(verified, 1);
  const originalDigest = release.assets[0].digest;
  release.assets[0].digest = `sha256:${'0'.repeat(64)}`;
  assert.equal(await restore(), false);
  assert.equal(verified, 1);
  assert.deepEqual(await fs.readdir(fixture.releaseDir).catch(() => []), []);
  release.assets[0].digest = originalDigest;
  assert.equal(await restore({ verify: async () => { throw new Error('stale or invalid scan'); } }), false);
  assert.deepEqual(await fs.readdir(fixture.releaseDir).catch(() => []), []);
});

test('interrupted index upload leaves a partial draft that the next attempt completes', async (t) => {
  const fixture = await files(t);
  const api = fakeGitHub();
  api.beforeMutation = (event) => {
    if (event.kind === 'upload' && event.name === 'releases.json') throw new Error('HTTP 503 before index upload');
  };
  await assert.rejects(ensureDraftAssets(options(fixture, api)), /503|подтвердить/);
  assert.equal(api.releases.length, 1);
  const release = api.releases[0];
  assert.equal(release.assets.length, 4);
  assert.equal(shouldResumeDraft(release, version), false);
  assert.equal(api.writes.filter((entry) => entry.kind === 'upload' && entry.name === 'releases.json').length, 3);
  api.beforeMutation = undefined;
  await ensureDraftAssets(options(fixture, api));
  assert.equal(shouldResumeDraft(release, version), true);
  assert.equal(api.writes.filter((entry) => entry.kind === 'create').length, 1);
  for (const name of fixture.names.filter((name) => name !== 'releases.json')) {
    assert.equal(api.writes.filter((entry) => entry.kind === 'upload' && entry.name === name).length, 1);
  }
  const writes = api.writes.length;
  await ensureDraftAssets(options(fixture, api));
  assert.equal(api.writes.length, writes, 'verified assets must be idempotent on another retry');
});

test('ambiguous committed create and upload responses are reread without duplicate writes', async (t) => {
  const fixture = await files(t);
  const api = fakeGitHub();
  api.afterMutation = () => { throw new Error('HTTP 500 after committed write'); };
  await ensureDraftAssets(options(fixture, api));
  assert.equal(api.releases.length, 1);
  assert.equal(api.writes.filter((entry) => entry.kind === 'create').length, 1);
  for (const name of fixture.names) {
    assert.equal(api.writes.filter((entry) => entry.kind === 'upload' && entry.name === name).length, 1);
  }
  assert.equal(api.writes.filter((entry) => entry.kind === 'upload').at(-1).name, 'releases.json');
});

test('an upload that leaves a starter asset is repaired within the same bounded retry', async (t) => {
  const fixture = await files(t);
  const api = fakeGitHub();
  const interruptedName = fixture.names[0];
  const completedUploads = [];
  let starter;
  api.beforeMutation = (event, release) => {
    if (event.kind === 'upload' && event.name === interruptedName && !starter) {
      starter = api.asset(release, event.name, Buffer.alloc(0), { state: 'starter', size: 0, digest: null });
      throw new Error('HTTP 502 after incomplete upload created a starter asset');
    }
  };
  api.afterMutation = (event) => {
    if (event.kind === 'upload') completedUploads.push(event.name);
  };
  await ensureDraftAssets(options(fixture, api));
  assert.ok(starter);
  const removals = api.writes.filter((event) => event.kind === 'deleteAsset');
  assert.equal(removals.length, 1);
  assert.equal(removals[0].assetId, starter.id);
  assert.equal(removals[0].name, interruptedName);
  assert.equal(api.writes.filter((event) => event.kind === 'upload' && event.name === interruptedName).length, 2);
  for (const name of fixture.names) assert.equal(completedUploads.filter((uploaded) => uploaded === name).length, 1);
  assert.equal(completedUploads.at(-1), 'releases.json');
  assert.equal(shouldResumeDraft(api.releases[0], version), true);
});

test('fresh preparation reconciles changed and starter assets with index removed first', async (t) => {
  const fixture = await files(t);
  const api = fakeGitHub();
  const release = api.draft({ target_commitish: 'old', body: 'old scan' });
  for (const [name, bytes] of fixture.payloads) api.asset(release, name, bytes);
  const changedName = fixture.names[0];
  const changed = Buffer.from('a newly collected dataset\n');
  await fs.writeFile(path.join(fixture.releaseDir, changedName), changed);
  const starter = release.assets.find((asset) => asset.name === fixture.names[1]);
  starter.state = 'starter';
  starter.digest = null;
  starter.size = 0;
  api.afterMutation = (event) => {
    if (event.kind === 'deleteAsset') throw new Error('connection lost after committed asset deletion');
  };
  await ensureDraftAssets(options(fixture, api));
  const removals = api.writes.filter((entry) => entry.kind === 'deleteAsset');
  assert.equal(removals[0].name, 'releases.json');
  assert.equal(removals.filter((entry) => entry.name === 'releases.json').length, 1);
  assert.deepEqual(new Set(removals.map((entry) => entry.name)), new Set(['releases.json', changedName, starter.name]));
  assert.equal(api.writes.filter((entry) => entry.kind === 'upload').at(-1).name, 'releases.json');
  assert.equal(release.target_commitish, 'current');
  assert.equal(release.body, 'fresh scan');
  for (const asset of release.assets) {
    const expected = await fs.readFile(path.join(fixture.releaseDir, asset.name));
    assert.deepEqual(api.bytes(asset), expected);
    assert.equal(asset.digest, `sha256:${sha256(expected)}`);
  }
});

test('duplicate-tag recovery keeps the populated draft and removes only empty duplicates', async (t) => {
  const fixture = await files(t);
  const api = fakeGitHub();
  const empty = api.draft({ created_at: '2026-11-22T00:00:00Z' });
  const populated = api.draft();
  api.asset(populated, fixture.names[0], fixture.payloads.get(fixture.names[0]));
  await ensureDraftAssets(options(fixture, api));
  assert.deepEqual(api.releases.map((entry) => entry.id), [populated.id]);
  assert.equal(api.writes.filter((entry) => entry.kind === 'deleteRelease').length, 1);
  assert.equal(api.writes.find((entry) => entry.kind === 'deleteRelease').releaseId, empty.id);
  assert.equal(api.writes.filter((entry) => entry.kind === 'create').length, 0);
});

test('published, foreign and ambiguous populated drafts block all mutations', async (t) => {
  const fixture = await files(t);
  for (const scenario of ['published', 'foreign', 'two populated']) {
    const api = fakeGitHub();
    const release = api.draft();
    api.asset(release, fixture.names[0], fixture.payloads.get(fixture.names[0]));
    if (scenario === 'published') api.draft({ draft: false });
    if (scenario === 'foreign') api.asset(release, 'unexpected.txt', Buffer.from('foreign'));
    if (scenario === 'two populated') {
      const other = api.draft();
      api.asset(other, fixture.names[1], fixture.payloads.get(fixture.names[1]));
    }
    await assert.rejects(ensureDraftAssets(options(fixture, api)), undefined, scenario);
    assert.equal(api.writes.length, 0, scenario);
  }
});

test('publication observed on a later read stops recovery before any write', async (t) => {
  const fixture = await files(t);
  const api = fakeGitHub();
  const release = api.draft();
  api.asset(release, fixture.names[0], Buffer.from('old partial scan'));
  let reads = 0;
  const run = (args, options) => {
    if (args.includes(`repos/${REPOSITORY}/releases?per_page=100`) && ++reads === 2) release.draft = false;
    return api.run(args, options);
  };
  await assert.rejects(ensureDraftAssets({ ...options(fixture, api), run }), /опубликован/);
  assert.equal(api.writes.length, 0);
});

test('a draft published during retry backoff is reread before another upload', async (t) => {
  const fixture = await files(t);
  const api = fakeGitHub();
  const release = api.draft();
  api.beforeMutation = () => { throw new Error('HTTP 503 before upload'); };
  await assert.rejects(ensureDraftAssets({ ...options(fixture, api),
    wait: async () => { release.draft = false; } }), /опубликован/);
  assert.equal(api.writes.length, 1);
  assert.equal(api.writes[0].kind, 'upload');
});

test('successful create uses its returned ID while the release list is stale', async (t) => {
  const fixture = await files(t);
  const api = fakeGitHub();
  let hiddenReads = 3;
  const run = (args, options) => {
    if (args.includes(`repos/${REPOSITORY}/releases?per_page=100`)
        && api.releases.length && hiddenReads-- > 0) return '[]';
    return api.run(args, options);
  };
  await ensureDraftAssets({ ...options(fixture, api), run });
  assert.equal(api.releases.length, 1);
  assert.equal(api.writes.filter((event) => event.kind === 'create').length, 1);
  assert.ok(api.reads.includes(`repos/${REPOSITORY}/releases/${api.releases[0].id}`));
  assert.equal(api.releases[0].assets.length, 5);
});

test('an ambiguous create with delayed visibility is not blindly repeated', async (t) => {
  const fixture = await files(t);
  const api = fakeGitHub();
  let hideCreated = true;
  api.afterMutation = (event) => {
    if (event.kind === 'create') throw new Error('connection lost after committed create');
  };
  const run = (args, options) => {
    if (hideCreated && args.includes(`repos/${REPOSITORY}/releases?per_page=100`)) return '[]';
    return api.run(args, options);
  };
  await assert.rejects(ensureDraftAssets({ ...options(fixture, api), run }), /connection lost/);
  assert.equal(api.writes.filter((event) => event.kind === 'create').length, 1);
  hideCreated = false;
  await ensureDraftAssets({ ...options(fixture, api), run });
  assert.equal(api.releases.length, 1);
  assert.equal(api.releases[0].assets.length, 5);
  assert.equal(api.writes.filter((event) => event.kind === 'create').length, 1);
});

test('an empty duplicate that appears during upload is removed before completion', async (t) => {
  const fixture = await files(t);
  const api = fakeGitHub();
  api.afterMutation = (event) => {
    if (event.kind === 'upload' && event.name === 'releases.json') api.draft();
  };
  await ensureDraftAssets(options(fixture, api));
  assert.equal(api.releases.length, 1);
  assert.equal(api.releases[0].assets.length, 5);
  assert.equal(api.writes.filter((event) => event.kind === 'deleteRelease').length, 1);
});

test('direct draft reads prevent stale asset lists from causing duplicate uploads', async (t) => {
  const fixture = await files(t);
  const api = fakeGitHub();
  const release = api.draft();
  const stale = JSON.stringify([release]);
  const run = (args, options) => args.includes(`repos/${REPOSITORY}/releases?per_page=100`)
    ? stale : api.run(args, options);
  await ensureDraftAssets({ ...options(fixture, api), run });
  assert.equal(api.writes.filter((event) => event.kind === 'upload').length, 5);
  assert.equal(release.assets.length, 5);
});

test('duplicate cleanup checks its exact ID even when the list still calls it empty', async (t) => {
  const fixture = await files(t);
  for (const transition of ['published', 'populated']) {
    const api = fakeGitHub();
    const release = api.draft();
    api.asset(release, fixture.names[0], fixture.payloads.get(fixture.names[0]));
    const duplicate = api.draft();
    const stale = JSON.stringify(api.releases);
    if (transition === 'published') duplicate.draft = false;
    else api.asset(duplicate, fixture.names[1], fixture.payloads.get(fixture.names[1]));
    const run = (args, options) => args.includes(`repos/${REPOSITORY}/releases?per_page=100`)
      ? stale : api.run(args, options);
    await assert.rejects(ensureDraftAssets({ ...options(fixture, api), run }), /Удаление.*запрещено/);
    assert.equal(api.writes.filter((event) => event.kind === 'deleteRelease').length, 0);
  }
});
