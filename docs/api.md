# Read-only API

GitHub Pages публикует статический API без авторизации, backend и изменяемого состояния. Точка входа:

```text
https://krotname.github.io/rf-credential-relationships/api/latest.json
```

## Представления

| Поле `latest.json` | Содержимое |
|---|---|
| `manifest` | Метаданные и SHA-256 всех файлов выпуска |
| `schema` | JSON Schema полного набора |
| `dataset` | Все типизированные связи |
| `types` | Четыре предсобранных фильтра |
| `delta` | Добавленные и удалённые связи |
| `releaseAssets` | Исходные assets GitHub Release |

Пример загрузки одного типа:

```bash
LATEST=https://krotname.github.io/rf-credential-relationships/api/latest.json
URL=$(curl -fsSL "$LATEST" | jq -r '.types["dal-android"]')
curl -fsSL "$URL" | jq '.statistics'
```

```powershell
$latest = Invoke-RestMethod 'https://krotname.github.io/rf-credential-relationships/api/latest.json'
$android = Invoke-RestMethod $latest.types.'dal-android'
$android.statistics
```

## Версии и целостность

- Версия набора следует SemVer и входит в URL: `/api/vX.Y.Z/`.
- Опубликованные versioned-файлы неизменяемы; `latest.json` переключается на новый выпуск.
- Манифест содержит SHA-256 набора, фильтров и delta.
- JSON валидируется схемами из `/api/schema/` до публикации.
- Delta строится по точным объектам относительно предыдущего поддерживаемого выпуска.
- Еженедельные выпуски хранят полный индекс версий в asset `releases.json`; Pages загружает последний опубликованный индекс. [Конвейер выпусков](releases.md)

У первого выпуска `fromVersion: null` и `bootstrap: true`: весь набор находится в `added`. Потребителю, которому нужна воспроизводимость, следует закрепить versioned URL и проверять SHA-256 из манифеста.

## Типы связей

| Фильтр | `type` |
|---|---|
| `dal-web` | `dal_web_credentials` |
| `dal-android` | `dal_android_credentials` |
| `aasa-webcredentials` | `apple_webcredentials` |
| `webauthn-related-origins` | `webauthn_related_origin` |

Общие поля записи: `type`, `source`, `target`, `evidenceUrl`, `observedAt`. DAL web дополнительно содержит `reciprocal`, DAL Android — `fingerprints`.
