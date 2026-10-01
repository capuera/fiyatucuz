import postgres from 'postgres';

import { createDbHandle, loadDbEnv, type DbHandle } from '../src/index.js';

// ---------------------------------------------------------------------------
// Integration-test database guard (ADIM 14).
//
// Integration tests apply migrations and TRUNCATE tables, so they must never
// reach the local development database or anything else by accident:
//
//   - DATABASE_URL unset  → there is NO default; integration suites skip.
//   - DATABASE_URL set to any database other than EXPECTED_TEST_DATABASE
//                         → this module throws at import time, before any
//                           test (or migration) runs.
//   - After connecting, current_database() is verified again so a pooler
//     alias cannot redirect the tests elsewhere.
//
// Run integration tests with, e.g.:
//   DATABASE_URL=postgres://fiyatucuz:fiyatucuz@127.0.0.1:5432/fiyatucuz_adim14 pnpm test
// ---------------------------------------------------------------------------

export const EXPECTED_TEST_DATABASE = 'fiyatucuz_adim14';

/**
 * Never-reachable URL used when DATABASE_URL is unset, so a handle created in
 * a skipped suite's body can never connect anywhere (port 1 refuses).
 */
const UNCONFIGURED_URL = `postgres://unconfigured@127.0.0.1:1/${EXPECTED_TEST_DATABASE}`;

export class TestDatabaseGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestDatabaseGuardError';
  }
}

function databaseNameOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TestDatabaseGuardError('DATABASE_URL is not a parseable URL');
  }
  return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
}

/** Throws unless `url` targets {@link EXPECTED_TEST_DATABASE}. */
export function assertTestDatabaseUrl(url: string): void {
  const name = databaseNameOf(url);
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

/** The configured, guarded test DATABASE_URL — or a never-reachable sentinel. */
export function resolveDatabaseUrl(): string {
  return configuredUrl ?? UNCONFIGURED_URL;
}

/**
 * Probe PostgreSQL. Returns false (suites skip) when DATABASE_URL is unset or
 * the server is unreachable. Throws when the connected database is not the
 * expected test database.
 */
export async function isPostgresReachable(): Promise<boolean> {
  if (configuredUrl === undefined) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        `[@fiyatucuz/db] DATABASE_URL unset — integration tests skipped ` +
          `(expected database: ${EXPECTED_TEST_DATABASE}).`,
      );
    }
    return false;
  }
  const probe = postgres(configuredUrl, {
    max: 1,
    connect_timeout: 3,
    idle_timeout: 1,
    prepare: false,
    onnotice: () => {},
  });
  let actual: string;
  try {
    const rows = await probe<Array<{ db: string }>>`select current_database() as db`;
    actual = rows[0]?.db ?? '';
  } catch {
    return false;
  } finally {
    try {
      await probe.end({ timeout: 2 });
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

/**
 * Build a DbHandle for integration tests using the guarded DATABASE_URL and
 * safe defaults. Uses loadDbEnv so the test path exercises the real env schema.
 */
export function makeTestDbHandle(): DbHandle {
  const env = loadDbEnv({
    ...process.env,
    DATABASE_URL: resolveDatabaseUrl(),
    // Small pool for tests to keep the local container lightly loaded.
    DATABASE_POOL_MAX: '4',
    DATABASE_CONNECT_TIMEOUT_SECONDS: '5',
    DATABASE_IDLE_TIMEOUT_SECONDS: '2',
    DATABASE_PREPARED_STATEMENTS: 'false',
  });
  return createDbHandle(env);
}
