import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  buildDalGroups,
  buildTypedRelations,
  extractAppleWebCredentials,
  extractCredentialDeclarations,
  extractWebAuthnRelatedOrigins,
  fetchWithTimeout,
  isPublicWebHostname,
  isValidSha256Fingerprint,
  isPrereleasePackage,
  normalizeHostname,
  normalizeWebOrigin,
  parseAppleShared,
  parseArgs,
  parseBitwardenGlobal,
  readResponseBodyLimited,
  registrableDomain,
} from '../collect-rf-equivalent-domains.mjs';

const VALID_FINGERPRINT = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join(':');

test('keeps the ranking limit separate from bounded verification origins', () => {
  const options = parseArgs(['--limit', '5000']);
  assert.equal(options.limit, 5000);
  assert.equal(options.checkWww, false);
  assert.equal(options.maxDiscovered, 0);
  assert.equal(options.associations, true);
  assert.equal(parseArgs(['--no-associations']).associations, false);
  assert.equal(parseArgs(['--concurrency', '400']).concurrency, 400);
  assert.throws(() => parseArgs(['--concurrency', '401']), /от 1 до 400/);
});

test('normalizes IDN and registrable domains', () => {
  assert.equal(normalizeHostname('https://ПРИМЕР.РФ/'), 'xn--e1afmkfd.xn--p1ai');
  assert.equal(registrableDomain('www.mail.example.co.uk'), 'example.co.uk');
  assert.equal(normalizeHostname('127.0.0.1'), null);
  assert.equal(normalizeWebOrigin('https://u@example.com'), null);
  assert.equal(isPublicWebHostname('login.example.ru'), true);
  assert.equal(isPublicWebHostname('internal.lan'), false);
});

test('extracts only credential-sharing declarations', () => {
  const payload = [
    { relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'web', site: 'https://ignored.ru' } },
    { relation: ['delegate_permission/common.get_login_creds'], target: { namespace: 'web', site: 'https://b.ru' } },
    {
      relation: ['delegate_permission/common.get_login_creds'],
      target: {
        namespace: 'android_app', package_name: 'ru.example.app',
        sha256_cert_fingerprints: [VALID_FINGERPRINT],
      },
    },
  ];
  const result = extractCredentialDeclarations(payload, 'https://a.ru');
  assert.deepEqual(result.web.map((item) => item.origin), ['https://b.ru']);
  assert.deepEqual(result.android.map((item) => item.packageName), ['ru.example.app']);
});

test('merges certificates declared separately for the same Android package', () => {
  const secondFingerprint = VALID_FINGERPRINT.replace(/^00/, 'FF');
  const lowerCaseDuplicate = `  ${VALID_FINGERPRINT.toLowerCase()}  `;
  const result = extractCredentialDeclarations([
    {
      relation: ['delegate_permission/common.get_login_creds'],
      target: {
        namespace: 'android_app',
        package_name: 'ru.example.app',
        sha256_cert_fingerprints: [VALID_FINGERPRINT, lowerCaseDuplicate],
      },
    },
    {
      relation: ['delegate_permission/common.get_login_creds'],
      target: {
        namespace: 'android_app',
        package_name: 'ru.example.app',
        sha256_cert_fingerprints: [secondFingerprint],
      },
    },
  ], 'https://example.ru');
  assert.deepEqual(result.android[0].fingerprints, [VALID_FINGERPRINT.toUpperCase(), secondFingerprint.toUpperCase()]);
});

test('extracts Apple and WebAuthn associations conservatively', () => {
  assert.deepEqual(extractAppleWebCredentials({
    webcredentials: { apps: ['ABCDE12345.ru.example.app', 'invalid', 'ABCDE12345.ru.example.app'] },
  }), ['ABCDE12345.ru.example.app']);
  assert.deepEqual(extractWebAuthnRelatedOrigins({
    origins: [
      'https://login.example.ru',
      'http://unsafe.example.ru',
      'https://other.example.ru/path',
      'https://internal.lan',
    ],
  }), ['https://login.example.ru', 'https://other.example.ru']);
  assert.throws(
    () => extractWebAuthnRelatedOrigins({ origins: ['https://login.example.ru', 42] }),
    /массивом строк/,
  );
});

test('builds separate typed credential relations', () => {
  const checkedAt = '2026-09-05T00:00:00.000Z';
  const records = new Map([['https://a.ru', {
    status: 'ok', checkedAt, declarations: {
      web: [{ origin: 'https://a.ru' }, { origin: 'https://b.ru' }],
      android: [{ packageName: 'ru.example.app', fingerprints: [VALID_FINGERPRINT] }],
    },
  }]]);
  const associations = {
    aasa: new Map([['https://a.ru', {
      status: 'ok', checkedAt,
      values: ['ABCDE12345.ru.example.app', 'ABCDE12345.ru.example.app.adhoc'],
    }]]),
    webauthn: new Map([['https://a.ru', { status: 'ok', checkedAt, values: ['https://login.b.ru'] }]]),
  };
  const relations = buildTypedRelations(records, associations);
  assert.deepEqual(relations.map((item) => item.type), [
    'apple_webcredentials',
    'dal_android_credentials',
    'dal_web_credentials',
    'webauthn_related_origin',
  ]);
  assert.equal(relations.find((item) => item.type === 'dal_web_credentials').reciprocal, false);
  assert.equal(relations.some((item) => item.source === item.target), false);
  assert.equal(relations.some((item) => item.target.endsWith('.adhoc')), false);
});

