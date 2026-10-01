// Public surface of the offers module (ADR-0003: other modules import ONLY
// from this barrel). ADIM 14 provides the tenant-scoped write path used by
// the feed importer plus minimal reads; the public cross-tenant read model
// is a later step (ADR-0018 §Follow-ups).

export {
  findExistingByExternalIds,
  upsertOffers,
  deactivateUnseenOffers,
  listOffersForFeed,
  findOfferByExternalId,
  type MerchantOfferRow,
  type MerchantOfferInsert,
  type OfferStatus,
  type ExistingOfferState,
} from './repository.js';

export * as offersRepository from './repository.js';
