// Tests for the API release tooling (ADIM 15A-3). Run with:
//   node --test scripts/release/test/
// The real repository is only READ; every output goes to a fresh tmpdir.

import assert from 'node:assert/strict';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  API_PACKAGE,
  computeBuildOrder,
  computeRuntimeClosure,
  findSharedLinks,
  installPlan,
  isForbiddenPath,
  isSafeRelativePath,
  listWorkspacePackages,
  MANIFEST_FILE,
  prepareRelease,
  ReleaseError,
  sha256Text,
  verifyRelease,
} from '../release-lib.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLEAN_GIT = Object.freeze({
  head: 'a'.repeat(40),
  clean: true,
  commitTime: '2026-10-04T00:00:00+03:00',
});
const EXPECTED_CLOSURE = [
  '@fiyatucuz/api',
  '@fiyatucuz/config',
  '@fiyatucuz/db',
  '@fiyatucuz/types',
  '@fiyatucuz/validation',
];

const scratch = mkdtempSync(join(tmpdir(), 'fiyatucuz-release-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const freshDir = (label) => join(scratch, `${label}-${(counter += 1)}`);

function walkFiles(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(dir, r));
    else out.push(r);
  }
  return out;
}

/** Prepare a source release from the real repository into a fresh dir. */
function prepareReal() {
  const outputDir = freshDir('rel');
  const result = prepareRelease({ repoRoot: REPO_ROOT, outputDir, git: CLEAN_GIT });
  return { outputDir, ...result };
}

// ---------------------------------------------------------------------------

describe('workspace closure (real repository)', () => {
  it('K: is exactly the API runtime closure; web/mobile are excluded', () => {
    const packages = listWorkspacePackages(REPO_ROOT);
    const closure = computeRuntimeClosure(packages, API_PACKAGE);
    assert.deepEqual(closure, EXPECTED_CLOSURE);
    const excluded = packages.filter((p) => !closure.includes(p.name)).map((p) => p.name);
    assert.deepEqual(excluded.sort(), ['@fiyatucuz/mobile', '@fiyatucuz/web']);
  });

  it('build order puts dependencies first', () => {
    const packages = listWorkspacePackages(REPO_ROOT);
    const order = computeBuildOrder(packages, computeRuntimeClosure(packages));
    assert.equal(order.at(-1), '@fiyatucuz/api');
    assert.ok(order.indexOf('@fiyatucuz/config') < order.indexOf('@fiyatucuz/db'));
    assert.deepEqual([...order].sort(), EXPECTED_CLOSURE);
  });
});

