[CmdletBinding()]
param(
    [ValidateSet('majestic', 'cloudflare', 'file')]
    [string]$Source = 'majestic',
    [ValidateRange(1, 1000000)]
    [int]$Limit = 1000,
    [ValidateRange(1, 400)]
    [int]$Concurrency = 20,
    [ValidateRange(-1, 100000)]
    [int]$MaxDiscovered = -1,
    [string]$InputFile,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'out'),
    [switch]$CheckWww,
    [switch]$SkipAssociations,
    [switch]$Refresh
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js 20 или новее не найден.'
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\tldts'))) {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci завершился с кодом $LASTEXITCODE" }
}

$nodeArguments = @(
    (Join-Path $PSScriptRoot 'collect-rf-equivalent-domains.mjs'),
    '--source', $Source,
    '--limit', $Limit,
    '--concurrency', $Concurrency,
    '--out', $OutputDirectory
)
if ($InputFile) { $nodeArguments += @('--input', $InputFile) }
if ($MaxDiscovered -ge 0) { $nodeArguments += @('--max-discovered', $MaxDiscovered) }
if ($CheckWww) { $nodeArguments += '--check-www' }
if ($SkipAssociations) { $nodeArguments += '--no-associations' }
if ($Refresh) { $nodeArguments += '--refresh' }

& node @nodeArguments
exit $LASTEXITCODE
