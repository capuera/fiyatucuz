import { sql } from 'drizzle-orm';

import type { Db } from './client.js';
import type { Tx } from './transaction.js';

/**
 * Custom GUC namespace used by every RLS policy (see ADR-0004, ADR-0012).
 *
 * Reserved for the primary tenant scoping only; do not add ad-hoc `app.*` GUCs
 * without an ADR update — every one becomes a piece of RLS surface area.
 */
export const TENANT_GUC = 'app.tenant_id';

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

function assertValidTenantId(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== 'string') {
    throw new TenantContextError('tenantId must be a string');
  }
  if (tenantId.length === 0 || tenantId.length > 64) {
    throw new TenantContextError('tenantId must be a non-empty string <= 64 chars');
  }
  // Reject control chars / whitespace / anything that could be interpreted as a
  // separator by downstream tooling. The value is bound via a parameter to
  // set_config() anyway, so injection is not possible; this is a sanity gate to
  // catch obviously malformed inputs at the API boundary.
  if (!/^[A-Za-z0-9._:-]+$/.test(tenantId)) {
    throw new TenantContextError('tenantId contains disallowed characters');
  }
}

/**
 * Run `fn` inside a transaction whose {@link TENANT_GUC} is bound to `tenantId`.
 *
 * The GUC is set with `set_config(name, value, is_local := true)`, which is the
 * exact functional equivalent of `SET LOCAL app.tenant_id = '<id>'` — scoped to
 * the current transaction and reverted at COMMIT/ROLLBACK. This is safe under
 * pgBouncer transaction pooling; a session-scoped `SET` would leak across
 * checkouts of the same physical connection.
 *
 * Callers do not need to remember to unset anything. Nested tenant contexts are
 * intentionally not supported: repositories should treat the tenant as an input
 * to the top-level unit of work, not something a downstream call re-scopes.
 */
export async function withTenantTransaction<T>(
  db: Db,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertValidTenantId(tenantId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config(${TENANT_GUC}, ${tenantId}, true)`);
    return fn(tx);
  });
}
