#!/usr/bin/env node
// FiyatUcuz deployment helper CLI (ADIM 15A-4, ADR-0021). Called by the
// PowerShell orchestration in scripts/deploy/windows/. Every command prints ONE
// JSON object on stdout and exits 0 (ok), 1 (check failed) or 2 (usage).
// Env-file VALUES are never printed; only key-level findings.

import { readFileSync } from 'node:fs';
import process from 'node:process';

import {
  appendEvent,
  assertMigrationsReviewed,
  assertRemovableJunction,
  checkFreeSpace,
  checkRuntimeVersions,
  classifyMigrationApply,
  createReceipt,
  databaseRollbackNote,
  decideFailureStatus,
  DeployError,
  deploymentLayout,
  deriveReleaseId,
  mergeReceiptPatch,
  parseEnvText,
  planActivationStep,
  pollHealth,
  precheckActivation,
  precheckRollback,
  retentionReport,
  runBackup,
  runMigrationCli,
  secretsOf,
  validateAclSnapshot,
  validateApiEnv,
  validateListeners,
  validateMigrationEnv,
  writeReceiptAtomic,
} from './deploy-lib.mjs';
import { verifySealedRelease } from '../release/release-lib.mjs';

class UsageError extends Error {}

function parseOptions(args, allowed) {
  const opts = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (!allowed.includes(key)) throw new UsageError(`unknown option ${JSON.stringify(key)}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${key} needs a value`);
    opts[key.slice(2)] = value;
    i += 1;
  }
  return opts;
}

const need = (opts, ...keys) => {
  for (const k of keys) if (!opts[k]) throw new UsageError(`--${k} is required`);
};
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const readEnv = (file) => parseEnvText(readFileSync(file, 'utf8'));
const list = (v) =>
  v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
const emit = (obj) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  return obj.ok === false ? 1 : 0;
};

