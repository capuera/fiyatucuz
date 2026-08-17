import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { createUser } from '../src/modules/identity/index.js';
import {
  addMember,
  createTenant,
  findMembership,
  InvalidTenantSlugError,
  listMembers,
  listMembershipsForUser,
  TenantAlreadyExistsError,
  validateSlug,
} from '../src/modules/tenants/index.js';

import { isPostgresReachable, makeTestDbHandle, truncateIdentityAndTenants } from './helpers.js';

const reachable = await isPostgresReachable();

describe('tenants — validateSlug (unit)', () => {
  it('accepts a well-formed slug', () => {
    expect(validateSlug('acme-corp')).toBe('acme-corp');
    expect(validateSlug('AcMe-Corp')).toBe('acme-corp');
  });

  it('rejects too short', () => {
    expect(() => validateSlug('ab')).toThrow(InvalidTenantSlugError);
  });

  it('rejects too long', () => {
    expect(() => validateSlug('x'.repeat(49))).toThrow(InvalidTenantSlugError);
  });

  it('rejects leading/trailing hyphen and double hyphens', () => {
    expect(() => validateSlug('-abc')).toThrow(InvalidTenantSlugError);
    expect(() => validateSlug('abc-')).toThrow(InvalidTenantSlugError);
    expect(() => validateSlug('a--b')).toThrow(InvalidTenantSlugError);
  });

  it('rejects invalid characters', () => {
    expect(() => validateSlug('abc_def')).toThrow(InvalidTenantSlugError);
    expect(() => validateSlug('abc.def')).toThrow(InvalidTenantSlugError);
    expect(() => validateSlug('abc def')).toThrow(InvalidTenantSlugError);
  });
});

describe.skipIf(!reachable)(
  'tenants — repository + service (integration; requires PostgreSQL)',
  () => {
    const handle = makeTestDbHandle();

    afterEach(async () => {
      await truncateIdentityAndTenants(handle.sql);
    });

    afterAll(async () => {
      await handle.close();
    });

    it('createTenant inserts and returns the row', async () => {
      const t = await createTenant(handle.db, { name: 'Acme Corp', slug: 'acme-corp' });
      expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(t.slug).toBe('acme-corp');
      expect(t.status).toBe('ACTIVE');
    });

    it('createTenant rejects duplicate slug', async () => {
      await createTenant(handle.db, { name: 'A', slug: 'dup-tenant' });
      await expect(
        createTenant(handle.db, { name: 'B', slug: 'dup-tenant' }),
      ).rejects.toBeInstanceOf(TenantAlreadyExistsError);
    });

    it('addMember inserts under the correct tenant context and returns the row', async () => {
      const tenant = await createTenant(handle.db, { name: 'A', slug: 'mem-tenant' });
      const user = await createUser(handle.db, { email: 'owner@example.com' });

      const membership = await addMember(handle.db, tenant.id, {
        userId: user.id,
        role: 'OWNER',
      });

      expect(membership.tenantId).toBe(tenant.id);
      expect(membership.userId).toBe(user.id);
      expect(membership.role).toBe('OWNER');
      expect(membership.status).toBe('ACTIVE');
    });

    it('addMember refuses to write a row with a different tenant_id (WITH CHECK)', async () => {
      // Impossible via the service (it uses tenant_id from the tx context),
      // but we test the DB-level guard by attempting a direct INSERT with a
      // mismatched tenant_id inside a withTenantTransaction bound to tenant A.
      const a = await createTenant(handle.db, { name: 'A', slug: 'guard-a' });
      const b = await createTenant(handle.db, { name: 'B', slug: 'guard-b' });
      const user = await createUser(handle.db, { email: 'guard@example.com' });

      const { withTenantTransaction, newId, sql } = await import('@fiyatucuz/db');

      await expect(
        withTenantTransaction(handle.db, a.id, async (tx) => {
          // Manual INSERT bypassing the service. Switch effective role to
          // fiyatucuz_app so RLS applies (test connection is superuser).
          // WITH CHECK on the policy must reject: tenant_id (b.id) ≠
          // current_setting (a.id).
          await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
          await tx.execute(
            sql`insert into tenant_users (id, tenant_id, user_id, role) values (${newId()}, ${b.id}, ${user.id}, 'MEMBER')`,
          );
        }),
      ).rejects.toThrow(/row-level security|policy/i);
    });

    it('listMembers returns only rows for the requested tenant', async () => {
      const a = await createTenant(handle.db, { name: 'A', slug: 'list-a' });
      const b = await createTenant(handle.db, { name: 'B', slug: 'list-b' });
      const alice = await createUser(handle.db, { email: 'alice@example.com' });
      const bob = await createUser(handle.db, { email: 'bob@example.com' });

      await addMember(handle.db, a.id, { userId: alice.id, role: 'OWNER' });
      await addMember(handle.db, b.id, { userId: bob.id, role: 'OWNER' });

      const membersOfA = await listMembers(handle.db, a.id);
      const membersOfB = await listMembers(handle.db, b.id);

      expect(membersOfA).toHaveLength(1);
      expect(membersOfA[0]?.userId).toBe(alice.id);
      expect(membersOfB).toHaveLength(1);
      expect(membersOfB[0]?.userId).toBe(bob.id);
    });

    it('findMembership returns null when the user is not a member of the tenant', async () => {
      const a = await createTenant(handle.db, { name: 'A', slug: 'notmem-a' });
      const alice = await createUser(handle.db, { email: 'alice2@example.com' });
      const found = await findMembership(handle.db, a.id, alice.id);
      expect(found).toBeNull();
    });

    it('listMembershipsForUser (auth-bootstrap) returns every tenant the user belongs to', async () => {
      // Backed by the SECURITY DEFINER helper auth_bootstrap_memberships(uuid).
      // Called BEFORE any tenant context has been chosen — cross-tenant read
      // for the given user only.
      const a = await createTenant(handle.db, { name: 'A', slug: 'boot-svc-a' });
      const b = await createTenant(handle.db, { name: 'B', slug: 'boot-svc-b' });
      const alice = await createUser(handle.db, { email: 'alice-boot-svc@example.com' });
      const bob = await createUser(handle.db, { email: 'bob-boot-svc@example.com' });

      await addMember(handle.db, a.id, { userId: alice.id, role: 'OWNER' });
      await addMember(handle.db, b.id, { userId: alice.id, role: 'MEMBER' });
      await addMember(handle.db, a.id, { userId: bob.id, role: 'MEMBER' });

      const aliceMemberships = await listMembershipsForUser(handle.db, alice.id);
      expect(aliceMemberships).toHaveLength(2);
      // Every returned row is Alice's — the SQL function's WHERE clause
      // hard-codes the filter, and the WHERE is not overridable by the caller.
      expect(aliceMemberships.every((m) => m.userId === alice.id)).toBe(true);
      expect(aliceMemberships.map((m) => m.tenantId).sort()).toEqual([a.id, b.id].sort());
      expect(aliceMemberships[0]?.createdAt).toBeInstanceOf(Date);
      expect(aliceMemberships[0]?.updatedAt).toBeInstanceOf(Date);

      const bobMemberships = await listMembershipsForUser(handle.db, bob.id);
      expect(bobMemberships).toHaveLength(1);
      expect(bobMemberships[0]?.userId).toBe(bob.id);
    });
  },
);

if (!reachable) {
  console.warn('[@fiyatucuz/api] tenants.test.ts: skipping integration tests — PG unreachable.');
}
