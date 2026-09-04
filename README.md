# Сборщик правил доменов РФ для Vaultwarden

Установка и запуск из PowerShell:

```powershell
git clone https://github.com/krotname/rf-vaultwarden-domain-rules.git
Set-Location .\rf-vaultwarden-domain-rules
.\run-rf-scan.ps1 -Limit 5000
Get-Content .\out\vaultwarden-equivalent-domains.txt | Set-Clipboard
```

Вставлять нужно по одной строке через «Настройки → Правила домена → Новый пользовательский домен». Основной файл содержит только пользовательские группы, которых целиком ещё нет в глобальных правилах Bitwarden.

`-Limit 5000` означает ровно 5000 доменов и не более 5000 HTTPS-запросов. Дополнительную взаимную проверку доменов вне топа включайте явно: `-MaxDiscovered 500`. Глубокая проверка `www` тоже включается отдельно: `-CheckWww`.

При стандартном запуске связи с доменами вне исходного топа остаются в `evidence.json` как односторонние и не попадают в готовые правила.

## Что считается доказательством

- Рейтинг даёт только список сайтов для проверки и сам по себе ничего не связывает.
- Веб-домены объединяются лишь при взаимных `delegate_permission/common.get_login_creds` в живых `/.well-known/assetlinks.json`.
- Android-пакет включается по опубликованному HTTPS-сайтом объявлению с SHA-256 отпечатком сертификата приложения.
- Пакеты с `debug`, `beta`, `test`, `qa`, `stage`, `demo` и похожими маркерами отбрасываются.
- Официальные списки Bitwarden и Apple используются для сверки; направленные миграции Apple `from/to` не превращаются в симметричные правила.

## Источники рейтинга

Без токена, по умолчанию — Majestic Million с фильтром `.ru`, `.su`, `.рф`:

```powershell
.\run-rf-scan.ps1 -Source majestic -Limit 10000
```

Географический топ Cloudflare Radar для России:

```powershell
$env:CLOUDFLARE_API_TOKEN = '<токен с User Details Read>'
.\run-rf-scan.ps1 -Source cloudflare -Limit 5000
```

Свой TXT/CSV/JSON со столбцом `domain`:

```powershell
.\run-rf-scan.ps1 -Source file -InputFile "C:\путь\domains.csv" -Limit 5000
```

## Результаты

- `data/vaultwarden-equivalent-domains.txt` — опубликованный проверенный снимок для топ‑5000.
- `out/vaultwarden-equivalent-domains.txt` — строки для ручной вставки.
- `out/vaultwarden-equivalent-domains.json` — те же группы в JSON.
- `out/evidence.json` — источники, взаимные связи, отклонённые пакеты и статистика.
- `out/assetlinks-cache.json` — кэш для быстрого продолжения; `-Refresh` перепроверяет сеть.

Скрипт ничего не меняет в Vaultwarden и не хранит токены. Cloudflare-токен читается только из указанной переменной окружения.

## Опубликованный снимок

Текущий снимок получен 4 сентября 2026 года: 5000 доменов Majestic Million и 78 связанных origins, 29 готовых групп. Локальные кэши и токены в репозиторий не входят.