async function main([command, ...rest]) {
  switch (command) {
    case 'release-id': {
      const o = parseOptions(rest, ['--manifest']);
      need(o, 'manifest');
      return emit({ ok: true, releaseId: deriveReleaseId(readJson(o.manifest)) });
    }
    case 'validate-api-env': {
      const o = parseOptions(rest, ['--file', '--root']);
      need(o, 'file', 'root');
      return emit(validateApiEnv(readEnv(o.file), deploymentLayout(o.root)));
    }
    case 'validate-migration-env': {
      const o = parseOptions(rest, ['--file']);
      need(o, 'file');
      return emit(validateMigrationEnv(readEnv(o.file)));
    }
    case 'migration': {
      // status: read-only. review: status + human review gate, nothing applied.
      // apply: status → review gate → apply → status, classified (deploy-lib).
      const o = parseOptions(rest, ['--mode', '--node', '--cli', '--env-file', '--reviewed']);
      need(o, 'mode', 'node', 'cli', 'env-file');
      if (!['status', 'review', 'apply'].includes(o.mode)) {
        throw new UsageError('--mode must be status, review or apply');
      }
      const env = readEnv(o['env-file']);
      const check = validateMigrationEnv(env);
      if (!check.ok) {
        return emit({ ok: false, outcome: 'CONFIG', state: 'NOT_ATTEMPTED', errors: check.errors });
      }
      const base = {
        node: o.node,
        migrateCli: o.cli,
        migrationEnvFile: o['env-file'],
        secrets: secretsOf(env),
      };
      const before = runMigrationCli({ ...base, mode: 'status' });
      if (!before.ok) return emit({ ...before, state: 'NOT_ATTEMPTED', attempted: false, before });
      // The database records migrations this release does not contain: the
      // release is older than the schema. Never treated as pending; every
      // mode refuses before the apply command could run (fix-forward only).
      if (before.recordedMissing.length > 0) {
        return emit({
          ok: false,
          outcome: 'RECORDED_BUT_MISSING',
          errors: [
            `database records migrations missing from this release: ${before.recordedMissing.join(', ')}`,
          ],
          recordedMissing: before.recordedMissing,
          state: 'NOT_ATTEMPTED',
          attempted: false,
          knownApplied: [],
          before,
        });
      }
      if (o.mode === 'status') return emit({ ...before, before });
      if (before.pending.length === 0) {
        return emit({
          ok: true,
          outcome: 'NOTHING_PENDING',
          ...classifyMigrationApply({ before }),
          before,
          after: before,
        });
      }
      try {
        assertMigrationsReviewed(before.pending, list(o.reviewed));
      } catch (e) {
        if (!(e instanceof DeployError)) throw e;
        return emit({
          ok: false,
          outcome: e.code,
          error: e.message,
          state: 'NOT_ATTEMPTED',
          attempted: false,
          knownApplied: [],
          before,
        });
      }
      if (o.mode === 'review')
        return emit({ ok: true, outcome: 'REVIEWED', pending: before.pending, before });
      const apply = runMigrationCli({ ...base, mode: 'apply' });
      const after = runMigrationCli({ ...base, mode: 'status' });
      const c = classifyMigrationApply({ before, apply, after });
      const missingAfter = after.ok ? after.recordedMissing : [];
      return emit({
        ok: c.state === 'SUCCEEDED' && missingAfter.length === 0,
        outcome: !apply.ok
          ? apply.outcome
          : missingAfter.length > 0
            ? 'RECORDED_BUT_MISSING_AFTER_APPLY'
            : c.state === 'SUCCEEDED'
              ? 'OK'
              : `POST_STATUS_${c.state}`,
        recordedMissing: missingAfter,
        ...c,
        before,
        after: after.ok ? after : null,
        message: apply.ok ? null : apply.message,
      });
    }
    case 'backup': {
      const o = parseOptions(rest, ['--pg-dump', '--pg-restore', '--env-file', '--out']);
      need(o, 'pg-dump', 'pg-restore', 'env-file', 'out');
      const env = readEnv(o['env-file']);
      const check = validateMigrationEnv(env);
      if (!check.ok) return emit({ ok: false, errors: check.errors });
      return emit({
        ok: true,
        backup: runBackup({
          pgDump: o['pg-dump'],
          pgRestore: o['pg-restore'],
          migrationEnv: env,
          outFile: o.out,
        }),
      });
    }
    case 'health': {
      const o = parseOptions(rest, ['--url', '--timeout-sec', '--interval-sec']);
      const url = o.url ?? 'http://127.0.0.1:4000/health';
      if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url))
        throw new UsageError('health URL must be local http://127.0.0.1');
      const r = await pollHealth({
        url,
        ...(o['timeout-sec'] ? { timeoutMs: Number(o['timeout-sec']) * 1000 } : {}),
        ...(o['interval-sec'] ? { intervalMs: Number(o['interval-sec']) * 1000 } : {}),
      });
      return emit(r);
    }
    case 'check-listeners': {
      const o = parseOptions(rest, ['--snapshot']);
      need(o, 'snapshot');
      return emit(validateListeners(readJson(o.snapshot)));
    }
    case 'plan-activation': {
      const o = parseOptions(rest, [
        '--snapshot',
        '--root',
        '--target',
        '--rollback-to',
        '--legacy',
      ]);
      need(o, 'snapshot', 'root');
      if (!!o.target === !!o['rollback-to'])
        throw new UsageError('exactly one of --target / --rollback-to');
      const intent = o.target
        ? { kind: 'activate', target: o.target }
        : { kind: 'rollback', to: o['rollback-to'] };
      const plan = planActivationStep(readJson(o.snapshot), intent, deploymentLayout(o.root), {
        allowLegacy: o.legacy === 'allow',
      });
      return emit({ ok: plan.op !== 'abort', ...plan });
    }
    case 'precheck-activation': {
      const o = parseOptions(rest, ['--snapshot', '--root', '--target']);
      need(o, 'snapshot', 'root', 'target');
      return emit(precheckActivation(readJson(o.snapshot), o.target, deploymentLayout(o.root)));
    }
    case 'precheck-rollback': {
      const o = parseOptions(rest, ['--snapshot', '--root', '--to', '--legacy']);
      need(o, 'snapshot', 'root', 'to');
      return emit(
        precheckRollback(readJson(o.snapshot), o.to, deploymentLayout(o.root), {
          allowLegacy: o.legacy === 'allow',
        }),
      );
    }
    case 'decide-status': {
      const o = parseOptions(rest, ['--phase', '--migration-state', '--rollback']);
      need(o, 'phase');
      const rollback =
        o.rollback === 'ok' ? { ok: true } : o.rollback === 'failed' ? { ok: false } : null;
      return emit({
        ok: true,
        status: decideFailureStatus({
          phase: o.phase,
          migrationState: o['migration-state'],
          rollback,
        }),
      });
    }
    case 'check-junction-removal': {
      const o = parseOptions(rest, ['--snapshot', '--root', '--name', '--legacy']);
      need(o, 'snapshot', 'root', 'name');
      assertRemovableJunction(o.name, readJson(o.snapshot)[o.name], deploymentLayout(o.root), {
        allowLegacy: o.legacy === 'allow',
      });
      return emit({ ok: true });
    }
    case 'check-acl': {
      const o = parseOptions(rest, ['--snapshot', '--root']);
      need(o, 'snapshot', 'root');
      return emit(validateAclSnapshot(readJson(o.snapshot), deploymentLayout(o.root)));
    }
    case 'check-runtime': {
      const o = parseOptions(rest, ['--manifest', '--node-version', '--pnpm-version']);
      need(o, 'manifest', 'node-version', 'pnpm-version');
      return emit(
        checkRuntimeVersions({
          nodeVersion: o['node-version'],
          pnpmVersion: o['pnpm-version'],
          manifest: readJson(o.manifest),
        }),
      );
    }
    case 'check-disk': {
      const o = parseOptions(rest, ['--free-bytes']);
      need(o, 'free-bytes');
      return emit(checkFreeSpace(o['free-bytes']));
    }
    case 'receipt-init': {
      const o = parseOptions(rest, ['--file', '--init', '--secret-env']);
      need(o, 'file', 'init');
      const secrets = list(o['secret-env']).flatMap((f) => secretsOf(readEnv(f)));
      const receipt = appendEvent(createReceipt(readJson(o.init)), 'init', 'ok');
      writeReceiptAtomic(o.file, receipt, { secrets });
      return emit({ ok: true });
    }
    case 'receipt-update': {
      const o = parseOptions(rest, ['--file', '--patch', '--phase', '--result', '--secret-env']);
      need(o, 'file', 'phase', 'result');
      const secrets = list(o['secret-env']).flatMap((f) => secretsOf(readEnv(f)));
      const patch = o.patch ? readJson(o.patch) : {};
      // Throws RECEIPT_IDENTITY_CONFLICT before anything is written.
      const receipt = mergeReceiptPatch(readJson(o.file), patch);
      if (patch.status && !('databaseNote' in patch)) {
        receipt.databaseNote = databaseRollbackNote(patch.status, {
          state: receipt.migrations?.state,
          knownApplied: receipt.migrations?.knownApplied ?? [],
        });
      }
      appendEvent(receipt, o.phase, o.result);
      writeReceiptAtomic(o.file, receipt, { secrets });
      return emit({ ok: true });
    }
    case 'release-identity': {
      // Seal verification + the identity read from the verified bytes. On any
      // verification error no identity is emitted.
      const o = parseOptions(rest, ['--release', '--seal', '--seal-sha256']);
      need(o, 'release', 'seal');
      const r = verifySealedRelease({
        releaseDir: o.release,
        sealPath: o.seal,
        expectedSealSha256: o['seal-sha256'],
      });
      return emit(r.ok ? { ok: true, identity: r.identity } : { ok: false, errors: r.errors });
    }
    case 'retention-report': {
      const o = parseOptions(rest, ['--releases', '--protect']);
      need(o, 'releases');
      return emit({
        ok: true,
        ...retentionReport({ releasesDir: o.releases, protectedTargets: list(o.protect) }),
      });
    }
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command ?? '')}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    if (e instanceof UsageError) {
      process.stdout.write(`${JSON.stringify({ ok: false, usage: e.message })}\n`);
      process.exitCode = 2;
    } else if (e instanceof DeployError) {
      process.stdout.write(`${JSON.stringify({ ok: false, code: e.code, error: e.message })}\n`);
      process.exitCode = 1;
    } else {
      // Never echo arbitrary error objects (could carry env/argv details).
      process.stdout.write(
        `${JSON.stringify({ ok: false, code: 'UNEXPECTED', error: e instanceof Error ? e.name : 'error' })}\n`,
      );
      process.exitCode = 1;
    }
  },
);
