#Requires -Version 5.1
# FiyatUcuz Windows deployment module (ADIM 15A-4, ADR-0021).
#
# Windows PowerShell 5.1. This module gathers Windows facts (service, junctions,
# ACLs, TCP listeners) and executes ONE step at a time; every decision comes
# from scripts/deploy/deploy-cli.mjs (tested in Node).
#
# Hard rules:
#   - The ONLY service ever touched is FiyatUcuzApi (fixed, not a parameter).
#   - Materialized releases (releases\<id>) are never renamed or moved; only
#     the activation junctions are created / renamed / removed.
#   - Activation junctions are removed with a non-recursive directory delete
#     after verifying they are reparse points; never with a recursive delete.
#   - No process is ever force-killed; stop timeouts abort the deployment.
#
# NOT VERIFIED ON WINDOWS YET (ADIM 15A-7): junction semantics, Get-Item
# LinkType/Target, Get-NetTCPConnection, WinSW stop behaviour, PS 5.1 runtime.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ServiceName = 'FiyatUcuzApi'
$script:ServiceAccount = 'NT AUTHORITY\LocalService'
$script:ServiceFilter = "Name='FiyatUcuzApi'"
$script:ActivationNames = @('current', 'current.next', 'current.prev', 'current.failed')
$script:ApiPort = 4000

function Get-OptionalProperty {
    param([object]$Object, [Parameter(Mandatory = $true)][string]$Name)
    if ($null -eq $Object) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

function Get-FiyatUcuzLayout {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$ToolsRoot
    )
    return @{
        Root          = $Root
        Releases      = Join-Path $Root 'releases'
        LegacyApp     = Join-Path $Root 'app'
        Config        = Join-Path $Root 'config'
        ApiEnv        = Join-Path $Root 'config\api.env'
        MigrationEnv  = Join-Path $Root 'config\migration.env'
        FeedArchive   = Join-Path $Root 'data\feed-archive'
        LogsApi       = Join-Path $Root 'logs\api'
        Runtime       = Join-Path $Root 'runtime'
        Node          = Join-Path $Root 'runtime\node22\node.exe'
        PnpmCli       = Join-Path $Root 'runtime\pnpm\9.15.4\bin\pnpm.cjs'
        WinSW         = Join-Path $Root 'runtime\service\FiyatUcuzApi.exe'
        Staging       = Join-Path $Root 'staging'
        Store         = Join-Path $Root 'staging\pnpm-store'
        Work          = Join-Path $Root 'staging\work'
        Backups       = Join-Path $Root 'staging\db-backups'
        Deployments   = Join-Path $Root 'deployments'
        Tar           = Join-Path $env:SystemRoot 'System32\tar.exe'
        ReleaseCli    = Join-Path $ToolsRoot 'scripts\release\api-release.mjs'
        DeployCli     = Join-Path $ToolsRoot 'scripts\deploy\deploy-cli.mjs'
    }
}

# Run a Node CLI with an argument ARRAY (no shell, no string interpolation).
# The CLIs print one JSON object; values of env files are never in it.
function Invoke-FiyatUcuzNode {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Layout,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $output = @(& $Layout.Node @Arguments)
    $code = $LASTEXITCODE
    $parsed = $null
    if ($output.Count -gt 0) {
        # Whole output first (pretty-printed JSON), then the last line.
        try { $parsed = (($output -join "`n") | ConvertFrom-Json) } catch { $parsed = $null }
        if ($null -eq $parsed) {
            try { $parsed = ($output[$output.Count - 1] | ConvertFrom-Json) } catch { $parsed = $null }
        }
    }
    return [pscustomobject]@{ ExitCode = $code; Result = $parsed; Lines = $output }
}

function Save-FiyatUcuzJson {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Layout,
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $dir = Join-Path $Layout.Work 'snapshots'
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $file = Join-Path $dir ("{0}-{1}.json" -f $Name, [Guid]::NewGuid().ToString('N'))
    $json = ConvertTo-Json -InputObject $Value -Depth 8
    [System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding $false))
    return $file
}

# ---------------------------------------------------------------------------
# Service identity + control (FiyatUcuzApi only)
# ---------------------------------------------------------------------------

function Get-FiyatUcuzServiceInfo {
    $svc = @(Get-CimInstance -ClassName Win32_Service -Filter $script:ServiceFilter)
    if ($svc.Count -ne 1) { throw "service $($script:ServiceName) must exist exactly once (found $($svc.Count))" }
    return $svc[0]
}

