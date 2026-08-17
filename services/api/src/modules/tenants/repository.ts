import { and, eq, sql, type Db, type Tx } from '@fiyatucuz/db';
import { tenants, tenantUsers } from '@fiyatucuz/db/schema';

// ---------------------------------------------------------------------------
// Types derived from the Drizzle schema
// ---------------------------------------------------------------------------

export type TenantRow = typeof tenants.$inferSelect;
export type TenantInsert = typeof tenants.$inferInsert;

export type TenantMembershipRow = typeof tenantUsers.$inferSelect;
export type TenantMembershipInsert = typeof tenantUsers.$inferInsert;

// ---------------------------------------------------------------------------
// tenants — global registry, no RLS on this table
// ---------------------------------------------------------------------------

export async function findTenantById(tx: Tx, id: string): Promise<TenantRow | null> {
  const rows = await tx.select().from(tenants).where(eq(tenants.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findTenantBySlug(tx: Tx, slug: string): Promise<TenantRow | null> {
  const rows = await tx.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function insertTenant(tx: Tx, input: TenantInsert): Promise<TenantRow> {
  const rows = await tx.insert(tenants).values(input).returning();
  const row = rows[0];
  if (!row) throw new Error('insertTenant: RETURNING produced no row');
  return row;
}

// ---------------------------------------------------------------------------
// tenant_users — TENANT-SCOPED table (RLS applies).
//
// These functions MUST be called from inside a withTenantTransaction (or
// the equivalent) — the RLS policy on tenant_users will reject every query
// otherwise (fail-closed by design; see ADR-0013).
// ---------------------------------------------------------------------------

export async function insertMembership(
  tx: Tx,
  input: TenantMembershipInsert,
): Promise<TenantMembershipRow> {
  const rows = await tx.insert(tenantUsers).values(input).returning();
  const row = rows[0];
  if (!row) throw new Error('insertMembership: RETURNING produced no row');
  return row;
}

export async function findMembershipByUser(
  tx: Tx,
  userId: string,
): Promise<TenantMembershipRow | null> {
  const rows = await tx
    .select()
    .from(tenantUsers)
    .where(eq(tenantUsers.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function findMembership(
  tx: Tx,
  tenantId: string,
  userId: string,
): Promise<TenantMembershipRow | null> {
  const rows = await tx
    .select()
    .from(tenantUsers)
    .where(and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listMembershipsForTenant(
  tx: Tx,
  tenantId: string,
): Promise<readonly TenantMembershipRow[]> {
  // RLS is the security boundary; the explicit WHERE is the query semantic.
  // Both apply in production and independently prove the intent. Also makes
  // the function correct under connections that legitimately bypass RLS
  // (superuser during tests, reporting queries).
  return tx.select().from(tenantUsers).where(eq(tenantUsers.tenantId, tenantId));
}

// ---------------------------------------------------------------------------
// Auth-bootstrap lookup — calls the SECURITY DEFINER helper
// public.auth_bootstrap_memberships(uuid) established in migration 0003.
//
// Called from the auth path BEFORE any tenant context is chosen. The DB
// function is the only sanctioned way for fiyatucuz_app to read a user's
// memberships across tenants; it is narrowly scoped (returns only rows for
// the passed user id) and takes no other input. See ADR-0013 §Authentication
// bootstrap RLS resolution.
//
// Takes `Db` (not `Tx`) because the call is a top-level bootstrap outside
// any withTenantTransaction — there is no tenant context to bind here by
// design.
// ---------------------------------------------------------------------------

// db.execute() returns raw postgres.js rows; timestamps come back as strings
// because Drizzle's `mode: 'date'` converter only applies through the typed
// table-select builder. Parse to Date at the boundary so callers get the
// same Date-typed TenantMembershipRow they would from listMembershipsForTenant.
interface AuthBootstrapRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly role: TenantMembershipRow['role'];
  readonly status: TenantMembershipRow['status'];
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
}

function toDate(v: string | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

export async function listMembershipsForUser(
  db: Db,
  userId: string,
): Promise<readonly TenantMembershipRow[]> {
  const rows = await db.execute(
    sql`select id, tenant_id, user_id, role, status, created_at, updated_at
        from public.auth_bootstrap_memberships(${userId})`,
  );
  return (rows as unknown as readonly AuthBootstrapRow[]).map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    role: r.role,
    status: r.status,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  }));
}