describe('prepare (real repository → tmpdir)', () => {
  it('A: a clean prepare succeeds and verifies as a source artifact', () => {
    const { outputDir, manifest, manifestSha256 } = prepareReal();
    assert.deepEqual(
      manifest.workspaceClosure.map((w) => w.name),
      EXPECTED_CLOSURE,
    );
    assert.equal(manifest.gitCommit, CLEAN_GIT.head);
    assert.equal(manifest.createdAt, CLEAN_GIT.commitTime);
    // Deterministic: the same commit yields a byte-identical manifest.
    const again = prepareRelease({
      repoRoot: REPO_ROOT,
      outputDir: freshDir('rel'),
      git: CLEAN_GIT,
    });
    assert.equal(again.manifestSha256, manifestSha256);
    const result = verifyRelease({
      releaseDir: outputDir,
      stage: 'source',
      expectedManifestSha256: manifestSha256,
    });
    assert.deepEqual(result, { ok: true, errors: [] });
  });

  it('B: a dirty working tree is rejected', () => {
    assert.throws(
      () =>
        prepareRelease({
          repoRoot: REPO_ROOT,
          outputDir: freshDir('dirty'),
          git: { ...CLEAN_GIT, clean: false },
        }),
      (e) => e instanceof ReleaseError && /not clean/.test(e.message),
    );
  });

  it('C: an existing output directory is never reused or overwritten', () => {
    const outputDir = freshDir('exists');
    mkdirSync(outputDir);
    writeFileSync(join(outputDir, 'keep.txt'), 'untouched');
    assert.throws(
      () => prepareRelease({ repoRoot: REPO_ROOT, outputDir, git: CLEAN_GIT }),
      /already exists/,
    );
    assert.deepEqual(readdirSync(outputDir), ['keep.txt']);
  });

  it('output inside the repository is rejected', () => {
    assert.throws(
      () =>
        prepareRelease({
          repoRoot: REPO_ROOT,
          outputDir: join(REPO_ROOT, 'should-not-exist-release'),
          git: CLEAN_GIT,
        }),
      /outside the repository/,
    );
    assert.equal(existsSync(join(REPO_ROOT, 'should-not-exist-release')), false);
  });

  it('D/E/F: no .env, no node_modules, no dist, no web/mobile sources', () => {
    const { outputDir } = prepareReal();
    const files = walkFiles(outputDir);
    assert.ok(!files.some((f) => f.split('/').some((s) => /^\.env/.test(s))), '.env shipped');
    assert.ok(!files.some((f) => f.split('/').includes('node_modules')), 'node_modules shipped');
    assert.ok(!files.some((f) => f.split('/').includes('dist')), 'dist shipped');
    assert.ok(!files.some((f) => f.endsWith('.tsbuildinfo')), 'tsbuildinfo shipped');
    assert.ok(!files.some((f) => f.split('/').includes('test')), 'tests shipped');
    for (const app of ['apps/web', 'apps/mobile']) {
      assert.deepEqual(
        files.filter((f) => f.startsWith(`${app}/`)),
        [`${app}/package.json`],
        `${app} must contribute only its manifest`,
      );
    }
    if (existsSync(join(REPO_ROOT, 'services/api/.env'))) {
      assert.equal(existsSync(join(outputDir, 'services/api/.env')), false);
    }
  });

  it('migration SQL and the migration CLI source are included; lockfile hashed', () => {
    const { outputDir, manifest } = prepareReal();
    const repoSql = readdirSync(join(REPO_ROOT, 'packages/db/drizzle'))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    assert.deepEqual(manifest.migrations, repoSql);
    for (const f of repoSql) assert.ok(existsSync(join(outputDir, 'packages/db/drizzle', f)));
    assert.ok(existsSync(join(outputDir, 'packages/db/src/cli/migrate.ts')));
    assert.ok(manifest.requiredBuildOutputs.includes('packages/db/dist/cli/migrate.js'));
    assert.equal(manifest.migrationCli, 'packages/db/dist/cli/migrate.js');
    assert.equal(
      manifest.lockfile.sha256,
      sha256Text(readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8')),
    );
  });

  it('L: the manifest carries no credentials or env content', () => {
    const { outputDir } = prepareReal();
    const text = readFileSync(join(outputDir, MANIFEST_FILE), 'utf8');
    for (const needle of [
      'postgres://',
      'postgresql://',
      'DATABASE_URL',
      'DATABASE_MIGRATION_URL',
    ]) {
      assert.ok(!text.includes(needle), `manifest contains ${needle}`);
    }
    assert.doesNotMatch(text, /:\/\/[^\s/"@]*:[^\s/"@]*@/, 'manifest contains URL userinfo');
    // No absolute developer paths, no env names, no file contents.
    assert.ok(!text.includes(REPO_ROOT), 'manifest contains an absolute repository path');
    assert.ok(!text.includes(tmpdir()), 'manifest contains an absolute temp path');
    assert.ok(!text.includes('DATABASE_MIGRATION_EXPECTED_DB'));
    // Only file paths/hashes/metadata — no file contents are embedded.
    assert.ok(!JSON.parse(text).files.some((f) => 'content' in f));
  });
});

describe('verify (tampering)', () => {
  const expectFail = (outputDir, re, stage = 'source', expectedManifestSha256) => {
    const result = verifyRelease({ releaseDir: outputDir, stage, expectedManifestSha256 });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => re.test(e)),
      `expected an error matching ${re}, got: ${result.errors.join(' | ')}`,
    );
  };

  it('G: lockfile tamper fails', () => {
    const { outputDir } = prepareReal();
    appendFileSync(join(outputDir, 'pnpm-lock.yaml'), '\n# tampered\n');
    expectFail(outputDir, /hash mismatch: pnpm-lock\.yaml/);
  });

  it('H: manifest tamper fails (edited hash, edited closure, or wrong expected digest)', () => {
    const a = prepareReal();
    const m = JSON.parse(readFileSync(join(a.outputDir, MANIFEST_FILE), 'utf8'));
    m.files[0].sha256 = '0'.repeat(64);
    writeFileSync(join(a.outputDir, MANIFEST_FILE), JSON.stringify(m));
    expectFail(a.outputDir, /hash mismatch/);
    expectFail(a.outputDir, /manifest SHA-256 does not match/, 'source', a.manifestSha256);

    const b = prepareReal();
    const m2 = JSON.parse(readFileSync(join(b.outputDir, MANIFEST_FILE), 'utf8'));
    m2.workspaceClosure.push({ name: '@fiyatucuz/web', dir: 'apps/web' });
    writeFileSync(join(b.outputDir, MANIFEST_FILE), JSON.stringify(m2));
    expectFail(b.outputDir, /workspace closure mismatch/);
  });

  it('I: a missing migration file fails', () => {
    const { outputDir, manifest } = prepareReal();
    unlinkSync(join(outputDir, 'packages/db/drizzle', manifest.migrations[0]));
    expectFail(outputDir, /missing file: packages\/db\/drizzle\//);
  });

  it('J: an injected secret-like or unexpected file fails', () => {
    const { outputDir } = prepareReal();
    writeFileSync(join(outputDir, 'services/api/.env'), 'X=1');
    writeFileSync(join(outputDir, 'migration.env'), 'X=1');
    writeFileSync(join(outputDir, 'extra.txt'), 'x');
    expectFail(outputDir, /forbidden file present: services\/api\/\.env/);
    expectFail(outputDir, /forbidden file present: migration\.env/);
    expectFail(outputDir, /unexpected file: extra\.txt/);
  });

  it('source stage rejects node_modules and dist', () => {
    const { outputDir } = prepareReal();
    mkdirSync(join(outputDir, 'node_modules'));
    mkdirSync(join(outputDir, 'services/api/dist'));
    expectFail(outputDir, /must not contain node_modules/);
    expectFail(outputDir, /must not contain services\/api\/dist/);
  });

  it('path traversal in the manifest is rejected', () => {
    const { outputDir } = prepareReal();
    const m = JSON.parse(readFileSync(join(outputDir, MANIFEST_FILE), 'utf8'));
    m.files.push({ path: '../outside.txt', sha256: '0'.repeat(64), bytes: 0 });
    writeFileSync(join(outputDir, MANIFEST_FILE), JSON.stringify(m));
    expectFail(outputDir, /unsafe path in manifest/);
  });

  it('a manifest with credential-like content is rejected', () => {
    const { outputDir } = prepareReal();
    const m = JSON.parse(readFileSync(join(outputDir, MANIFEST_FILE), 'utf8'));
    m.note = 'postgres://u:p@h/db';
    writeFileSync(join(outputDir, MANIFEST_FILE), JSON.stringify(m));
    expectFail(outputDir, /credential-like/);
  });
});

