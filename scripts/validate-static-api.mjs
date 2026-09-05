import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function compareSemanticVersions(left, right) {
  const leftParts = left.replace(/^v/, '').split('.').map(Number);
  const rightParts = right.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function expectedDelta(previous, current) {
  const previousKeys = new Set((previous?.relations ?? []).map(canonical));
  const currentKeys = new Set(current.relations.map(canonical));
  return {
    added: current.relations.filter((relation) => !previousKeys.has(canonical(relation))),
    removed: (previous?.relations ?? []).filter((relation) => !currentKeys.has(canonical(relation))),
  };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function assertValid(validate, value, label) {
  if (!validate(value)) throw new Error(`${label}: ${JSON.stringify(validate.errors)}`);
}

function assertStatistics(dataset, label) {
  const actual = Object.fromEntries(Object.keys(dataset.statistics.relationsByType).map((type) => [type, 0]));
  for (const relation of dataset.relations) actual[relation.type] += 1;
  if (dataset.statistics.totalRelations !== dataset.relations.length
      || canonical(actual) !== canonical(dataset.statistics.relationsByType)) {
    throw new Error(`Statistics ${label} не согласованы`);
  }
}

function localPathForUrl(siteDir, value) {
  const pathname = new URL(value).pathname;
  const marker = '/api/';
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) throw new Error(`URL вне API: ${value}`);
  const relative = decodeURIComponent(pathname.slice(markerIndex + 1));
  const target = path.resolve(siteDir, ...relative.split('/'));
  const apiRoot = path.resolve(siteDir, 'api') + path.sep;
  if (!target.startsWith(apiRoot)) throw new Error(`Небезопасный API URL: ${value}`);
  return target;
}

export async function validateStaticApi({ siteDir = path.join(PROJECT_ROOT, 'site') } = {}) {
  const schemaDir = path.join(siteDir, 'api', 'schema');
  const schemaNames = ['relationships-v1', 'manifest-v1', 'latest-v1', 'delta-v1'];
  const schemas = await Promise.all(schemaNames.map((name) => readJson(path.join(schemaDir, `${name}.schema.json`))));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const schema of schemas) ajv.addSchema(schema);
  const validators = Object.fromEntries(schemaNames.map((name, index) => [name, ajv.getSchema(schemas[index].$id)]));

  const latestPath = path.join(siteDir, 'api', 'latest.json');
  const latest = await readJson(latestPath);
  assertValid(validators['latest-v1'], latest, 'latest.json');
  async function validateManifest(manifestPath) {
    const manifest = await readJson(manifestPath);
    assertValid(validators['manifest-v1'], manifest, `manifest ${manifest.version}`);
    if (localPathForUrl(siteDir, manifest.schema) !== path.join(schemaDir, 'relationships-v1.schema.json')) {
      throw new Error(`Manifest ${manifest.version} указывает на неизвестную schema`);
    }
    const expectedSlugs = ['aasa-webcredentials', 'dal-android', 'dal-web', 'webauthn-related-origins'];
    if (JSON.stringify(Object.keys(manifest.types).sort()) !== JSON.stringify(expectedSlugs)) {
      throw new Error(`Manifest ${manifest.version} должен содержать четыре обязательных type endpoint`);
    }

    const datasetBytes = await fs.readFile(localPathForUrl(siteDir, manifest.dataset.url));
    const dataset = JSON.parse(datasetBytes.toString('utf8'));
    assertValid(validators['relationships-v1'], dataset, `relationships ${manifest.version}`);
    if (sha256(datasetBytes) !== manifest.dataset.sha256 || dataset.relations.length !== manifest.dataset.count) {
      throw new Error(`Hash/count relationships ${manifest.version} не совпадает с manifest`);
    }
    assertStatistics(dataset, `relationships ${manifest.version}`);

    let filteredTotal = 0;
    for (const [slug, artifact] of Object.entries(manifest.types)) {
      const bytes = await fs.readFile(localPathForUrl(siteDir, artifact.url));
      const filtered = JSON.parse(bytes.toString('utf8'));
      assertValid(validators['relationships-v1'], filtered, `type ${slug}`);
      assertStatistics(filtered, `type ${slug}`);
      if (sha256(bytes) !== artifact.sha256 || filtered.relations.length !== artifact.count) {
        throw new Error(`Hash/count type ${slug} не совпадает с manifest`);
      }
      if (filtered.relations.some((relation) => relation.type !== artifact.relationshipType)) {
        throw new Error(`Endpoint ${slug} содержит другой тип связи`);
      }
      const expected = dataset.relations.filter((relation) => relation.type === artifact.relationshipType);
      if (canonical(filtered.relations.map(canonical).sort()) !== canonical(expected.map(canonical).sort())) {
        throw new Error(`Endpoint ${slug} не совпадает с фильтром dataset`);
      }
      filteredTotal += artifact.count;
    }
    if (filteredTotal !== dataset.relations.length) throw new Error(`Type endpoints ${manifest.version} не покрывают dataset`);

    const deltaBytes = await fs.readFile(localPathForUrl(siteDir, manifest.delta.url));
    const delta = JSON.parse(deltaBytes.toString('utf8'));
    assertValid(validators['delta-v1'], delta, `delta ${manifest.version}`);
    if (sha256(deltaBytes) !== manifest.delta.sha256
        || delta.added.length !== manifest.delta.added
        || delta.removed.length !== manifest.delta.removed
        || delta.added.length + delta.removed.length !== manifest.delta.count) {
      throw new Error(`Hash/count delta ${manifest.version} не совпадает с manifest`);
    }
    if (delta.bootstrap !== manifest.delta.bootstrap || delta.fromVersion !== manifest.delta.fromVersion) {
      throw new Error(`Семантика delta ${manifest.version} не совпадает с manifest`);
    }
    return { manifest, dataset, delta };
  }

  const apiDir = path.join(siteDir, 'api');
  const versionDirs = (await fs.readdir(apiDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^v\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareSemanticVersions);
  if (versionDirs.length === 0) throw new Error('В static API нет ни одной версии');
  const validated = [];
  for (const versionDir of versionDirs) {
    validated.push(await validateManifest(path.join(apiDir, versionDir, 'manifest.json')));
  }
  for (let index = 0; index < validated.length; index += 1) {
    const currentRelease = validated[index];
    const previousRelease = index === 0 ? null : validated[index - 1];
    const expected = expectedDelta(previousRelease?.dataset ?? null, currentRelease.dataset);
    const expectedPreviousVersion = previousRelease?.manifest.version ?? null;
    const expectedBootstrap = previousRelease === null;
    const expectedBaseline = expectedBootstrap ? 'empty' : 'previous-release';
    if (currentRelease.delta.toVersion !== currentRelease.manifest.version
        || currentRelease.delta.fromVersion !== expectedPreviousVersion
        || currentRelease.delta.bootstrap !== expectedBootstrap
        || currentRelease.delta.baseline !== expectedBaseline
        || canonical(currentRelease.delta.added) !== canonical(expected.added)
        || canonical(currentRelease.delta.removed) !== canonical(expected.removed)) {
      throw new Error(`Delta ${currentRelease.manifest.version} не является точной разницей соседних datasets`);
    }
  }
  const current = validated.find(({ manifest }) => manifest.version === latest.version);
  if (!current
      || localPathForUrl(siteDir, latest.manifest) !== path.join(apiDir, `v${latest.version}`, 'manifest.json')
      || latest.publishedAt !== current.manifest.publishedAt
      || latest.schema !== current.manifest.schema
      || latest.dataset !== current.manifest.dataset.url
      || latest.delta !== current.manifest.delta.url
      || canonical(latest.releaseAssets) !== canonical(current.manifest.releaseAssets)
      || JSON.stringify(latest.types) !== JSON.stringify(Object.fromEntries(
        Object.entries(current.manifest.types).map(([slug, artifact]) => [slug, artifact.url]),
      ))) {
    throw new Error('latest.json не согласован с manifest.json');
  }
  return { version: latest.version, count: current.dataset.relations.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const siteDir = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const result = await validateStaticApi({ siteDir });
  process.stdout.write(`Validated static API ${result.version}: ${result.count} relations\n`);
}
