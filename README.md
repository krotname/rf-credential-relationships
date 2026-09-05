# Связи российских доменов и приложений

[Готовый TXT](data/vaultwarden-equivalent-domains.txt) содержит проверенные пользовательские группы эквивалентных доменов. Одна строка — одна группа для «Настройки → Правила домена».

## Полный прогон

```powershell
git clone https://github.com/krotname/rf-credential-relationships.git
Set-Location .\rf-credential-relationships
.\run-rf-scan.ps1 -Source majestic -Limit 1000000 -Concurrency 400 -MaxDiscovered 100000
npm test
```

Результаты и возобновляемый кэш создаются в игнорируемом каталоге `out/`. `relationships.json` разделяет Digital Asset Links, Apple AASA и WebAuthn Related Origins; он не расширяет Vaultwarden-группы связями другого типа. Быстрый запуск только прежнего DAL-анализа: `-SkipAssociations`.

## Критерии включения

- Веб-домены связываются только при взаимных `delegate_permission/common.get_login_creds` на точных базовых доменах.
- Android-пакет требует опубликованный сайтом SHA-256 отпечаток сертификата.
- Поддоменные расширения и prerelease/debug/test-пакеты исключаются.
- Группы, уже покрытые глобальными правилами Bitwarden, не дублируются.
- Apple `webcredentials` и WebAuthn related origins публикуются только как отдельные типизированные связи.

Подробные `relationships.json` и `evidence.json` публикуются как assets релиза; кэши и сетевые логи в Git не входят. Все параметры доступны через `node collect-rf-equivalent-domains.mjs --help`.

## Типы связей

| `type` | Источник | Назначение |
|---|---|---|
| `dal_web_credentials` | Android Digital Asset Links | Веб-origin → веб-origin; взаимность в `reciprocal` |
| `dal_android_credentials` | Android Digital Asset Links | Веб-origin → Android package + сертификаты |
| `apple_webcredentials` | Apple AASA | Веб-origin → Apple Team ID + bundle ID |
| `webauthn_related_origin` | WebAuthn Related Origin Requests | RP origin → связанный HTTPS-origin |

Каждая запись содержит `source`, `target`, `evidenceUrl` и `observedAt`. Для DAL web дополнительно сохраняется признак `reciprocal`, для Android — все опубликованные SHA-256 отпечатки. Формат версионирован полем `schemaVersion` и подходит для импорта в другие менеджеры паролей, аудиторов passkey и каталоги приложений.

Связь Apple подтверждает опубликованное сайтом AASA-объявление, но не закрытое entitlement внутри приложения. Потребители должны учитывать тип и направление связи, а для эквивалентности веб-доменов использовать только взаимный DAL (`reciprocal: true`).

Снимок от 5 сентября 2026 года: весь доступный Majestic Million — 29 926 доменов `.ru`, `.su`, `.рф` и 79 связанных origins; 30 005 проверок DAL, 54 Vaultwarden-группы, 230 элементов. Дополнительно проверено по 30 005 AASA и WebAuthn endpoint и опубликовано 2 437 типизированных связей: 1 571 DAL web, 252 Android, 459 Apple и 155 WebAuthn.

## Статический API

Read-only API публикуется на GitHub Pages без backend, авторизации и секретов. Стабильная точка входа — [`latest.json`](https://krotname.github.io/rf-credential-relationships/api/latest.json); она указывает на неизменяемый каталог версии, JSON Schema, полный dataset, четыре предсобранных фильтра и delta.

| Представление | URL |
|---|---|
| Последняя версия | `https://krotname.github.io/rf-credential-relationships/api/latest.json` |
| Манифест v2.0.0 | `https://krotname.github.io/rf-credential-relationships/api/v2.0.0/manifest.json` |
| Все связи | `https://krotname.github.io/rf-credential-relationships/api/v2.0.0/relationships.json` |
| DAL web | `https://krotname.github.io/rf-credential-relationships/api/v2.0.0/types/dal-web.json` |
| DAL Android | `https://krotname.github.io/rf-credential-relationships/api/v2.0.0/types/dal-android.json` |
| Apple AASA | `https://krotname.github.io/rf-credential-relationships/api/v2.0.0/types/aasa-webcredentials.json` |
| WebAuthn | `https://krotname.github.io/rf-credential-relationships/api/v2.0.0/types/webauthn-related-origins.json` |
| Delta | `https://krotname.github.io/rf-credential-relationships/api/v2.0.0/delta-from-previous.json` |
| JSON Schema | `https://krotname.github.io/rf-credential-relationships/api/schema/relationships-v1.schema.json` |

```bash
curl -fsSL https://krotname.github.io/rf-credential-relationships/api/latest.json | jq '{version,dataset,types,delta}'
curl -fsSL https://krotname.github.io/rf-credential-relationships/api/v2.0.0/types/dal-web.json | jq '.statistics'
```

```powershell
$latest = Invoke-RestMethod 'https://krotname.github.io/rf-credential-relationships/api/latest.json'
$dalAndroid = Invoke-RestMethod $latest.types.'dal-android'
$dalAndroid.statistics
```

Версия в URL следует SemVer версии набора данных. Файлы внутри уже опубликованного `vX.Y.Z` не меняются; `latest.json` переключается только на новый проверенный выпуск. Добавление полей совместимо в пределах текущей JSON Schema, удаление/переименование полей или изменение их смысла требует новой major-версии schema/API.

Для первого поддерживаемого выпуска delta имеет `fromVersion: null`, `bootstrap: true` и `baseline: "empty"`: все текущие связи находятся в `added`, а `removed` пуст. Начиная со второго выпуска delta сравнивает точные объекты с предыдущей поддерживаемой версией. Производные JSON не хранятся в Git: workflow скачивает immutable release asset, проверяет SHA-256, строит endpoints и валидирует их схемами перед публикацией.

SHA-256 каждого versioned API artifact закреплён в `api/releases.json`: обычная сборка завершается ошибкой при любом изменении ранее опубликованных байтов. Для нового выпуска сначала получают кандидаты locks командой `npm run build:api -- --no-verify-locks --print-locks`, затем проверяют и добавляют их в release config; CI всегда запускает сборку с обязательной проверкой locks. Валидатор независимо пересчитывает bootstrap или точную разницу с соседним dataset и не доверяет самозаявленным delta-счётчикам.
