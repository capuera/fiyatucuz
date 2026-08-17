// Public surface of the identity module.
//
// Per ADR-0003 (modular monolith), other modules import ONLY from this
// barrel — never from repository.ts or service.ts directly. The barrel is
// the enforced boundary that later lets us extract identity into its own
// worker/service if scale demands it.

export {
  createUser,
  findUserById,
  findUserByEmail,
  normalizeEmail,
  UserAlreadyExistsError,
  UserNotFoundError,
  type CreateUserInput,
} from './service.js';

export type {
  UserRow,
  UserInsert,
  CredentialRow,
  CredentialInsert,
  OAuthIdentityRow,
  OAuthIdentityInsert,
  SessionRow,
  SessionInsert,
  RefreshTokenRow,
  RefreshTokenInsert,
} from './repository.js';

// The repository namespace is exported for tests and for future modules
// that need direct persistence primitives inside a shared transaction. It
// is NOT part of the public HTTP surface.
export * as identityRepository from './repository.js';
