// Public surface of the tenants module.
//
// Per ADR-0003 (modular monolith), other modules import ONLY from this
// barrel — never from repository.ts or service.ts directly.

export {
  createTenant,
  addMember,
  listMembers,
  listMembershipsForUser,
  findMembership,
  validateSlug,
  TenantAlreadyExistsError,
  TenantNotFoundError,
  InvalidTenantSlugError,
  type CreateTenantInput,
  type AddMemberInput,
} from './service.js';

export type {
  TenantRow,
  TenantInsert,
  TenantMembershipRow,
  TenantMembershipInsert,
} from './repository.js';

export * as tenantsRepository from './repository.js';
