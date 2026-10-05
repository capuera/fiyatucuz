// FiyatUcuz API release tooling (ADIM 15A-3, ADR-0020).
//
// Two stages, deliberately separated:
//   1. SOURCE artifact (any OS, e.g. the Mac): an allowlisted copy of exactly
//      what is needed to install + build the API closure on the target host,
//      plus a manifest with SHA-256 of every file. No node_modules, no dist,
//      no secrets — native dependencies (@node-rs/argon2) must be installed on
//      the target OS, so a macOS node_modules is never shipped.
//   2. MATERIALIZED release (Windows host, 15A-4): `pnpm install` with
//      --frozen-lockfile, --package-import-method copy, an isolated
//      --store-dir and the API filter, then an explicit tsc build.
//
// Only Node built-ins. Every function takes explicit paths; nothing mutates the
// developer checkout.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MANIFEST_FILE = 'release-manifest.json';
export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_KIND = 'fiyatucuz-api-release-source';
export const API_PACKAGE = '@fiyatucuz/api';

/** Root files copied verbatim (install + build inputs). */
export const ROOT_FILES = Object.freeze([
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  '.npmrc',
  'tsconfig.base.json',
]);

/** Install contract — the pnpm flags the target host must use. */
export const INSTALL_CONTRACT = Object.freeze({
  frozenLockfile: true,
  packageImportMethod: 'copy',
  isolatedStore: true,
  ignoreScripts: true,
  filter: `${API_PACKAGE}...`,
});

// Names that must never appear in a release (matched on every path segment).
const FORBIDDEN_SEGMENT_PATTERNS = Object.freeze([
  /^\.env(\..*)?$/i, // .env, .env.production, …  (.env.example is not needed either)
  /^migration\.env$/i,
  /\.(pem|key|p12|pfx|crt|cer|jks|kdbx)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.npmrc\.local$/i,
  /^\.pgpass$|^pgpass\.conf$/i,
  /\.(dump|backup|bak)$/i,
  /\.sql\.gz$/i,
  /\.log$/i,
  /^credentials?(\..*)?$/i,
  /^secrets?(\..*)?$/i,
  /^raw\.(xml|csv)$/i, // archived feed bodies (ADR-0017)
]);

// Build/runtime products that may exist in the dev checkout but are never
// part of the source artifact (skipped while walking allowlisted trees).
const SKIPPED_DIR_NAMES = new Set(['node_modules', 'dist', '.turbo', '.cache', 'coverage']);
const SKIPPED_FILE_PATTERNS = [/\.tsbuildinfo$/];

export class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseError';
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Native relative path → manifest form (POSIX separators). */
export function toPosix(rel) {
  return rel.split(sep).join('/');
}

/** A manifest path must be relative, normalized and stay inside the release. */
export function isSafeRelativePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 400) return false;
  if (p.includes('\\') || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p))
    return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export function isForbiddenPath(relPosix) {
  return relPosix.split('/').some((seg) => FORBIDDEN_SEGMENT_PATTERNS.some((re) => re.test(seg)));
}

export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Workspace graph
// ---------------------------------------------------------------------------

/** Minimal parser for the `packages:` list in pnpm-workspace.yaml. */
export function readWorkspacePatterns(repoRoot) {
  const text = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const patterns = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = /^\s+-\s+['"]?([^'"]+)['"]?\s*$/.exec(line);
      if (m) patterns.push(m[1]);
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  for (const p of patterns) {
    if (!/^[A-Za-z0-9_-]+\/\*$/.test(p)) {
      throw new ReleaseError(`unsupported workspace pattern "${p}" (expected "<dir>/*")`);
    }
  }
  return patterns;
}

