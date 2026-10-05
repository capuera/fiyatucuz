#!/usr/bin/env node
// Prettier gate with an explicit historical baseline (ADIM 15A-6B).
//
//   node scripts/ci/check-format.mjs [--changed-since <git-ref>]
//
// Policy (docs/development/ci.md):
//   1. Every file Prettier checks must be formatted, EXCEPT the files listed in
//      scripts/ci/prettier-baseline.txt (historical debt, formatted later).
//   2. The baseline only shrinks: a listed file that is now formatted (or no
//      longer exists) must be removed from the list.
//   3. With --changed-since, a baseline file changed since that ref must be
//      formatted in the same change (debt is paid when a file is touched).
//
// Exit codes: 0 ok, 1 gate failed, 2 usage / tool error.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BASELINE_FILE = join(ROOT, 'scripts', 'ci', 'prettier-baseline.txt');

/** Baseline file → sorted repo-relative POSIX paths ('#' comments, blanks ignored). */
export function parseBaseline(text) {
  const paths = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  const dupes = paths.filter((p, i) => paths.indexOf(p) !== i);
  if (dupes.length > 0) throw new Error(`duplicate baseline entries: ${dupes.join(', ')}`);
  return [...paths].sort();
}

/**
 * Pure gate decision.
 *   unformatted: files Prettier reports as not formatted
 *   baseline:    grandfathered files
 *   changed:     files changed since the reference (null = rule not applied)
 */
export function evaluateFormatGate({ unformatted, baseline, changed = null }) {
  const bad = new Set(unformatted);
  const grand = new Set(baseline);
  const newDebt = [...bad].filter((f) => !grand.has(f)).sort();
  const staleBaseline = [...grand].filter((f) => !bad.has(f)).sort();
  const changedBaseline =
    changed === null ? [] : [...new Set(changed)].filter((f) => grand.has(f) && bad.has(f)).sort();
  return {
    ok: newDebt.length === 0 && staleBaseline.length === 0 && changedBaseline.length === 0,
    newDebt,
    staleBaseline,
    changedBaseline,
  };
}

function prettierBin() {
  const require = createRequire(join(ROOT, 'package.json'));
  const pkgPath = require.resolve('prettier/package.json');
  const bin = JSON.parse(readFileSync(pkgPath, 'utf8')).bin;
  return join(dirname(pkgPath), typeof bin === 'string' ? bin : bin.prettier);
}

/** Files Prettier would change, repo-relative (honours .prettierignore). */
function listUnformatted() {
  const r = spawnSync(process.execPath, [prettierBin(), '--list-different', '.'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  // --list-different: 0 = all formatted, 1 = some differ, 2 = Prettier error.
  if (r.error || (r.status !== 0 && r.status !== 1)) {
    process.stderr.write(r.stderr || String(r.error));
    throw new Error('prettier failed');
  }
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/\\/g, '/'));
}

function changedSince(ref) {
  const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', shell: false });
  if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status !== 0) {
    throw new Error(`--changed-since: unknown git ref ${JSON.stringify(ref)}`);
  }
  const r = git(['diff', '--name-only', '--diff-filter=ACMR', ref, '--']);
  if (r.status !== 0) throw new Error('git diff failed');
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

function main(argv) {
  let ref = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--changed-since' && argv[i + 1]) {
      ref = argv[i + 1];
      i += 1;
    } else {
      process.stderr.write('usage: check-format.mjs [--changed-since <git-ref>]\n');
      return 2;
    }
  }
  const baseline = parseBaseline(readFileSync(BASELINE_FILE, 'utf8'));
  const changed = ref === null ? null : changedSince(ref); // validates the ref before Prettier runs
  const result = evaluateFormatGate({ unformatted: listUnformatted(), baseline, changed });
  const say = (line) => process.stdout.write(`${line}\n`);
  for (const f of result.newDebt)
    say(`[format] not formatted (run: pnpm exec prettier --write ${f}): ${f}`);
  for (const f of result.changedBaseline) {
    say(`[format] baseline file changed, format it and remove it from the baseline: ${f}`);
  }
  for (const f of result.staleBaseline) {
    say(
      `[format] baseline entry is formatted or gone, remove it from scripts/ci/prettier-baseline.txt: ${f}`,
    );
  }
  say(
    result.ok
      ? `[format] OK — ${baseline.length} historical file(s) remain in the baseline${ref ? `; changed since ${ref} checked` : ''}`
      : '[format] FAILED',
  );
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`[format] error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  }
}
