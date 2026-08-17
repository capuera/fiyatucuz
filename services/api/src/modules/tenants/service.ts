import {
  newId,
  transaction,
  withTenantTransaction,
  type Db,
} from '@fiyatucuz/db';

import * as repo from './repository.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TenantAlreadyExistsError extends Error {
  readonly code = 'TENANT_ALREADY_EXISTS' as const;
  constructor(public readonly slug: string) {
    super(`tenant already exists for slug ${slug}`);
    this.name = 'TenantAlreadyExistsError';
  }
}

export class InvalidTenantSlugError extends Error {
  readonly code = 'INVALID_TENANT_SLUG' as const;
  constructor(public readonly slug: string, reason: string) {
    super(`invalid tenant slug "${slug}": ${reason}`);
    this.name = 'InvalidTenantSlugError';
  }
}

export class TenantNotFoundError extends Error {
  readonly code = 'TENANT_NOT_FOUND' as const;
  constructor(public readonly identifier: string) {
    super(`tenant not found: ${identifier}`);
    this.name = 'TenantNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Slug validation
// ---------------------------------------------------------------------------
//
// Slugs are URL-safe short identifiers used in tenant-facing URLs. Not a
// security boundary (RLS is), but must be predictable and DNS-friendly.
// Rules kept intentionally simple: 3–48 chars, lowercase alnum + hyphen,
// no leading/trailing hyphen, no consecutive hyphens.

const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$/;

export function validateSlug(input: string): string {
  const slug = input.trim().toLowerCase();
  if (slug.length < 3 || slug.length > 48) {
    throw new InvalidTenantSlugError(input, 'length must be 3..48 characters');
  }
  if (!SLUG_RE.test(slug)) {
    throw new InvalidTenantSlugError(
      input,
      'must match [a-z0-9] with optional single hyphens, no leading/trailing hyphen',
    );
  }
  return slug;
}

// ---------------------------------------------------------------------------
// Tenant creation
// ---------------------------------------------------------------------------

export interface CreateTenantInput {
  readonly name: string;
  readonly slug: string;
}

export async function createTenant(db: Db, input: CreateTenantInput): Promise<repo.TenantRow> {
  const slug = validateSlug(input.slug);

  return transaction(db, async (tx) => {
    const existing = await repo.findTenantBySlug(tx, slug);
    if (existing) throw new TenantAlreadyExistsError(slug);
    return repo.insertTenant(tx, {
      id: newId(),
      name: input.name.trim(),
      slug,
      status: 'ACTIVE',
    });
  });
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------
//
// addMember opens a tenant-scoped transaction. Callers do not need to (and
// must not) manage the app.tenant_id GUC themselves — the helper owns it.
//
// Note that "first tenant creator becomes OWNER" is an application workflow
// decision (which caller decides which role to assign at signup time); the
// database enforces relational integrity, not the workflow.

export interface AddMemberInput {
  readonly userId: string;
  readonly role: repo.TenantMembershipRow['role'];
  readonly status?: repo.TenantMembershipRow['status'];
}

export async function addMember(
  db: Db,
  tenantId: string,
  input: AddMemberInput,
): Promise<repo.TenantMembershipRow> {
  return withTenantTransaction(db, tenantId, (tx) =>
    repo.insertMembership(tx, {
      id: newId(),
      tenantId,
      userId: input.userId,
      role: input.role,
      status: input.status ?? 'ACTIVE',
    }),
  );
}

export async function listMembers(
  db: Db,
  tenantId: string,
): Promise<readonly repo.TenantMembershipRow[]> {
  return withTenantTransaction(db, tenantId, (tx) =>
    repo.listMembershipsForTenant(tx, tenantId),
  );
}

export async function findMembership(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<repo.TenantMembershipRow | null> {
  return withTenantTransaction(db, tenantId, (tx) => repo.findMembership(tx, tenantId, userId));
}

/**
 * Auth-bootstrap lookup: list every tenant the given user belongs to,
 * regardless of tenant context. Backed by the SECURITY DEFINER helper
 * `public.auth_bootstrap_memberships(uuid)` (see ADR-0013 §Authentication
 * bootstrap RLS resolution).
 *
 * Intended to be called exactly once per authentication event, after the
 * user has been authenticated (session valid) but before they have chosen
 * a tenant to act in. Once a tenant is chosen, all subsequent queries use
 * withTenantTransaction / RLS as normal.
 *
 * Filtering (e.g. hiding REMOVED memberships) is the caller's decision —
 * this function returns the raw membership set so different call sites can
 * choose different UI treatments.
 */
export async function listMembershipsForUser(
  db: Db,
  userId: string,
): Promise<readonly repo.TenantMembershipRow[]> {
  return repo.listMembershipsForUser(db, userId);
}
