#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Phased FiyatUcuz API deployment (ADIM 15A-4, ADR-0021).

.DESCRIPTION
  -Phase Prepare : copy the archive into staging\work -> SHA-256 -> listing
                   validation -> extract -> source verify (manifest SHA-256)
                   -> copy to the FINAL path releases\<id> -> pnpm install
                   (copy import, isolated store, API filter, frozen lockfile,
                   no scripts) -> tsc build -> materialized verify -> seal
                   (outside the release). Never touches the running service
                   or the activation junctions.
  -Phase Activate: read-only gate (preflight, seal, junction state, rollback
                   target seal, migration review, backup tools) -> backup ->
                   migration -> re-verify seal + junction state -> stage
                   current.next -> stop FiyatUcuzApi -> rename swap -> start
                   -> local health (90 s) -> listener check. A failure after
                   the swap began triggers an application rollback; the
                   database is never rolled back by this tool.

  Final statuses are decided in Node (deploy-lib decideFailureStatus).
  A materialized release is NEVER renamed or moved (pnpm Windows links may
  hold absolute paths). The junction swap is NOT atomic; every intermediate
  state is re-classified before each step.

  STATUS: tooling only. NOT VERIFIED ON WINDOWS (ADIM 15A-7) and NOT approved
  for production (ADIM 15A-P). Do not run against production before both.
