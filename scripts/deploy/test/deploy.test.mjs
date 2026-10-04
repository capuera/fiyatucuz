// Tests for the Windows deployment tooling (ADIM 15A-4, ADR-0021). Run with:
//   node --test scripts/deploy/test/deploy.test.mjs
//
// Everything runs locally in a tmpdir with FAKE executables (pg_dump,
// pg_restore, migration CLI) and a local HTTP server. No database, no service,
// no Windows host. Windows-only behaviour (junctions, ACLs, WinSW, PowerShell
// 5.1 runtime) is NOT VERIFIED here — deferred to ADIM 15A-7.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseTarListings,
  prepareRelease,
  sealRelease,
  validateArchiveEntries,
  verifySealedRelease,
} from '../../release/release-lib.mjs';
import {
  assertMigrationsReviewed,
  assertReleaseAbsent,
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
  FINAL_STATUS,
  parseEnvText,
  pgEnvFromMigrationEnv,
  planActivationStep,
  pollHealth,
  precheckActivation,
  precheckRollback,
  releasePaths,
  retentionReport,
  runBackup,
  runMigrationCli,
  sanitizedChildEnv,
  secretsOf,
  validateAclSnapshot,
  validateApiEnv,
  validateListeners,
  validateMigrationEnv,
  writeReceiptAtomic,
} from '../deploy-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DEPLOY_CLI = resolve(HERE, '..', 'deploy-cli.mjs');
const WINDOWS_DIR = resolve(HERE, '..', 'windows');
const NODE = process.execPath;
const clone = (v) => JSON.parse(JSON.stringify(v));

