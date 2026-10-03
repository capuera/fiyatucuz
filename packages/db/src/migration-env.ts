import { EnvError } from '@fiyatucuz/config';

import { loadDbEnv, type DbEnv } from './env.js';

/**
 * Migration database environment (ADIM 15A-1).
 *
 * DATABASE_MIGRATION_URL is a **separate** credential from the API runtime's
 * DATABASE_URL. The runtime login deliberately has no DDL rights; migrations
 * run under their own credential, which the API never reads.
 *
 * There is **no fallback to DATABASE_URL in any environment** — not keyed on
 * NODE_ENV either (NODE_ENV defaults to "development", so an env-based
 * fallback would fail open in a misconfigured production). Same pattern as
 * loadReportingDbEnv (reporting.ts).
 *
 * DATABASE_MIGRATION_EXPECTED_DB is required: the CLI compares it against
 * `current_database()` before touching anything (wrong-target protection).
 *
 * Error messages never include the URL or any part of it.
 */

export const MIGRATION_URL_VAR = 'DATABASE_MIGRATION_URL';
export const MIGRATION_EXPECTED_DB_VAR = 'DATABASE_MIGRATION_EXPECTED_DB';

/** Migrations are strictly sequential; one connection is enough. */
export const MIGRATION_POOL_MAX = 1;

export interface MigrationDbEnv {
  /** Connection settings (DATABASE_URL here is the migration URL). */
  readonly db: DbEnv;
  /** Database name the connection must report via current_database(). */
  readonly expectedDatabase: string;
}

export class MigrationEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationEnvError';
  }
}

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

export function loadMigrationDbEnv(
  source: Record<string, string | undefined> = process.env,
): MigrationDbEnv {
  const url = source[MIGRATION_URL_VAR]?.trim();
  if (!url) {
    throw new MigrationEnvError(
      `${MIGRATION_URL_VAR} is required. The migration CLI never uses DATABASE_URL ` +
        '(the API runtime credential).',
    );
  }
  const expectedDatabase = source[MIGRATION_EXPECTED_DB_VAR]?.trim();
  if (!expectedDatabase) {
    throw new MigrationEnvError(
      `${MIGRATION_EXPECTED_DB_VAR} is required (name of the database the migration must target).`,
    );
  }
  if (expectedDatabase.length > 63) {
    throw new MigrationEnvError(`${MIGRATION_EXPECTED_DB_VAR} exceeds 63 characters.`);
  }

  // Validate shape here so no downstream parser can echo the URL back.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MigrationEnvError(`${MIGRATION_URL_VAR} is not a valid URL.`);
  }
  if (!POSTGRES_PROTOCOLS.has(parsed.protocol)) {
    throw new MigrationEnvError(`${MIGRATION_URL_VAR} must use the postgres:// scheme.`);
  }

  // Reuse the primary DbEnvSchema by substituting the URL (reporting.ts
  // pattern). The source's own DATABASE_URL is overwritten, never read.
  try {
    const db = loadDbEnv({
      ...source,
      DATABASE_URL: url,
      DATABASE_POOL_MAX: String(MIGRATION_POOL_MAX),
    });
    return { db, expectedDatabase };
  } catch (err) {
    if (err instanceof EnvError) {
      // Issue messages carry paths + reasons, never input values.
      const summary = err.zodError.issues
        .map(
          (i) =>
            `${String(i.path[0] ?? '(root)').replace('DATABASE_URL', MIGRATION_URL_VAR)}: ${i.message}`,
        )
        .join('; ');
      throw new MigrationEnvError(`Invalid migration environment: ${summary}`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Output sanitization
// ---------------------------------------------------------------------------

// scheme://user:password@  →  scheme://user:***@   (any URL-like credential)
const URL_CREDENTIALS_RE = /([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]*):([^\s@/]*)@/gi;

/**
 * Remove credentials from free text: every given secret (full URL, raw and
 * decoded password) is replaced, then any `scheme://user:pass@` left over is
 * masked. Used for every line the migration CLI prints on failure.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('[REDACTED]');
  }
  return out.replace(URL_CREDENTIALS_RE, '$1$2:***@');
}

/** Secrets derived from a database URL that must never appear in output. */
export function secretsOfDatabaseUrl(url: string): string[] {
  const secrets = [url];
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      secrets.push(parsed.password);
      try {
        secrets.push(decodeURIComponent(parsed.password));
      } catch {
        /* undecodable password — raw form already covered */
      }
    }
  } catch {
    /* not parseable — full string already covered */
  }
  return secrets;
}

/**
 * Safe one-line description of an error. Only `name`, an SQLSTATE/errno
 * `code` and `message` are used — never the object itself, so properties
 * like Node's ERR_INVALID_URL `input` or driver connection metadata cannot
 * leak. The result is passed through {@link redactSecrets}.
 */
export function describeError(err: unknown, secrets: readonly string[] = []): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const codePart =
      typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code) ? ` [${code}]` : '';
    return redactSecrets(`${err.name}${codePart}: ${err.message}`, secrets);
  }
  return redactSecrets(`non-error thrown: ${typeof err}`, secrets);
}