function Assert-FiyatUcuzService {
    param([Parameter(Mandatory = $true)][hashtable]$Layout)
    $s = Get-FiyatUcuzServiceInfo
    if ($s.Name -cne $script:ServiceName) { throw 'service name mismatch' }
    $path = ([string]$s.PathName).Trim()
    if ($path.StartsWith('"')) { $path = $path.Substring(1, $path.IndexOf('"', 1) - 1) }
    if (-not [string]::Equals($path, $Layout.WinSW, [StringComparison]::OrdinalIgnoreCase)) {
        throw "service executable is not the expected WinSW wrapper ($($Layout.WinSW))"
    }
    if (-not [string]::Equals([string]$s.StartName, $script:ServiceAccount, [StringComparison]::OrdinalIgnoreCase)) {
        throw "service account must be $($script:ServiceAccount)"
    }
    return $s
}

function Stop-FiyatUcuzApi {
    param([int]$TimeoutSec = 60)
    $svc = Get-Service -Name $script:ServiceName
    if ($svc.Status -eq 'Stopped') { return }
    Stop-Service -Name $script:ServiceName -NoWait
    try {
        $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds($TimeoutSec))
    } catch {
        # No force-kill of any process: the operator decides.
        throw "FiyatUcuzApi did not stop within $TimeoutSec s; activation aborted (no process was killed)"
    }
}

function Start-FiyatUcuzApi {
    param([int]$TimeoutSec = 30)
    $svc = Get-Service -Name $script:ServiceName
    if ($svc.Status -eq 'Running') { return }
    Start-Service -Name $script:ServiceName
    try {
        $svc.WaitForStatus('Running', [TimeSpan]::FromSeconds($TimeoutSec))
    } catch {
        throw "FiyatUcuzApi did not reach Running within $TimeoutSec s"
    }
}

function Assert-FiyatUcuzServiceStopped {
    $svc = Get-Service -Name $script:ServiceName
    if ($svc.Status -ne 'Stopped') { throw 'FiyatUcuzApi must be stopped before renaming activation junctions' }
}

function Get-FiyatUcuzServiceStatus {
    return [string](Get-Service -Name $script:ServiceName).Status
}

# ---------------------------------------------------------------------------
# Activation junctions
# ---------------------------------------------------------------------------

# Existence is read from the entry's own attributes, so a junction whose
# target is missing (dangling) is still reported as existing. Only "not
# found" means absent; any other error (e.g. access denied) is thrown.
function Get-ActivationEntry {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        $attrs = [System.IO.File]::GetAttributes($Path)
    } catch {
        $ex = $_.Exception
        if ($null -ne $ex.InnerException) { $ex = $ex.InnerException }
        if ($ex -is [System.IO.FileNotFoundException] -or $ex -is [System.IO.DirectoryNotFoundException]) {
            return @{ exists = $false; isJunction = $false; target = $null }
        }
        throw
    }
    $isJunction = $false
    $target = $null
    if (([int]$attrs -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        $item = Get-Item -LiteralPath $Path -Force
        $isJunction = ((Get-OptionalProperty -Object $item -Name 'LinkType') -eq 'Junction')
        if ($isJunction) { $target = @(Get-OptionalProperty -Object $item -Name 'Target')[0] }
    }
    return @{ exists = $true; isJunction = $isJunction; target = $target }
}

function Get-ActivationSnapshot {
    param([Parameter(Mandatory = $true)][hashtable]$Layout)
    $snap = @{}
    foreach ($n in $script:ActivationNames) { $snap[$n] = Get-ActivationEntry -Path (Join-Path $Layout.Root $n) }
    return $snap
}

function Assert-ActivationName {
    param([Parameter(Mandatory = $true)][string]$Name)
    if ($script:ActivationNames -notcontains $Name) { throw "'$Name' is not an activation junction name" }
}

function New-ActivationJunction {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Layout,
        [Parameter(Mandatory = $true)][string]$Target
    )
    $path = Join-Path $Layout.Root 'current.next'
    if ((Get-ActivationEntry -Path $path).exists) { throw 'current.next already exists' }
    $parent = Split-Path -Parent $Target
    if (-not [string]::Equals($parent, $Layout.Releases, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'junction target must be a release directory under releases\'
    }
    New-Item -ItemType Junction -Path $path -Target $Target | Out-Null
}

