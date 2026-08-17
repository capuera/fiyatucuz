import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import type { DbEnv } from './env.js';
import * as schema from './schema/index.js';

/** Raw postgres.js client (escape hatch for COPY, LISTEN/NOTIFY, hand-tuned SQL). */
export type Sql = ReturnType<typeof postgres>;

/** Drizzle client bound to the shared schema barrel. */
export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Everything a caller needs to talk to and later close the database.
 *
 * The pool is created lazily by postgres.js — no TCP connection is opened until the
 * first query. This is intentional so the API can boot without PostgreSQL reachable
 * (health/liveness must not depend on DB — see ADR-0012).
 */
export interface DbHandle {
  readonly db: Db;
  readonly sql: Sql;
  /** Graceful shutdown. Drains in-flight queries, then closes sockets. */
  readonly close: () => Promise<void>;
}

/**
 * Create a database handle from a validated {@link DbEnv}.
 *
 * Import-safe: does not touch the network. Suitable for Fastify boot and for future
 * worker processes.
 */
export function createDbHandle(env: DbEnv): DbHandle {
  const sql = postgres(env.DATABASE_URL, {
    max: env.DATABASE_POOL_MAX,
    connect_timeout: env.DATABASE_CONNECT_TIMEOUT_SECONDS,
    idle_timeout: env.DATABASE_IDLE_TIMEOUT_SECONDS,
    max_lifetime: env.DATABASE_MAX_LIFETIME_SECONDS,
    prepare: env.DATABASE_PREPARED_STATEMENTS,
    ssl: env.DATABASE_SSL,
    // Swallow server NOTICEs by default; tests/tooling can override by passing their own sql.
    onnotice: () => {},
  });

  const db = drizzle(sql, { schema });

  return {
    db,
    sql,
    close: async () => {
      // Give in-flight statements up to 5s to finish before force-closing.
      await sql.end({ timeout: 5 });
    },
  };
}
