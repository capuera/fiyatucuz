import { sql } from 'drizzle-orm';
import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './identity.js';

// -- Enums --------------------------------------------------------------------

export const tenantStatus = pgEnum('tenant_status', ['ACTIVE', 'SUSPENDED', 'DEACTIVATED']);

export const tenantMemberRole = pgEnum('tenant_member_role', ['OWNER', 'ADMIN', 'MEMBER']);

export const tenantMemberStatus = pgEnum('tenant_member_status', [
  'ACTIVE',
  'INVITED',
  'SUSPENDED',
  'REMOVED',
]);

// -- tenants ------------------------------------------------------------------
//
// Global tenant registry. Not tenant-scoped itself — the tenant list is
// administrative data. RLS is NOT enabled on this table.

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique('tenants_slug_unique'),
  status: tenantStatus('status').notNull().default('ACTIVE'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

// -- tenant_users -------------------------------------------------------------
//
// Membership: which users belong to which tenants, and in what role. This is
// the first tenant-scoped table — RLS is enabled with a policy binding
// `tenant_id` to the transaction-local `app.tenant_id` GUC (see the
// 0002_identity_tenants.sql migration).
//
// The unique (tenant_id, user_id) constraint enforces "one membership row per
// (tenant, user) pair" at the database layer; role/status changes are
// UPDATEs on that row, never new INSERTs.

export const tenantUsers = pgTable(
  'tenant_users',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: tenantMemberRole('role').notNull(),
    status: tenantMemberStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    tenantUserUnique: unique('tenant_users_tenant_user_unique').on(t.tenantId, t.userId),
    tenantIdIdx: index('tenant_users_tenant_id_idx').on(t.tenantId),
    userIdIdx: index('tenant_users_user_id_idx').on(t.userId),
  }),
);
