// Public surface of the merchants module.
//
// Per ADR-0003 (modular monolith), other modules import ONLY from this
// barrel — never from routes.ts, service.ts, repository.ts, validation.ts.

export {
  createMerchantService,
  InvalidDomainError,
  MerchantNotFoundError,
  MerchantSiteNotFoundError,
  MerchantSiteDomainAlreadyExistsError,
  MerchantSiteDomainAlreadyVerifiedElsewhereError,
  MerchantSlugAlreadyExistsError,
  VerificationChallengeMissingError,
  VerificationTokenMismatchError,
  type MerchantService,
  type MerchantServiceDeps,
  type VerificationChallenge,
} from './service.js';

export {
  normalizeDomain,
  CreateMerchantBodySchema,
  UpdateMerchantBodySchema,
  CreateMerchantSiteBodySchema,
  UpdateMerchantSiteBodySchema,
  CreateVerificationChallengeBodySchema,
  type CreateMerchantInput,
  type UpdateMerchantInput,
  type CreateMerchantSiteInput,
  type UpdateMerchantSiteInput,
  type CreateVerificationChallengeInput,
} from './validation.js';

export type {
  MerchantRow,
  MerchantInsert,
  MerchantSiteRow,
  MerchantSiteInsert,
} from './repository.js';

export { registerMerchantRoutes, type MerchantRoutesOptions } from './routes.js';

export * as merchantsRepository from './repository.js';
