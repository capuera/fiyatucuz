---
number: 0020
title: Windows release artifact and dependency isolation
status: accepted
date: 2026-10-04
deciders: project owner
supersedes:
superseded-by:
---

# 0020 — Windows release artifact and dependency isolation

## Context

The ADIM 14 production deploy ran `pnpm install` as Administrator directly in the live checkout.

- On NTFS, pnpm's default import method **hard-linked** package files to the Administrator's pnpm store. A hard link shares the file record — and so its security descriptor — with the store. Directory-level `LocalService` RX was therefore not enough.
- The `FiyatUcuzApi` service (LocalService) failed to load dependencies such as `saxes`, while Administrator could run the same build in the foreground.
- A recursive `icacls` over `node_modules` fixed it, but processed hundreds of thousands of files and failed on long React Native paths. The unfiltered install also pulled the web/mobile workspaces.

Constraints:

- `@node-rs/argon2` is a native dependency, so a `node_modules` built on macOS cannot run on Windows (ADR-0017 §15).
- The host has a global Node 24 used by other applications. FiyatUcuz uses its own portable Node 22.

## Decision

1. **API-only closure.** A release contains `@fiyatucuz/api` and the workspace packages reachable through its `dependencies` (`workspace:` protocol): `api`, `config`, `db`, `types`, `validation`.
   - `apps/web` and `apps/mobile` contribute only their `package.json`, so the frozen lockfile's importers match; they contribute no sources and no installed dependencies.
2. **Two stages.**
   - **(a) Source artifact.** Prepared on any OS from a clean commit. It is an allowlist copy (root install/build files, workspace manifests, closure `tsconfig.json` + `src/**`, `packages/db/drizzle/*.sql`) plus `release-manifest.json` with the SHA-256 of every file.
   - **(b) Materialization on the Windows host.** Dependencies are installed and the packages built **there**. A macOS `node_modules` is never shipped.
3. **Install contract** (target host, from `install-plan`):

   ```
   <node> <pnpm.cjs> install --frozen-lockfile --package-import-method copy \
     --store-dir <isolated store> --filter @fiyatucuz/api... --ignore-scripts
   ```

   - `copy` creates new file records that inherit the release directory's ACL.
   - The isolated store keeps the Administrator profile store out of the picture.
   - `--ignore-scripts` is safe for this closure (no needed lifecycle scripts) and avoids spawning shells.
   - Flags are passed per invocation; the repository `.npmrc` is unchanged, so developer workflows keep their defaults.

4. **Build contract.** `tsc` runs per closure package, dependencies first, invoked as `<node> <pkg>/node_modules/typescript/bin/tsc`. There is no `pnpm -r`, no reliance on `PATH`, and no global Node/pnpm.
5. **Invariant.** Production release dependency files MUST NOT be hard-linked to any other path (in particular an Administrator/global pnpm store). `verify --stage materialized` rejects any dependency or build-output file with link count > 1.
6. **Secrets stay external.** Releases never contain `.env*`, `migration.env`, keys, dumps, logs or archived feed bodies. Prepare and verify fail closed on secret-like names and on symlinks. The migration credential is supplied at deploy time (ADR-0019).
7. **Immutability.**
   - A release directory is never reused: prepare refuses an existing output, and the output must be outside the repository.
   - The manifest's own SHA-256 is recorded out of band and re-checked on the host.
   - Activation (junction/service) is a later step and only uses a verified release.

Tooling lives in `scripts/release/`, outside the pnpm workspace. A `packages/*` tool would be a workspace importer and change `pnpm-lock.yaml`. It uses Node built-ins only and is tested with `node:test`.

## Alternatives considered

- **`pnpm deploy --prod`** — deferred. It is marked experimental in pnpm 9.15.4, and the workspace packages have no `files` field (their `dist/` is gitignored).
- **Shipping `node_modules` from macOS or CI Linux** — rejected (native dependencies).
- **Repository-wide `package-import-method=copy` in `.npmrc`** — rejected. It would slow every developer install for a production-only need.
- **Recursive `icacls` after install** — rejected (cost, long paths, and it also rewrites the shared store records).
- **Windows CI artifact** — deferred. It is a valid later option with the same manifest and verify contract.

## Consequences

**Positive:**

- LocalService access no longer depends on store ACLs.
- No React Native/Next tree on the server, which removes the long-path exposure.
- Every release input is hash-verified.
- Explicit Node/pnpm paths keep FiyatUcuz independent of the host's global Node.

**Negative / costs:**

- Copying is slower and uses more disk than hard links.
- devDependencies (TypeScript etc.) remain in the materialized release because the build runs there; pruning is deferred.
- The install/build contract and the NTFS `nlink` behaviour are verified only on Windows (ADIM 15A-4 / 15A-7). Mac tests cover APFS semantics only.

## Follow-ups

- ADIM 15A-4: Windows materialization wrapper, LocalService effective-access check, activation/rollback.
- ADIM 15A-7: staging rehearsal of the exact install/build contract, including frozen-lockfile behaviour with manifest-only excluded workspaces.
- Later: prune devDependencies after build; Windows CI artifact; `pnpm deploy` once stable.
