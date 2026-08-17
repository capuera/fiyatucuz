import { randomUUID } from 'node:crypto';

/**
 * Generate a new application identifier stored in PostgreSQL as `uuid`.
 *
 * ADIM 9 uses UUIDv4 via `node:crypto` — Node.js 22 does not ship a native
 * UUIDv7 generator and this sprint deliberately avoids new dependencies.
 * UUIDv7 (time-ordered, index-friendly) is the target format; when a native
 * generator lands (or when a small trusted library is adopted), this is the
 * only call site that changes. The database storage type (`uuid`) is
 * identical for both formats — no schema migration is required.
 *
 * Every domain entity that lands after ADIM 9 must generate its primary key
 * via this function. Do not call `crypto.randomUUID` directly from repository
 * or service code.
 */
export function newId(): string {
  return randomUUID();
}
