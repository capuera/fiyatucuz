import type { Db } from './client.js';

/**
 * Drizzle transaction handle for the postgres-js dialect.
 *
 * Derived from {@link Db} so it always tracks whatever driver/schema options the
 * client is instantiated with. Repositories accept `Tx` and are indifferent to
 * whether they were opened inside a plain {@link transaction} or a
 * `withTenantTransaction`.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Run a callback inside a database transaction.
 *
 * - Commits when the callback resolves.
 * - Rolls back when the callback throws (Drizzle rethrows so the caller sees the
 *   original error).
 */
export async function transaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction((tx) => fn(tx));
}
