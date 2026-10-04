// FiyatUcuz Windows deployment logic (ADIM 15A-4, ADR-0021).
//
// Pure, testable decisions live here; PowerShell (scripts/deploy/windows/)
// only gathers Windows facts (service, junctions, ACLs, TCP listeners) and
// executes ONE step at a time as instructed by this module.
//
// Invariants (also in ADR-0021):
//   - A materialized release lives at its FINAL path releases\<id> and is
//     never renamed or moved (pnpm Windows links may hold absolute targets).
//     Only the activation junctions current / current.next / current.prev /
//     current.failed are created, renamed or removed (never recursively).
//   - The overall swap is NOT atomic; every intermediate junction state is
//     classified, and anything ambiguous stops with CRITICAL_OPERATOR_ACTION.
//   - No secret value ever reaches argv, stdout/stderr, receipts or errors.
//
// Node built-ins only.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { Buffer } from 'node:buffer';
import { win32 } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SERVICE_NAME = 'FiyatUcuzApi';
export const SERVICE_ACCOUNT = 'NT AUTHORITY\\LocalService';
export const LISTEN_PORT = 4000;
export const ALLOWED_LISTEN_ADDRESSES = Object.freeze(['127.0.0.1']);
export const MIN_FREE_BYTES = 5 * 1024 ** 3; // 5 GiB before materialization
export const TIMEOUTS = Object.freeze({
  stopSec: 60,
  startSec: 30,
  healthSec: 90,
  healthIntervalSec: 2,
});
export const ACTIVATION_NAMES = Object.freeze([
  'current',
  'current.next',
  'current.prev',
  'current.failed',
]);
export const RECEIPT_SCHEMA_VERSION = 1;
export const RELEASE_ID_RE = /^\d{8}-[0-9a-f]{12}$/;

export const FINAL_STATUS = Object.freeze({
  COMPLETED: 'COMPLETED',
  FAILED_NO_CHANGE: 'FAILED_NO_CHANGE',
  FAILED_MIGRATION_PARTIAL: 'FAILED_MIGRATION_PARTIAL',
  ROLLED_BACK: 'ROLLED_BACK',
  ROLLED_BACK_APP_ONLY: 'ROLLED_BACK_APP_ONLY',
  CRITICAL_OPERATOR_ACTION: 'CRITICAL_OPERATOR_ACTION',
});

export class DeployError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeployError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Layout (Windows paths, computed with path.win32 so tests run anywhere)
// ---------------------------------------------------------------------------

export function deploymentLayout(root = 'C:\\FiyatUcuz') {
  const j = (...p) => win32.join(root, ...p);
  return Object.freeze({
    root: win32.normalize(root),
    releases: j('releases'),
    activation: Object.freeze(Object.fromEntries(ACTIVATION_NAMES.map((n) => [n, j(n)]))),
    legacyApp: j('app'),
    config: j('config'),
    apiEnv: j('config', 'api.env'),
    migrationEnv: j('config', 'migration.env'),
    data: j('data'),
    feedArchive: j('data', 'feed-archive'),
    logsApi: j('logs', 'api'),
    runtime: j('runtime'),
    node: j('runtime', 'node22', 'node.exe'),
    pnpmCli: j('runtime', 'pnpm', '9.15.4', 'bin', 'pnpm.cjs'),
    winsw: j('runtime', 'service', 'FiyatUcuzApi.exe'),
    staging: j('staging'),
    store: j('staging', 'pnpm-store'),
    incoming: j('staging', 'incoming'),
    work: j('staging', 'work'),
    backups: j('staging', 'db-backups'),
    deployments: j('deployments'),
  });
}

/** True iff `child` is `parent` or inside it (Windows semantics, case-insensitive). */
export function winIsInside(parent, child) {
  const rel = win32.relative(win32.resolve(parent), win32.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !win32.isAbsolute(rel));
}

function winEquals(a, b) {
  return win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();
}

// ---------------------------------------------------------------------------
// Release identity
// ---------------------------------------------------------------------------

/** Deterministic: commit date (UTC, from manifest.createdAt) + 12 hex of the SHA. */
export function deriveReleaseId(manifest) {
  const commit = String(manifest?.gitCommit ?? '');
  if (!/^[0-9a-f]{40}$/.test(commit))
    throw new DeployError('BAD_MANIFEST', 'manifest gitCommit invalid');
  const t = new Date(manifest.createdAt);
  if (Number.isNaN(t.getTime()))
    throw new DeployError('BAD_MANIFEST', 'manifest createdAt invalid');
  const ymd = t.toISOString().slice(0, 10).replace(/-/g, '');
  return `${ymd}-${commit.slice(0, 12)}`;
}

export function releasePaths(layout, releaseId) {
  if (!RELEASE_ID_RE.test(releaseId)) throw new DeployError('BAD_RELEASE_ID', 'invalid release id');
  const dir = win32.join(layout.releases, releaseId);
  return { dir, seal: `${dir}.seal.json` };
}