#>
param(
    [Parameter(Mandatory = $true)][ValidateSet('Prepare', 'Activate')][string]$Phase,
    [string]$Root = 'C:\FiyatUcuz',
    [Parameter(Mandatory = $true)][string]$ToolsRoot,
    [string]$Archive,
    [string]$ArchiveSha256,
    [string]$ManifestSha256,
    [string]$ReleaseId,
    [string]$SealSha256,
    [string]$PgDump,
    [string]$PgRestore,
    [string[]]$ReviewedMigrations = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FiyatUcuz.Deploy.psm1') -Force

$layout = Get-FiyatUcuzLayout -Root $Root -ToolsRoot $ToolsRoot
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$deploymentId = "$stamp-$($Phase.ToLowerInvariant())"
$receiptPath = Join-Path $layout.Deployments "$deploymentId.json"
$secretEnvs = "$($layout.ApiEnv),$($layout.MigrationEnv)"
$script:MigrationState = 'NOT_CHECKED'

function Invoke-Cli {
    param([string[]]$Arguments)
    return Invoke-FiyatUcuzNode -Layout $layout -Arguments $Arguments
}

# Throws on failure: callers stop before the next mutation.
function Update-Receipt {
    param([hashtable]$Patch, [string]$PhaseName, [string]$Result)
    $patchFile = Save-FiyatUcuzJson -Layout $layout -Value $Patch -Name 'receipt-patch'
    $r = Invoke-Cli -Arguments @($layout.DeployCli, 'receipt-update', '--file', $receiptPath, '--patch', $patchFile,
        '--phase', $PhaseName, '--result', $Result, '--secret-env', $secretEnvs)
    if ($r.ExitCode -ne 0) { throw 'receipt update failed' }
}

# Best effort: used where safety requires continuing (rollback) or where the
# outcome is already final. Returns $true/$false, never throws.
function Write-ReceiptBestEffort {
    param([hashtable]$Patch, [string]$PhaseName, [string]$Result)
    try { Update-Receipt -Patch $Patch -PhaseName $PhaseName -Result $Result; return $true }
    catch { Write-Warning "receipt could not record phase '$PhaseName'"; return $false }
}

function Stop-Deployment {
    param([string]$Status, [string]$Reason, [hashtable]$Extra = @{})
    $patch = @{ status = $Status } + $Extra
    $null = Write-ReceiptBestEffort -Patch $patch -PhaseName 'final' -Result $Reason
    Write-Output "DEPLOYMENT $Status - $Reason"
    exit 1
}

# Failure before or around activation: the status comes from Node.
function Stop-Activation {
    param([string]$FailedPhase, [string]$Reason, [ValidateSet('ok', 'failed', 'none')][string]$Rollback = 'none', [hashtable]$Extra = @{})
    $status = Get-FailureStatus -Layout $layout -Phase $FailedPhase -MigrationState $script:MigrationState -Rollback $Rollback
    Stop-Deployment -Status $status -Reason "[$FailedPhase] $Reason" -Extra $Extra
}

function Assert-ExitOk {
    param([object]$Result, [string]$What)
    if ($Result.ExitCode -ne 0) {
        $detail = @(Get-OptionalProperty -Object $Result.Result -Name 'errors') | Where-Object { $_ }
        throw ("$What failed " + ($detail -join '; ')).Trim()
    }
}

# Seal verification that also returns the identity read from the verified
# seal and manifest (G1). Throws when verification fails or identity is
# incomplete; operator arguments are never used as identity.
function Get-VerifiedIdentity {
    param([string]$Dir, [string]$ExpectedSha)
    $a = @($layout.DeployCli, 'release-identity', '--release', $Dir, '--seal', "$Dir.seal.json")
    if ($ExpectedSha) { $a += @('--seal-sha256', $ExpectedSha) }
    $r = Invoke-Cli -Arguments $a
    $identity = Get-OptionalProperty -Object $r.Result -Name 'identity'
    if ($r.ExitCode -ne 0 -or $null -eq $identity) { throw "seal verification failed for $(Split-Path -Leaf $Dir)" }
    foreach ($f in @('releaseId', 'gitCommit', 'manifestSha256', 'sealSha256')) {
        if (-not [string](Get-OptionalProperty -Object $identity -Name $f)) { throw "verified identity incomplete ($f)" }
    }
    return $identity
}

# Receipt release section from a verified identity. archiveSha256 is not part
# of it: only Prepare records the archive hash it computed itself.
function ConvertTo-ReleasePatch {
    param([object]$Identity)
    return @{
        id = [string]$Identity.releaseId; gitCommit = [string]$Identity.gitCommit
        manifestSha256 = [string]$Identity.manifestSha256; sealSha256 = [string]$Identity.sealSha256; verifiedBy = 'seal'
    }
}

# --- receipt BEFORE the first mutation -----------------------------------------
$init = @{
    deploymentId = $deploymentId; host = $env:COMPUTERNAME; operator = $env:USERNAME
    # Operator inputs: stored as receipt.requested, never as verified identity.
    releaseId = $ReleaseId; archiveSha256 = $ArchiveSha256; manifestSha256 = $ManifestSha256; sealSha256 = $SealSha256
    tool = @{ phase = $Phase }
}
$initFile = Save-FiyatUcuzJson -Layout $layout -Value $init -Name 'receipt-init'
$r = Invoke-Cli -Arguments @($layout.DeployCli, 'receipt-init', '--file', $receiptPath, '--init', $initFile, '--secret-env', $secretEnvs)
if ($r.ExitCode -ne 0) { Write-Output 'DEPLOYMENT FAILED_NO_CHANGE - initial receipt could not be written; nothing was changed'; exit 1 }

# =============================================================================
# PREPARE (never touches the service or the activation junctions)
# =============================================================================
if ($Phase -eq 'Prepare') {
    try {
        & (Join-Path $PSScriptRoot 'Test-FiyatUcuzPreflight.ps1') -Root $Root -ToolsRoot $ToolsRoot -ForPrepare
        if ($LASTEXITCODE -ne 0) { throw 'preflight failed' }
        if (-not $Archive -or -not $ArchiveSha256 -or -not $ManifestSha256) { throw '-Archive, -ArchiveSha256 and -ManifestSha256 are required' }

        # Work on a private copy (staging is Administrators-only): the file that
        # is hashed and listed is exactly the file that is extracted.
        $workArchive = Join-Path $layout.Work "$deploymentId.tgz"
        Copy-Item -LiteralPath $Archive -Destination $workArchive
        $actual = (Get-FileHash -LiteralPath $workArchive -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $ArchiveSha256.ToLowerInvariant()) { throw 'archive SHA-256 mismatch' }
        # The hash Prepare computed itself (and matched against the input).
        Update-Receipt -Patch @{ release = @{ archiveSha256 = $actual; verifiedBy = 'prepare' } } -PhaseName 'archive' -Result 'archive hash verified'

        # Validate the listing BEFORE anything is extracted.
        $names = @(& $layout.Tar -tf $workArchive); if ($LASTEXITCODE -ne 0) { throw 'tar listing failed' }
        $verbose = @(& $layout.Tar -tvf $workArchive); if ($LASTEXITCODE -ne 0) { throw 'tar listing failed' }
        $utf8 = New-Object System.Text.UTF8Encoding $false
        $namesFile = Join-Path $layout.Work "$deploymentId.names.txt"
        $verboseFile = Join-Path $layout.Work "$deploymentId.verbose.txt"
        [System.IO.File]::WriteAllLines($namesFile, [string[]]$names, $utf8)
        [System.IO.File]::WriteAllLines($verboseFile, [string[]]$verbose, $utf8)
        Assert-ExitOk -What 'archive entry validation' -Result (Invoke-Cli -Arguments @($layout.ReleaseCli, 'check-archive', '--names', $namesFile, '--verbose', $verboseFile))

        $workDir = Join-Path $layout.Work $deploymentId
        if (Test-Path -LiteralPath $workDir) { throw 'work directory already exists' }
        New-Item -ItemType Directory -Path $workDir | Out-Null
        & $layout.Tar -xzf $workArchive -C $workDir
        if ($LASTEXITCODE -ne 0) { throw 'archive extraction failed' }
        Assert-ExitOk -What 'source verify' -Result (Invoke-Cli -Arguments @($layout.ReleaseCli, 'verify', '--release', $workDir, '--stage', 'source', '--manifest-sha256', $ManifestSha256))

        $manifestFile = Join-Path $workDir 'release-manifest.json'
        $idResult = Invoke-Cli -Arguments @($layout.DeployCli, 'release-id', '--manifest', $manifestFile)
        Assert-ExitOk -What 'release id' -Result $idResult
        $newReleaseId = [string](Get-OptionalProperty -Object $idResult.Result -Name 'releaseId')
        if ($newReleaseId -cnotmatch '^\d{8}-[0-9a-f]{12}$') { throw 'release id could not be derived' }
        $releaseDir = Join-Path $layout.Releases $newReleaseId
        $sealPath = "$releaseDir.seal.json"
        if ((Test-Path -LiteralPath $releaseDir) -or (Test-Path -LiteralPath $sealPath)) { throw "release $newReleaseId already exists; refusing to overwrite" }

        $nodeVersion = (& $layout.Node --version).Trim()
        $pnpmVersion = (& $layout.Node $layout.PnpmCli --version).Trim()
        Assert-ExitOk -What 'runtime versions' -Result (Invoke-Cli -Arguments @($layout.DeployCli, 'check-runtime', '--manifest', $manifestFile, '--node-version', $nodeVersion, '--pnpm-version', $pnpmVersion))
        Assert-ExitOk -What 'free disk' -Result (Invoke-Cli -Arguments @($layout.DeployCli, 'check-disk', '--free-bytes', [string](Get-FreeBytes -Root $layout.Root)))

        # Digest Prepare computes itself from the manifest the source verify just
        # accepted (equal to -ManifestSha256 by that check); id derived from it.
        $manifestDigest = (Get-FileHash -LiteralPath $manifestFile -Algorithm SHA256).Hash.ToLowerInvariant()
        Update-Receipt -Patch @{ release = @{ id = $newReleaseId; manifestSha256 = $manifestDigest; verifiedBy = 'prepare' } } -PhaseName 'source' -Result 'verified'

        # FINAL path from here on: never rename or move $releaseDir.
        Copy-Item -LiteralPath $workDir -Destination $releaseDir -Recurse
        Assert-ExitOk -What 'release copy verify' -Result (Invoke-Cli -Arguments @($layout.ReleaseCli, 'verify', '--release', $releaseDir, '--stage', 'source', '--manifest-sha256', $ManifestSha256))

        $planResult = Invoke-Cli -Arguments @($layout.ReleaseCli, 'install-plan', '--release', $releaseDir, '--node', $layout.Node, '--pnpm', $layout.PnpmCli, '--store', $layout.Store)
        Assert-ExitOk -What 'install plan' -Result $planResult
        $plan = $planResult.Result
        if ($null -eq $plan) { throw 'install plan unreadable' }
        Push-Location -LiteralPath $releaseDir
        try {
            $install = @($plan.install)
            & $install[0] @($install[1..($install.Count - 1)])
            if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }
            foreach ($stepArgs in @($plan.build)) {
                $b = @($stepArgs)
                & $b[0] @($b[1..($b.Count - 1)])
                if ($LASTEXITCODE -ne 0) { throw 'build failed' }
            }
        } finally { Pop-Location }

        Assert-ExitOk -What 'materialized verify' -Result (Invoke-Cli -Arguments @($layout.ReleaseCli, 'verify', '--release', $releaseDir, '--stage', 'materialized', '--manifest-sha256', $ManifestSha256))
        $seal = Invoke-Cli -Arguments @($layout.ReleaseCli, 'seal', '--release', $releaseDir, '--seal', $sealPath, '--release-id', $newReleaseId, '--manifest-sha256', $ManifestSha256)
        Assert-ExitOk -What 'seal' -Result $seal
        if (-not (($seal.Lines -join "`n") -match 'seal sha256: ([0-9a-f]{64})')) { throw 'seal digest not reported' }
        $sealSha = $Matches[1]
        # Re-verify the new seal and take identity (incl. gitCommit) from it; the
        # write-once receipt refuses any value that differs from the earlier steps.
        $identity = Get-VerifiedIdentity -Dir $releaseDir -ExpectedSha $sealSha
        Update-Receipt -Patch @{ status = 'PREPARED'; release = (ConvertTo-ReleasePatch -Identity $identity) } -PhaseName 'seal' -Result 'sealed'
        Write-Output "PREPARED release $newReleaseId (seal sha256 $sealSha). Production is unchanged."
        exit 0
    } catch {
        # An unsealed release directory (if created) is left in place for
        # diagnosis; it can never be activated (no seal). Manual cleanup.
        Stop-Deployment -Status 'FAILED_NO_CHANGE' -Reason $_.Exception.Message
    }
}