const scratch = mkdtempSync(join(tmpdir(), 'fiyatucuz-deploy-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const freshDir = (label) => {
  const d = join(scratch, `${label}-${(counter += 1)}`);
  mkdirSync(d, { recursive: true });
  return d;
};

const L = deploymentLayout('C:\\FiyatUcuz');
const REL_A = 'C:\\FiyatUcuz\\releases\\20261001-aaaaaaaaaaaa';
const REL_B = 'C:\\FiyatUcuz\\releases\\20261004-bbbbbbbbbbbb';
const REL_C = 'C:\\FiyatUcuz\\releases\\20260901-cccccccccccc';
const SECRET_PW = 'S3cr3t-Pa55w0rd-xyz';
const MIGRATION_URL = `postgres://fiyatucuz_migrator:${SECRET_PW}@127.0.0.1:5432/fiyatucuz`;

const env = (obj) =>
  parseEnvText(
    Object.entries(obj)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
const goodApiEnv = () => ({
  NODE_ENV: 'production',
  API_HOST: '127.0.0.1',
  API_PORT: '4000',
  DATABASE_URL: `postgres://fiyatucuz_app:${SECRET_PW}@127.0.0.1:5432/fiyatucuz`,
  FEED_ARCHIVE_LOCAL_ROOT: 'C:\\FiyatUcuz\\data\\feed-archive',
});
const goodMigrationEnv = () => ({
  DATABASE_MIGRATION_URL: MIGRATION_URL,
  DATABASE_MIGRATION_EXPECTED_DB: 'fiyatucuz',
});

/** Executable Node script (absolute shebang: does not depend on PATH). */
function fakeExe(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, `#!${NODE}\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

// ---------------------------------------------------------------------------
// Archive validation (listing-based, before extraction)
// ---------------------------------------------------------------------------

describe('archive validation', () => {
  const ok = (names) =>
    validateArchiveEntries(
      ['release-manifest.json', ...names].map((p) => ({ path: p, type: 'file' })),
    );

  it('accepts a normal listing, with or without a leading ./', () => {
    assert.equal(ok(['package.json', 'services/api/src/index.ts']).ok, true);
    const dotted = validateArchiveEntries([
      { path: './', type: 'directory' },
      { path: './release-manifest.json', type: 'file' },
      { path: './services/', type: 'directory' },
    ]);
    assert.deepEqual(dotted, { ok: true, errors: [] });
  });

  it('rejects traversal, absolute, drive, UNC and backslash paths', () => {
    for (const bad of [
      '../evil.js',
      'a/../../evil',
      '/etc/passwd',
      'C:/Windows/x',
      'c:evil',
      '\\\\host\\share\\x',
      'a\\b.js',
      'a/..\\..\\x',
      './../x',
      'a//b',
    ]) {
      const r = ok([bad]);
      assert.equal(r.ok, false, bad);
      assert.ok(
        r.errors.some((e) => /unsafe archive path/.test(e)),
        `${bad}: ${r.errors.join('|')}`,
      );
    }
  });

  it('rejects Windows-reinterpreted names (ADS, device names, trailing dot/space)', () => {
    for (const bad of [
      'a/file.js:stream',
      'a/CON',
      'a/nul.txt',
      'COM1.js',
      'a/b.',
      'a/b ',
      'a/x?y',
      'a/x\u0001',
    ]) {
      const r = ok([bad]);
      assert.ok(
        r.errors.some((e) => /unsafe archive path/.test(e)),
        `${JSON.stringify(bad)}: ${r.errors.join('|')}`,
      );
    }
    assert.equal(ok(['a/console.js', 'a/con-fig.js']).ok, true);
  });

  it('rejects case-insensitive duplicates and entries below a file', () => {
    assert.ok(ok(['a/B.js', 'a/b.js']).errors.some((e) => /duplicate/.test(e)));
    const below = validateArchiveEntries([
      { path: 'release-manifest.json', type: 'file' },
      { path: 'a', type: 'file' },
      { path: 'a/b.js', type: 'file' },
    ]);
    assert.ok(below.errors.some((e) => /below a file/.test(e)));
    const manifestDir = validateArchiveEntries([
      { path: 'release-manifest.json/', type: 'directory' },
    ]);
    assert.equal(manifestDir.ok, false);
  });

  it('rejects symlinks, hard links and other entry types', () => {
    for (const type of ['symlink', 'hardlink', 'other']) {
      const r = validateArchiveEntries([
        { path: 'release-manifest.json', type: 'file' },
        { path: 'services/link', type },
      ]);
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => /unsupported archive entry type/.test(e)));
    }
  });

  it('rejects forbidden files, duplicates and a missing manifest', () => {
    assert.ok(ok(['services/api/.env']).errors.some((e) => /forbidden/.test(e)));
    assert.ok(ok(['a.txt', './a.txt']).errors.some((e) => /duplicate/.test(e)));
    const noManifest = validateArchiveEntries([{ path: 'package.json', type: 'file' }]);
    assert.ok(noManifest.errors.some((e) => /release-manifest\.json/.test(e)));
  });

  it('pairs real tar -tf / -tvf output and detects a symlink entry', (t) => {
    const src = freshDir('tarsrc');
    writeFileSync(join(src, 'release-manifest.json'), '{}');
    mkdirSync(join(src, 'services'));
    writeFileSync(join(src, 'services', 'a.js'), '1');
    symlinkSync('../release-manifest.json', join(src, 'services', 'link'));
    const archive = join(freshDir('tar'), 'r.tgz');
    const c = spawnSync('tar', ['-czf', archive, '-C', src, '.'], { encoding: 'utf8' });
    if (c.status !== 0) return t.skip('tar not available');
    const names = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' }).stdout;
    const verbose = spawnSync('tar', ['-tvf', archive], { encoding: 'utf8' }).stdout;
    const entries = parseTarListings(names, verbose);
    assert.equal(entries.find((e) => e.path.endsWith('services/link')).type, 'symlink');
    assert.equal(entries.find((e) => e.path.endsWith('services/a.js')).type, 'file');
    assert.equal(validateArchiveEntries(entries).ok, false);
  });

  it('fails closed when the two listings disagree', () => {
    assert.throws(() => parseTarListings('a\nb\n', '-rw a\n'), /disagree/);
  });
});

// ---------------------------------------------------------------------------
// Seal
// ---------------------------------------------------------------------------

describe('release seal', () => {
  const SEAL_ID = '20261004-aaaaaaaaaaaa';
  function materializedRelease() {
    const parent = freshDir('sealrel');
    const releaseDir = join(parent, SEAL_ID);
    const { manifest, manifestSha256 } = prepareRelease({
      repoRoot: REPO_ROOT,
      outputDir: releaseDir,
      git: { head: 'a'.repeat(40), clean: true, commitTime: '2026-10-04T00:00:00Z' },
    });
    const pkg = join(releaseDir, 'node_modules/.pnpm/zod@3.25.76/node_modules/zod');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'index.js'), 'module.exports = {};');
    for (const rel of manifest.requiredBuildOutputs) {
      mkdirSync(dirname(join(releaseDir, rel)), { recursive: true });
      writeFileSync(join(releaseDir, rel), 'export {};');
    }
    return { releaseDir, sealPath: `${releaseDir}.seal.json`, manifest, manifestSha256 };
  }

  it('seals outside the release and verifies with the expected digest', () => {
    const r = materializedRelease();
    const { sealSha256 } = sealRelease({
      ...r,
      releaseId: '20261004-aaaaaaaaaaaa',
      expectedManifestSha256: r.manifestSha256,
    });
    assert.match(sealSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(verifySealedRelease({ ...r, expectedSealSha256: sealSha256 }), {
      ok: true,
      errors: [],
    });
  });

  it('refuses a seal path inside the release, an existing seal, or a wrong manifest digest', () => {
    const r = materializedRelease();
    assert.throws(
      () =>
        sealRelease({
          ...r,
          sealPath: join(r.releaseDir, 'seal.json'),
          releaseId: SEAL_ID,
          expectedManifestSha256: r.manifestSha256,
        }),
      /outside the release/,
    );
    assert.throws(
      () => sealRelease({ ...r, releaseId: SEAL_ID, expectedManifestSha256: 'f'.repeat(64) }),
      /refusing to seal/,
    );
    sealRelease({ ...r, releaseId: SEAL_ID, expectedManifestSha256: r.manifestSha256 });
    assert.throws(
      () => sealRelease({ ...r, releaseId: SEAL_ID, expectedManifestSha256: r.manifestSha256 }),
      /EEXIST/,
    );
  });

  it('detects tampering of build output, node_modules and the seal itself', () => {
    const r = materializedRelease();
    const { sealSha256 } = sealRelease({
      ...r,
      releaseId: SEAL_ID,
      expectedManifestSha256: r.manifestSha256,
    });

    const out = join(r.releaseDir, r.manifest.requiredBuildOutputs[0]);
    writeFileSync(out, 'export const evil = 1;');
    assert.ok(
      verifySealedRelease({ ...r, expectedSealSha256: sealSha256 }).errors.includes(
        'build outputs changed since sealing',
      ),
    );
    writeFileSync(out, 'export {};');

    writeFileSync(
      join(r.releaseDir, 'node_modules/.pnpm/zod@3.25.76/node_modules/zod/index.js'),
      'evil',
    );
    assert.equal(verifySealedRelease({ ...r, expectedSealSha256: sealSha256 }).ok, false);
    writeFileSync(
      join(r.releaseDir, 'node_modules/.pnpm/zod@3.25.76/node_modules/zod/index.js'),
      'module.exports = {};',
    );
    assert.equal(verifySealedRelease({ ...r, expectedSealSha256: sealSha256 }).ok, true);

    assert.ok(
      verifySealedRelease({ ...r, expectedSealSha256: 'e'.repeat(64) }).errors.includes(
        'seal SHA-256 mismatch',
      ),
    );
  });

  it('binds the seal to its release directory name', () => {
    const r = materializedRelease();
    assert.throws(
      () =>
        sealRelease({
          ...r,
          releaseId: '20261004-bbbbbbbbbbbb',
          expectedManifestSha256: r.manifestSha256,
        }),
      /directory name/,
    );
    // A seal copied next to a different release directory is rejected.
    const { sealSha256 } = sealRelease({
      ...r,
      releaseId: SEAL_ID,
      expectedManifestSha256: r.manifestSha256,
    });
    const other = materializedRelease();
    const moved = join(dirname(other.releaseDir), '20261004-cccccccccccc');
    fs.renameSync(other.releaseDir, moved);
    const res = verifySealedRelease({
      releaseDir: moved,
      sealPath: r.sealPath,
      expectedSealSha256: sealSha256,
    });
    assert.ok(res.errors.includes('seal belongs to a different release'), res.errors.join('|'));
  });

  it('records links without following them and refuses links that escape the release', () => {
    const r = materializedRelease();
    const nm = join(r.releaseDir, 'node_modules');
    symlinkSync('.pnpm/zod@3.25.76/node_modules/zod', join(nm, 'zod'));
    const { sealSha256 } = sealRelease({
      ...r,
      releaseId: SEAL_ID,
      expectedManifestSha256: r.manifestSha256,
    });
    assert.equal(verifySealedRelease({ ...r, expectedSealSha256: sealSha256 }).ok, true);
    // Retargeting a link inside node_modules is detected.
    fs.unlinkSync(join(nm, 'zod'));
    symlinkSync('.pnpm', join(nm, 'zod'));
    assert.ok(
      verifySealedRelease({ ...r, expectedSealSha256: sealSha256 }).errors.includes(
        'node_modules changed since sealing',
      ),
    );

    const esc = materializedRelease();
    symlinkSync(tmpdir(), join(esc.releaseDir, 'node_modules', 'escape'));
    assert.throws(
      () => sealRelease({ ...esc, releaseId: SEAL_ID, expectedManifestSha256: esc.manifestSha256 }),
      /outside the release/,
    );
  });

  it('detects an added build file or directory under dist', () => {
    const r = materializedRelease();
    const { sealSha256 } = sealRelease({
      ...r,
      releaseId: SEAL_ID,
      expectedManifestSha256: r.manifestSha256,
    });
    const dist = join(r.releaseDir, 'services/api/dist');
    mkdirSync(join(dist, 'injected'));
    assert.equal(verifySealedRelease({ ...r, expectedSealSha256: sealSha256 }).ok, false);
    rmSync(join(dist, 'injected'), { recursive: true });
    writeFileSync(join(dist, 'extra.js'), 'evil');
    assert.equal(verifySealedRelease({ ...r, expectedSealSha256: sealSha256 }).ok, false);
  });

  it('detects a source/manifest change after sealing', () => {
    const r = materializedRelease();
    const { sealSha256 } = sealRelease({
      ...r,
      releaseId: SEAL_ID,
      expectedManifestSha256: r.manifestSha256,
    });
    writeFileSync(
      join(r.releaseDir, 'release-manifest.json'),
      `${readFileSync(join(r.releaseDir, 'release-manifest.json'), 'utf8')} `,
    );
    assert.equal(verifySealedRelease({ ...r, expectedSealSha256: sealSha256 }).ok, false);
  });
});

// ---------------------------------------------------------------------------
// Release identity
// ---------------------------------------------------------------------------

describe('release id', () => {
  it('is derived from the commit date (UTC) and SHA', () => {
    const id = deriveReleaseId({
      gitCommit: `abcdef012345${'0'.repeat(28)}`,
      createdAt: '2026-10-04T01:00:00+03:00',
    });
    assert.equal(id, '20261003-abcdef012345');
  });

  it('rejects invalid manifests and unsafe ids', () => {
    assert.throws(
      () => deriveReleaseId({ gitCommit: 'xyz', createdAt: '2026-10-04' }),
      DeployError,
    );
    assert.throws(
      () => deriveReleaseId({ gitCommit: 'a'.repeat(40), createdAt: 'nope' }),
      DeployError,
    );
    for (const bad of ['..\\x', '20261004-AAAAAAAAAAAA', '20261004-aaaa', 'current']) {
      assert.throws(() => releasePaths(L, bad), /invalid release id/);
    }
    assert.equal(releasePaths(L, '20261004-bbbbbbbbbbbb').seal, `${REL_B}.seal.json`);
  });

  it('refuses to reuse an existing release directory', () => {
    assert.throws(
      () => assertReleaseAbsent(true),
      (e) => e.code === 'RELEASE_EXISTS',
    );
    assert.doesNotThrow(() => assertReleaseAbsent(false));
  });
});

// ---------------------------------------------------------------------------
// Env policy
// ---------------------------------------------------------------------------

describe('env policy', () => {
  it('accepts the expected API env', () => {
    assert.deepEqual(validateApiEnv(env(goodApiEnv()), L), { ok: true, errors: [] });
  });

  it('requires keys and exact NODE_ENV / API_HOST / API_PORT', () => {
    const r = validateApiEnv(env({}), L);
    for (const k of [
      'NODE_ENV',
      'API_HOST',
      'API_PORT',
      'DATABASE_URL',
      'FEED_ARCHIVE_LOCAL_ROOT',
    ]) {
      assert.ok(
        r.errors.some((e) => e.startsWith(k)),
        k,
      );
    }
    for (const [k, v] of [
      ['NODE_ENV', 'Production'],
      ['NODE_ENV', 'development'],
      ['API_HOST', '0.0.0.0'],
      ['API_HOST', '::'],
      ['API_PORT', '4001'],
    ]) {
      const e = validateApiEnv(env({ ...goodApiEnv(), [k]: v }), L);
      assert.equal(e.ok, false, `${k}=${v}`);
    }
  });

  it('forbids migration keys in the API env and a feed archive inside releases/config', () => {
    const r = validateApiEnv(env({ ...goodApiEnv(), DATABASE_MIGRATION_URL: MIGRATION_URL }), L);
    assert.ok(r.errors.some((e) => /DATABASE_MIGRATION_URL must not/.test(e)));
    for (const p of [
      'C:\\FiyatUcuz\\releases\\x',
      'C:\\FiyatUcuz\\current\\data',
      'C:\\FiyatUcuz\\config\\a',
      'data\\rel',
      '\\\\srv\\share',
    ]) {
      assert.equal(
        validateApiEnv(env({ ...goodApiEnv(), FEED_ARCHIVE_LOCAL_ROOT: p }), L).ok,
        false,
        p,
      );
    }
  });

  it('migration env: requires migration keys, forbids DATABASE_URL', () => {
    assert.deepEqual(validateMigrationEnv(env(goodMigrationEnv())), { ok: true, errors: [] });
    const r = validateMigrationEnv(env({ DATABASE_URL: MIGRATION_URL }));
    assert.ok(r.errors.some((e) => /DATABASE_MIGRATION_URL is missing/.test(e)));
    assert.ok(r.errors.some((e) => /EXPECTED_DB is missing/.test(e)));
    assert.ok(r.errors.some((e) => /DATABASE_URL must not/.test(e)));
    assert.equal(
      validateMigrationEnv(
        env({ ...goodMigrationEnv(), DATABASE_MIGRATION_URL: 'mysql://a:b@h/d' }),
      ).ok,
      false,
    );
  });

  it('error messages and CLI output never contain secret values', () => {
    const bad = { ...goodApiEnv(), NODE_ENV: SECRET_PW, DATABASE_MIGRATION_URL: MIGRATION_URL };
    const r = validateApiEnv(env(bad), L);
    assert.ok(!JSON.stringify(r).includes(SECRET_PW));
    const file = join(freshDir('env'), 'api.env');
    writeFileSync(
      file,
      Object.entries(bad)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    );
    const cli = spawnSync(
      NODE,
      [DEPLOY_CLI, 'validate-api-env', '--file', file, '--root', 'C:\\FiyatUcuz'],
      { encoding: 'utf8' },
    );
    assert.equal(cli.status, 1);
    assert.ok(!cli.stdout.includes(SECRET_PW) && !cli.stderr.includes(SECRET_PW));
  });
});

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

describe('receipt', () => {
  const init = {
    deploymentId: 'd1',
    host: 'h',
    operator: 'o',
    releaseId: '20261004-bbbbbbbbbbbb',
    gitCommit: 'a'.repeat(40),
  };

  it('is written atomically (no temp file left) and replaces the previous version', () => {
    const dir = freshDir('receipt');
    const file = join(dir, 'd1.json');
    writeReceiptAtomic(file, createReceipt(init));
    const r = createReceipt(init);
    r.status = 'COMPLETED';
    writeReceiptAtomic(file, r);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'COMPLETED');
    assert.deepEqual(readdirSync(dir), ['d1.json']);
  });

  it('a failed write leaves the old receipt intact, removes the temp file and throws RECEIPT_WRITE', () => {
    const dir = freshDir('receipt');
    const file = join(dir, 'd1.json');
    writeReceiptAtomic(file, createReceipt(init));
    const before = readFileSync(file, 'utf8');
    const failing = {
      ...fs,
      renameSync: () => {
        throw new Error('disk full');
      },
    };
    assert.throws(
      () => writeReceiptAtomic(file, { ...createReceipt(init), status: 'X' }, { fsImpl: failing }),
      (e) => e.code === 'RECEIPT_WRITE',
    );
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(readdirSync(dir), ['d1.json']);
  });

  it('refuses credential-like content and known secret values', () => {
    const file = join(freshDir('receipt'), 'r.json');
    const r = createReceipt(init);
    r.tool = { note: MIGRATION_URL };
    assert.throws(
      () => writeReceiptAtomic(file, r),
      (e) => e.code === 'RECEIPT_SECRET',
    );
    const r2 = createReceipt(init);
    r2.tool = { note: `x ${SECRET_PW} y` };
    assert.throws(
      () => writeReceiptAtomic(file, r2, { secrets: [SECRET_PW] }),
      (e) => e.code === 'RECEIPT_SECRET',
    );
    assert.equal(existsSync(file), false);
  });

  it('CLI receipt-init fails (exit 1, nothing written) when the directory is missing', () => {
    const dir = freshDir('receipt');
    const initFile = join(dir, 'init.json');
    writeFileSync(initFile, JSON.stringify(init));
    const target = join(dir, 'missing', 'r.json');
    const cli = spawnSync(
      NODE,
      [DEPLOY_CLI, 'receipt-init', '--file', target, '--init', initFile],
      { encoding: 'utf8' },
    );
    assert.equal(cli.status, 1);
    assert.equal(JSON.parse(cli.stdout).code, 'RECEIPT_WRITE');
    assert.equal(existsSync(target), false);
  });
});

// ---------------------------------------------------------------------------
// Backup (fake pg_dump / pg_restore)
// ---------------------------------------------------------------------------

describe('backup', () => {
  function fakes(dir, { dump = 'ok', restore = 'ok' } = {}) {
    const record = join(dir, 'record.json');
    const pgDump = fakeExe(
      dir,
      'pg_dump',
      `const fs = require('fs');
const out = process.argv[process.argv.indexOf('--file') + 1];
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
if (${JSON.stringify(dump)} === 'fail') { process.stderr.write('connection failed for password ' + process.env.PGPASSWORD + '\\n'); process.exit(1); }
fs.writeFileSync(out, ${JSON.stringify(dump)} === 'empty' ? '' : 'PGDMP fake custom dump');`,
    );
    const pgRestore = fakeExe(
      dir,
      'pg_restore',
      `if (${JSON.stringify(restore)} === 'fail') process.exit(1); process.stdout.write('; Archive created\\n');`,
    );
    return { pgDump, pgRestore, record };
  }
  const parent = {
    PATH: process.env.PATH,
    DATABASE_URL: 'postgres://x:leak@h/d',
    PGPASSWORD: 'parent-leak',
    SECRET_TOKEN: 'zzz',
  };

  it('success: password only in the child env (PG*), never in argv; dump verified with pg_restore --list', () => {
    const dir = freshDir('backup');
    const f = fakes(dir);
    const outFile = join(dir, 'b.dump');
    const r = runBackup({
      pgDump: f.pgDump,
      pgRestore: f.pgRestore,
      migrationEnv: env(goodMigrationEnv()),
      outFile,
      parentEnv: parent,
    });
    assert.equal(r.restoreListOk, true);
    assert.ok(r.bytes > 0);
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
    const rec = JSON.parse(readFileSync(f.record, 'utf8'));
    assert.deepEqual(rec.argv, ['--format=custom', '--no-password', '--file', outFile]);
    assert.ok(!rec.argv.join(' ').includes(SECRET_PW));
    assert.equal(rec.env.PGPASSWORD, SECRET_PW);
    assert.equal(rec.env.PGDATABASE, 'fiyatucuz');
    assert.equal(rec.env.DATABASE_URL, undefined);
    assert.equal(rec.env.SECRET_TOKEN, undefined);
    assert.ok(!JSON.stringify(r).includes(SECRET_PW));
  });

  it('pg_dump failure: BACKUP_FAILED with the password redacted', () => {
    const dir = freshDir('backup');
    const f = fakes(dir, { dump: 'fail' });
    assert.throws(
      () =>
        runBackup({
          pgDump: f.pgDump,
          pgRestore: f.pgRestore,
          migrationEnv: env(goodMigrationEnv()),
          outFile: join(dir, 'b.dump'),
          parentEnv: parent,
        }),
      (e) => e.code === 'BACKUP_FAILED' && !e.message.includes(SECRET_PW),
    );
  });

  it('empty dump, unreadable dump, existing file and DB mismatch all fail', () => {
    const dir = freshDir('backup');
    const e1 = fakes(freshDir('b1'), { dump: 'empty' });
    assert.throws(
      () =>
        runBackup({
          ...e1,
          migrationEnv: env(goodMigrationEnv()),
          outFile: join(dir, '1.dump'),
          parentEnv: parent,
        }),
      /empty/,
    );
    const e2 = fakes(freshDir('b2'), { restore: 'fail' });
    assert.throws(
      () =>
        runBackup({
          ...e2,
          migrationEnv: env(goodMigrationEnv()),
          outFile: join(dir, '2.dump'),
          parentEnv: parent,
        }),
      /pg_restore/,
    );
    writeFileSync(join(dir, '3.dump'), 'old');
    assert.throws(
      () =>
        runBackup({
          ...e2,
          migrationEnv: env(goodMigrationEnv()),
          outFile: join(dir, '3.dump'),
          parentEnv: parent,
        }),
      (e) => e.code === 'BACKUP_EXISTS',
    );
    const mismatch = env({ ...goodMigrationEnv(), DATABASE_MIGRATION_EXPECTED_DB: 'other' });
    assert.throws(
      () =>
        runBackup({
          ...e2,
          migrationEnv: mismatch,
          outFile: join(dir, '4.dump'),
          parentEnv: parent,
        }),
      (e) => e.code === 'BACKUP_TARGET_MISMATCH',
    );
  });
});

// ---------------------------------------------------------------------------
// Migration wrapper (fake compiled migration CLI)
// ---------------------------------------------------------------------------

describe('migration wrapper', () => {
  /** A fake packages/db dist CLI with the real CLI's output format. */
  function fakeMigrationCli(dir) {
    const cli = join(dir, 'migrate.js');
    writeFileSync(
      cli,
      `const fs = require('fs');
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
fs.writeFileSync(process.env.FAKE_STATE + '.env.json', JSON.stringify({ env: process.env, argv: process.argv.slice(2) }));
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'lock') { process.stderr.write('MigrationLockUnavailableError: lock busy\\n'); process.exit(1); }
if (mode === 'mismatch') { process.stderr.write('MigrationTargetMismatchError: wrong db\\n'); process.exit(1); }
if (process.argv.includes('--status')) {
  if (state.broken) { process.stderr.write('Error: connection lost\\n'); process.exit(1); }
  console.log('[db:migrate] applied (' + state.applied.length + '):'); state.applied.forEach((m) => console.log('  ' + m));
  console.log('[db:migrate] pending (' + state.pending.length + '):'); state.pending.forEach((m) => console.log('  ' + m));
  process.exit(0);
}
if (mode === 'fail-after-first') {
  const first = state.pending.shift(); state.applied.push(first);
  fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(state));
  console.log('[db:migrate] Applied ' + first);
  process.stderr.write('PostgresError: syntax error\\n'); process.exit(1);
}
if (mode === 'fail-before') { process.stderr.write('PostgresError: permission denied\\n'); process.exit(1); }
if (mode === 'leave-one') {
  const first = state.pending.shift(); state.applied.push(first);
  fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(state));
  console.log('[db:migrate] Applied ' + first); process.exit(0);
}
if (mode === 'crash-and-break') {
  state.applied.push(state.pending.shift()); state.broken = true;
  fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(state));
  process.stderr.write('Error: connection lost\\n'); process.exit(1);
}
for (const m of state.pending) console.log('[db:migrate] Applied ' + m);
state.applied.push(...state.pending); state.pending = [];
fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(state));`,
    );
    return cli;
  }

  function setup({ applied = ['0001_a.sql'], pending = ['0002_b.sql'], mode = 'ok' } = {}) {
    const dir = freshDir('mig');
    const state = join(dir, 'state.json');
    writeFileSync(state, JSON.stringify({ applied, pending }));
    const envFile = join(dir, 'migration.env');
    writeFileSync(
      envFile,
      [
        `DATABASE_MIGRATION_URL=${MIGRATION_URL}`,
        'DATABASE_MIGRATION_EXPECTED_DB=fiyatucuz',
        `FAKE_STATE=${state}`,
        `FAKE_MODE=${mode}`,
      ].join('\n'),
    );
    return { dir, state, envFile, cli: fakeMigrationCli(dir) };
  }
  const parentEnv = {
    PATH: process.env.PATH,
    DATABASE_URL: 'postgres://app:runtime-pw@h/d',
    DATABASE_MIGRATION_URL: 'postgres://evil:x@evil/evil',
    PGPASSWORD: 'p',
  };

  it('status parses applied/pending; the child env is sanitized (credentials only via --env-file)', () => {
    const s = setup();
    const r = runMigrationCli({
      node: NODE,
      migrateCli: s.cli,
      migrationEnvFile: s.envFile,
      mode: 'status',
      parentEnv,
      secrets: [SECRET_PW],
    });
    assert.deepEqual([r.ok, r.applied, r.pending], [true, ['0001_a.sql'], ['0002_b.sql']]);
    const child = JSON.parse(readFileSync(`${s.state}.env.json`, 'utf8'));
    assert.equal(
      child.env.DATABASE_URL,
      undefined,
      'runtime DATABASE_URL must not leak into the migration child',
    );
    assert.equal(child.env.PGPASSWORD, undefined);
    assert.equal(
      child.env.DATABASE_MIGRATION_URL,
      MIGRATION_URL,
      'parent value must not shadow the env file',
    );
    assert.ok(!child.argv.join(' ').includes(SECRET_PW));
  });

  it('lock busy and expected-DB mismatch are classified', () => {
    const lock = setup({ mode: 'lock' });
    assert.equal(
      runMigrationCli({
        node: NODE,
        migrateCli: lock.cli,
        migrationEnvFile: lock.envFile,
        mode: 'status',
        parentEnv,
      }).outcome,
      'LOCK_BUSY',
    );
    const mm = setup({ mode: 'mismatch' });
    assert.equal(
      runMigrationCli({
        node: NODE,
        migrateCli: mm.cli,
        migrationEnvFile: mm.envFile,
        mode: 'apply',
        parentEnv,
      }).outcome,
      'TARGET_MISMATCH',
    );
  });

  it('review gate: applying requires exactly the pending set', () => {
    assert.throws(
      () => assertMigrationsReviewed(['0002_b.sql'], []),
      (e) => e.code === 'MIGRATION_REVIEW_REQUIRED',
    );
    assert.throws(
      () => assertMigrationsReviewed(['0002_b.sql', '0003_c.sql'], ['0002_b.sql']),
      /reviewed/,
    );
    assert.doesNotThrow(() => assertMigrationsReviewed(['0002_b.sql'], ['0002_b.sql']));
    assert.doesNotThrow(() => assertMigrationsReviewed([], []));
  });

  const cliRun = (s, mode, reviewed) => {
    const r = spawnSync(
      NODE,
      [
        DEPLOY_CLI,
        'migration',
        '--mode',
        mode,
        '--node',
        NODE,
        '--cli',
        s.cli,
        '--env-file',
        s.envFile,
        ...(reviewed ? ['--reviewed', reviewed] : []),
      ],
      { encoding: 'utf8' },
    );
    assert.ok(
      !r.stdout.includes(SECRET_PW) && !r.stderr.includes(SECRET_PW),
      'secret in CLI output',
    );
    return { code: r.status, out: JSON.parse(r.stdout) };
  };
  const pendingOf = (s) => JSON.parse(readFileSync(s.state, 'utf8')).pending;

  it('A: nothing pending → NOT_NEEDED, nothing attempted', () => {
    const s = setup({ pending: [] });
    const { code, out } = cliRun(s, 'apply');
    assert.deepEqual(
      [code, out.outcome, out.state, out.attempted],
      [0, 'NOTHING_PENDING', 'NOT_NEEDED', false],
    );
  });

  it('review gate: missing/partial review applies nothing (NOT_ATTEMPTED); review mode never applies', () => {
    const s = setup({ pending: ['0002_b.sql', '0003_c.sql'] });
    for (const reviewed of [undefined, '0002_b.sql']) {
      const { code, out } = cliRun(s, 'apply', reviewed);
      assert.deepEqual(
        [code, out.outcome, out.state, out.attempted],
        [1, 'MIGRATION_REVIEW_REQUIRED', 'NOT_ATTEMPTED', false],
      );
    }
    const review = cliRun(s, 'review', '0003_c.sql,0002_b.sql');
    assert.deepEqual([review.code, review.out.outcome], [0, 'REVIEWED']);
    assert.deepEqual(pendingOf(s), ['0002_b.sql', '0003_c.sql']);
  });

  it('B: success → SUCCEEDED with the applied IDs from the status diff', () => {
    const s = setup();
    const { code, out } = cliRun(s, 'apply', '0002_b.sql');
    assert.deepEqual(
      [code, out.outcome, out.state, out.knownApplied, out.after.pending],
      [0, 'OK', 'SUCCEEDED', ['0002_b.sql'], []],
    );
  });

  it('C: failure before applying anything → FAILED_NO_CHANGE (proven by the after-status)', () => {
    const s = setup({ mode: 'fail-before' });
    const { code, out } = cliRun(s, 'apply', '0002_b.sql');
    assert.deepEqual(
      [code, out.outcome, out.state, out.attempted, out.knownApplied],
      [1, 'FAILED', 'FAILED_NO_CHANGE', true, []],
    );
    assert.equal(
      decideFailureStatus({ phase: 'migration', migrationState: out.state }),
      FINAL_STATUS.FAILED_NO_CHANGE,
    );
  });

  it('D: partial apply then failure → PARTIAL with the known applied IDs', () => {
    const s = setup({ pending: ['0002_b.sql', '0003_c.sql'], mode: 'fail-after-first' });
    const { code, out } = cliRun(s, 'apply', '0002_b.sql,0003_c.sql');
    assert.deepEqual(
      [code, out.outcome, out.state, out.knownApplied, out.after.pending],
      [1, 'FAILED', 'PARTIAL', ['0002_b.sql'], ['0003_c.sql']],
    );
    assert.equal(
      decideFailureStatus({ phase: 'migration', migrationState: out.state }),
      FINAL_STATUS.FAILED_MIGRATION_PARTIAL,
    );
    assert.match(
      databaseRollbackNote(FINAL_STATUS.FAILED_MIGRATION_PARTIAL, out),
      /^DB NOT ROLLED BACK: .*PARTIAL.*0002_b\.sql/,
    );
  });

  it('E: CLI succeeds but migrations are still pending → INCOMPLETE (exit 1)', () => {
    const s = setup({ pending: ['0002_b.sql', '0003_c.sql'], mode: 'leave-one' });
    const { code, out } = cliRun(s, 'apply', '0002_b.sql,0003_c.sql');
    assert.deepEqual([code, out.state, out.knownApplied], [1, 'INCOMPLETE', ['0002_b.sql']]);
    assert.equal(
      decideFailureStatus({ phase: 'migration', migrationState: out.state }),
      FINAL_STATUS.FAILED_MIGRATION_PARTIAL,
    );
  });

  it('unprovable state (apply and after-status both fail) → UNKNOWN, treated as changed', () => {
    const s = setup({ mode: 'crash-and-break' });
    const { code, out } = cliRun(s, 'apply', '0002_b.sql');
    assert.deepEqual([code, out.state, out.after], [1, 'UNKNOWN', null]);
    assert.equal(
      decideFailureStatus({ phase: 'migration', migrationState: 'UNKNOWN' }),
      FINAL_STATUS.FAILED_MIGRATION_PARTIAL,
    );
    assert.match(
      databaseRollbackNote(FINAL_STATUS.FAILED_MIGRATION_PARTIAL, { state: 'UNKNOWN' }),
      /none proven.*may be incomplete/,
    );
  });

  it('classification: CLI "Applied" lines are a lower bound when no after-status exists', () => {
    const before = { ok: true, applied: ['a.sql'], pending: ['b.sql', 'c.sql'] };
    assert.deepEqual(
      classifyMigrationApply({
        before,
        apply: { ok: false, applied: ['b.sql'] },
        after: { ok: false },
      }),
      {
        state: 'PARTIAL',
        attempted: true,
        knownApplied: ['b.sql'],
      },
    );
    assert.equal(
      classifyMigrationApply({
        before,
        apply: { ok: true, applied: ['b.sql', 'c.sql'] },
        after: { ok: false },
      }).state,
      'UNKNOWN',
    );
    assert.equal(classifyMigrationApply({ before, apply: null }).state, 'NOT_ATTEMPTED');
    assert.equal(classifyMigrationApply({ before: { ok: false } }).state, 'UNKNOWN');
  });

  it('F/G: after a successful migration, any later failure is never reported as no-change', () => {
    for (const phase of ['precheck', 'stage', 'receipt']) {
      assert.equal(
        decideFailureStatus({ phase, migrationState: 'SUCCEEDED' }),
        FINAL_STATUS.FAILED_MIGRATION_PARTIAL,
        phase,
      );
    }
    for (const phase of ['swap', 'start', 'health', 'listener']) {
      assert.equal(
        decideFailureStatus({ phase, migrationState: 'SUCCEEDED', rollback: { ok: true } }),
        FINAL_STATUS.ROLLED_BACK_APP_ONLY,
        phase,
      );
      assert.equal(
        decideFailureStatus({ phase, migrationState: 'SUCCEEDED', rollback: { ok: false } }),
        FINAL_STATUS.CRITICAL_OPERATOR_ACTION,
        phase,
      );
    }
    assert.match(
      databaseRollbackNote(FINAL_STATUS.ROLLED_BACK_APP_ONLY, {
        state: 'SUCCEEDED',
        knownApplied: ['0002_b.sql'],
      }),
      /^DB NOT ROLLED BACK/,
    );
  });
});

// ---------------------------------------------------------------------------
// Health + listener
// ---------------------------------------------------------------------------

describe('health and listener', () => {
  async function server(handler) {
    const s = createServer(handler);
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    return {
      url: `http://127.0.0.1:${s.address().port}/health`,
      close: () => new Promise((r) => s.close(r)),
    };
  }

  it('polls until healthy', async () => {
    let n = 0;
    const s = await server((req, res) => {
      n += 1;
      if (n < 3) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    });
    try {
      const r = await pollHealth({ url: s.url, timeoutMs: 5000, intervalMs: 50 });
      assert.equal(r.ok, true);
      assert.equal(r.attempts, 3);
    } finally {
      await s.close();
    }
  });

  it('times out on persistent failure or a non-ok body', async () => {
    const s = await server((req, res) => res.writeHead(200).end('{"status":"degraded"}'));
    try {
      const r = await pollHealth({ url: s.url, timeoutMs: 300, intervalMs: 50 });
      assert.equal(r.ok, false);
    } finally {
      await s.close();
    }
    const unreachable = await pollHealth({
      url: 'http://127.0.0.1:9/health',
      timeoutMs: 200,
      intervalMs: 50,
    });
    assert.deepEqual([unreachable.ok, unreachable.lastStatus], [false, 'unreachable']);
  });

  it('CLI health refuses non-local URLs (public health is not a gate)', () => {
    const r = spawnSync(NODE, [DEPLOY_CLI, 'health', '--url', 'https://api.fiyatucuz.com/health'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 2);
  });

  const procs = [
    { ProcessId: 100, ParentProcessId: 4 },
    { ProcessId: 200, ParentProcessId: 100 },
    { ProcessId: 999, ParentProcessId: 4 },
  ];

  it('accepts 127.0.0.1:4000 owned by the service process tree', () => {
    const r = validateListeners({
      listeners: [{ LocalAddress: '127.0.0.1', LocalPort: 4000, OwningProcess: 200 }],
      processes: procs,
      servicePid: 100,
    });
    assert.deepEqual(r.errors, []);
  });

  it('rejects wildcard/IPv6/LAN binds, foreign owners and no listener', () => {
    for (const addr of ['0.0.0.0', '::', '::1', '192.168.1.10']) {
      const r = validateListeners({
        listeners: [{ LocalAddress: addr, LocalPort: 4000, OwningProcess: 200 }],
        processes: procs,
        servicePid: 100,
      });
      assert.equal(r.ok, false, addr);
    }
    const foreign = validateListeners({
      listeners: [{ LocalAddress: '127.0.0.1', LocalPort: 4000, OwningProcess: 999 }],
      processes: procs,
      servicePid: 100,
    });
    assert.ok(foreign.errors.some((e) => /outside/.test(e)));
    assert.equal(validateListeners({ listeners: [], processes: procs, servicePid: 100 }).ok, false);
  });
});

