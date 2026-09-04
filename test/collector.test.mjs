import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDalGroups,
  extractCredentialDeclarations,
  isPrereleasePackage,
  normalizeHostname,
  normalizeWebOrigin,
  parseAppleShared,
  parseArgs,
  parseBitwardenGlobal,
  registrableDomain,
} from '../collect-rf-equivalent-domains.mjs';

test('keeps the ranking limit separate from bounded verification origins', () => {
  const options = parseArgs(['--limit', '5000']);
  assert.equal(options.limit, 5000);
  assert.equal(options.checkWww, false);
  assert.equal(options.maxDiscovered, 0);
});

test('normalizes IDN and registrable domains', () => {
  assert.equal(normalizeHostname('https://ПРИМЕР.РФ/'), 'xn--e1afmkfd.xn--p1ai');
  assert.equal(registrableDomain('www.mail.example.co.uk'), 'example.co.uk');
  assert.equal(normalizeHostname('127.0.0.1'), null);
  assert.equal(normalizeWebOrigin('https://u@example.com'), null);
});

test('extracts only credential-sharing declarations', () => {
  const payload = [
    { relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'web', site: 'https://ignored.ru' } },
    { relation: ['delegate_permission/common.get_login_creds'], target: { namespace: 'web', site: 'https://b.ru' } },
    {
      relation: ['delegate_permission/common.get_login_creds'],
      target: {
        namespace: 'android_app', package_name: 'ru.example.app',
        sha256_cert_fingerprints: ['AA:BB'],
      },
    },
  ];
  const result = extractCredentialDeclarations(payload, 'https://a.ru');
  assert.deepEqual(result.web.map((item) => item.origin), ['https://b.ru']);
  assert.deepEqual(result.android.map((item) => item.packageName), ['ru.example.app']);
});

test('requires reciprocal web declarations and excludes debug apps', () => {
  const records = new Map([
    ['https://a.ru', {
      status: 'ok', declarations: {
        web: [{ origin: 'https://b.ru' }, { origin: 'https://one-way.ru' }],
        android: [{ packageName: 'ru.example.release' }, { packageName: 'ru.example.debug' }],
      },
    }],
    ['https://b.ru', {
      status: 'ok', declarations: { web: [{ origin: 'https://a.ru' }], android: [] },
    }],
  ]);
  const result = buildDalGroups(records, new Map([['a.ru', 1]]));
  assert.deepEqual(result.groups[0].members.sort(), ['a.ru', 'androidapp://ru.example.release', 'b.ru']);
  assert.equal(result.nonReciprocal.length, 1);
  assert.equal(result.rejectedApps[0].packageName, 'ru.example.debug');
});

test('recognizes prerelease package markers', () => {
  assert.equal(isPrereleasePackage('ru.hh.android.debug'), true);
  assert.equal(isPrereleasePackage('ru.yandex.yandexmaps.pr'), true);
  assert.equal(isPrereleasePackage('com.yandex.browser.broteam'), true);
  assert.equal(isPrereleasePackage('com.google.android.apps.nbu.paisa.user.teamfood2'), true);
  assert.equal(isPrereleasePackage('ru.kontur.acceptance'), true);
  assert.equal(isPrereleasePackage('com.idamob.tinkoff.android'), false);
});

test('parses authoritative catalogs', () => {
  const bitwarden = 'GlobalDomains.Add(GlobalEquivalentDomainsType.X, new List<string> { "a.ru", "b.com" });';
  assert.deepEqual(parseBitwardenGlobal(bitwarden), [['a.ru', 'b.com']]);
  assert.deepEqual(parseAppleShared('[{"shared":["a.ru","b.com"]},{"from":["x.ru"],"to":["y.ru"]}]'), [['a.ru', 'b.com']]);
});