# =============================================================================
# ACTIVATE
# =============================================================================
$releaseDir = $null
$sealPath = $null
$previous = $null
$migrateCli = $null

function Test-Sealed {
    param([string]$Dir, [string]$ExpectedSha)
    $a = @($layout.ReleaseCli, 'verify', '--release', $Dir, '--stage', 'sealed', '--seal', "$Dir.seal.json")
    if ($ExpectedSha) { $a += @('--seal-sha256', $ExpectedSha) }
    return ((Invoke-Cli -Arguments $a).ExitCode -eq 0)
}

function Test-ServiceHealthy {
    $h = Invoke-Cli -Arguments @($layout.DeployCli, 'health', '--timeout-sec', '90', '--interval-sec', '2')
    $l = $null
    $lOk = $false
    try {
        $listenerFile = Save-FiyatUcuzJson -Layout $layout -Value (Get-ListenerSnapshot) -Name 'listener'
        $l = Invoke-Cli -Arguments @($layout.DeployCli, 'check-listeners', '--snapshot', $listenerFile)
        $lOk = ($l.ExitCode -eq 0)
    } catch { $lOk = $false }
    $failed = $null
    if ($h.ExitCode -ne 0) { $failed = 'health' } elseif (-not $lOk) { $failed = 'listener' }
    $lResult = $null
    if ($null -ne $l) { $lResult = $l.Result }
    return @{ ok = ($null -eq $failed); failedPhase = $failed; health = $h.Result; listener = $lResult }
}