/** An existing release directory is never reused or overwritten. */
export function assertReleaseAbsent(dirExists) {
  if (dirExists) {
    throw new DeployError(
      'RELEASE_EXISTS',
      'release directory already exists; refusing to overwrite',
    );
  }
}

// ---------------------------------------------------------------------------
// Env files — keys are validated, values are NEVER printed
// ---------------------------------------------------------------------------

/** Minimal dotenv parser: KEY=VALUE, optional `export `, quotes, comments. */
export function parseEnvText(text) {
  const values = new Map();
  let invalidLines = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      invalidLines += 1;
      continue;
    }
    let value = m[2];
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2)
      value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values.set(m[1], value);
  }
  return { values, invalidLines };
}

const API_ENV_FORBIDDEN = ['DATABASE_MIGRATION_URL', 'DATABASE_MIGRATION_EXPECTED_DB'];

/** Runtime env policy. Errors name keys only. */
export function validateApiEnv(parsed, layout) {
  const v = parsed.values;
  const errors = [];
  const exact = (key, expected) => {
    if (!v.has(key)) errors.push(`${key} is missing`);
    else if (v.get(key) !== expected) errors.push(`${key} must be exactly "${expected}"`);
  };
  exact('NODE_ENV', 'production');
  exact('API_HOST', '127.0.0.1');
  exact('API_PORT', String(LISTEN_PORT));
  if (!v.get('DATABASE_URL')) errors.push('DATABASE_URL is missing');
  for (const key of API_ENV_FORBIDDEN) {
    if (v.has(key)) errors.push(`${key} must not be in the API runtime env (migration-only)`);
  }
  const archive = v.get('FEED_ARCHIVE_LOCAL_ROOT');
  if (!archive) errors.push('FEED_ARCHIVE_LOCAL_ROOT is missing');
  else if (!win32.isAbsolute(archive) || /^[\\/]{2}/.test(archive)) {
    errors.push('FEED_ARCHIVE_LOCAL_ROOT must be an absolute local path');
  } else {
    for (const forbidden of [
      layout.releases,
      layout.activation.current,
      layout.activation['current.next'],
      layout.activation['current.prev'],
      layout.legacyApp,
      layout.config,
      layout.staging,
    ]) {
      if (winIsInside(forbidden, archive)) {
        errors.push(
          'FEED_ARCHIVE_LOCAL_ROOT must not be inside a release/activation/config/staging path',
        );
        break;
      }
    }
    if (!winEquals(archive, layout.feedArchive)) {
      errors.push('FEED_ARCHIVE_LOCAL_ROOT is not the expected data\\feed-archive path');
    }
  }
  if (parsed.invalidLines > 0) errors.push(`${parsed.invalidLines} unparseable line(s)`);
  return { ok: errors.length === 0, errors };
}

/** Migration env policy: migration credentials only, never merged with runtime. */
export function validateMigrationEnv(parsed) {
  const v = parsed.values;
  const errors = [];
  const url = v.get('DATABASE_MIGRATION_URL');
  if (!url) errors.push('DATABASE_MIGRATION_URL is missing');
  else {
    try {
      const u = new URL(url);
      if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
        errors.push('DATABASE_MIGRATION_URL must use postgres://');
      }
    } catch {
      errors.push('DATABASE_MIGRATION_URL is not a valid URL');
    }
  }
  if (!v.get('DATABASE_MIGRATION_EXPECTED_DB'))
    errors.push('DATABASE_MIGRATION_EXPECTED_DB is missing');
  if (v.has('DATABASE_URL'))
    errors.push('DATABASE_URL must not be in the migration env (runtime-only)');
  if (parsed.invalidLines > 0) errors.push(`${parsed.invalidLines} unparseable line(s)`);
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Secret redaction + child-process environment isolation
// ---------------------------------------------------------------------------

// Keys whose values are configuration, not credentials. Every OTHER key's value
// is treated as secret (deny by default). Without this list, values such as
// "127.0.0.1" or "production" would make every receipt look secret-bearing.
const NON_SECRET_KEYS = new Set([
  'NODE_ENV',
  'API_HOST',
  'API_PORT',
  'API_TRUST_PROXY',
  'CORS_ALLOWED_ORIGINS',
  'LOG_LEVEL',
  'FEED_ARCHIVE_LOCAL_ROOT',
  'DATABASE_MIGRATION_EXPECTED_DB',
]);
const isNonSecretKey = (k) => NON_SECRET_KEYS.has(k) || /^RATE_LIMIT_[A-Z_]+$/.test(k);

/** Values of credential-bearing keys (deny by default) plus decoded URL passwords. */
export function secretsOf(parsed) {
  const out = [];
  for (const [key, value] of parsed?.values?.entries() ?? []) {
    if (!isNonSecretKey(key) && value.length >= 4) out.push(value);
    try {
      const u = new URL(value);
      if (u.password) out.push(u.password, decodeURIComponent(u.password));
    } catch {
      /* not a URL */
    }
  }
  return [...new Set(out)].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
}

export function redact(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  return out.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]*):([^\s@/]*)@/gi, '$1$2:***@');
}