/** All workspace packages: { name, dir (posix, relative), manifest }. */
export function listWorkspacePackages(repoRoot) {
  const out = [];
  for (const pattern of readWorkspacePatterns(repoRoot)) {
    const base = pattern.slice(0, -2);
    let entries = [];
    try {
      entries = readdirSync(join(repoRoot, base), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = `${base}/${e.name}`;
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      if (typeof manifest.name === 'string') out.push({ name: manifest.name, dir, manifest });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Runtime closure: `rootName` plus every workspace package reachable through
 * `dependencies` entries using the `workspace:` protocol (devDependencies are
 * build-time only and never pull another workspace into the release).
 */
export function computeRuntimeClosure(packages, rootName = API_PACKAGE) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  if (!byName.has(rootName)) throw new ReleaseError(`workspace package ${rootName} not found`);
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    const pkg = byName.get(name);
    if (!pkg) throw new ReleaseError(`workspace dependency ${name} not found`);
    seen.add(name);
    for (const [dep, spec] of Object.entries(pkg.manifest.dependencies ?? {})) {
      if (String(spec).startsWith('workspace:')) visit(dep);
    }
  };
  visit(rootName);
  return [...seen].sort();
}

/** Dependencies-first build order (deterministic: name order among peers). */
export function computeBuildOrder(packages, closure) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const inClosure = new Set(closure);
  const order = [];
  const done = new Set();
  const visiting = new Set();
  const visit = (name) => {
    if (done.has(name)) return;
    if (visiting.has(name)) throw new ReleaseError(`workspace dependency cycle at ${name}`);
    visiting.add(name);
    const deps = Object.entries(byName.get(name).manifest.dependencies ?? {})
      .filter(([dep, spec]) => String(spec).startsWith('workspace:') && inClosure.has(dep))
      .map(([dep]) => dep)
      .sort();
    for (const dep of deps) visit(dep);
    visiting.delete(name);
    done.add(name);
    order.push(name);
  };
  for (const name of [...closure].sort()) visit(name);
  return order;
}

// ---------------------------------------------------------------------------
// Allowlist collection
// ---------------------------------------------------------------------------

/** Recursively list regular files under `dirRel`; symlinks are rejected. */
function walkTree(repoRoot, dirRel, files) {
  for (const e of readdirSync(join(repoRoot, dirRel), { withFileTypes: true })) {
    const rel = `${dirRel}/${e.name}`;
    const st = lstatSync(join(repoRoot, rel));
    if (st.isSymbolicLink()) throw new ReleaseError(`symlink not allowed in release input: ${rel}`);
    if (st.isDirectory()) {
      if (SKIPPED_DIR_NAMES.has(e.name)) continue;
      walkTree(repoRoot, rel, files);
    } else if (st.isFile()) {
      if (SKIPPED_FILE_PATTERNS.some((re) => re.test(e.name))) continue;
      files.push(rel);
    } else {
      throw new ReleaseError(`unsupported file type in release input: ${rel}`);
    }
  }
}

function requireRegularFile(repoRoot, rel) {
  let st;
  try {
    st = lstatSync(join(repoRoot, rel));
  } catch {
    throw new ReleaseError(`required release input missing: ${rel}`);
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new ReleaseError(`required release input is not a regular file: ${rel}`);
  }
}

/**
 * Allowlisted release inputs (POSIX relative paths, sorted):
 *   - ROOT_FILES
 *   - package.json of EVERY workspace package (workspace metadata so the
 *     frozen lockfile matches; excluded workspaces contribute no sources)
 *   - for each closure package: tsconfig.json + src/**
 *   - packages/db/drizzle/*.sql (migration assets)
 */
export function collectReleaseInputs(repoRoot, packages, closure) {
  const files = [...ROOT_FILES];
  const inClosure = new Set(closure);
  for (const pkg of packages) {
    files.push(`${pkg.dir}/package.json`);
    if (!inClosure.has(pkg.name)) continue;
    files.push(`${pkg.dir}/tsconfig.json`);
    walkTree(repoRoot, `${pkg.dir}/src`, files);
  }
  const db = packages.find((p) => p.name === '@fiyatucuz/db');
  if (!db || !inClosure.has(db.name))
    throw new ReleaseError('@fiyatucuz/db is not in the API closure');
  const migrationsDir = `${db.dir}/drizzle`;
  const migrations = readdirSync(join(repoRoot, migrationsDir), { withFileTypes: true })
    .filter((e) => e.name.endsWith('.sql'))
    .map((e) => {
      const rel = `${migrationsDir}/${e.name}`;
      if (!e.isFile() || lstatSync(join(repoRoot, rel)).isSymbolicLink()) {
        throw new ReleaseError(`migration is not a regular file: ${rel}`);
      }
      return rel;
    })
    .sort();
  if (migrations.length === 0) throw new ReleaseError('no migration SQL files found');
  files.push(...migrations);

  for (const rel of files) {
    if (!isSafeRelativePath(rel)) throw new ReleaseError(`unsafe release input path: ${rel}`);
    if (isForbiddenPath(rel))
      throw new ReleaseError(`forbidden (secret-like) file in release input: ${rel}`);
    requireRegularFile(repoRoot, rel);
  }
  return {
    files: [...new Set(files)].sort(),
    migrations: migrations.map((m) => m.split('/').pop()),
  };
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

/**
 * Build the SOURCE artifact into `outputDir` (must not exist; must be outside
 * the repository). `git` is injected so callers/tests control the checkout
 * state: { head: 40-hex, clean: boolean, commitTime: ISO-8601 }.
 * Returns { manifest, manifestSha256 }.
 */
export function prepareRelease({ repoRoot, outputDir, git }) {
  const root = resolve(repoRoot);
  const out = resolve(outputDir);
  if (!git || git.clean !== true) {
    throw new ReleaseError(
      'working tree is not clean — commit or stash changes before preparing a release',
    );
  }
  if (!/^[0-9a-f]{40}$/.test(git.head ?? '')) throw new ReleaseError('invalid git HEAD');
  if (isInside(root, out))
    throw new ReleaseError('output directory must be outside the repository');

  const packages = listWorkspacePackages(root);
  const closure = computeRuntimeClosure(packages);
  const buildOrder = computeBuildOrder(packages, closure);
  const { files, migrations } = collectReleaseInputs(root, packages, closure);

  // Fail closed if the output exists (never merge into or overwrite a release).
  mkdirSync(dirname(out), { recursive: true });
  try {
    mkdirSync(out);
  } catch (err) {
    if (err && err.code === 'EEXIST') throw new ReleaseError('output directory already exists');
    throw err;
  }

  const entries = [];
  for (const rel of files) {
    const src = join(root, ...rel.split('/'));
    const dst = join(out, ...rel.split('/'));
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    const bytes = lstatSync(dst).size;
    entries.push({ path: rel, sha256: sha256File(dst), bytes });
  }

  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const pnpmMatch = /^pnpm@(\d+\.\d+\.\d+)$/.exec(rootManifest.packageManager ?? '');
  if (!pnpmMatch) throw new ReleaseError('root packageManager must pin pnpm@<x.y.z>');
  const byName = new Map(packages.map((p) => [p.name, p]));
  const dirOf = (name) => byName.get(name).dir;
  const apiDir = dirOf(API_PACKAGE);
  const dbDir = dirOf('@fiyatucuz/db');

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    gitCommit: git.head,
    // Commit time, not wall-clock: the same commit yields the same manifest.
    createdAt: git.commitTime,
    nodeVersionRequirement: rootManifest.engines?.node ?? null,
    pnpmVersion: pnpmMatch[1],
    workspaceClosure: closure.map((name) => ({ name, dir: dirOf(name) })),
    excludedWorkspaces: packages
      .filter((p) => !closure.includes(p.name))
      .map((p) => ({ name: p.name, dir: p.dir })),
    buildOrder,
    lockfile: {
      path: 'pnpm-lock.yaml',
      sha256: entries.find((e) => e.path === 'pnpm-lock.yaml').sha256,
    },
    apiEntry: `${apiDir}/dist/index.js`,
    migrationCli: `${dbDir}/dist/cli/migrate.js`,
    migrations,
    requiredBuildOutputs: [
      ...buildOrder.map((name) => `${dirOf(name)}/dist/index.js`),
      `${dbDir}/dist/cli/migrate.js`,
      `${dbDir}/dist/schema/index.js`,
    ].sort(),
    install: { ...INSTALL_CONTRACT },
    files: entries,
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(out, MANIFEST_FILE), text, { flag: 'wx' });
  return { manifest, manifestSha256: sha256Text(text) };
}

// ---------------------------------------------------------------------------
// Install / build plan (target host)
// ---------------------------------------------------------------------------

/**
 * Exact commands for the target host. All executables are explicit paths
 * (portable Node + pnpm's CLI script), so nothing depends on PATH or on a
 * globally installed Node/pnpm. `--ignore-scripts`: no lifecycle script in
 * the API closure is needed (native @node-rs/argon2 ships prebuilt via
 * optionalDependencies), and it keeps install from spawning shells.
 */
export function installPlan(
  manifest,
  { node = '<NODE>', pnpmCli = '<PNPM_CLI_JS>', storeDir = '<STORE_DIR>' } = {},
) {
  const install = [
    node,
    pnpmCli,
    'install',
    '--frozen-lockfile',
    '--package-import-method',
    manifest.install.packageImportMethod,
    '--store-dir',
    storeDir,
    '--filter',
    manifest.install.filter,
    ...(manifest.install.ignoreScripts ? ['--ignore-scripts'] : []),
  ];
  const dirByName = new Map(manifest.workspaceClosure.map((w) => [w.name, w.dir]));
  const build = manifest.buildOrder.map((name) => {
    const dir = dirByName.get(name);
    return [node, `${dir}/node_modules/typescript/bin/tsc`, '-p', `${dir}/tsconfig.json`];
  });
  return { cwd: '<RELEASE_DIR>', install, build };
}

// ---------------------------------------------------------------------------
// Hard-link detection
// ---------------------------------------------------------------------------

/**
 * Regular files under `dir` whose link count is > 1, i.e. sharing their data
 * (and, on NTFS, their security descriptor) with another path — such as a
 * pnpm store. Symlinks/junctions are not followed. On Windows, Node reports
 * the NTFS hard-link count in `nlink`; that behaviour is validated on the
 * Windows host (15A-4), not here.
 */
export function findSharedLinks(dir, baseRel = '') {
  const shared = [];
  const walk = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile() && st.nlink > 1) shared.push(childRel);
    }
  };
  walk(dir, baseRel);
  return shared;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Paths the install/build may add in the materialized stage — and nowhere
 * else: the root node_modules, and for each closure package its own
 * node_modules, dist/ and .tsbuildinfo. Anything else that is not in the
 * manifest (e.g. src/dist/x.js) is an unexpected file.
 */