# Remove a staged current.next while the service is still running (pre-stop
# abort). Only the junction is removed; returns $true/$false, never throws.
function Undo-Staging {
    try {
        $r = Invoke-ActivationSteps -Layout $layout -RollbackTo $previous
        return [bool]$r.ok
    } catch { return $false }
}

function Invoke-AppRollback {
    try {
        Stop-FiyatUcuzApi -TimeoutSec 60
        $r = Invoke-ActivationSteps -Layout $layout -RollbackTo $previous
        if (-not $r.ok) { return @{ ok = $false; reason = "rollback junction plan refused: $($r.reason)" } }
        Start-FiyatUcuzApi -TimeoutSec 30
        $check = Test-ServiceHealthy
        if (-not $check.ok) { return @{ ok = $false; reason = "previous release not healthy ($($check.failedPhase))" } }
        return @{ ok = $true; reason = $null }
    } catch {
        return @{ ok = $false; reason = $_.Exception.Message }
    }
}

# --- 1. read-only gate: everything checkable BEFORE the database changes -------
try {
    if ($ReleaseId -cnotmatch '^\d{8}-[0-9a-f]{12}$') { throw 'invalid or missing -ReleaseId' }
    if ($SealSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'invalid or missing -SealSha256' }
    $releaseDir = Join-Path $layout.Releases $ReleaseId
    $sealPath = "$releaseDir.seal.json"
    $migrateCli = Join-Path $releaseDir 'packages\db\dist\cli\migrate.js'

    # service identity, env policy, static ACLs, disk, runtime vs manifest, current junction
    & (Join-Path $PSScriptRoot 'Test-FiyatUcuzPreflight.ps1') -Root $Root -ToolsRoot $ToolsRoot -Manifest (Join-Path $releaseDir 'release-manifest.json')
    if ($LASTEXITCODE -ne 0) { throw 'preflight failed' }
    Assert-FiyatUcuzService -Layout $layout | Out-Null

    $identity = Get-VerifiedIdentity -Dir $releaseDir -ExpectedSha $SealSha256
    if ([string]$identity.releaseId -cne $ReleaseId) { throw 'verified release id differs from -ReleaseId' }
    # Record the verified identity at once, so a later gate failure still has it.
    Update-Receipt -Patch @{ release = (ConvertTo-ReleasePatch -Identity $identity) } -PhaseName 'verify' -Result 'target seal verified'

    $pre = Test-ActivationPrecheck -Layout $layout -Target $releaseDir
    Assert-ExitOk -What 'activation junction precheck' -Result $pre
    $previous = [string](Get-OptionalProperty -Object $pre.Result -Name 'previous')
    if (-not $previous) { throw 'previous release unknown' }
    # The rollback target must itself be intact before anything changes.
    if (-not (Test-Sealed -Dir $previous -ExpectedSha $null)) { throw 'current (rollback target) release failed seal verification' }

    $statusRun = Invoke-Cli -Arguments @($layout.DeployCli, 'migration', '--mode', 'status', '--node', $layout.Node, '--cli', $migrateCli, '--env-file', $layout.MigrationEnv)
    # G2: the database records migrations this release does not contain (the
    # release is older than the schema). NO-GO before review, backup, apply,
    # service stop and any junction change. Fix-forward only.
    $recordedMissing = @(Get-OptionalProperty -Object $statusRun.Result -Name 'recordedMissing' | Where-Object { $_ })
    if ($recordedMissing.Count -gt 0) {
        $null = Write-ReceiptBestEffort -Patch @{ migrations = @{
                state = 'NOT_ATTEMPTED'; attempted = $false; outcome = 'RECORDED_BUT_MISSING'; knownApplied = @()
                recordedMissing = $recordedMissing; before = $statusRun.Result; after = $null; reviewed = $ReviewedMigrations
            }
        } -PhaseName 'precheck' -Result 'recorded-but-missing migrations'
        throw "database records migrations missing from this release: $($recordedMissing -join ', ') (a fix-forward release containing them is required)"
    }
    Assert-ExitOk -What "migration status ($(Get-OptionalProperty -Object $statusRun.Result -Name 'outcome'))" -Result $statusRun
    $pending = @(Get-OptionalProperty -Object $statusRun.Result -Name 'pending' | Where-Object { $_ })
    if ($pending.Count -gt 0) {
        if ($ReviewedMigrations.Count -eq 0) { throw "pending migrations must be reviewed and listed in -ReviewedMigrations: $($pending -join ', ')" }
        if (-not $PgDump -or -not (Test-Path -LiteralPath $PgDump -PathType Leaf)) { throw 'pending migrations require -PgDump (existing file) for the mandatory backup' }
        if (-not $PgRestore -or -not (Test-Path -LiteralPath $PgRestore -PathType Leaf)) { throw 'pending migrations require -PgRestore (existing file)' }
        # Full paths only: the same file must be checked here and executed by Node.
        if ($PgDump -notmatch '^[A-Za-z]:\\' -or $PgRestore -notmatch '^[A-Za-z]:\\') { throw '-PgDump and -PgRestore must be full paths (drive letter)' }
        $review = Invoke-Cli -Arguments @($layout.DeployCli, 'migration', '--mode', 'review', '--node', $layout.Node, '--cli', $migrateCli,
            '--env-file', $layout.MigrationEnv, '--reviewed', ($ReviewedMigrations -join ','))
        Assert-ExitOk -What 'migration review gate' -Result $review
        $script:MigrationState = 'NOT_ATTEMPTED'
    } else {
        $script:MigrationState = 'NOT_NEEDED'
    }

    Update-Receipt -Patch @{
        release = (ConvertTo-ReleasePatch -Identity $identity)
        previousRelease = $previous; junctions = @{ before = (Get-ActivationSnapshot -Layout $layout) }
        service = @{ before = (Get-FiyatUcuzServiceStatus) }
        migrations = @{ state = $script:MigrationState; attempted = $false; outcome = $null; knownApplied = @(); before = $statusRun.Result; after = $null; reviewed = $ReviewedMigrations }
    } -PhaseName 'precheck' -Result "gate passed; $($pending.Count) pending migration(s)"
} catch {
    Stop-Activation -FailedPhase 'precheck' -Reason $_.Exception.Message
}