// ---------------------------------------------------------------------------
// Activation / rollback state machine (simulated junction filesystem)
// ---------------------------------------------------------------------------

describe('activation and rollback', () => {
  const J = (target) => ({ exists: true, isJunction: true, target });
  const ABSENT = { exists: false, isJunction: false, target: null };
  const snap = (o = {}) => ({
    current: ABSENT,
    'current.next': ABSENT,
    'current.prev': ABSENT,
    'current.failed': ABSENT,
    ...o,
  });

  /** Execute planned steps against an in-memory snapshot, as the PS module does. */
  function drive(
    state,
    intent,
    { serviceStopped = true, failAfter = Infinity, allowLegacy = false } = {},
  ) {
    const s = clone(state);
    const ops = [];
    for (let i = 0; i < 10; i += 1) {
      const p = planActivationStep(s, intent, L, { allowLegacy });
      if (p.op === 'done' || p.op === 'abort') return { s, ops, final: p };
      if (ops.length >= failAfter) return { s, ops, final: { op: 'interrupted' } };
      if (p.op === 'rename' && p.requiresServiceStopped && !serviceStopped)
        return { s, ops, final: { op: 'needsStop' } };
      ops.push(p.op === 'rename' ? `rename ${p.from}->${p.to}` : `${p.op} ${p.name}`);
      if (p.op === 'createNext') s['current.next'] = J(p.target);
      else if (p.op === 'removeJunction') s[p.name] = ABSENT;
      else if (p.op === 'rename') {
        s[p.to] = s[p.from];
        s[p.from] = ABSENT;
      }
    }
    throw new Error('did not converge');
  }

  it('activation: stage next while running, stop, swap; releases are never touched', () => {
    const staged = drive(
      snap({
        current: J(REL_A),
        'current.prev': J('C:\\FiyatUcuz\\releases\\20260901-cccccccccccc'),
      }),
      { kind: 'activate', target: REL_B },
      { serviceStopped: false },
    );
    assert.deepEqual(staged.ops, ['createNext current.next', 'removeJunction current.prev']);
    assert.equal(staged.final.op, 'needsStop');
    const done = drive(staged.s, { kind: 'activate', target: REL_B });
    assert.deepEqual(done.ops, ['rename current->current.prev', 'rename current.next->current']);
    assert.equal(done.s.current.target, REL_B);
    assert.equal(done.s['current.prev'].target, REL_A);
  });

  it('an interrupted swap is resumable (mid-swap state recognized)', () => {
    const mid = drive(
      snap({ current: J(REL_A) }),
      { kind: 'activate', target: REL_B },
      { failAfter: 2 },
    );
    assert.equal(mid.s.current.exists, false);
    const resumed = drive(mid.s, { kind: 'activate', target: REL_B });
    assert.equal(resumed.s.current.target, REL_B);
  });

  it('rollback restores the previous release from current.prev (also mid-swap)', () => {
    const after = snap({ current: J(REL_B), 'current.prev': J(REL_A) });
    const r = drive(after, { kind: 'rollback', to: REL_A });
    assert.deepEqual(r.ops, ['rename current->current.failed', 'rename current.prev->current']);
    assert.equal(r.s.current.target, REL_A);
    const mid = snap({ 'current.prev': J(REL_A), 'current.next': J(REL_B) });
    assert.equal(drive(mid, { kind: 'rollback', to: REL_A }).s.current.target, REL_A);
  });

  it('ambiguous partial swap → CRITICAL_OPERATOR_ACTION', () => {
    const cases = [
      snap(),
      snap({ 'current.next': J(REL_B) }),
      snap({
        current: J(REL_A),
        'current.next': J('C:\\FiyatUcuz\\releases\\20261002-dddddddddddd'),
      }),
      snap({ current: { exists: true, isJunction: false, target: null } }),
      snap({ current: J('C:\\Windows') }),
      snap({ current: J(L.legacyApp) }),
    ];
    for (const c of cases) {
      const p = planActivationStep(c, { kind: 'activate', target: REL_B }, L, {
        allowLegacy: false,
      });
      assert.equal(p.op, 'abort', JSON.stringify(c));
      assert.equal(p.status, FINAL_STATUS.CRITICAL_OPERATOR_ACTION);
    }
    assert.equal(
      planActivationStep(snap({ current: J(REL_B) }), { kind: 'rollback', to: REL_A }, L).op,
      'abort',
    );
  });

  it('activation target must be a release directory', () => {
    for (const t of [
      'C:\\FiyatUcuz\\app',
      'C:\\FiyatUcuz\\releases\\..\\config',
      'C:\\FiyatUcuz\\current',
    ]) {
      assert.equal(
        planActivationStep(snap({ current: J(REL_A) }), { kind: 'activate', target: t }, L).op,
        'abort',
        t,
      );
    }
  });

  it('junction removal guard: allowed names only, verified junctions only', () => {
    assert.throws(
      () => assertRemovableJunction('releases', J(REL_A), L),
      /not an activation junction name/,
    );
    assert.throws(
      () => assertRemovableJunction('app', J(REL_A), L),
      /not an activation junction name/,
    );
    assert.throws(
      () => assertRemovableJunction('current.prev', { exists: true, isJunction: false }, L),
      /not-junction/,
    );
    assert.throws(
      () => assertRemovableJunction('current.prev', J('C:\\FiyatUcuz\\config'), L),
      /bad-target/,
    );
    assert.throws(() => assertRemovableJunction('current.prev', ABSENT, L), /does not exist/);
    assert.equal(assertRemovableJunction('current.prev', J(REL_A), L), true);
    assert.throws(
      () => assertRemovableJunction('current.prev', J(L.legacyApp), L, { allowLegacy: false }),
      /bad-target/,
    );
  });

  it('final status: no migration → ROLLED_BACK; after migration → APP_ONLY with an explicit DB note', () => {
    assert.equal(
      decideFailureStatus({
        phase: 'health',
        migrationState: 'NOT_NEEDED',
        rollback: { ok: true },
      }),
      FINAL_STATUS.ROLLED_BACK,
    );
    const m = { state: 'SUCCEEDED', knownApplied: ['0002_b.sql'] };
    const st = decideFailureStatus({
      phase: 'health',
      migrationState: m.state,
      rollback: { ok: true },
    });
    assert.equal(st, FINAL_STATUS.ROLLED_BACK_APP_ONLY);
    assert.match(databaseRollbackNote(st, m), /^DB NOT ROLLED BACK: .*0002_b\.sql/);
    assert.equal(databaseRollbackNote(FINAL_STATUS.ROLLED_BACK, { state: 'NOT_NEEDED' }), null);
    assert.equal(databaseRollbackNote(FINAL_STATUS.COMPLETED, m), null);
    assert.equal(
      decideFailureStatus({ phase: 'backup', migrationState: 'NOT_ATTEMPTED' }),
      FINAL_STATUS.FAILED_NO_CHANGE,
    );
    // Stop timeout, failed restart, unknown phase → operator.
    for (const phase of ['stop', 'restart', 'something-else']) {
      assert.equal(
        decideFailureStatus({ phase, migrationState: 'NOT_NEEDED' }),
        FINAL_STATUS.CRITICAL_OPERATOR_ACTION,
        phase,
      );
    }
    // A post-swap failure without a confirmed rollback is never "rolled back".
    assert.equal(
      decideFailureStatus({ phase: 'listener', migrationState: 'NOT_NEEDED' }),
      FINAL_STATUS.CRITICAL_OPERATOR_ACTION,
    );
  });

  it('pre-migration precheck: clean state passes and names the previous release', () => {
    const r = precheckActivation(snap({ current: J(REL_A), 'current.prev': J(REL_C) }), REL_B, L);
    assert.deepEqual(r, { ok: true, errors: [], previous: REL_A });
  });

  it('pre-migration precheck rejects every state that would only fail after the DB changed', () => {
    const cases = [
      [snap(), 'current must be'],
      [snap({ current: J(REL_A), 'current.next': J(REL_B) }), 'current.next already exists'],
      [
        snap({ current: J(REL_A), 'current.prev': { exists: true, isJunction: false } }),
        'current.prev is not-junction',
      ],
      [
        snap({ current: J(REL_A), 'current.failed': J('C:\\FiyatUcuz\\config') }),
        'current.failed is bad-target',
      ],
      [snap({ current: J(L.legacyApp) }), 'current is bad-target'],
      [snap({ current: J(REL_B) }), 'already active'],
      [
        snap({ current: { exists: true, isJunction: true, target: null } }),
        'current is bad-target',
      ],
    ];
    for (const [state, msg] of cases) {
      const r = precheckActivation(state, REL_B, L);
      assert.equal(r.ok, false, msg);
      assert.ok(
        r.errors.some((e) => e.includes(msg)),
        `${msg}: ${r.errors.join('|')}`,
      );
    }
    assert.equal(
      precheckActivation(snap({ current: J(REL_A) }), 'C:\\FiyatUcuz\\app', L).ok,
      false,
    );
  });

  it('rollback precheck runs before stopping: wrong target or unrecognized state is refused', () => {
    assert.equal(
      precheckRollback(snap({ current: J(REL_B), 'current.prev': J(REL_A) }), REL_A, L).ok,
      true,
    );
    assert.equal(
      precheckRollback(snap({ current: J(REL_B), 'current.prev': J(REL_A) }), REL_C, L).ok,
      false,
    );
    assert.equal(
      precheckRollback(snap({ current: J(REL_A) }), REL_A, L).ok,
      false,
      'already current',
    );
    // Legacy only with explicit permission.
    const legacy = snap({ current: J(REL_A), 'current.prev': J(L.legacyApp) });
    assert.equal(precheckRollback(legacy, L.legacyApp, L).ok, false);
    assert.equal(precheckRollback(legacy, L.legacyApp, L, { allowLegacy: true }).ok, true);
  });

  it('failure injection: interruption after each swap step is always recoverable by rollback', () => {
    const start = snap({ current: J(REL_A), 'current.prev': J(REL_C) });
    const full = drive(start, { kind: 'activate', target: REL_B });
    for (let k = 0; k <= full.ops.length; k += 1) {
      const mid = drive(start, { kind: 'activate', target: REL_B }, { failAfter: k });
      const back = drive(mid.s, { kind: 'rollback', to: REL_A });
      assert.equal(back.final.op, 'done', `after ${k} step(s): ${JSON.stringify(back.final)}`);
      assert.equal(back.s.current.target, REL_A, `after ${k} step(s)`);
      assert.equal(back.s['current.next'].exists, false);
      // Only activation pointers were touched — every op names one of them.
      for (const op of [...mid.ops, ...back.ops])
        assert.match(op, /^(createNext|removeJunction|rename) current/);
    }
  });

  it('failure injection: an interrupted rollback is itself resumable', () => {
    const swapped = snap({ current: J(REL_B), 'current.prev': J(REL_A) });
    const half = drive(swapped, { kind: 'rollback', to: REL_A }, { failAfter: 1 });
    assert.equal(half.s.current.exists, false);
    assert.equal(drive(half.s, { kind: 'rollback', to: REL_A }).s.current.target, REL_A);
  });

  it('a real directory or foreign target under an activation name is never renamed or removed', () => {
    const realDir = { exists: true, isJunction: false, target: null };
    for (const name of ['current', 'current.next', 'current.prev', 'current.failed']) {
      for (const intent of [
        { kind: 'activate', target: REL_B },
        { kind: 'rollback', to: REL_A },
      ]) {
        const base = { current: J(REL_A), 'current.prev': J(REL_A) };
        const p = planActivationStep(snap({ ...base, [name]: realDir }), intent, L);
        assert.equal(p.op, 'abort', `${name} ${intent.kind}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Preflight helpers
// ---------------------------------------------------------------------------

describe('preflight helpers', () => {
  it('disk threshold, runtime versions and child env allowlist', () => {
    assert.equal(checkFreeSpace(5 * 1024 ** 3).ok, true);
    assert.equal(checkFreeSpace(5 * 1024 ** 3 - 1).ok, false);
    const manifest = { pnpmVersion: '9.15.4', nodeVersionRequirement: '>=22' };
    assert.equal(
      checkRuntimeVersions({ nodeVersion: 'v22.23.2', pnpmVersion: '9.15.4', manifest }).ok,
      true,
    );
    assert.equal(
      checkRuntimeVersions({ nodeVersion: 'v24.1.0', pnpmVersion: '9.15.4', manifest }).ok,
      false,
    );
    assert.equal(
      checkRuntimeVersions({ nodeVersion: 'v22.23.2', pnpmVersion: '9.15.5', manifest }).ok,
      false,
    );
    const child = sanitizedChildEnv({
      PATH: '/bin',
      DATABASE_URL: 'x',
      PGPASSWORD: 'y',
      NODE_OPTIONS: '--require evil',
    });
    assert.deepEqual(Object.keys(child), ['PATH']);
  });

  it('secretsOf includes decoded URL passwords', () => {
    const s = secretsOf(env({ DATABASE_MIGRATION_URL: 'postgres://u:p%40ss-word@h/d' }));
    assert.ok(s.includes('p@ss-word'));
  });

  it('static ACL model: migration.env must be inaccessible to LocalService and broad principals', () => {
    const full = (who) => ({
      identity: who,
      rights: 'FullControl',
      type: 'Allow',
      inherited: true,
    });
    const base = [full('BUILTIN\\Administrators'), full('NT AUTHORITY\\SYSTEM')];
    const ls = (rights) => ({
      identity: 'NT AUTHORITY\\LOCAL SERVICE',
      rights,
      type: 'Allow',
      inherited: true,
    });
    const model = {
      [L.root]: [ls('ReadAndExecute, Synchronize')],
      [L.releases]: [ls('ReadAndExecute, Synchronize')],
      [L.runtime]: [ls('ReadAndExecute, Synchronize')],
      [L.config]: [],
      [L.apiEnv]: [ls('Read, Synchronize')],
      [L.migrationEnv]: [],
      [L.staging]: [],
      [L.deployments]: [],
      [L.feedArchive]: [ls('Modify, Synchronize')],
      [L.logsApi]: [ls('Modify, Synchronize')],
    };
    const snapshot = Object.entries(model).map(([path, extra]) => ({
      path,
      protected: path === L.config,
      rules: [...base, ...extra],
    }));
    assert.deepEqual(validateAclSnapshot(snapshot, L), { ok: true, errors: [] });
    const leaky = clone(snapshot);
    leaky
      .find((e) => e.path === L.migrationEnv)
      .rules.push(ls('Read'), {
        identity: 'Everyone',
        rights: 'Read',
        type: 'Allow',
        inherited: true,
      });
    const r = validateAclSnapshot(leaky, L);
    assert.ok(r.errors.some((e) => /migrationEnv: LocalService must have no access/.test(e)));
    assert.ok(r.errors.some((e) => /migrationEnv: broad principal/.test(e)));
  });
});

// ---------------------------------------------------------------------------
// Review fixes: secret classification, receipt merge, PS 5.1 shapes
// ---------------------------------------------------------------------------

describe('review fixes', () => {
  it('config values are not secrets; credentials (incl. unknown keys) are', () => {
    const secrets = secretsOf(
      env({
        ...goodApiEnv(),
        REDIS_URL: 'redis://:r3dis-pass@127.0.0.1:6379',
        SOME_TOKEN: 'tok-123456',
      }),
    );
    for (const v of ['production', '127.0.0.1', '4000', 'C:\\FiyatUcuz\\data\\feed-archive'])
      assert.ok(!secrets.includes(v), v);
    for (const v of [SECRET_PW, 'r3dis-pass', 'tok-123456', goodApiEnv().DATABASE_URL])
      assert.ok(secrets.includes(v), v);
    assert.ok(!secretsOf(env(goodMigrationEnv())).includes('fiyatucuz'));
  });

  it('a COMPLETED receipt with listener/health data is writable with real env secrets loaded', () => {
    const dir = freshDir('receipt');
    const apiEnv = join(dir, 'api.env');
    const migEnv = join(dir, 'migration.env');
    writeFileSync(
      apiEnv,
      Object.entries(goodApiEnv())
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    );
    writeFileSync(
      migEnv,
      Object.entries(goodMigrationEnv())
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    );
    const file = join(dir, 'r.json');
    const init = join(dir, 'init.json');
    writeFileSync(
      init,
      JSON.stringify({
        deploymentId: 'd',
        host: 'h',
        operator: 'o',
        releaseId: '20261004-bbbbbbbbbbbb',
      }),
    );
    const run = (...a) =>
      spawnSync(NODE, [DEPLOY_CLI, ...a, '--secret-env', `${apiEnv},${migEnv}`], {
        encoding: 'utf8',
      });
    assert.equal(run('receipt-init', '--file', file, '--init', init).status, 0);
    const patch = (o) => {
      const f = join(dir, `p-${(counter += 1)}.json`);
      writeFileSync(f, JSON.stringify(o));
      return f;
    };
    assert.equal(
      run(
        'receipt-update',
        '--file',
        file,
        '--patch',
        patch({ junctions: { before: { current: REL_A } }, service: { before: 'Running' } }),
        '--phase',
        'p',
        '--result',
        'r',
      ).status,
      0,
    );
    const done = run(
      'receipt-update',
      '--file',
      file,
      '--patch',
      patch({
        status: 'COMPLETED',
        listener: { ok: true, addresses: ['127.0.0.1'] },
        junctions: { after: { current: REL_B } },
      }),
      '--phase',
      'final',
      '--result',
      'completed',
    );
    assert.equal(done.status, 0, done.stdout);
    const r = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(
      r.junctions,
      { before: { current: REL_A }, after: { current: REL_B } },
      'one-level merge keeps before',
    );
    assert.equal(r.service.before, 'Running');
    assert.equal(r.status, 'COMPLETED');
    assert.equal(r.databaseNote, null);
    // A secret value is still refused (and the previous receipt stays intact).
    const leak = run(
      'receipt-update',
      '--file',
      file,
      '--patch',
      patch({ tool: { note: SECRET_PW } }),
      '--phase',
      'x',
      '--result',
      'x',
    );
    assert.equal(leak.status, 1);
    assert.ok(!leak.stdout.includes(SECRET_PW));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'COMPLETED');
  });

  it('receipt-update derives the DB note from the recorded migration state', () => {
    const dir = freshDir('receipt');
    const file = join(dir, 'r.json');
    writeReceiptAtomic(file, {
      ...createReceipt({ deploymentId: 'd' }),
      migrations: { state: 'PARTIAL', knownApplied: ['0002_b.sql'] },
    });
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ status: 'FAILED_MIGRATION_PARTIAL' }));
    assert.equal(
      spawnSync(NODE, [
        DEPLOY_CLI,
        'receipt-update',
        '--file',
        file,
        '--patch',
        p,
        '--phase',
        'final',
        '--result',
        'x',
      ]).status,
      0,
    );
    assert.match(
      JSON.parse(readFileSync(file, 'utf8')).databaseNote,
      /^DB NOT ROLLED BACK: migration state PARTIAL; known applied: 0002_b\.sql/,
    );
  });

  it('listener check accepts PowerShell single-object serialization and still fails closed', () => {
    const one = validateListeners({
      listeners: { LocalAddress: '127.0.0.1', LocalPort: 4000, OwningProcess: 200 },
      processes: { ProcessId: 200, ParentProcessId: 100 },
      servicePid: 100,
    });
    assert.equal(one.ok, true, one.errors.join('|'));
    assert.equal(validateListeners({ listeners: null, processes: null, servicePid: 0 }).ok, false);
    const noPid = validateListeners({
      listeners: [{ LocalAddress: '127.0.0.1', LocalPort: 4000, OwningProcess: 200 }],
      processes: [],
      servicePid: 0,
    });
    assert.ok(noPid.errors.includes('service PID unknown'));
  });

  it('pg_dump receives sslmode from the migration URL (env only)', () => {
    const e = pgEnvFromMigrationEnv(
      env({ ...goodMigrationEnv(), DATABASE_MIGRATION_URL: `${MIGRATION_URL}?sslmode=require` }),
    );
    assert.equal(e.PGSSLMODE, 'require');
    assert.equal(pgEnvFromMigrationEnv(env(goodMigrationEnv())).PGSSLMODE, undefined);
  });

  it('CLI decide-status / precheck-activation emit Node decisions for PowerShell', () => {
    const r = spawnSync(
      NODE,
      [
        DEPLOY_CLI,
        'decide-status',
        '--phase',
        'health',
        '--migration-state',
        'SUCCEEDED',
        '--rollback',
        'ok',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(JSON.parse(r.stdout).status, FINAL_STATUS.ROLLED_BACK_APP_ONLY);
    const f = join(freshDir('snap'), 's.json');
    writeFileSync(
      f,
      JSON.stringify({
        current: { exists: true, isJunction: true, target: REL_A },
        'current.next': { exists: true, isJunction: true, target: REL_B },
      }),
    );
    const p = spawnSync(
      NODE,
      [
        DEPLOY_CLI,
        'precheck-activation',
        '--snapshot',
        f,
        '--root',
        'C:\\FiyatUcuz',
        '--target',
        REL_B,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(p.status, 1);
    assert.equal(JSON.parse(p.stdout).ok, false);
  });
});

// ---------------------------------------------------------------------------
// Retention (report only)
// ---------------------------------------------------------------------------

describe('retention', () => {
  it('reports eligibility and deletes nothing', () => {
    const dir = freshDir('releases');
    const ids = [
      '20260801-111111111111',
      '20260901-222222222222',
      '20261001-333333333333',
      '20261002-444444444444',
      '20261003-555555555555',
    ];
    for (const id of ids) mkdirSync(join(dir, id));
    writeFileSync(join(dir, `${ids[0]}.seal.json`), '{}');
    const r = retentionReport({
      releasesDir: dir,
      protectedTargets: [`C:\\FiyatUcuz\\releases\\${ids[0]}`],
    });
    assert.deepEqual(r.deleted, []);
    const byId = Object.fromEntries(r.releases.map((x) => [x.id, x]));
    assert.equal(byId[ids[0]].eligibleForManualCleanup, false, 'protected');
    assert.equal(byId[ids[1]].eligibleForManualCleanup, true);
    assert.equal(byId[ids[4]].withinRetention, true);
    for (const id of ids) assert.ok(existsSync(join(dir, id)));
  });
});

// ---------------------------------------------------------------------------
// PowerShell static safety scan (string checks are the point here: the
// scripts cannot be executed on this non-Windows host — runtime is 15A-7)
// ---------------------------------------------------------------------------

/** Strip <# ... #> blocks and # comments (not inside quotes; good enough for these files). */
function stripPsComments(text) {
  const noBlocks = text.replace(/<#[\s\S]*?#>/g, '');
  return noBlocks
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*#Requires\b/i.test(line)) return line;
      let quote = null;
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === "'" || c === '"') quote = c;
        else if (c === '#') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

const DANGEROUS = [
  [/\biisreset\b/i, 'iisreset'],
  [/\bRestart-Computer\b/i, 'Restart-Computer'],
  [/\bStop-Computer\b/i, 'Stop-Computer'],
  [/\bStop-Process\b/i, 'Stop-Process'],
  [/\btaskkill\b/i, 'taskkill'],
  [/\bW3SVC\b/i, 'W3SVC'],
  [/\bWAS\b(?=['"\s])/, 'WAS service'],
  [/\bsetx\b/i, 'setx'],
  [/\bInvoke-Expression\b|\biex\b/i, 'Invoke-Expression'],
  [/\bRemove-Item\b[^\n]*-Recurse/i, 'Remove-Item -Recurse'],
  [/\b(?:rm|del|rmdir|rd)\b\s[^\n]*\/s\b/i, 'recursive delete alias'],
  [/\bRestart-Service\b/i, 'Restart-Service'],
  [/\[Environment\]::SetEnvironmentVariable/i, 'machine env mutation'],
  [/\bSet-ExecutionPolicy\b(?![^\n]*-Scope\s+Process)/i, 'Set-ExecutionPolicy'],
  [/\b(?:Register|New)-ScheduledTask\b|\bschtasks\b/i, 'scheduled task'],
  [/\bNew-Service\b|\bsc(?:\.exe)?\s+(?:create|delete|config)\b/i, 'service create/modify'],
  [/\bnetsh\b|\bNew-NetFirewallRule\b|\bSet-NetFirewall/i, 'firewall'],
  [/\b(?:Import-Module\s+WebAdministration|IISAdministration)\b|\bappcmd\b/i, 'IIS administration'],
  [/\?\?|\?\.|&&|\|\||-Parallel\b|\bclean\s*\{/i, 'PowerShell 7 syntax'],
  [/\bFiyatUcuz\*|\*FiyatUcuz/i, 'wildcard service name'],
];
const SERVICE_CMDLET = /\b(Stop|Start|Set|Suspend|Resume)-Service\b[^\n]*/gi;

function scanPs(text) {
  const code = stripPsComments(text);
  const found = DANGEROUS.filter(([re]) => re.test(code)).map(([, name]) => name);
  for (const m of code.matchAll(SERVICE_CMDLET)) {
    if (!/-Name \$script:ServiceName\b/.test(m[0]) || /\*/.test(m[0]))
      found.push(`service control not pinned to FiyatUcuzApi: ${m[0].trim()}`);
  }
  if (/\bSet-Service\b/i.test(code)) found.push('Set-Service');
  return found;
}

describe('PowerShell static safety scan', () => {
  const files = readdirSync(WINDOWS_DIR).filter((f) => /\.ps(m?)1$/.test(f));

  it('finds all five PowerShell files', () => {
    assert.deepEqual(
      files.sort(),
      [
        'Deploy-FiyatUcuzApi.ps1',
        'FiyatUcuz.Deploy.psm1',
        'Rollback-FiyatUcuzApi.ps1',
        'Test-FiyatUcuzPreflight.ps1',
      ].sort(),
    );
  });

  for (const f of files) {
    it(`${f}: no dangerous commands, PS 5.1 headers and strict mode`, () => {
      const text = readFileSync(join(WINDOWS_DIR, f), 'utf8');
      assert.deepEqual(scanPs(text), []);
      assert.match(text, /^#Requires -Version 5\.1$/m);
      if (f.endsWith('.ps1')) assert.match(text, /^#Requires -RunAsAdministrator$/m);
      assert.match(text, /^Set-StrictMode -Version Latest$/m);
      assert.match(text, /^\$ErrorActionPreference = 'Stop'$/m);
    });
  }

  it('PowerShell files are pure ASCII (5.1 reads BOM-less files as ANSI; UTF-8 dashes decode to quote characters)', () => {
    for (const f of [...files, 'FiyatUcuzApi.xml.template']) {
      // eslint-disable-next-line no-control-regex
      assert.ok(/^[\x00-\x7f]*$/.test(readFileSync(join(WINDOWS_DIR, f), 'utf8')), f);
    }
  });

  it('junction removal is non-recursive and only via the guarded module function', () => {
    const all = files
      .map((f) => stripPsComments(readFileSync(join(WINDOWS_DIR, f), 'utf8')))
      .join('\n');
    const deletes = [...all.matchAll(/\[System\.IO\.Directory\]::Delete\(([^)]*)\)/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(deletes, ['$path, $false']);
    assert.ok(!/\bRemove-Item\b/i.test(all), 'no Remove-Item at all');
  });

  it('the scanner itself detects each forbidden pattern (and ignores comments)', () => {
    const samples = [
      'iisreset /restart',
      'Restart-Computer -Force',
      'Stop-Process -Id 4',
      'taskkill /F /IM node.exe',
      'Stop-Service -Name W3SVC',
      'setx PATH x /M',
      'Invoke-Expression $x',
      'Remove-Item -LiteralPath $p -Recurse -Force',
      "[Environment]::SetEnvironmentVariable('A','B','Machine')",
      'Set-ExecutionPolicy Unrestricted -Scope LocalMachine',
      'Register-ScheduledTask -TaskName x',
      'New-Service -Name x -BinaryPathName y',
      'Stop-Service -Name FiyatUcuz*',
      'Stop-Service -Name $other',
      '$a = $b ?? 1',
      'Restart-Service -Name $script:ServiceName',
    ];
    for (const s of samples) assert.ok(scanPs(s).length > 0, s);
    assert.deepEqual(scanPs('# iisreset in a comment\n<# Stop-Process #>\nWrite-Output "x"'), []);
    assert.deepEqual(scanPs('Stop-Service -Name $script:ServiceName -NoWait'), []);
  });

  it('the WinSW template loads only api.env and runs as LocalService', () => {
    const xml = readFileSync(join(WINDOWS_DIR, 'FiyatUcuzApi.xml.template'), 'utf8').replace(
      /<!--[\s\S]*?-->/g,
      '',
    );
    assert.match(xml, /<id>FiyatUcuzApi<\/id>/);
    assert.match(
      xml,
      /--env-file=C:\\FiyatUcuz\\config\\api\.env C:\\FiyatUcuz\\current\\services\\api\\dist\\index\.js/,
    );
    assert.ok(!/migration\.env/.test(xml));
    assert.match(xml, /NT AUTHORITY\\LocalService/);
    assert.match(xml, /<stoptimeout>60 sec<\/stoptimeout>/);
  });
});
