# Связи российских доменов и приложений

[Готовый TXT](data/vaultwarden-equivalent-domains.txt) содержит проверенные пользовательские группы эквивалентных доменов. Одна строка — одна группа для «Настройки → Правила домена».

## Полный прогон

```powershell
git clone https://github.com/krotname/rf-vaultwarden-domain-rules.git
Set-Location .\rf-vaultwarden-domain-rules
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