# --- 2. backup + migration (service still running; expand-only per ADR-0019) ---
if ($pending.Count -gt 0) {
    try {
        if (-not (Test-Path -LiteralPath $layout.Backups)) { New-Item -ItemType Directory -Path $layout.Backups | Out-Null }
        $backupFile = Join-Path $layout.Backups "$deploymentId.dump"
        $backup = Invoke-Cli -Arguments @($layout.DeployCli, 'backup', '--pg-dump', $PgDump, '--pg-restore', $PgRestore, '--env-file', $layout.MigrationEnv, '--out', $backupFile)
        if ($backup.ExitCode -ne 0) { throw "backup failed: $(Get-OptionalProperty -Object $backup.Result -Name 'error')" }
        Update-Receipt -Patch @{ backup = (Get-OptionalProperty -Object $backup.Result -Name 'backup') } -PhaseName 'backup' -Result 'verified'
    } catch {
        Stop-Activation -FailedPhase 'backup' -Reason "$($_.Exception.Message); migration not attempted"
    }

    # From the moment the apply CLI starts, the database may change.
    $script:MigrationState = 'UNKNOWN'
    $apply = Invoke-Cli -Arguments @($layout.DeployCli, 'migration', '--mode', 'apply', '--node', $layout.Node, '--cli', $migrateCli,
        '--env-file', $layout.MigrationEnv, '--reviewed', ($ReviewedMigrations -join ','))
    $state = [string](Get-OptionalProperty -Object $apply.Result -Name 'state')
    if ($state) { $script:MigrationState = $state }
    # Unreadable result: the apply CLI may have run - assume it was attempted.
    $attempted = $true
    if ($null -ne $apply.Result) { $attempted = [bool](Get-OptionalProperty -Object $apply.Result -Name 'attempted') }
    $migrationPatch = @{ migrations = @{
            state        = $script:MigrationState
            attempted    = $attempted
            outcome      = (Get-OptionalProperty -Object $apply.Result -Name 'outcome')
            knownApplied = @(Get-OptionalProperty -Object $apply.Result -Name 'knownApplied' | Where-Object { $_ })
            before       = (Get-OptionalProperty -Object $apply.Result -Name 'before')
            after        = (Get-OptionalProperty -Object $apply.Result -Name 'after')
            reviewed     = $ReviewedMigrations
        }
    }
    try {
        Update-Receipt -Patch $migrationPatch -PhaseName 'migration' -Result $script:MigrationState
    } catch {
        Stop-Activation -FailedPhase 'receipt' -Reason 'receipt could not record the migration result; new release NOT activated'
    }
    if ($apply.ExitCode -ne 0 -or $script:MigrationState -ne 'SUCCEEDED') {
        Stop-Activation -FailedPhase 'migration' -Reason "migration state $($script:MigrationState); new release NOT activated"
    }
}