// Variables a Windows child process needs to run; everything else (notably
// DATABASE_*, PG*, *_URL) is dropped. Values are copied, never logged.
const CHILD_ENV_ALLOW = new Set(
  [
    'SystemRoot',
    'SYSTEMROOT',
    'windir',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
    'PATH',
    'Path',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'COMPUTERNAME',
    'HOME',
    'LANG',
  ].map((k) => k),
);

/** Build a child env from an allowlist of the parent + explicit extras. */
export function sanitizedChildEnv(parentEnv, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(parentEnv ?? {})) {
    if (CHILD_ENV_ALLOW.has(k) && typeof v === 'string') env[k] = v;
  }
  return { ...env, ...extra };
}

function run(exe, args, { env, timeoutMs = 10 * 60 * 1000 } = {}) {
  const r = spawnSync(exe, args, {
    env,
    encoding: 'utf8',
    shell: false,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    code: typeof r.status === 'number' ? r.status : -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    spawnError: r.error ? (r.error.code ?? 'SPAWN_FAILED') : null,
  };
}

// ---------------------------------------------------------------------------
// Migration wrapper (packages/db dist CLI, ADR-0019)
// ---------------------------------------------------------------------------

export function parseMigrationStatus(stdout) {
  const applied = [];
  const pending = [];
  let bucket = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    if (/\] applied \(\d+\):/.test(line)) bucket = applied;
    else if (/\] pending \(\d+\):/.test(line)) bucket = pending;
    else if (/^\[db:migrate\]/.test(line)) bucket = null;
    else if (bucket && /^\s{2}\S+\.sql$/.test(line)) bucket.push(line.trim());
  }
  return { applied, pending };
}

function classifyMigrationFailure(code, stderr) {
  if (code === 2) return 'USAGE';
  if (/MigrationLockUnavailableError/.test(stderr)) return 'LOCK_BUSY';
  if (/MigrationTargetMismatchError/.test(stderr)) return 'TARGET_MISMATCH';
  if (/MigrationEnvError|is required/.test(stderr)) return 'CONFIG';
  return 'FAILED';
}

/**
 * Run the compiled migration CLI. The credential reaches the child ONLY via
 * --env-file (a path in argv, not a secret); the parent environment is
 * stripped first because `node --env-file` does not override variables that
 * already exist in the environment.
 */
export function runMigrationCli({
  node,
  migrateCli,
  migrationEnvFile,
  mode,
  parentEnv = process.env,
  secrets = [],
  timeoutMs,
}) {
  if (mode !== 'status' && mode !== 'apply')
    throw new DeployError('USAGE', 'mode must be status or apply');
  const args = [
    `--env-file=${migrationEnvFile}`,
    migrateCli,
    ...(mode === 'status' ? ['--status'] : []),
  ];
  const r = run(node, args, { env: sanitizedChildEnv(parentEnv), timeoutMs });
  const stdout = redact(r.stdout, secrets);
  const stderr = redact(r.stderr, secrets);
  // Migrations the CLI reported as committed — also on failure (a later
  // migration may fail after earlier ones were applied).
  const appliedNow = [...stdout.matchAll(/\] Applied (\S+\.sql)/g)].map((m) => m[1]);
  if (r.spawnError)
    return {
      ok: false,
      outcome: 'SPAWN_FAILED',
      exitCode: r.code,
      applied: [],
      pending: [],
      message: r.spawnError,
    };
  if (r.code !== 0) {
    return {
      ok: false,
      outcome: classifyMigrationFailure(r.code, stderr),
      exitCode: r.code,
      applied: mode === 'apply' ? appliedNow : [],
      pending: [],
      message: stderr.split(/\r?\n/).find((l) => l.trim()) ?? 'migration CLI failed',
    };
  }
  const status =
    mode === 'status' ? parseMigrationStatus(stdout) : { applied: appliedNow, pending: [] };
  return { ok: true, outcome: 'OK', exitCode: 0, ...status, message: null };
}

/**
 * Human gate (ADR-0019): the tool cannot prove SQL is expand-only. Applying
 * requires the operator to list exactly the pending migrations they reviewed.
 */
export function assertMigrationsReviewed(pending, reviewed) {
  const a = [...pending].sort();
  const b = [...new Set(reviewed ?? [])].sort();
  if (a.length === 0) return;
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new DeployError(
      'MIGRATION_REVIEW_REQUIRED',
      `pending migrations must be explicitly reviewed (expand-only per ADR-0019): ${a.join(', ')}`,
    );
  }
}

/**
 * What an apply attempt did to the database, from the status before, the
 * apply result and the status after. The applied set comes from the
 * before/after status diff when the after-status is available (authoritative),
 * otherwise from the CLI's own "Applied" lines (a known lower bound).
 *
 * state:
 *   NOT_NEEDED       nothing was pending
 *   NOT_ATTEMPTED    the apply CLI was never run (e.g. review gate refused)
 *   SUCCEEDED        apply ok, nothing pending afterwards
 *   INCOMPLETE       apply ok, but migrations are still pending afterwards
 *   FAILED_NO_CHANGE apply failed and the after-status PROVES nothing changed
 *   PARTIAL          apply failed after applying at least one migration
 *   UNKNOWN          the database may have changed but this cannot be proven
 */
