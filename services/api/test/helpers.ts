import { createDbHandle, loadDbEnv, type DbHandle, type Sql } from '@fiyatucuz/db';

// ---------------------------------------------------------------------------
// Integration-test database guard (ADIM 14) — mirrors
// packages/db/test/helpers.ts. Integration tests TRUNCATE tables, so they
// must never reach the local development database by accident:
//
//   - DATABASE_URL unset  → no default; integration suites skip.
//   - DATABASE_URL set to any database other than EXPECTED_TEST_DATABASE
//                         → this module throws at import time.
//   - After connecting, current_database() is verified again.
// ---------------------------------------------------------------------------

export const EXPECTED_TEST_DATABASE = 'fiyatucuz_adim14';

/** Never-reachable URL used when DATABASE_URL is unset (port 1 refuses). */
const UNCONFIGURED_URL = `postgres://unconfigured@127.0.0.1:1/${EXPECTED_TEST_DATABASE}`;

export class TestDatabaseGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestDatabaseGuardError';
  }
}

/** Throws unless `url` targets {@link EXPECTED_TEST_DATABASE}. */
export function assertTestDatabaseUrl(url: string): void {
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new TestDatabaseGuardError('DATABASE_URL is not a parseable URL');
  }
  if (name !== EXPECTED_TEST_DATABASE) {
    throw new TestDatabaseGuardError(
      `refusing to run integration tests against database "${name}"; ` +
        `DATABASE_URL must target "${EXPECTED_TEST_DATABASE}"`,
    );
  }
}

const configuredUrl = process.env.DATABASE_URL;
// Fail the whole test file at import time on a wrong database.
if (configuredUrl !== undefined) assertTestDatabaseUrl(configuredUrl);

let warnedUnconfigured = false;

export function resolveDatabaseUrl(): string {
  return configuredUrl ?? UNCONFIGURED_URL;
}

export async function isPostgresReachable(): Promise<boolean> {
  if (configuredUrl === undefined) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        `[@fiyatucuz/api] DATABASE_URL unset — integration tests skipped ` +
          `(expected database: ${EXPECTED_TEST_DATABASE}).`,
      );
    }
    return false;
  }
  // Probe via a short-lived DbHandle so the api test suite doesn't need a
  // direct dependency on the postgres driver.
  const env = loadDbEnv({
    DATABASE_URL: configuredUrl,
    DATABASE_POOL_MAX: '1',
    DATABASE_CONNECT_TIMEOUT_SECONDS: '3',
    DATABASE_IDLE_TIMEOUT_SECONDS: '1',
  });
  const probe = createDbHandle(env);
  let actual: string;
  try {
    const rows = await probe.sql<Array<{ db: string }>>`select current_database() as db`;
    actual = rows[0]?.db ?? '';
  } catch {
    return false;
  } finally {
    try {
      await probe.close();
    } catch {
      /* ignore */
    }
  }
  if (actual !== EXPECTED_TEST_DATABASE) {
    throw new TestDatabaseGuardError(
      `connected to database "${actual}", expected "${EXPECTED_TEST_DATABASE}"`,
    );
  }
  return true;
}

export function makeTestDbHandle(): DbHandle {
  const env = loadDbEnv({
    ...process.env,
    DATABASE_URL: resolveDatabaseUrl(),
    DATABASE_POOL_MAX: '4',
    DATABASE_CONNECT_TIMEOUT_SECONDS: '5',
    DATABASE_IDLE_TIMEOUT_SECONDS: '2',
    DATABASE_PREPARED_STATEMENTS: 'false',
  });
  return createDbHandle(env);
}

/**
 * Truncate identity + tenant tables between tests so ordering is
 * deterministic. Uses raw postgres.js `sql` (bypasses Drizzle typing) since
 * the migration runs before tests do; running as superuser here.
 *
 * Left intentionally coarse: RESTART IDENTITY is not needed (all PKs are
 * UUIDs generated in the app), CASCADE handles FK order.
 */
export async function truncateIdentityAndTenants(sql: Sql): Promise<void> {
  await sql.unsafe(`
    TRUNCATE TABLE
      refresh_tokens,
      sessions,
      credentials,
      oauth_identities,
      tenant_users,
      tenants,
      users
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Truncate merchant tables + identity + tenants together (CASCADE handles the
 * FK from merchant_sites → merchants and from merchants → tenants). Kept as
 * an additive helper so existing tests continue to use the narrower one.
 */
export async function truncateAllBusinessTables(sql: Sql): Promise<void> {
  await sql.unsafe(`
    TRUNCATE TABLE
      merchant_sites,
      merchants,
      refresh_tokens,
      sessions,
      credentials,
      oauth_identities,
      tenant_users,
      tenants,
      users
    RESTART IDENTITY CASCADE
  `);
}
