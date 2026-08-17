import postgres from 'postgres';

import { createDbHandle, loadDbEnv, type DbHandle } from '../src/index.js';

/** Default local development URL — matches infra/dev/docker-compose.yml. */
export const DEFAULT_LOCAL_URL = 'postgres://fiyatucuz:fiyatucuz@127.0.0.1:5432/fiyatucuz';

/** Resolve DATABASE_URL for tests: env first, then the local Docker default. */
export function resolveDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL;
}

/**
 * Probe PostgreSQL. Returns true iff a plain `SELECT 1` succeeds against the
 * resolved DATABASE_URL within a short window. Never throws.
 */
export async function isPostgresReachable(): Promise<boolean> {
  const probe = postgres(resolveDatabaseUrl(), {
    max: 1,
    connect_timeout: 3,
    idle_timeout: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    try {
      await probe.end({ timeout: 2 });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Build a DbHandle for integration tests using the resolved DATABASE_URL and
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