export function classifyMigrationApply({ before, apply, after }) {
  if (!before?.ok) return { state: 'UNKNOWN', attempted: Boolean(apply), knownApplied: [] };
  if ((before.pending ?? []).length === 0) {
    return { state: 'NOT_NEEDED', attempted: false, knownApplied: [] };
  }
  if (!apply) return { state: 'NOT_ATTEMPTED', attempted: false, knownApplied: [] };
  const beforeSet = new Set(before.applied ?? []);
  const afterKnown = after?.ok === true;
  const knownApplied = afterKnown
    ? (after.applied ?? []).filter((m) => !beforeSet.has(m))
    : [...new Set(apply.applied ?? [])];
  let state;
  if (apply.ok) {
    if (!afterKnown) state = 'UNKNOWN';
    else state = (after.pending ?? []).length === 0 ? 'SUCCEEDED' : 'INCOMPLETE';
  } else if (!afterKnown) {
    state = knownApplied.length > 0 ? 'PARTIAL' : 'UNKNOWN';
  } else {
    state = knownApplied.length > 0 ? 'PARTIAL' : 'FAILED_NO_CHANGE';
  }
  return { state, attempted: true, knownApplied };
}

/** True when the database may differ from its pre-deployment state. */
export function databaseMayHaveChanged(migrationState) {
  return ['SUCCEEDED', 'INCOMPLETE', 'PARTIAL', 'UNKNOWN'].includes(migrationState);
}

// ---------------------------------------------------------------------------
// Backup (pg_dump custom format + pg_restore --list)
// ---------------------------------------------------------------------------

/** PG* variables for the child only — the password never appears in argv. */
export function pgEnvFromMigrationEnv(parsed) {
  const url = new URL(parsed.values.get('DATABASE_MIGRATION_URL'));
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const expected = parsed.values.get('DATABASE_MIGRATION_EXPECTED_DB');
  if (!database || database !== expected) {
    throw new DeployError(
      'BACKUP_TARGET_MISMATCH',
      'migration URL database does not match the expected database',
    );
  }
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database,
    ...(url.searchParams.get('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode') } : {}),
  };
}

