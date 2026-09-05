# RF Credential Relationships

[![Test](https://github.com/krotname/rf-credential-relationships/actions/workflows/test.yml/badge.svg)](https://github.com/krotname/rf-credential-relationships/actions/workflows/test.yml)
[![API](https://github.com/krotname/rf-credential-relationships/actions/workflows/pages.yml/badge.svg)](https://krotname.github.io/rf-credential-relationships/)
[![Release](https://img.shields.io/github/v/release/krotname/rf-credential-relationships)](https://github.com/krotname/rf-credential-relationships/releases/latest)
[![Weekly release](https://github.com/krotname/rf-credential-relationships/actions/workflows/weekly-release.yml/badge.svg)](https://github.com/krotname/rf-credential-relationships/actions/workflows/weekly-release.yml)
[![CodeQL](https://github.com/krotname/rf-credential-relationships/actions/workflows/codeql.yml/badge.svg)](https://github.com/krotname/rf-credential-relationships/actions/workflows/codeql.yml)
[![Downloads](https://img.shields.io/github/downloads/krotname/rf-credential-relationships/total)](https://github.com/krotname/rf-credential-relationships/releases)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

Публичный проверяемый набор связей между российскими сайтами и приложениями. Он помогает менеджерам паролей находить общий аккаунт на официально связанных доменах, владельцам сервисов — проверять credential sharing и passkey, исследователям — отслеживать публичные границы доверия. Данные собираются из [Digital Asset Links](https://developers.google.com/digital-asset-links), Apple AASA и WebAuthn Related Origins — без догадок по брендам и редиректам.

**[Скачать данные и правила Vaultwarden](https://github.com/krotname/rf-credential-relationships/releases/latest)** · **[Read-only API](https://krotname.github.io/rf-credential-relationships/api/latest.json)** · **[Сообщить об ошибке](https://github.com/krotname/rf-credential-relationships/issues/new/choose)**

## Данные

Исходный снимок `v2.0.0` содержит 2 437 типизированных связей. Актуальные значения — в [последнем выпуске](https://github.com/krotname/rf-credential-relationships/releases/latest) и API:

| Тип | Количество | Что связывает |
|---|---:|---|
| `dal_web_credentials` | 1 571 | сайт ↔ сайт |
| `dal_android_credentials` | 252 | сайт → Android-приложение |
| `apple_webcredentials` | 459 | сайт → Apple-приложение |
| `webauthn_related_origin` | 155 | WebAuthn RP → другой origin |

TXT исходного снимка содержит 54 группы (230 доменов) для Vaultwarden. Он объединяет взаимные DAL-связи сайтов и записи каталога Apple shared credentials, исключая группы, уже встроенные в Bitwarden. Связи с приложениями и WebAuthn остаются отдельными типизированными записями.

## Еженедельные выпуски

Каждое воскресенье в **06:17 МСК (03:17 UTC)** GitHub Actions собирает свежие публичные доказательства, проверяет данные и публикует следующий patch-релиз с JSON, TXT, доказательствами и SHA-256. Затем тот же конвейер обновляет GitHub Pages. Запуск не зависит от домашнего компьютера или Codex; GitHub может задержать старт по расписанию.

Неполный сбор блокирует публикацию, старый выпуск остаётся доступен. Ручной запуск: **Actions → Weekly release → Run workflow**. [Устройство конвейера и восстановление](docs/releases.md)

## Использование

```bash
curl -fsSL https://krotname.github.io/rf-credential-relationships/api/latest.json
```

`latest.json` указывает на неизменяемую версию, JSON Schema, полный набор, фильтры по типам и delta к предыдущему выпуску. [Описание API](docs/api.md)

Google Password Manager не импортирует внешние списки эквивалентных доменов. В Chrome готовые группы можно применять через расширение Bitwarden/Vaultwarden и его **Account settings → Domain rules**; нативные DAL и WebAuthn-связи Chrome получает непосредственно с сайтов.

Для собственного сканирования нужны Node.js 20+ и PowerShell 7:

```powershell
npm ci
.\run-rf-scan.ps1 -Source majestic -Limit 1000000 -Concurrency 400 -MaxDiscovered 100000
npm test
```

Результаты и возобновляемый кэш сохраняются в `out/` и не попадают в Git. Все параметры: `node collect-rf-equivalent-domains.mjs --help`.

## Границы доверия

- Каждая запись содержит источник доказательства и время наблюдения.
- Эквивалентность веб-доменов требует взаимного DAL `get_login_creds`.
- Android-связь включает опубликованный сайтом SHA-256 сертификата.
- AASA подтверждает декларацию сайта, но не entitlement внутри приложения.
- Debug-, test- и prerelease-пакеты исключаются.

Полные правила отбора описаны в [методологии](docs/methodology.md). Ошибки и дополнения принимаются через [issues](https://github.com/krotname/rf-credential-relationships/issues) и pull request; порядок проверки — в [CONTRIBUTING.md](CONTRIBUTING.md).
