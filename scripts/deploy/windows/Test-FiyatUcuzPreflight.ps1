#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Read-only preflight for a FiyatUcuz API deployment (ADIM 15A-4, ADR-0021).

.DESCRIPTION
  Checks layout, portable Node/pnpm, the FiyatUcuzApi service identity, the
  API and migration env files (keys only; values are never printed), the
  static ACL model, free disk space and the activation junction state.
  Changes nothing except writing snapshot JSON under staging\work\snapshots.

  STATUS: tooling only. NOT VERIFIED ON WINDOWS (ADIM 15A-7) and NOT approved
  for production (ADIM 15A-P).
#>
param(
    [string]$Root = 'C:\FiyatUcuz',
    [Parameter(Mandatory = $true)][string]$ToolsRoot,
    [string]$Manifest,
    # Prepare never touches the activation junctions: report their state only.
    [switch]$ForPrepare
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FiyatUcuz.Deploy.psm1') -Force

$layout = Get-FiyatUcuzLayout -Root $Root -ToolsRoot $ToolsRoot
$failures = New-Object System.Collections.Generic.List[string]

function Add-Check {
    param([string]$Name, [bool]$Ok, [string]$Detail)
    $mark = 'FAIL'
    if ($Ok) { $mark = 'OK  ' }
    Write-Output ("[{0}] {1}{2}" -f $mark, $Name, $(if ($Detail) { " - $Detail" } else { '' }))
    if (-not $Ok) { $failures.Add($Name) }
}

function Add-NodeCheck {
    param([string]$Name, [string[]]$Arguments)
    $r = Invoke-FiyatUcuzNode -Layout $layout -Arguments $Arguments
    $errors = @(Get-OptionalProperty -Object $r.Result -Name 'errors')
    Add-Check -Name $Name -Ok ($r.ExitCode -eq 0) -Detail (($errors | Where-Object { $_ }) -join '; ')
}

foreach ($p in @($layout.Releases, $layout.Config, $layout.Runtime, $layout.Staging, $layout.Deployments, $layout.FeedArchive, $layout.LogsApi)) {
    Add-Check -Name "directory $p" -Ok (Test-Path -LiteralPath $p -PathType Container) -Detail ''
}
foreach ($p in @($layout.Node, $layout.PnpmCli, $layout.WinSW, $layout.ApiEnv, $layout.MigrationEnv, $layout.Tar, $layout.DeployCli, $layout.ReleaseCli)) {
    Add-Check -Name "file $p" -Ok (Test-Path -LiteralPath $p -PathType Leaf) -Detail ''
}
if ($failures.Count -gt 0) { Write-Output 'PREFLIGHT FAILED (layout)'; exit 1 }

$nodeVersion = (& $layout.Node --version).Trim()
$pnpmVersion = (& $layout.Node $layout.PnpmCli --version).Trim()
Add-Check -Name 'portable node' -Ok ($nodeVersion -match '^v22\.') -Detail $nodeVersion
Add-Check -Name 'portable pnpm' -Ok ($pnpmVersion -eq '9.15.4') -Detail $pnpmVersion
if ($Manifest) {
    Add-NodeCheck -Name 'runtime vs manifest' -Arguments @($layout.DeployCli, 'check-runtime', '--manifest', $Manifest, '--node-version', $nodeVersion, '--pnpm-version', $pnpmVersion)
}

try { Assert-FiyatUcuzService -Layout $layout | Out-Null; Add-Check -Name 'service identity FiyatUcuzApi' -Ok $true -Detail '' }
catch { Add-Check -Name 'service identity FiyatUcuzApi' -Ok $false -Detail $_.Exception.Message }

Add-NodeCheck -Name 'api.env policy' -Arguments @($layout.DeployCli, 'validate-api-env', '--file', $layout.ApiEnv, '--root', $layout.Root)
Add-NodeCheck -Name 'migration.env policy' -Arguments @($layout.DeployCli, 'validate-migration-env', '--file', $layout.MigrationEnv)

$aclFile = Save-FiyatUcuzJson -Layout $layout -Value (Get-AclSnapshot -Layout $layout) -Name 'acl'
Add-NodeCheck -Name 'ACL model (static)' -Arguments @($layout.DeployCli, 'check-acl', '--snapshot', $aclFile, '--root', $layout.Root)

Add-NodeCheck -Name 'free disk >= 5 GiB' -Arguments @($layout.DeployCli, 'check-disk', '--free-bytes', [string](Get-FreeBytes -Root $layout.Root))

$snap = Get-ActivationSnapshot -Layout $layout
foreach ($n in @('current', 'current.next', 'current.prev', 'current.failed')) {
    $e = $snap[$n]
    Write-Output ("       {0}: exists={1} junction={2} target={3}" -f $n, $e.exists, $e.isJunction, $e.target)
}
if (-not $ForPrepare) {
    Add-Check -Name 'current is a junction' -Ok ($snap['current'].exists -and $snap['current'].isJunction) -Detail ''
    Add-Check -Name 'no leftover current.next' -Ok (-not $snap['current.next'].exists) -Detail ''
}

if ($failures.Count -gt 0) {
    Write-Output ("PREFLIGHT FAILED ({0} check(s))" -f $failures.Count)
    exit 1
}
Write-Output 'PREFLIGHT OK'
exit 0