function Rename-ActivationJunction {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Layout,
        [Parameter(Mandatory = $true)][string]$From,
        [Parameter(Mandatory = $true)][string]$To
    )
    Assert-ActivationName -Name $From
    Assert-ActivationName -Name $To
    Assert-FiyatUcuzServiceStopped
    $fromPath = Join-Path $Layout.Root $From
    $toPath = Join-Path $Layout.Root $To
    $entry = Get-ActivationEntry -Path $fromPath
    if (-not $entry.isJunction) { throw "$From is not a junction; refusing to rename" }
    if ((Get-ActivationEntry -Path $toPath).exists) { throw "$To already exists; refusing to rename" }
    # Renames the junction itself (never the release directory it points to).
    Rename-Item -LiteralPath $fromPath -NewName $To
}

function Remove-ActivationJunction {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Layout,
        [Parameter(Mandatory = $true)][string]$Name,
        [switch]$AllowLegacy
    )
    Assert-ActivationName -Name $Name
    $snapFile = Save-FiyatUcuzJson -Layout $Layout -Value (Get-ActivationSnapshot -Layout $Layout) -Name 'junction'
    $checkArgs = @($Layout.DeployCli, 'check-junction-removal', '--snapshot', $snapFile, '--root', $Layout.Root, '--name', $Name)
    if ($AllowLegacy) { $checkArgs += @('--legacy', 'allow') }
    $check = Invoke-FiyatUcuzNode -Layout $Layout -Arguments $checkArgs
    if ($check.ExitCode -ne 0) { throw "refusing to remove $Name (not a verified activation junction)" }
    $path = Join-Path $Layout.Root $Name
    $item = Get-Item -LiteralPath $path -Force
    if (([int]$item.Attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -eq 0) {
        throw "$Name is not a reparse point; refusing to delete"
    }
    # Non-recursive: removes the junction entry only, never the target's files.
    [System.IO.Directory]::Delete($path, $false)
}

# One step at a time: snapshot -> plan (Node) -> execute -> repeat.
# Returns @{ ok; needsStop; reason; snapshot }.
function Invoke-ActivationSteps {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Layout,
        [string]$Target,
        [string]$RollbackTo,
        [switch]$AllowLegacy,
        [switch]$StopBeforeRename,
        [int]$MaxSteps = 8
    )
    for ($i = 0; $i -lt $MaxSteps; $i++) {
        $snap = Get-ActivationSnapshot -Layout $Layout
        $file = Save-FiyatUcuzJson -Layout $Layout -Value $snap -Name 'activation'
        $planArgs = @($Layout.DeployCli, 'plan-activation', '--snapshot', $file, '--root', $Layout.Root)
        if ($Target) { $planArgs += @('--target', $Target) } else { $planArgs += @('--rollback-to', $RollbackTo) }
        if ($AllowLegacy) { $planArgs += @('--legacy', 'allow') }
        $plan = (Invoke-FiyatUcuzNode -Layout $Layout -Arguments $planArgs).Result
        $op = Get-OptionalProperty -Object $plan -Name 'op'
        if ($op -eq 'done') { return @{ ok = $true; needsStop = $false; reason = $null; snapshot = $snap } }
        if ($op -eq 'abort' -or $null -eq $op) {
            return @{ ok = $false; needsStop = $false; reason = (Get-OptionalProperty -Object $plan -Name 'reason'); snapshot = $snap }
        }
        if ($op -eq 'createNext') {
            New-ActivationJunction -Layout $Layout -Target (Get-OptionalProperty -Object $plan -Name 'target')
        } elseif ($op -eq 'removeJunction') {
            Remove-ActivationJunction -Layout $Layout -Name (Get-OptionalProperty -Object $plan -Name 'name') -AllowLegacy:$AllowLegacy
        } elseif ($op -eq 'rename') {
            if ((Get-OptionalProperty -Object $plan -Name 'requiresServiceStopped') -and (Get-FiyatUcuzServiceStatus) -ne 'Stopped') {
                if ($StopBeforeRename) { return @{ ok = $true; needsStop = $true; reason = $null; snapshot = $snap } }
                throw 'rename requires FiyatUcuzApi to be stopped'
            }
            Rename-ActivationJunction -Layout $Layout -From (Get-OptionalProperty -Object $plan -Name 'from') -To (Get-OptionalProperty -Object $plan -Name 'to')
        } else {
            return @{ ok = $false; needsStop = $false; reason = "unknown plan op '$op'"; snapshot = $snap }
        }
    }
    return @{ ok = $false; needsStop = $false; reason = 'too many activation steps'; snapshot = (Get-ActivationSnapshot -Layout $Layout) }
}