# --- 3. re-verify immediately before activation, then stage current.next -------
try {
    $again = Get-VerifiedIdentity -Dir $releaseDir -ExpectedSha $SealSha256
    if ([string]$again.gitCommit -cne [string]$identity.gitCommit -or [string]$again.manifestSha256 -cne [string]$identity.manifestSha256) {
        throw 'release identity changed before activation'
    }
    Assert-ExitOk -What 'activation junction re-check' -Result (Test-ActivationPrecheck -Layout $layout -Target $releaseDir)
} catch {
    Stop-Activation -FailedPhase 'precheck' -Reason $_.Exception.Message
}
try {
    $staged = Invoke-ActivationSteps -Layout $layout -Target $releaseDir -StopBeforeRename
    if (-not ($staged.ok -and $staged.needsStop)) { throw "activation staging refused: $($staged.reason)" }
    Update-Receipt -Patch @{} -PhaseName 'stage' -Result 'current.next staged; stopping FiyatUcuzApi'
} catch {
    $undone = Undo-Staging
    Stop-Activation -FailedPhase 'stage' -Reason "$($_.Exception.Message) (current.next removed: $undone)" -Extra @{ junctions = @{ after = (Get-ActivationSnapshot -Layout $layout) } }
}

# --- 4. stop (no kill; a timeout leaves everything for the operator) ------------
try {
    Stop-FiyatUcuzApi -TimeoutSec 60
} catch {
    Stop-Activation -FailedPhase 'stop' -Reason $_.Exception.Message -Extra @{ junctions = @{ after = (Get-ActivationSnapshot -Layout $layout) } }
}