describe('materialized stage (simulated install output)', () => {
  /** Simulate a Windows-side install: copied deps + build outputs. */
  function materialize(outputDir, manifest, { hardLink = false } = {}) {
    const pkgDir = join(outputDir, 'node_modules/.pnpm/zod@3.25.76/node_modules/zod');
    mkdirSync(pkgDir, { recursive: true });
    const storeFile = join(scratch, `store-${(counter += 1)}.js`);
    writeFileSync(storeFile, 'module.exports = {};');
    if (hardLink) linkSync(storeFile, join(pkgDir, 'index.js'));
    else copyFileSync(storeFile, join(pkgDir, 'index.js'));
    for (const rel of manifest.requiredBuildOutputs) {
      mkdirSync(dirname(join(outputDir, rel)), { recursive: true });
      writeFileSync(join(outputDir, rel), 'export {};');
    }
  }

  it('copied dependencies + build outputs verify', () => {
    const { outputDir, manifest } = prepareReal();
    materialize(outputDir, manifest);
    assert.deepEqual(verifyRelease({ releaseDir: outputDir, stage: 'materialized' }), {
      ok: true,
      errors: [],
    });
  });

  it('a hard-linked dependency file fails (store sharing)', () => {
    const { outputDir, manifest } = prepareReal();
    materialize(outputDir, manifest, { hardLink: true });
    const result = verifyRelease({ releaseDir: outputDir, stage: 'materialized' });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => /hard-linked/.test(e)),
      result.errors.join(' | '),
    );
  });

  it('missing build output fails', () => {
    const { outputDir, manifest } = prepareReal();
    materialize(outputDir, manifest);
    unlinkSync(join(outputDir, 'packages/db/dist/cli/migrate.js'));
    const result = verifyRelease({ releaseDir: outputDir, stage: 'materialized' });
    assert.ok(result.errors.includes('missing build output: packages/db/dist/cli/migrate.js'));
  });

  it('files injected into a source tree under a dist/ or node_modules name fail', () => {
    const { outputDir, manifest } = prepareReal();
    materialize(outputDir, manifest);
    mkdirSync(join(outputDir, 'services/api/src/dist'), { recursive: true });
    writeFileSync(join(outputDir, 'services/api/src/dist/evil.js'), 'x');
    mkdirSync(join(outputDir, 'packages/db/src/node_modules'), { recursive: true });
    writeFileSync(join(outputDir, 'packages/db/src/node_modules/evil.js'), 'x');
    mkdirSync(join(outputDir, 'apps/web/dist'), { recursive: true });
    writeFileSync(join(outputDir, 'apps/web/dist/x.js'), 'x');
    const errors = verifyRelease({ releaseDir: outputDir, stage: 'materialized' }).errors;
    for (const rel of [
      'services/api/src/dist/evil.js',
      'packages/db/src/node_modules/evil.js',
      'apps/web/dist/x.js',
    ]) {
      assert.ok(errors.includes(`unexpected file: ${rel}`), `${rel}: ${errors.join(' | ')}`);
    }
  });

  it('package-level node_modules and dist files are hard-link checked too', () => {
    const { outputDir, manifest } = prepareReal();
    materialize(outputDir, manifest);
    const store = join(scratch, `store-${(counter += 1)}.js`);
    writeFileSync(store, 'x');
    mkdirSync(join(outputDir, 'services/api/node_modules/.bin'), { recursive: true });
    linkSync(store, join(outputDir, 'services/api/node_modules/.bin/shim.js'));
    const extraDist = join(outputDir, 'packages/db/dist/extra.js');
    linkSync(store, extraDist);
    const errors = verifyRelease({ releaseDir: outputDir, stage: 'materialized' }).errors;
    assert.ok(
      errors.some((e) => /dependency file\(s\) are hard-linked/.test(e)),
      errors.join(' | '),
    );
    assert.ok(
      errors.includes('build output is hard-linked: packages/db/dist/extra.js'),
      errors.join(' | '),
    );
  });

  it('pnpm-style symlinks inside node_modules are allowed (not hard links)', () => {
    const { outputDir, manifest } = prepareReal();
    materialize(outputDir, manifest);
    mkdirSync(join(outputDir, 'services/api/node_modules'), { recursive: true });
    symlinkSync(
      join(outputDir, 'node_modules/.pnpm/zod@3.25.76/node_modules/zod'),
      join(outputDir, 'services/api/node_modules/zod'),
    );
    assert.deepEqual(verifyRelease({ releaseDir: outputDir, stage: 'materialized' }), {
      ok: true,
      errors: [],
    });
  });

  it('non-API dependencies (react-native/expo/next) in the store layout fail', () => {
    const { outputDir, manifest } = prepareReal();
    materialize(outputDir, manifest);
    mkdirSync(join(outputDir, 'node_modules/.pnpm/react-native@0.76.0'), { recursive: true });
    const result = verifyRelease({ releaseDir: outputDir, stage: 'materialized' });
    assert.ok(
      result.errors.some((e) => /non-API dependencies/.test(e)),
      result.errors.join(' | '),
    );
  });
});