/** SHA-256 in 4 MiB chunks: a production dump can be larger than memory allows. */
function sha256FileStreaming(file) {
  const hash = createHash('sha256');
  const buf = Buffer.alloc(4 * 1024 * 1024);
  const fd = openSync(file, 'r');
  try {
    let n;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

export function runBackup({
  pgDump,
  pgRestore,
  migrationEnv,
  outFile,
  parentEnv = process.env,
  timeoutMs,
}) {
  if (existsSync(outFile)) throw new DeployError('BACKUP_EXISTS', 'backup file already exists');
  const secrets = secretsOf(migrationEnv);
  const dump = run(pgDump, ['--format=custom', '--no-password', '--file', outFile], {
    env: sanitizedChildEnv(parentEnv, pgEnvFromMigrationEnv(migrationEnv)),
    timeoutMs,
  });
  if (dump.spawnError || dump.code !== 0) {
    throw new DeployError(
      'BACKUP_FAILED',
      redact(`pg_dump failed (exit ${dump.code}): ${dump.stderr.split(/\r?\n/)[0] ?? ''}`, secrets),
    );
  }
  let bytes = 0;
  try {
    bytes = lstatSync(outFile).size;
  } catch {
    throw new DeployError('BACKUP_FAILED', 'pg_dump produced no file');
  }
  if (bytes === 0) throw new DeployError('BACKUP_FAILED', 'pg_dump produced an empty file');
  const sha256 = sha256FileStreaming(outFile);
  const list = run(pgRestore, ['--list', outFile], {
    env: sanitizedChildEnv(parentEnv),
    timeoutMs,
  });
  const restoreListOk = list.code === 0 && list.stdout.trim().length > 0;
  if (!restoreListOk)
    throw new DeployError('BACKUP_FAILED', 'pg_restore --list could not read the backup');
  return { path: outFile, bytes, sha256, restoreListOk };
}

// ---------------------------------------------------------------------------
// Health / listener
// ---------------------------------------------------------------------------

/** Poll until HTTP 200 + JSON {status:"ok"} or timeout. Local URL is authoritative. */
export async function pollHealth({
  url = `http://127.0.0.1:${LISTEN_PORT}/health`,
  timeoutMs = TIMEOUTS.healthSec * 1000,
  intervalMs = TIMEOUTS.healthIntervalSec * 1000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const started = Date.now();
  let attempts = 0;
  let lastStatus = null;
  while (true) {
    attempts += 1;
    try {
      const res = await fetchImpl(url, {
        signal: globalThis.AbortSignal.timeout(Math.max(1000, intervalMs)),
      });
      lastStatus = res.status;
      if (res.status === 200) {
        const body = await res.json().catch(() => null);
        if (body && body.status === 'ok')
          return { ok: true, attempts, elapsedMs: Date.now() - started, lastStatus };
      }
    } catch {
      lastStatus = 'unreachable';
    }
    if (Date.now() - started + intervalMs > timeoutMs) {
      return { ok: false, attempts, elapsedMs: Date.now() - started, lastStatus };
    }
    await sleep(intervalMs);
  }
}

/**
 * Every listener on the API port must be 127.0.0.1 and owned by the
 * FiyatUcuzApi process tree (WinSW service PID or one of its descendants).
 * Inputs come from Get-NetTCPConnection / Win32_Process / Win32_Service.
 */
export function validateListeners({ listeners, processes, servicePid, port = LISTEN_PORT }) {
  const errors = [];
  // PowerShell 5.1 may serialize a one-element array as a bare object.
  const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const rows = asList(listeners).filter((l) => Number(l.LocalPort) === port);
  if (rows.length === 0) errors.push(`nothing is listening on port ${port}`);
  const children = new Map();
  for (const p of asList(processes)) {
    const list = children.get(Number(p.ParentProcessId)) ?? [];
    list.push(Number(p.ProcessId));
    children.set(Number(p.ParentProcessId), list);
  }
  const tree = new Set();
  const stack = Number(servicePid) > 0 ? [Number(servicePid)] : [];
  while (stack.length) {
    const pid = stack.pop();
    if (tree.has(pid)) continue;
    tree.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  if (tree.size === 0) errors.push('service PID unknown');
  for (const l of rows) {
    if (!ALLOWED_LISTEN_ADDRESSES.includes(String(l.LocalAddress))) {
      errors.push(`port ${port} listening on disallowed address ${l.LocalAddress}`);
    }
    if (!tree.has(Number(l.OwningProcess))) {
      errors.push(
        `port ${port} owned by a process outside the ${SERVICE_NAME} tree (pid ${l.OwningProcess})`,
      );
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    addresses: [...new Set(rows.map((l) => String(l.LocalAddress)))],
  };
}

// ---------------------------------------------------------------------------
// Activation junctions — classification + one-step planning
// ---------------------------------------------------------------------------

/**
 * A junction entry is valid if it is a reparse-point junction whose target is
 * a direct child of releases\ (a release directory) or — only when explicitly
 * allowed — the legacy app directory. Real directories are never valid
 * activation entries.
 */
function entryStatus(entry, layout, { allowLegacy }) {
  if (!entry || !entry.exists) return 'absent';
  if (!entry.isJunction) return 'not-junction';
  const target = String(entry.target ?? '');
  if (!target || !win32.isAbsolute(target)) return 'bad-target';
  if (
    winEquals(win32.dirname(target), layout.releases) &&
    RELEASE_ID_RE.test(win32.basename(target))
  ) {
    return 'valid';
  }
  if (allowLegacy && winEquals(target, layout.legacyApp)) return 'valid';
  return 'bad-target';
}

/** Guard for removing an activation junction: never a real directory, never recursive. */
export function assertRemovableJunction(name, entry, layout, { allowLegacy = true } = {}) {
  if (!ACTIVATION_NAMES.includes(name)) {
    throw new DeployError('JUNCTION_GUARD', `"${name}" is not an activation junction name`);
  }
  const status = entryStatus(entry, layout, { allowLegacy });
  if (status === 'absent') throw new DeployError('JUNCTION_GUARD', `${name} does not exist`);
  if (status !== 'valid')
    throw new DeployError(
      'JUNCTION_GUARD',
      `${name} is not a removable activation junction (${status})`,
    );
  return true;
}

const step = (op, fields = {}) => ({ op, ...fields });

/**
 * Decide the NEXT single step for an activation or rollback, given a fresh
 * snapshot of { current, 'current.next', 'current.prev', 'current.failed' }
 * (each { exists, isJunction, target }). Callers execute one step, take a new
 * snapshot and ask again. Renames are marked requiresServiceStopped.
 *
 * intent: { kind: 'activate', target } | { kind: 'rollback', to }
 * Returns { op: 'done' | 'createNext' | 'removeJunction' | 'rename' | 'abort', … }.
 */
export function planActivationStep(snapshot, intent, layout, { allowLegacy = true } = {}) {
  const s = Object.fromEntries(
    ACTIVATION_NAMES.map((n) => [
      n,
      { entry: snapshot?.[n], status: entryStatus(snapshot?.[n], layout, { allowLegacy }) },
    ]),
  );
  for (const n of ACTIVATION_NAMES) {
    if (s[n].status === 'not-junction' || s[n].status === 'bad-target') {
      return step('abort', {
        reason: `${n} is ${s[n].status}`,
        status: FINAL_STATUS.CRITICAL_OPERATOR_ACTION,
      });
    }
  }
  const has = (n) => s[n].status === 'valid';
  const targetOf = (n) => (has(n) ? String(s[n].entry.target) : null);
  const is = (n, t) => has(n) && winEquals(targetOf(n), t);
  const abort = (reason) =>
    step('abort', { reason, status: FINAL_STATUS.CRITICAL_OPERATOR_ACTION });

  if (intent?.kind === 'activate') {
    const t = intent.target;
    if (
      !t ||
      !winEquals(win32.dirname(t), layout.releases) ||
      !RELEASE_ID_RE.test(win32.basename(t))
    ) {
      return abort('activation target is not a release directory');
    }
    if (is('current', t)) {
      return has('current.next') ? step('removeJunction', { name: 'current.next' }) : step('done');
    }
    if (!has('current')) {
      // Mid-swap: current already moved to prev, next not yet promoted.
      if (has('current.prev') && is('current.next', t)) {
        return step('rename', {
          from: 'current.next',
          to: 'current',
          requiresServiceStopped: true,
        });
      }
      return abort('current is missing and the state is not a recognizable mid-swap');
    }
    if (!has('current.next')) return step('createNext', { name: 'current.next', target: t });
    if (!is('current.next', t)) return abort('current.next points to a different release');
    if (has('current.prev')) return step('removeJunction', { name: 'current.prev' });
    return step('rename', { from: 'current', to: 'current.prev', requiresServiceStopped: true });
  }

  if (intent?.kind === 'rollback') {
    const to = intent.to;
    if (!to) return abort('rollback target missing');
    if (is('current', to)) {
      return has('current.next') ? step('removeJunction', { name: 'current.next' }) : step('done');
    }
    if (!has('current')) {
      if (is('current.prev', to)) {
        return step('rename', {
          from: 'current.prev',
          to: 'current',
          requiresServiceStopped: true,
        });
      }
      return abort('current is missing and current.prev is not the rollback target');
    }
    if (!is('current.prev', to)) return abort('current.prev is not the rollback target');
    if (has('current.failed')) return step('removeJunction', { name: 'current.failed' });
    return step('rename', { from: 'current', to: 'current.failed', requiresServiceStopped: true });
  }
  return abort('unknown intent');
}

/**
 * Read-only activation gate, evaluated BEFORE any migration: every pointer is
 * absent or a valid junction, current → a release, no current.next, target
 * differs from current, and the first planned step is createNext. A junction
 * state that is ambiguous must be found here, not after the database changed.
 */
export function precheckActivation(snapshot, target, layout) {
  const errors = [];
  for (const n of ACTIVATION_NAMES) {
    const st = entryStatus(snapshot?.[n], layout, { allowLegacy: false });
    if (st === 'not-junction' || st === 'bad-target') errors.push(`${n} is ${st}`);
  }
  const current = snapshot?.current;
  if (entryStatus(current, layout, { allowLegacy: false }) !== 'valid') {
    errors.push('current must be a junction to a release directory');
  }
  if (snapshot?.['current.next']?.exists) {
    errors.push('current.next already exists (interrupted deployment?)');
  }
  if (current?.target && target && winEquals(current.target, target)) {
    errors.push('target release is already active');
  }
  if (errors.length === 0) {
    const first = planActivationStep(snapshot, { kind: 'activate', target }, layout, {
      allowLegacy: false,
    });
    if (first.op !== 'createNext') {
      errors.push(`unexpected first activation step: ${first.op} ${first.reason ?? ''}`.trim());
    }
  }
  const ok = errors.length === 0;
  return { ok, errors, previous: ok ? String(current.target) : null };
}

/** Read-only rollback gate, evaluated BEFORE the service is stopped. */
export function precheckRollback(snapshot, to, layout, { allowLegacy = false } = {}) {
  const first = planActivationStep(snapshot, { kind: 'rollback', to }, layout, { allowLegacy });
  if (first.op === 'abort') return { ok: false, errors: [first.reason] };
  if (first.op === 'done') return { ok: false, errors: ['rollback target is already current'] };
  return { ok: true, errors: [] };
}

// ---------------------------------------------------------------------------
// Outcome / rollback decisions
// ---------------------------------------------------------------------------

// Phases before the service is touched, and phases after the swap began.
const PRE_SERVICE_PHASES = new Set([
  'preflight',
  'source',
  'materialize',
  'build',
  'verify',
  'seal',
  'acl',
  'precheck',
  'migration-status',
  'review',
  'backup',
  'migration',
  'stage',
  'receipt',
]);
const POST_SWAP_PHASES = new Set(['swap', 'start', 'health', 'listener']);

/**
 * Final status after a failure. Never claims a database rollback: whenever
 * the database may have changed (migration state SUCCEEDED / INCOMPLETE /
 * PARTIAL / UNKNOWN) a pre-service stop is FAILED_MIGRATION_PARTIAL and a
 * successful application rollback is ROLLED_BACK_APP_ONLY. A failed stop, a
 * failed restart, a failed rollback or an unknown phase is CRITICAL.
 */
export function decideFailureStatus({ phase, migrationState = 'NOT_NEEDED', rollback }) {
  const dbChanged = databaseMayHaveChanged(migrationState);
  if (PRE_SERVICE_PHASES.has(phase)) {
    return dbChanged ? FINAL_STATUS.FAILED_MIGRATION_PARTIAL : FINAL_STATUS.FAILED_NO_CHANGE;
  }
  if (POST_SWAP_PHASES.has(phase) && rollback?.ok === true) {
    return dbChanged ? FINAL_STATUS.ROLLED_BACK_APP_ONLY : FINAL_STATUS.ROLLED_BACK;
  }
  return FINAL_STATUS.CRITICAL_OPERATOR_ACTION;
}

/** Explicit, never-optimistic database wording for the receipt. */
export function databaseRollbackNote(status, { state = 'NOT_NEEDED', knownApplied = [] } = {}) {
  if (status === FINAL_STATUS.COMPLETED || !databaseMayHaveChanged(state)) return null;
  const ids = knownApplied.length > 0 ? knownApplied.join(', ') : 'none proven';
  const uncertain =
    state === 'UNKNOWN' || state === 'PARTIAL'
      ? ' The exact applied set may be incomplete; check db:migrate:status.'
      : '';
  return `DB NOT ROLLED BACK: migration state ${state}; known applied: ${ids}.${uncertain} Database restore is a manual operator procedure.`;
}

// ---------------------------------------------------------------------------
// Preflight checks
// ---------------------------------------------------------------------------

export function checkFreeSpace(freeBytes, min = MIN_FREE_BYTES) {
  const n = Number(freeBytes);
  return Number.isFinite(n) && n >= min
    ? { ok: true, errors: [] }
    : {
        ok: false,
        errors: [
          `free space ${Math.floor(n / 1024 ** 2)} MiB is below ${Math.floor(min / 1024 ** 2)} MiB`,
        ],
      };
}

export function checkRuntimeVersions({ nodeVersion, pnpmVersion, manifest }) {
  const errors = [];
  const nm = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(nodeVersion ?? '').trim());
  const req = /^>=\s*(\d+)$/.exec(String(manifest?.nodeVersionRequirement ?? ''));
  if (!nm) errors.push('node version unreadable');
  else if (Number(nm[1]) !== 22) errors.push(`node major must be 22 (got ${nm[1]})`);
  else if (req && Number(nm[1]) < Number(req[1]))
    errors.push('node does not satisfy the manifest requirement');
  if (String(pnpmVersion ?? '').trim() !== manifest?.pnpmVersion) {
    errors.push(`pnpm must be exactly ${manifest?.pnpmVersion}`);
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// ACL static validation (effective access is verified on Windows, 15A-7)
// ---------------------------------------------------------------------------

const P = Object.freeze({
  ADMINS: 'BUILTIN\\ADMINISTRATORS',
  SYSTEM: 'NT AUTHORITY\\SYSTEM',
  LOCAL_SERVICE: 'NT AUTHORITY\\LOCAL SERVICE',
});
const BROAD = new Set(['EVERYONE', 'BUILTIN\\USERS', 'NT AUTHORITY\\AUTHENTICATED USERS']);
const WRITE_RIGHTS =
  /FullControl|Modify|Write|AppendData|CreateFiles|CreateDirectories|Delete|ChangePermissions|TakeOwnership/i;
const READ_RIGHTS = /FullControl|Modify|Read|ReadAndExecute|ReadData|ListDirectory/i;

function normPrincipal(p) {
  const u = String(p ?? '').toUpperCase();
  return u === 'NT AUTHORITY\\LOCALSERVICE' ? P.LOCAL_SERVICE : u;
}

/** Expected model: key → { localService: 'none'|'read'|'modify', protected? } */
export function expectedAclModel(layout) {
  return [
    { key: 'root', path: layout.root, localService: 'read' },
    { key: 'releases', path: layout.releases, localService: 'read' },
    { key: 'runtime', path: layout.runtime, localService: 'read' },
    { key: 'config', path: layout.config, localService: 'none', protected: true },
    { key: 'apiEnv', path: layout.apiEnv, localService: 'read' },
    { key: 'migrationEnv', path: layout.migrationEnv, localService: 'none' },
    { key: 'staging', path: layout.staging, localService: 'none' },
    { key: 'deployments', path: layout.deployments, localService: 'none' },
    { key: 'feedArchive', path: layout.feedArchive, localService: 'modify' },
    { key: 'logsApi', path: layout.logsApi, localService: 'modify' },
  ];
}

/**
 * snapshot: [{ path, protected, rules: [{ identity, rights, type, inherited }] }]
 * (from Get-Acl). Static check of the intended model — NOT effective access.
 */
export function validateAclSnapshot(snapshot, layout) {
  const errors = [];
  const byPath = new Map((snapshot ?? []).map((e) => [win32.resolve(e.path).toLowerCase(), e]));
  for (const spec of expectedAclModel(layout)) {
    const e = byPath.get(win32.resolve(spec.path).toLowerCase());
    if (!e) {
      errors.push(`${spec.key}: ACL not captured`);
      continue;
    }
    if (spec.protected && e.protected !== true)
      errors.push(`${spec.key}: inheritance must be disabled`);
    const allow = (e.rules ?? []).filter((r) => String(r.type).toLowerCase() === 'allow');
    if ((e.rules ?? []).some((r) => String(r.type).toLowerCase() === 'deny'))
      errors.push(`${spec.key}: unexpected Deny rule`);
    const rightsFor = (principal) =>
      allow.filter((r) => normPrincipal(r.identity) === principal).map((r) => String(r.rights));
    for (const admin of [P.ADMINS, P.SYSTEM]) {
      if (!rightsFor(admin).some((r) => /FullControl/i.test(r)))
        errors.push(`${spec.key}: ${admin} must have FullControl`);
    }
    const ls = rightsFor(P.LOCAL_SERVICE);
    const lsRead = ls.some((r) => READ_RIGHTS.test(r));
    const lsWrite = ls.some((r) => WRITE_RIGHTS.test(r));
    if (spec.localService === 'none' && ls.length > 0)
      errors.push(`${spec.key}: LocalService must have no access`);
    if (spec.localService === 'read' && !lsRead)
      errors.push(`${spec.key}: LocalService needs read access`);
    if (spec.localService === 'read' && lsWrite)
      errors.push(`${spec.key}: LocalService must not have write access`);
    if (spec.localService === 'modify') {
      if (!ls.some((r) => /Modify/i.test(r))) errors.push(`${spec.key}: LocalService needs Modify`);
      if (ls.some((r) => /FullControl|ChangePermissions|TakeOwnership/i.test(r))) {
        errors.push(`${spec.key}: LocalService must not change ACLs/ownership`);
      }
    }
    for (const r of allow) {
      const who = normPrincipal(r.identity);
      if ([P.ADMINS, P.SYSTEM, P.LOCAL_SERVICE].includes(who)) continue;
      if (BROAD.has(who) && (spec.localService === 'none' || spec.key === 'apiEnv')) {
        errors.push(`${spec.key}: broad principal ${r.identity} must have no access`);
      } else if (WRITE_RIGHTS.test(String(r.rights))) {
        errors.push(`${spec.key}: ${r.identity} must not have write access`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Receipt — atomic, secret-free
// ---------------------------------------------------------------------------

const CREDENTIAL_PATTERN =
  /postgres(ql)?:\/\/|[a-z][a-z0-9+.-]*:\/\/[^\s/"@]*:[^\s/"@]*@|PGPASSWORD/i;

export function assertSecretFree(text, secrets = []) {
  if (CREDENTIAL_PATTERN.test(text) || secrets.some((s) => s.length >= 4 && text.includes(s))) {
    throw new DeployError(
      'RECEIPT_SECRET',
      'receipt content contains credential-like data; refusing to write',
    );
  }
}

export function createReceipt(init) {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    deploymentId: init.deploymentId,
    host: init.host,
    operator: init.operator,
    tool: init.tool ?? null,
    release: {
      id: init.releaseId,
      gitCommit: init.gitCommit,
      archiveSha256: init.archiveSha256 ?? null,
      manifestSha256: init.manifestSha256 ?? null,
      sealSha256: null,
    },
    previousRelease: init.previousRelease ?? null,
    backup: null,
    // state: see classifyMigrationApply; NOT_CHECKED until the status ran.
    migrations: {
      state: 'NOT_CHECKED',
      attempted: false,
      outcome: null,
      knownApplied: [],
      before: null,
      after: null,
      reviewed: [],
    },
    service: { before: null, after: null },
    junctions: { before: null, after: null },
    health: { local: null, external: 'not-checked' },
    listener: null,
    databaseNote: null,
    status: 'IN_PROGRESS',
    events: [],
  };
}

export function appendEvent(receipt, phase, result, at = new Date().toISOString()) {
  receipt.events.push({ at, phase, result });
  return receipt;
}

/**
 * Atomic replace: write a unique temp file in the same directory, fsync,
 * close, rename over the target. Throws DeployError('RECEIPT_WRITE') on any
 * failure (callers stop before the next mutation). `fsImpl` is injectable for
 * failure tests.
 */
export function writeReceiptAtomic(path, receipt, { secrets = [], fsImpl } = {}) {
  const fsx = fsImpl ?? { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync };
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  assertSecretFree(text, secrets);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  let fd = null;
  try {
    fd = fsx.openSync(tmp, 'wx');
    fsx.writeSync(fd, text);
    fsx.fsyncSync(fd);
    fsx.closeSync(fd);
    fd = null;
    fsx.renameSync(tmp, path);
  } catch {
    if (fd !== null) {
      try {
        fsx.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fsx.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw new DeployError('RECEIPT_WRITE', 'deployment receipt could not be written');
  }
}

// ---------------------------------------------------------------------------
// Retention — REPORT ONLY (nothing is ever deleted here)
// ---------------------------------------------------------------------------

export function retentionReport({ releasesDir, protectedTargets = [], keepPrevious = 2 }) {
  const names = readdirSync(releasesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && RELEASE_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  const protectedIds = new Set(protectedTargets.map((t) => win32.basename(String(t))));
  const kept = new Set(names.slice(0, keepPrevious + 1));
  return {
    deleted: [],
    releases: names.map((id) => ({
      id,
      protected: protectedIds.has(id),
      withinRetention: kept.has(id),
      eligibleForManualCleanup: !protectedIds.has(id) && !kept.has(id),
    })),
  };
}