# --- 5. swap, start, verify - any failure (incl. receipt) => app rollback -------
$failedPhase = 'swap'
$failure = $null
try {
    Update-Receipt -Patch @{} -PhaseName 'swap' -Result 'service stopped; renaming activation junctions'
    $swap = Invoke-ActivationSteps -Layout $layout -Target $releaseDir
    if (-not $swap.ok) { throw "swap: $($swap.reason)" }
    Update-Receipt -Patch @{ junctions = @{ after = (Get-ActivationSnapshot -Layout $layout) } } -PhaseName 'swap' -Result 'current -> new release'
    $failedPhase = 'start'
    Start-FiyatUcuzApi -TimeoutSec 30
    $failedPhase = 'health'
    $check = Test-ServiceHealthy
    if (-not $check.ok) {
        $failedPhase = $check.failedPhase
        throw "$($check.failedPhase) verification failed"
    }
} catch {
    $failure = $_.Exception.Message
}

if ($null -eq $failure) {
    # Healthy. A failing final receipt write must NOT roll back a healthy
    # release, and the receipt must not claim COMPLETED without being written.
    $done = Write-ReceiptBestEffort -Patch @{
        status = 'COMPLETED'; health = @{ local = $check.health; external = 'operator-to-check-from-outside' }
        listener = $check.listener; service = @{ after = (Get-FiyatUcuzServiceStatus) }
        junctions = @{ after = (Get-ActivationSnapshot -Layout $layout) }
    } -PhaseName 'final' -Result 'completed'
    if (-not $done) {
        Write-Output "DEPLOYMENT HEALTHY BUT RECEIPT NOT FINALIZED - release $ReleaseId is active; receipt $receiptPath still says IN_PROGRESS. Record the outcome manually."
        exit 3
    }
    Write-Output "DEPLOYMENT COMPLETED - release $ReleaseId is active. Check https://api.fiyatucuz.com/health from an external machine."
    exit 0
}

# --- 6. application rollback (receipt writes are best effort here) -------------
$null = Write-ReceiptBestEffort -Patch @{} -PhaseName 'rollback' -Result "starting application rollback after $failedPhase failure"
$rollback = Invoke-AppRollback
$rb = 'failed'
if ($rollback.ok) { $rb = 'ok' }
$reason = "activation failed ($failure); rollback: "
if ($rollback.ok) { $reason += 'application restored' } else { $reason += $rollback.reason }
Stop-Activation -FailedPhase $failedPhase -Reason $reason -Rollback $rb -Extra @{
    junctions = @{ after = (Get-ActivationSnapshot -Layout $layout) }
    service   = @{ after = (Get-FiyatUcuzServiceStatus) }
}
