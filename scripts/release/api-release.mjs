#!/usr/bin/env node
// FiyatUcuz API release CLI (ADIM 15A-3, ADR-0020). Node built-ins only.
//
//   node scripts/release/api-release.mjs closure
//   node scripts/release/api-release.mjs prepare --output <dir>
//   node scripts/release/api-release.mjs verify --release <dir> --stage source|materialized [--manifest-sha256 <hex>]
//   node scripts/release/api-release.mjs install-plan --release <dir> [--node <path>] [--pnpm <pnpm.cjs>] [--store <dir>]
//
// Exit codes: 0 ok, 1 verification/preparation failure, 2 usage error.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  computeBuildOrder,
  computeRuntimeClosure,
  installPlan,
  listWorkspacePackages,
  MANIFEST_FILE,
  prepareRelease,
  ReleaseError,
  verifyRelease,
} from './release-lib.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

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

class UsageError extends Error {}

function gitState(repoRoot) {
  const git = (...a) => execFileSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8' }).trim();
  return {
    head: git('rev-parse', 'HEAD'),
    clean: git('status', '--porcelain', '--untracked-files=normal') === '',
    commitTime: git('show', '-s', '--format=%cI', 'HEAD'),
  };
}

function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'closure': {
      parseOptions(rest, []);
      const packages = listWorkspacePackages(REPO_ROOT);
      const closure = computeRuntimeClosure(packages);
      out(`closure: ${closure.join(', ')}`);
      out(`build order: ${computeBuildOrder(packages, closure).join(' -> ')}`);
      out(
        `excluded: ${packages
          .filter((p) => !closure.includes(p.name))
          .map((p) => p.name)
          .join(', ')}`,
      );
      return 0;
    }
    case 'prepare': {
      const opts = parseOptions(rest, ['--output']);
      if (!opts.output) throw new UsageError('--output is required');
      const { manifest, manifestSha256 } = prepareRelease({
        repoRoot: REPO_ROOT,
        outputDir: opts.output,
        git: gitState(REPO_ROOT),
      });
      out(`prepared source release for ${manifest.gitCommit} (${manifest.files.length} files)`);
      out(`manifest sha256: ${manifestSha256}`);
      return 0;
    }
    case 'verify': {
      const opts = parseOptions(rest, ['--release', '--stage', '--manifest-sha256']);
      if (!opts.release || !opts.stage) throw new UsageError('--release and --stage are required');
      const result = verifyRelease({
        releaseDir: opts.release,
        stage: opts.stage,
        expectedManifestSha256: opts['manifest-sha256'],
      });
      if (result.ok) {
        out(`release OK (${opts.stage})`);
        return 0;
      }
      for (const e of result.errors) err(`verify: ${e}`);
      return 1;
    }
    case 'install-plan': {
      const opts = parseOptions(rest, ['--release', '--node', '--pnpm', '--store']);
      if (!opts.release) throw new UsageError('--release is required');
      const manifest = JSON.parse(readFileSync(join(resolve(opts.release), MANIFEST_FILE), 'utf8'));
      const plan = installPlan(manifest, {
        ...(opts.node ? { node: opts.node } : {}),
        ...(opts.pnpm ? { pnpmCli: opts.pnpm } : {}),
        ...(opts.store ? { storeDir: opts.store } : {}),
      });
      out(JSON.stringify(plan, null, 2));
      return 0;
    }
    default:
      throw new UsageError(
        'usage: api-release.mjs <closure|prepare|verify|install-plan> [options]',
      );
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    err(e.message);
    process.exitCode = 2;
  } else if (e instanceof ReleaseError) {
    err(`release: ${e.message}`);
    process.exitCode = 1;
  } else {
    err(`release: unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