# Read-only gates (no mutation): evaluated before migrations / before stopping.
function Test-ActivationPrecheck {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Layout,
        [Parameter(Mandatory = $true)][string]$Target
    )
    $file = Save-FiyatUcuzJson -Layout $Layout -Value (Get-ActivationSnapshot -Layout $Layout) -Name 'precheck'
    return Invoke-FiyatUcuzNode -Layout $Layout -Arguments @($Layout.DeployCli, 'precheck-activation', '--snapshot', $file,
        '--root', $Layout.Root, '--target', $Target)
}

function Test-RollbackPrecheck {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Layout,
        [Parameter(Mandatory = $true)][string]$To,
        [switch]$AllowLegacy
    )
    $file = Save-FiyatUcuzJson -Layout $Layout -Value (Get-ActivationSnapshot -Layout $Layout) -Name 'precheck'
    $a = @($Layout.DeployCli, 'precheck-rollback', '--snapshot', $file, '--root', $Layout.Root, '--to', $To)
    if ($AllowLegacy) { $a += @('--legacy', 'allow') }
    return Invoke-FiyatUcuzNode -Layout $Layout -Arguments $a
}

# Final status after a failure, decided in Node (deploy-lib decideFailureStatus).
# Falls back to CRITICAL_OPERATOR_ACTION if the decision cannot be obtained.
function Get-FailureStatus {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Layout,
        [Parameter(Mandatory = $true)][string]$Phase,
        [string]$MigrationState = 'NOT_CHECKED',
        [ValidateSet('ok', 'failed', 'none')][string]$Rollback = 'none'
    )
    try {
        $r = Invoke-FiyatUcuzNode -Layout $Layout -Arguments @($Layout.DeployCli, 'decide-status', '--phase', $Phase,
            '--migration-state', $MigrationState, '--rollback', $Rollback)
        $status = [string](Get-OptionalProperty -Object $r.Result -Name 'status')
        if ($r.ExitCode -eq 0 -and $status) { return $status }
    } catch {
        Write-Warning 'status decision failed; reporting CRITICAL_OPERATOR_ACTION'
    }
    return 'CRITICAL_OPERATOR_ACTION'
}

# ---------------------------------------------------------------------------
# Listener, ACL, disk
# ---------------------------------------------------------------------------

function Get-ListenerSnapshot {
    $conns = @(Get-NetTCPConnection -LocalPort $script:ApiPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object LocalAddress, LocalPort, OwningProcess)
    $svc = Get-FiyatUcuzServiceInfo
    $procs = @(Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
    return @{ listeners = $conns; processes = $procs; servicePid = [int]$svc.ProcessId; port = $script:ApiPort }
}

function Get-AclSnapshot {
    param([Parameter(Mandatory = $true)][hashtable]$Layout)
    $paths = @($Layout.Root, $Layout.Releases, $Layout.Runtime, $Layout.Config, $Layout.ApiEnv, $Layout.MigrationEnv,
        $Layout.Staging, $Layout.Deployments, $Layout.FeedArchive, $Layout.LogsApi)
    $out = @()
    foreach ($p in $paths) {
        if (-not (Test-Path -LiteralPath $p)) { continue }
        $acl = Get-Acl -LiteralPath $p
        $rules = @($acl.Access | ForEach-Object {
                [pscustomobject]@{
                    identity  = $_.IdentityReference.Value
                    rights    = $_.FileSystemRights.ToString()
                    type      = $_.AccessControlType.ToString()
                    inherited = $_.IsInherited
                }
            })
        $out += [pscustomobject]@{ path = $p; protected = $acl.AreAccessRulesProtected; rules = $rules }
    }
    return $out
}

function Get-FreeBytes {
    param([Parameter(Mandatory = $true)][string]$Root)
    $drive = New-Object System.IO.DriveInfo ([System.IO.Path]::GetPathRoot($Root))
    return [int64]$drive.AvailableFreeSpace
}

Export-ModuleMember -Function Get-OptionalProperty, Get-FiyatUcuzLayout, Invoke-FiyatUcuzNode, Save-FiyatUcuzJson,
    Get-FiyatUcuzServiceInfo, Assert-FiyatUcuzService, Stop-FiyatUcuzApi, Start-FiyatUcuzApi,
    Assert-FiyatUcuzServiceStopped, Get-FiyatUcuzServiceStatus, Get-ActivationEntry, Get-ActivationSnapshot,
    New-ActivationJunction, Rename-ActivationJunction, Remove-ActivationJunction, Invoke-ActivationSteps,
    Test-ActivationPrecheck, Test-RollbackPrecheck, Get-FailureStatus,
    Get-ListenerSnapshot, Get-AclSnapshot, Get-FreeBytes