function isMaterializedExtra(rel, closureDirs) {
  const under = (base, name) => rel === `${base}${name}` || rel.startsWith(`${base}${name}/`);
  if (under('', 'node_modules')) return true;
  return closureDirs.some(
    (d) => under(`${d}/`, 'node_modules') || under(`${d}/`, 'dist') || rel === `${d}/.tsbuildinfo`,
  );
}

/**
 * Verify a release directory.
 *   stage "source":       exactly the manifest's files + manifest; no
 *                         node_modules, no dist, no symlinks.
 *   stage "materialized": source files unchanged; node_modules present with no
 *                         shared hard links; build outputs present; extra
 *                         files only under node_modules / dist / *.tsbuildinfo.
 * Returns { ok, errors } — errors carry relative paths only, never contents.
 */
export function verifyRelease({ releaseDir, stage, expectedManifestSha256 }) {
  const errors = [];
  const root = resolve(releaseDir);
  if (stage !== 'source' && stage !== 'materialized') {
    return { ok: false, errors: ['stage must be "source" or "materialized"'] };
  }

  let manifest;
  let text;
  try {
    text = readFileSync(join(root, MANIFEST_FILE), 'utf8');
    manifest = JSON.parse(text);
  } catch {
    return { ok: false, errors: [`${MANIFEST_FILE} missing or not valid JSON`] };
  }
  if (expectedManifestSha256 && sha256Text(text) !== expectedManifestSha256) {
    errors.push('manifest SHA-256 does not match the expected value');
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION)
    errors.push('unsupported manifest schemaVersion');
  if (manifest.kind !== MANIFEST_KIND) errors.push('unexpected manifest kind');
  if (!/^[0-9a-f]{40}$/.test(manifest.gitCommit ?? '')) errors.push('invalid gitCommit');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    return { ok: false, errors: [...errors, 'manifest lists no files'] };
  }
  // Connection strings / env names / URL userinfo. (A bare word like
  // "password" is legitimate: src/modules/auth/password.ts is a file path.)
  if (
    /postgres(ql)?:\/\/|DATABASE_(MIGRATION_)?URL|[a-z][a-z0-9+.-]*:\/\/[^\s/"@]*:[^\s/"@]*@/i.test(
      text,
    )
  ) {
    errors.push('manifest contains credential-like content');
  }

  // Listed files: safe paths, present, regular, hash match.
  const listed = new Set();
  for (const f of manifest.files) {
    if (!f || !isSafeRelativePath(f.path)) {
      errors.push(`unsafe path in manifest: ${String(f?.path).slice(0, 80)}`);
      continue;
    }
    listed.add(f.path);
    if (isForbiddenPath(f.path)) errors.push(`forbidden file listed in manifest: ${f.path}`);
    const abs = join(root, ...f.path.split('/'));
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      errors.push(`missing file: ${f.path}`);
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) errors.push(`not a regular file: ${f.path}`);
    else if (sha256File(abs) !== f.sha256) errors.push(`hash mismatch: ${f.path}`);
  }

  // Required inputs.
  for (const rel of ROOT_FILES)
    if (!listed.has(rel)) errors.push(`required file not in manifest: ${rel}`);
  const lockEntry = manifest.files.find((f) => f.path === 'pnpm-lock.yaml');
  if (!lockEntry || manifest.lockfile?.sha256 !== lockEntry.sha256)
    errors.push('lockfile hash mismatch');
  const migrationFiles = [...listed].filter((p) => /\/drizzle\/[^/]+\.sql$/.test(p));
  if (migrationFiles.length === 0 || migrationFiles.length !== (manifest.migrations ?? []).length) {
    errors.push('migration SQL files missing or inconsistent with manifest');
  }

  // Workspace closure recomputed from the release's own package.json files.
  try {
    const packages = listWorkspacePackages(root);
    const closure = computeRuntimeClosure(packages);
    const expected = (manifest.workspaceClosure ?? []).map((w) => w.name).sort();
    if (JSON.stringify(closure) !== JSON.stringify(expected))
      errors.push('workspace closure mismatch');
    for (const w of manifest.excludedWorkspaces ?? []) {
      const pkgRoot = join(root, ...w.dir.split('/'));
      for (const e of safeReaddir(pkgRoot)) {
        if (e !== 'package.json') errors.push(`excluded workspace has content: ${w.dir}/${e}`);
      }
    }
  } catch (err) {
    errors.push(`workspace closure check failed: ${err instanceof Error ? err.message : 'error'}`);
  }

  // Walk everything actually present.
  const closureDirs = (manifest.workspaceClosure ?? [])
    .map((w) => w?.dir)
    .filter((d) => isSafeRelativePath(d));
  const nodeModulesDirs = [];
  const walk = (abs, rel) => {
    for (const e of safeReaddir(abs)) {
      const childAbs = join(abs, e);
      const childRel = rel ? `${rel}/${e}` : e;
      const st = lstatSync(childAbs);
      const allowedExtra = stage === 'materialized' && isMaterializedExtra(childRel, closureDirs);
      if (isForbiddenPath(childRel) && !childRel.split('/').includes('node_modules')) {
        errors.push(`forbidden file present: ${childRel}`);
      }
      if (st.isSymbolicLink()) {
        if (!allowedExtra) errors.push(`unexpected symlink: ${childRel}`);
        continue;
      }
      if (st.isDirectory()) {
        if (stage === 'source' && (e === 'node_modules' || e === 'dist')) {
          errors.push(`source artifact must not contain ${childRel}`);
          continue;
        }
        if (allowedExtra && e === 'node_modules') {
          nodeModulesDirs.push({ abs: childAbs, rel: childRel }); // link-checked below
          continue;
        }
        walk(childAbs, childRel);
      } else if (childRel !== MANIFEST_FILE && !listed.has(childRel) && !allowedExtra) {
        errors.push(`unexpected file: ${childRel}`);
      } else if (allowedExtra && st.isFile() && st.nlink > 1) {
        errors.push(`build output is hard-linked: ${childRel}`);
      }
    }
  };
  walk(root, '');

  if (stage === 'materialized') {
    const nm = join(root, 'node_modules');
    if (safeReaddir(nm).length === 0) errors.push('node_modules missing');
    else {
      // Root store layout and every package-level node_modules. Symlinks /
      // junctions (pnpm's dependency graph) are not followed or flagged;
      // only regular files whose data is shared with another path are.
      const shared = nodeModulesDirs.flatMap((d) => findSharedLinks(d.abs, d.rel));
      if (shared.length > 0) {
        errors.push(`${shared.length} dependency file(s) are hard-linked (e.g. ${shared[0]})`);
      }
      const pnpmDir = join(nm, '.pnpm');
      const leaked = safeReaddir(pnpmDir).filter((e) => /^(react-native|expo|next)@/.test(e));
      if (leaked.length > 0) errors.push(`non-API dependencies installed (e.g. ${leaked[0]})`);
    }
    for (const rel of manifest.requiredBuildOutputs ?? []) {
      if (!isSafeRelativePath(rel)) {
        errors.push(`unsafe build output path: ${rel}`);
        continue;
      }
      try {
        const st = lstatSync(join(root, ...rel.split('/')));
        if (!st.isFile()) errors.push(`build output is not a file: ${rel}`);
        else if (st.nlink > 1) errors.push(`build output is hard-linked: ${rel}`);
      } catch {
        errors.push(`missing build output: ${rel}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

// ===========================================================================
// ADIM 15A-4 — archive entry validation (before extraction)
// ===========================================================================

const TAR_TYPE_BY_CHAR = Object.freeze({
  '-': 'file',
  d: 'directory',
  l: 'symlink',
  h: 'hardlink',
});

/**
 * Pair `tar -tf` (exact names, one per line) with `tar -tvf` (type in the
 * first column) for the same archive. Names are never parsed out of the
 * verbose listing (owner/date/link suffixes make that ambiguous). A line-count
 * mismatch (e.g. a name containing a newline) fails closed.
 * bsdtar/libarchive format; Windows tar.exe behaviour is verified in 15A-7.
 */
export function parseTarListings(namesText, verboseText) {
  const split = (t) => t.split(/\r?\n/).filter((l) => l.length > 0);
  const names = split(namesText);
  const verbose = split(verboseText);
  if (names.length === 0) throw new ReleaseError('archive listing is empty');
  if (names.length !== verbose.length) {
    throw new ReleaseError('archive listings disagree (entry count mismatch)');
  }
  return names.map((name, i) => ({
    path: name,
    type: TAR_TYPE_BY_CHAR[verbose[i][0]] ?? 'other',
  }));
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Segments Windows would reinterpret: ":" (drive / alternate data stream),
 * reserved device names, trailing dot/space (silently stripped by Win32),
 * reserved characters and control characters.
 */
function isUnsafeWindowsSegment(seg) {
  return (
    /[:*?"<>|]/.test(seg) ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(seg) ||
    /[. ]$/.test(seg) ||
    WINDOWS_RESERVED.test(seg)
  );
}

/**
 * Validate archive entries BEFORE anything is extracted. Only regular files
 * and directories with safe relative names are allowed: no absolute, drive,
 * UNC or backslash paths, no `..`, no Windows-reinterpreted names (ADS ":",
 * device names, trailing dot/space), no case-insensitive duplicates, no
 * file/directory conflicts, no symlinks / hard links / devices / FIFOs.
 * A leading "./" (tar -C dir .) is accepted and stripped.
 */
export function validateArchiveEntries(entries) {
  const errors = [];
  const seen = new Map(); // lower-cased path -> type (NTFS is case-insensitive)
  for (const entry of entries) {
    const raw = String(entry?.path ?? '');
    const shown = raw.slice(0, 120);
    if (entry?.type !== 'file' && entry?.type !== 'directory') {
      errors.push(`unsupported archive entry type (${entry?.type}): ${shown}`);
      continue;
    }
    if (raw === './' || raw === '.') continue;
    if (/^[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw) || raw.includes('\\') || raw.includes('\0')) {
      errors.push(`unsafe archive path: ${shown}`);
      continue;
    }
    let rel = raw.startsWith('./') ? raw.slice(2) : raw;
    if (entry.type === 'directory') rel = rel.replace(/\/$/, '');
    if (!isSafeRelativePath(rel) || rel.split('/').some(isUnsafeWindowsSegment)) {
      errors.push(`unsafe archive path: ${shown}`);
      continue;
    }
    if (isForbiddenPath(rel)) errors.push(`forbidden file in archive: ${rel}`);
    const key = rel.toLowerCase();
    if (seen.has(key)) errors.push(`duplicate archive entry: ${rel}`);
    seen.set(key, entry.type);
  }
  for (const key of seen.keys()) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      if (seen.get(parts.slice(0, i).join('/')) === 'file') {
        errors.push(`archive entry is below a file: ${key}`);
        break;
      }
    }
  }
  if (seen.get(MANIFEST_FILE) !== 'file') {
    errors.push(`archive does not contain ${MANIFEST_FILE} at its root`);
  }
  return { ok: errors.length === 0, errors };
}

// ===========================================================================
// ADIM 15A-4 — seal (materialized + built + verified release)
// ===========================================================================

export const SEAL_SCHEMA_VERSION = 1;
export const SEAL_KIND = 'fiyatucuz-api-release-seal';

/** Strip the Win32 namespace prefixes readlink may return for junctions. */
function linkTargetPath(target) {
  return String(target).replace(/^(\\\\\?\\|\\\?\?\\)/, '');
}

/**
 * Every entry under `dir` as [rel, kind, value] tuples, sorted by path:
 * files ("file", sha256), directories ("dir", ""), links ("link", target),
 * anything else ("other", ""). Links are recorded, never followed; a link
 * whose target resolves outside `root` is reported in `escapes` (Node would
 * follow it at runtime).
 */
function treeEntries(root, dir, rel, escapes) {
  const out = [];
  const walk = (abs, r) => {
    for (const e of safeReaddir(abs)) {
      const childAbs = join(abs, e);
      const childRel = `${r}/${e}`;
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) {
        // pnpm links (Windows: junctions with absolute targets — the reason a
        // materialized release must never be moved). Target is part of the seal.
        const target = readlinkSync(childAbs);
        if (!isInside(root, resolve(dirname(childAbs), linkTargetPath(target))))
          escapes.push(childRel);
        out.push([childRel, 'link', target]);
      } else if (st.isDirectory()) {
        out.push([childRel, 'dir', '']);
        walk(childAbs, childRel);
      } else if (st.isFile()) {
        out.push([childRel, 'file', sha256File(childAbs)]);
      } else {
        out.push([childRel, 'other', '']);
      }
    }
  };
  walk(dir, rel);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function sealContent(releaseDir, manifest) {
  const root = resolve(releaseDir);
  const escapes = [];
  const closureDirs = manifest.workspaceClosure.map((w) => w.dir);
  const build = closureDirs.flatMap((d) =>
    treeEntries(root, join(root, ...d.split('/'), 'dist'), `${d}/dist`, escapes),
  );
  const nmDirs = ['node_modules', ...closureDirs.map((d) => `${d}/node_modules`)];
  const nm = nmDirs.flatMap((d) => treeEntries(root, join(root, ...d.split('/')), d, escapes));
  // One JSON tuple per line: no separator ambiguity between path, kind and value.
  const digest = (list) => sha256Text(list.map((t) => JSON.stringify(t)).join('\n'));
  return {
    escapes,
    content: {
      buildOutputs: build
        .filter((t) => t[1] === 'file')
        .map(([path, , sha256]) => ({ path, sha256 })),
      buildTreeSha256: digest(build),
      nodeModules: { entries: nm.length, treeSha256: digest(nm) },
    },
  };
}

/**
 * Seal a release that has been materialized, built and verified. The seal is
 * written OUTSIDE the release directory (never inside — the release must stay
 * byte-identical) and must not exist yet. Returns { seal, sealSha256 }.
 */
export function sealRelease({ releaseDir, sealPath, releaseId, expectedManifestSha256 }) {
  const root = resolve(releaseDir);
  if (isInside(root, sealPath))
    throw new ReleaseError('seal must be written outside the release directory');
  if (!expectedManifestSha256)
    throw new ReleaseError('expected manifest SHA-256 is required to seal');
  const result = verifyRelease({ releaseDir: root, stage: 'materialized', expectedManifestSha256 });
  if (!result.ok) {
    throw new ReleaseError(
      `release is not verifiable; refusing to seal (${result.errors.length} error(s))`,
    );
  }
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST_FILE), 'utf8'));
  if (releaseId !== basename(root)) {
    throw new ReleaseError('release id must equal the release directory name');
  }
  const { escapes, content } = sealContent(root, manifest);
  if (escapes.length > 0) {
    throw new ReleaseError(
      `link target outside the release; refusing to seal (e.g. ${escapes[0]})`,
    );
  }
  const seal = {
    schemaVersion: SEAL_SCHEMA_VERSION,
    kind: SEAL_KIND,
    releaseId,
    gitCommit: manifest.gitCommit,
    manifestSha256: expectedManifestSha256,
    ...content,
  };
  const text = `${JSON.stringify(seal, null, 2)}\n`;
  writeFileSync(sealPath, text, { flag: 'wx' });
  return { seal, sealSha256: sha256Text(text) };
}

/**
 * Re-verify a sealed release immediately before activation / rollback:
 * materialized verification + the seal's build-output hashes and node_modules
 * tree hash (catches any change since sealing). Returns { ok, errors }.
 */
export function verifySealedRelease({ releaseDir, sealPath, expectedSealSha256 }) {
  const root = resolve(releaseDir);
  let text;
  let seal;
  try {
    text = readFileSync(sealPath, 'utf8');
    seal = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['seal missing or not valid JSON'] };
  }
  const errors = [];
  if (expectedSealSha256 && sha256Text(text) !== expectedSealSha256)
    errors.push('seal SHA-256 mismatch');
  if (seal.schemaVersion !== SEAL_SCHEMA_VERSION || seal.kind !== SEAL_KIND)
    errors.push('unsupported seal');
  if (seal.releaseId !== basename(root)) errors.push('seal belongs to a different release');
  // Identity must be well-formed: a missing manifest digest would otherwise
  // silently skip the manifest binding below.
  if (!/^[0-9a-f]{64}$/.test(String(seal.manifestSha256 ?? '')))
    errors.push('seal manifest digest invalid');
  if (!/^[0-9a-f]{40}$/.test(String(seal.gitCommit ?? ''))) errors.push('seal commit invalid');
  if (errors.includes('seal manifest digest invalid')) return { ok: false, errors };
  const base = verifyRelease({
    releaseDir: root,
    stage: 'materialized',
    expectedManifestSha256: seal.manifestSha256,
  });
  errors.push(...base.errors);
  if (base.ok) {
    const manifest = JSON.parse(readFileSync(join(root, MANIFEST_FILE), 'utf8'));
    if (manifest.gitCommit !== seal.gitCommit) errors.push('seal commit does not match manifest');
    const { escapes, content: now } = sealContent(root, manifest);
    if (escapes.length > 0) errors.push(`link target outside the release: ${escapes[0]}`);
    if (
      JSON.stringify(now.buildOutputs) !== JSON.stringify(seal.buildOutputs) ||
      now.buildTreeSha256 !== seal.buildTreeSha256
    ) {
      errors.push('build outputs changed since sealing');
    }
    if (now.nodeModules.treeSha256 !== seal.nodeModules?.treeSha256) {
      errors.push('node_modules changed since sealing');
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  // Only after every check passed: the identity read from the bytes verified
  // above (seal text, and the manifest bound to it by its digest).
  return {
    ok: true,
    errors: [],
    identity: {
      releaseId: seal.releaseId,
      gitCommit: seal.gitCommit,
      manifestSha256: seal.manifestSha256,
      sealSha256: sha256Text(text),
    },
  };
}
