$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'run-rf-scan.ps1'
$command = Get-Command -Name $scriptPath -CommandType ExternalScript
$range = $command.Parameters['Concurrency'].Attributes |
    Where-Object { $_ -is [System.Management.Automation.ValidateRangeAttribute] } |
    Select-Object -First 1

if (-not $range -or $range.MinRange -ne 1 -or $range.MaxRange -ne 400) {
    throw 'Concurrency wrapper range must match the collector range 1..400.'
}

$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
    $scriptPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count) {
    throw ($parseErrors | Out-String)
}

Write-Output 'PowerShell wrapper validated: Concurrency 1..400'