describe('hard-link detection', () => {
  it('flags files sharing a record, not copies or symlinks', () => {
    const dir = freshDir('links');
    mkdirSync(dir);
    writeFileSync(join(dir, 'original.js'), 'x');
    linkSync(join(dir, 'original.js'), join(dir, 'hardlink.js'));
    copyFileSync(join(dir, 'original.js'), join(dir, 'copy.js'));
    symlinkSync(join(dir, 'copy.js'), join(dir, 'symlink.js'));
    assert.deepEqual(findSharedLinks(dir).sort(), ['hardlink.js', 'original.js']);
  });
});

describe('install contract (M)', () => {
  it('uses frozen lockfile, copy import, isolated store, API filter, no scripts', () => {
    const { manifest } = prepareReal();
    const plan = installPlan(manifest, { node: 'NODE', pnpmCli: 'PNPM', storeDir: 'STORE' });
    assert.deepEqual(plan.install, [
      'NODE',
      'PNPM',
      'install',
      '--frozen-lockfile',
      '--package-import-method',
      'copy',
      '--store-dir',
      'STORE',
      '--filter',
      '@fiyatucuz/api...',
      '--ignore-scripts',
    ]);
    assert.equal(plan.build.length, EXPECTED_CLOSURE.length);
    for (const step of plan.build) {
      assert.equal(step[0], 'NODE'); // explicit Node; no PATH lookup
      assert.match(step[1], /\/node_modules\/typescript\/bin\/tsc$/);
    }
    assert.match(plan.build.at(-1)[1], /^services\/api\//);
  });
});

describe('fixture repositories (secrets / symlinks inside allowlisted trees)', () => {
  function makeFixture() {
    const root = freshDir('fixture');
    const write = (rel, text) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    write(
      'package.json',
      JSON.stringify({ packageManager: 'pnpm@9.15.4', engines: { node: '>=22' } }),
    );
    write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n  - 'services/*'\n");
    write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    write('.npmrc', 'node-linker=isolated\n');
    write('tsconfig.base.json', '{}');
    for (const [dir, name, deps] of [
      ['services/api', '@fiyatucuz/api', { '@fiyatucuz/db': 'workspace:*' }],
      ['packages/db', '@fiyatucuz/db', {}],
    ]) {
      write(`${dir}/package.json`, JSON.stringify({ name, dependencies: deps }));
      write(`${dir}/tsconfig.json`, '{}');
      write(`${dir}/src/index.ts`, 'export {};');
    }
    write('packages/db/drizzle/0001_x.sql', 'select 1;');
    return root;
  }

  it('fixture prepares and verifies', () => {
    const root = makeFixture();
    const outputDir = freshDir('fixture-out');
    prepareRelease({ repoRoot: root, outputDir, git: CLEAN_GIT });
    assert.equal(verifyRelease({ releaseDir: outputDir, stage: 'source' }).ok, true);
  });

  it('a secret-like file inside src fails closed (nothing is written)', () => {
    const root = makeFixture();
    writeFileSync(join(root, 'services/api/src/server.key'), 'x');
    const outputDir = freshDir('fixture-out');
    assert.throws(() => prepareRelease({ repoRoot: root, outputDir, git: CLEAN_GIT }), /forbidden/);
    assert.equal(existsSync(outputDir), false);
  });

  it('a symlink inside src fails closed', () => {
    const root = makeFixture();
    symlinkSync('/etc/hosts', join(root, 'packages/db/src/link.ts'));
    assert.throws(
      () => prepareRelease({ repoRoot: root, outputDir: freshDir('fixture-out'), git: CLEAN_GIT }),
      /symlink not allowed/,
    );
  });

  it('missing migration SQL fails', () => {
    const root = makeFixture();
    rmSync(join(root, 'packages/db/drizzle/0001_x.sql'));
    assert.throws(
      () => prepareRelease({ repoRoot: root, outputDir: freshDir('fixture-out'), git: CLEAN_GIT }),
      /no migration SQL/,
    );
  });
});

describe('path helpers', () => {
  it('isSafeRelativePath', () => {
    for (const ok of ['a', 'a/b.ts', 'packages/db/drizzle/0001.sql'])
      assert.ok(isSafeRelativePath(ok), ok);
    for (const bad of ['', '/abs', '../x', 'a/../b', 'a//b', 'a\\b', 'C:/x', './a']) {
      assert.ok(!isSafeRelativePath(bad), bad);
    }
  });

  it('isForbiddenPath', () => {
    for (const bad of [
      '.env',
      'x/.env.production',
      'migration.env',
      'a/key.pem',
      'db.dump',
      'x/raw.xml',
      'app.log',
    ]) {
      assert.ok(isForbiddenPath(bad), bad);
    }
    for (const ok of [
      'services/api/src/modules/auth/password.ts',
      'packages/db/src/env.ts',
      'README.md',
    ]) {
      assert.ok(!isForbiddenPath(ok), ok);
    }
  });
});
