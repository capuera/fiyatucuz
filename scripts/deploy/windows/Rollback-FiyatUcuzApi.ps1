#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Manual APPLICATION rollback of the FiyatUcuz API (ADIM 15A-4, ADR-0021).

.DESCRIPTION
  Points the 'current' junction back at the release in current.prev (or,
  only with -ToLegacy, at the legacy C:\FiyatUcuz\app directory), restarts
  FiyatUcuzApi and verifies local health and the listener.

  Every check (release id, seal, api.env policy, service identity, junction
  plan) runs BEFORE the service is stopped.

  The DATABASE IS NEVER ROLLED BACK. This script cannot know which
  migrations a failed deployment applied, so a successful run always reports
  ROLLED_BACK_APP_ONLY with an explicit "DB NOT ROLLED BACK" note (see
  ADR-0021); the deployment receipt of the failed run holds the migration
  detail. Restoring a database backup is a separate, manual decision.

  STATUS: tooling only. NOT VERIFIED ON WINDOWS (ADIM 15A-7) and NOT approved
  for production (ADIM 15A-P).
#>
param(
    [string]$Root = 'C:\FiyatUcuz',
    [Parameter(Mandatory = $true)][string]$ToolsRoot,
    [string]$ToReleaseId,
    [string]$SealSha256,
    [switch]$ToLegacy,
    [string]$Reason = 'manual rollback'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FiyatUcuz.Deploy.psm1') -Force

$layout = Get-FiyatUcuzLayout -Root $Root -ToolsRoot $ToolsRoot
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$receiptPath = Join-Path $layout.Deployments "$stamp-rollback.json"
$secretEnvs = "$($layout.ApiEnv),$($layout.MigrationEnv)"
$dbNote = 'DB NOT ROLLED BACK: application-only rollback. This tool never reverts migrations; any migration applied by the failed deployment remains applied (see that deployment''s receipt). Database restore is a separate manual decision.'

function Invoke-Cli {
    param([string[]]$Arguments)
    return Invoke-FiyatUcuzNode -Layout $layout -Arguments $Arguments
}

function Update-Receipt {
    param([hashtable]$Patch, [string]$PhaseName, [string]$Result)
    $patchFile = Save-FiyatUcuzJson -Layout $layout -Value $Patch -Name 'receipt-patch'
    $r = Invoke-Cli -Arguments @($layout.DeployCli, 'receipt-update', '--file', $receiptPath, '--patch', $patchFile,
        '--phase', $PhaseName, '--result', $Result, '--secret-env', $secretEnvs)
    if ($r.ExitCode -ne 0) { throw 'receipt update failed' }
}

function Write-ReceiptBestEffort {
    param([hashtable]$Patch, [string]$PhaseName, [string]$Result)
    try { Update-Receipt -Patch $Patch -PhaseName $PhaseName -Result $Result; return $true }
    catch { Write-Warning "receipt could not record phase '$PhaseName'"; return $false }
}

function Stop-Rollback {
    param([string]$Status, [string]$Message, [int]$Code = 1)
    $null = Write-ReceiptBestEffort -Patch @{ status = $Status; databaseNote = $dbNote; junctions = @{ after = (Get-ActivationSnapshot -Layout $layout) } } -PhaseName 'final' -Result $Message
    Write-Output "ROLLBACK $Status - $Message"
    Write-Output $dbNote
    exit $Code
}

# --- read-only checks: nothing is changed if any of these fail ----------------
try {
    if ([bool]$ToReleaseId -eq [bool]$ToLegacy) { throw 'specify exactly one of -ToReleaseId or -ToLegacy' }
    Assert-FiyatUcuzService -Layout $layout | Out-Null
    $envCheck = Invoke-Cli -Arguments @($layout.DeployCli, 'validate-api-env', '--file', $layout.ApiEnv, '--root', $layout.Root)
    if ($envCheck.ExitCode -ne 0) { throw 'api.env policy check failed' }

    if ($ToLegacy) {
        # Explicit only. The legacy directory has no seal and is never treated as a release.
        $to = $layout.LegacyApp
        if (-not (Test-Path -LiteralPath $to -PathType Container)) { throw 'legacy app directory not found' }
    } else {
        if ($ToReleaseId -cnotmatch '^\d{8}-[0-9a-f]{12}$') { throw 'invalid release id' }
        if ($SealSha256 -and $SealSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'invalid -SealSha256' }
        $to = Join-Path $layout.Releases $ToReleaseId
        $verifyArgs = @($layout.ReleaseCli, 'verify', '--release', $to, '--stage', 'sealed', '--seal', "$to.seal.json")
        if ($SealSha256) { $verifyArgs += @('--seal-sha256', $SealSha256) }
        if ((Invoke-Cli -Arguments $verifyArgs).ExitCode -ne 0) { throw 'target release failed seal verification' }
    }

    $plan = Test-RollbackPrecheck -Layout $layout -To $to -AllowLegacy:$ToLegacy
    if ($plan.ExitCode -ne 0) {
        $errs = @(Get-OptionalProperty -Object $plan.Result -Name 'errors') | Where-Object { $_ }
        throw "junction state does not allow this rollback: $($errs -join '; ')"
    }
} catch {
    Write-Output "ROLLBACK FAILED_NO_CHANGE - $($_.Exception.Message)"
    exit 1
}

$before = Get-ActivationSnapshot -Layout $layout
$init = @{
    deploymentId = "$stamp-rollback"; host = $env:COMPUTERNAME; operator = $env:USERNAME
    releaseId = $ToReleaseId; previousRelease = [string]$before['current'].target
    tool = @{ phase = 'Rollback'; reason = $Reason; toLegacy = [bool]$ToLegacy }
}
$initFile = Save-FiyatUcuzJson -Layout $layout -Value $init -Name 'receipt-init'
$r = Invoke-Cli -Arguments @($layout.DeployCli, 'receipt-init', '--file', $receiptPath, '--init', $initFile, '--secret-env', $secretEnvs)
if ($r.ExitCode -ne 0) { Write-Output 'ROLLBACK FAILED_NO_CHANGE - receipt could not be written; nothing was changed'; exit 1 }

try {
    Update-Receipt -Patch @{ junctions = @{ before = $before }; service = @{ before = (Get-FiyatUcuzServiceStatus) } } -PhaseName 'stop' -Result 'stopping FiyatUcuzApi'
} catch {
    Write-Output 'ROLLBACK FAILED_NO_CHANGE - receipt could not be updated before stopping; nothing was changed'
    exit 1
}

# --- mutations: from here on safety wins; receipt writes are best effort -------
try {
    Stop-FiyatUcuzApi -TimeoutSec 60
} catch {
    Stop-Rollback -Status 'CRITICAL_OPERATOR_ACTION' -Message $_.Exception.Message
}

try {
    $steps = Invoke-ActivationSteps -Layout $layout -RollbackTo $to -AllowLegacy:$ToLegacy
    if (-not $steps.ok) { throw "junction plan refused: $($steps.reason)" }
    Start-FiyatUcuzApi -TimeoutSec 30
    $h = Invoke-Cli -Arguments @($layout.DeployCli, 'health', '--timeout-sec', '90', '--interval-sec', '2')
    $listenerFile = Save-FiyatUcuzJson -Layout $layout -Value (Get-ListenerSnapshot) -Name 'listener'
    $l = Invoke-Cli -Arguments @($layout.DeployCli, 'check-listeners', '--snapshot', $listenerFile)
    if ($h.ExitCode -ne 0 -or $l.ExitCode -ne 0) { throw 'health or listener verification failed after rollback' }
    $null = Write-ReceiptBestEffort -Patch @{ health = @{ local = $h.Result; external = 'operator-to-check-from-outside' }; listener = $l.Result; service = @{ after = (Get-FiyatUcuzServiceStatus) } } -PhaseName 'verify' -Result 'healthy'
} catch {
    Stop-Rollback -Status 'CRITICAL_OPERATOR_ACTION' -Message $_.Exception.Message
}

Stop-Rollback -Status 'ROLLED_BACK_APP_ONLY' -Message "application restored to $to" -Code 0
