# Правила российских доменов для Vaultwarden

[Готовый TXT](data/vaultwarden-equivalent-domains.txt) содержит проверенные пользовательские группы эквивалентных доменов. Одна строка — одна группа для «Настройки → Правила домена».

## Полный прогон

```powershell
git clone https://github.com/krotname/rf-vaultwarden-domain-rules.git
Set-Location .\rf-vaultwarden-domain-rules
.\run-rf-scan.ps1 -Source majestic -Limit 1000000 -Concurrency 100 -MaxDiscovered 100000
npm test
```

Результаты и возобновляемый кэш создаются в игнорируемом каталоге `out/`. Все параметры доступны через `node collect-rf-equivalent-domains.mjs --help`.

## Критерии включения

- Веб-домены связываются только при взаимных `delegate_permission/common.get_login_creds` на точных базовых доменах.
- Android-пакет требует опубликованный сайтом SHA-256 отпечаток сертификата.
- Поддоменные расширения и prerelease/debug/test-пакеты исключаются.
- Группы, уже покрытые глобальными правилами Bitwarden, не дублируются.

Снимок от 5 сентября 2026 года: весь доступный Majestic Million — 29 926 доменов `.ru`, `.su`, `.рф` и 79 связанных origins; 30 005 проверок, 54 группы, 230 элементов.
