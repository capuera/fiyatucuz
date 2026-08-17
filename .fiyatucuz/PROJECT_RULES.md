# PROJECT_RULES

Operational rules for every contributor — human or AI. These rules bind until amended via an ADR or explicit user instruction.

## 1. Git

- **No autonomous commits or pushes.** Every commit requires explicit user instruction in the same turn.
- **No destructive operations** without explicit user instruction: `git reset --hard`, `git clean -fd`, `git checkout .`, `git branch -D`, force-push, `git rebase -i`.
- **Never skip hooks** (`--no-verify`, `--no-gpg-sign`) unless the user explicitly asks.
- **Never modify `.git/config` or repository settings** without explicit user instruction.
- New commits are preferred over amending existing ones. Amend only when the user asks.
- Feature branches: `feat/<short-slug>`, `fix/<short-slug>`, `chore/<short-slug>`, `docs/<short-slug>`.
- Commit messages: Conventional Commits (`type(scope): subject`) — matches existing history.

## 2. Dependencies

- No dependency may be installed without an ADR (or an explicit user request for prototyping).
- Prefer packages that are:
  - MIT / Apache-2.0 / BSD licensed
  - Actively maintained (commit in the last 12 months)
  - Zero-native-code where reasonable
  - Widely adopted in the Node.js ecosystem
- Reject packages that:
  - Bundle heavy runtimes (electron, headless browsers) into always-loaded paths
  - Are single-maintainer with no fallback and > 1M weekly downloads risk
  - Vendor-lock the codebase to a proprietary service

## 3. Code style

- **TypeScript strict mode** everywhere. `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- **No `any`.** Use `unknown` + narrowing. Escape hatches require an inline comment explaining why.
- **No default exports** in shared packages (`packages/*`, `services/*`). Named exports only. App-level files (Next.js pages, RN screens) may use default exports where the framework requires them.
- File names: `kebab-case.ts`. React components: `PascalCase.tsx`.
- **No comments explaining WHAT.** Comment only WHY when non-obvious.
- **No dead code.** Delete instead of commenting out.
- Prefer pure functions and value objects over classes for domain logic. Classes are acceptable at framework boundaries (repositories, controllers).

## 4. Domain and architecture

- All new business logic must belong to a named bounded context (see `docs/architecture/bounded-contexts.md`).
- **Never create a cross-context import** that bypasses a package boundary. Contexts communicate via contracts, not shared internals.
- **Never introduce a new bounded context** without updating `docs/architecture/bounded-contexts.md` in the same PR.
- **Never store money as `number`.** Use minor units (`bigint` for TRY kuruş) or a decimal type.
- **Never store PII outside `identity` or `users`** contexts.

## 5. Multi-tenancy

- Every tenant-scoped table has a non-null `tenant_id` column.
- Every query touching tenant-scoped data must include a tenant filter — enforced at the repository layer, and eventually via RLS.
- **Never** trust a `tenant_id` supplied by the client. Derive it from the authenticated principal.

## 6. Security

- No secrets in source. `.env.example` documents every required variable; real values live outside the repo.
- All external inputs (HTTP body, query, headers, feeds, uploads) validated with Zod at the boundary.
- Passwords hashed with Argon2id. Tokens signed with EdDSA (Ed25519) preferred over RS256/HS256.
- Rate limits and abuse controls are architectural concerns, not afterthoughts.

## 7. Testing

- New backend module → unit tests for domain logic + integration test for the primary contract.
- New API endpoint → contract test (schema-level) + at least one integration test.
- No test may hit production infrastructure. Integration tests use ephemeral Postgres/Redis in Docker or Testcontainers.

## 8. Documentation

- Any architectural decision → ADR under `adr/`.
- Any new bounded context or domain term → update `docs/domain/ubiquitous-language.md`.
- **Do not create documentation files that are not required by an existing decision.** Empty README files are noise.

## 9. AI-specific

- Announce the smallest coherent change before making it.
- Never generate business rules from imagination. If unclear, ask.
- Never invent data. If a value is unknown, mark it explicitly (`// TODO(ask-user):`).
- Do not run long-running background processes or dev servers without asking.
- Do not send network traffic to third-party services beyond package registries without explicit user approval.

## 10. Files that must not be modified without explicit user approval

- `.git/*`
- `LICENSE` (once created)
- `README.md` — treat as public marketing surface; edits should be minimal and factual.
- Any file under `adr/` marked `status: accepted` — supersede instead of editing.