test('requires reciprocal web declarations and excludes debug apps', () => {
  const records = new Map([
    ['https://a.ru', {
      status: 'ok', declarations: {
        web: [{ origin: 'https://b.ru' }, { origin: 'https://one-way.ru' }],
        android: [
          { packageName: 'ru.example.release', fingerprints: [VALID_FINGERPRINT] },
          { packageName: 'ru.example.debug', fingerprints: [VALID_FINGERPRINT] },
        ],
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

test('rejects malformed fingerprints and subdomain-only web relations', async () => {
  assert.equal(isValidSha256Fingerprint(VALID_FINGERPRINT), true);
  assert.equal(isValidSha256Fingerprint('AA:BB'), false);
  const declarations = extractCredentialDeclarations([{
    relation: ['delegate_permission/common.get_login_creds'],
    target: { namespace: 'android_app', package_name: 'ru.example.app', sha256_cert_fingerprints: ['AA:BB'] },
  }], 'https://a.ru');
  assert.equal(declarations.android.length, 0);

  const records = new Map([
    ['https://a.ru', { status: 'ok', declarations: { web: [{ origin: 'https://login.b.ru' }], android: [] } }],
    ['https://login.b.ru', { status: 'ok', declarations: { web: [{ origin: 'https://a.ru' }], android: [] } }],
  ]);
  const subdomainResult = buildDalGroups(records, new Map([['a.ru', 1]]));
  assert.equal(subdomainResult.groups.length, 0);
  assert.equal(subdomainResult.unrepresentableWebLinks.length, 2);

  await assert.rejects(() => readResponseBodyLimited(new Response('123456'), 5), /ответ больше 5 байт/);
});

test('cancels a response body rejected before streaming', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': 1024 * 1024,
    });
    response.end('[]');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await assert.rejects(
      () => fetchWithTimeout(`http://127.0.0.1:${port}/assetlinks.json`, {
        timeoutMs: 1000,
        maxBytes: 16,
        jsonOnly: true,
      }),
      /ответ больше 16 байт/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('follows redirects only when explicitly requested', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/result' });
      response.end();
      return;
    }
    response.writeHead(200, {
      'content-type': request.url === '/text-json' ? 'text/json' : 'application/json',
    });
    response.end('{"origins":[]}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/redirect`;
    await assert.rejects(() => fetchWithTimeout(url, { timeoutMs: 1000, jsonOnly: true }), /HTTP 302/);
    assert.equal(
      await fetchWithTimeout(url, { timeoutMs: 1000, jsonOnly: true, redirect: 'follow' }),
      '{"origins":[]}',
    );
    await assert.rejects(
      () => fetchWithTimeout(url, { timeoutMs: 1000, jsonOnly: true, redirect: 'follow-https' }),
      /redirect вне HTTPS/,
    );
    await assert.rejects(
      () => fetchWithTimeout(`http://127.0.0.1:${port}/text-json`, {
        timeoutMs: 1000,
        jsonOnly: true,
        strictJsonContentType: true,
      }),
      /неверный Content-Type/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('recognizes prerelease package markers', () => {
  assert.equal(isPrereleasePackage('ru.hh.android.debug'), true);
  assert.equal(isPrereleasePackage('ru.yandex.yandexmaps.pr'), true);
  assert.equal(isPrereleasePackage('com.yandex.browser.broteam'), true);
  assert.equal(isPrereleasePackage('com.google.android.apps.nbu.paisa.user.teamfood2'), true);
  assert.equal(isPrereleasePackage('ru.kontur.acceptance'), true);
  assert.equal(isPrereleasePackage('ru.yandex.mail.adhoc'), true);
  assert.equal(isPrereleasePackage('com.idamob.tinkoff.android'), false);
});

test('parses authoritative catalogs', () => {
  const bitwarden = 'GlobalDomains.Add(GlobalEquivalentDomainsType.X, new List<string> { "a.ru", "b.com" });';
  assert.deepEqual(parseBitwardenGlobal(bitwarden), [['a.ru', 'b.com']]);
  assert.deepEqual(parseAppleShared('[{"shared":["a.ru","b.com"]},{"from":["x.ru"],"to":["y.ru"]}]'), [['a.ru', 'b.com']]);
});
