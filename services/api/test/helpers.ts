import { createDbHandle, loadDbEnv, type DbHandle, type Sql } from '@fiyatucuz/db';

const DEFAULT_LOCAL_URL = 'postgres://fiyatucuz:fiyatucuz@127.0.0.1:5432/fiyatucuz';

export function resolveDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL;
}

export async function isPostgresReachable(): Promise<boolean> {
  // Probe via a short-lived DbHandle so the api test suite doesn't need a
  // direct dependency on the postgres driver.
  const env = loadDbEnv({
    DATABASE_URL: resolveDatabaseUrl(),
    DATABASE_POOL_MAX: '1',
    DATABASE_CONNECT_TIMEOUT_SECONDS: '3',
    DATABASE_IDLE_TIMEOUT_SECONDS: '1',
  });
  const probe = createDbHandle(env);
  try {
    await probe.sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    try {
      await probe.close();
    } catch {
      /* ignore */
    }
  }
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
