/**
 * Feed import orchestration (ADR-0018).
 *
 * performImport(tenantId, importId):
 *   1. claim   — short tenant tx: QUEUED → PROCESSING with a fresh
 *                claim_token + lease (or take over an expired lease).
 *                Superseded imports fail fast; another worker's live claim
 *                is waited on, never duplicated.
 *   2. verify  — archive ref must match tenant/feed/fetch; pass 1 re-hashes
 *                the archive (no DB tx open).
 *   3. parse   — pass 2 streams through UTF-8 gate + security scanner →
 *                saxes extractor → normalizer. Accepted offers are flushed
 *                in bounded batches, one short tenant tx per batch; each
 *                batch tx also heartbeats the lease (claim_token-guarded).
 *   4. finalize— one short tenant tx. ONLY a SUCCESS import deactivates
 *                unseen offers; PARTIAL and FAILED never do.
 *
 * No DB transaction is held across archive I/O.
 */

import { randomUUID } from 'node:crypto';

import { newId, withTenantTransaction, type Db } from '@fiyatucuz/db';
import type { Logger } from 'pino';

import { merchantsRepository } from '../../merchants/index.js';
import { offersRepository, type MerchantOfferInsert } from '../../offers/index.js';
import type { FeedArchive } from '../archive/types.js';
import type { FeedEnv } from '../env.js';
import { parserFor } from '../parser/index.js';
import { XmlSecurityError } from '../parser/xml-security.js';
import * as feedsRepo from '../repository.js';

import { ImportError, ImportLeaseLostError } from './errors.js';
import { resolveFeedMapping } from './mapping.js';
import { normalizeFeedItem, type ItemIssue, type NormalizedOffer } from './normalize/offer.js';
import { truncateCodePoints } from './normalize/text.js';
import * as importRepo from './repository.js';
import { streamVerifiedXmlText, verifyArchiveIntegrity, type ExpectedArchive } from './verified-archive.js';
import { XmlDocumentError, type RawFeedItem } from './xml-items.js';

export class FeedImportNotFoundError extends Error {
  readonly code = 'FEED_IMPORT_NOT_FOUND' as const;
  readonly httpStatus = 404;
  constructor(public readonly importId: string) {
    super('feed import not found');
    this.name = 'FeedImportNotFoundError';
  }
}

export interface FeedImporterDeps {
  readonly db: Db;
  readonly env: FeedEnv;
  readonly archive: FeedArchive;
  readonly logger?: Logger;
}

export interface FeedImporter {
  /** Run (or observe) the import to a terminal state; returns the row. */
  performImport(tenantId: string, importId: string): Promise<importRepo.FeedImportRow>;
}

const POLL_STEP_MS = 25;
/** Waiting for another import of the same feed (rare after LEASE_EXPIRED recovery). */
const FEED_IDLE_POLL_MS = 250;
const ONE_PROCESSING_PER_FEED = 'feed_imports_one_processing_per_feed';

function isUniqueViolationOn(err: unknown, constraint: string): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { code?: unknown; constraint_name?: unknown; constraint?: unknown; message?: unknown };
  if (e.code !== '23505') return false;
  if (e.constraint_name === constraint || e.constraint === constraint) return true;
  return String(e.message ?? '').includes(constraint);
}

function sanitizeMessage(input: string, cap = 500): string {
  const oneLine = input.replace(/\s+/g, ' ').trim();
  return oneLine.length > cap ? oneLine.slice(0, cap) : oneLine;
}

function classify(err: unknown): { code: string; message: string } {
  if (err instanceof ImportError) return { code: err.code, message: err.message };
  if (err instanceof XmlDocumentError) return { code: err.code, message: err.message };
  if (err instanceof XmlSecurityError) {
    return { code: 'XML_SECURITY_REJECTED', message: `${err.subcode}: ${err.message}` };
  }
  return { code: 'IMPORT_FAILED', message: 'unexpected import failure' };
}

type ClaimOutcome =
  | { kind: 'terminal'; row: importRepo.FeedImportRow }
  | { kind: 'owned-elsewhere'; row: importRepo.FeedImportRow }
  | { kind: 'feed-busy' }
  | {
      kind: 'claimed';
      row: importRepo.FeedImportRow;
      token: string;
      fetch: feedsRepo.FeedFetchRow | null;
      feed: feedsRepo.FeedRow | null;
      siteDomain: string | null;
    };

export function createFeedImporter(deps: FeedImporterDeps): FeedImporter {
  const { db, env, archive, logger } = deps;
  const leaseUntil = (): Date => new Date(Date.now() + env.FEED_IMPORT_LEASE_MS);

  async function tryClaim(tenantId: string, importId: string): Promise<ClaimOutcome> {
    try {
      return await withTenantTransaction(db, tenantId, async (tx): Promise<ClaimOutcome> => {
        const row = await importRepo.findImportById(tx, tenantId, importId);
        if (!row) throw new FeedImportNotFoundError(importId);
        if (row.status === 'SUCCESS' || row.status === 'PARTIAL' || row.status === 'FAILED') {
          return { kind: 'terminal', row };
        }
        if (row.status === 'QUEUED' && (await importRepo.hasNewerActiveImport(tx, tenantId, row.feedId, row))) {
          const failed = await importRepo.failQueuedImport(
            tx, tenantId, importId, 'SUPERSEDED', 'a newer import of this feed already ran', new Date(),
          );
          return { kind: 'terminal', row: failed ?? row };
        }
        const now = new Date();
        // Recover the feed from a crashed import (expired lease) before
        // claiming, in the same transaction (ADR-0018 §Import state).
        await importRepo.expireStaleProcessingImports(tx, tenantId, row.feedId, importId, now);
        const token = randomUUID();
        const claimed = await importRepo.claimImport(tx, tenantId, importId, {
          token,
          now,
          leaseExpiresAt: leaseUntil(),
        });
        if (!claimed) return { kind: 'owned-elsewhere', row };
        const fetch = await feedsRepo.findFetchByIdAcrossFeeds(tx, tenantId, claimed.fetchId);
        const feed = await feedsRepo.findFeedByIdForTenant(tx, tenantId, claimed.feedId);
        const site = feed
          ? await merchantsRepository.findMerchantSiteByIdForTenant(tx, tenantId, feed.merchantSiteId)
          : null;
        return {
          kind: 'claimed',
          row: claimed,
          token,
          fetch,
          feed,
          siteDomain: site?.normalizedDomain ?? null,
        };
      });
    } catch (err) {
      // A different import of the same feed is PROCESSING (partial unique
      // index). The tx rolled back; nothing changed.
      if (isUniqueViolationOn(err, ONE_PROCESSING_PER_FEED)) return { kind: 'feed-busy' };
      throw err;
    }
  }

  async function readImport(tenantId: string, importId: string): Promise<importRepo.FeedImportRow> {
    const row = await withTenantTransaction(db, tenantId, (tx) =>
      importRepo.findImportById(tx, tenantId, importId),
    );
    if (!row) throw new FeedImportNotFoundError(importId);
    return row;
  }

  /** Poll until `done(row)` or the lease window elapses. */
  async function pollImport(
    tenantId: string,
    importId: string,
    done: (row: importRepo.FeedImportRow) => boolean,
  ): Promise<importRepo.FeedImportRow> {
    const deadline = Date.now() + env.FEED_IMPORT_LEASE_MS;
    while (true) {
      const row = await readImport(tenantId, importId);
      if (done(row) || Date.now() >= deadline) return row;
      await new Promise((resolve) => setTimeout(resolve, POLL_STEP_MS));
    }
  }

  async function finalizeFailed(
    tenantId: string,
    importId: string,
    token: string,
    counters: importRepo.ImportCounters,
    samples: readonly importRepo.ImportErrorSample[],
    err: unknown,
  ): Promise<importRepo.FeedImportRow> {
    const { code, message } = classify(err);
    const row = await withTenantTransaction(db, tenantId, (tx) =>
      importRepo.finalizeImport(tx, tenantId, importId, token, {
        status: 'FAILED',
        finishedAt: new Date(),
        counters,
        itemsDeactivated: 0,
        errorCode: code,
        errorMessage: sanitizeMessage(message),
        errorSamples: samples,
      }),
    );
    return row ?? (await readImport(tenantId, importId));
  }

  async function run(
    tenantId: string,
    claim: Extract<ClaimOutcome, { kind: 'claimed' }>,
  ): Promise<importRepo.FeedImportRow> {
    const importId = claim.row.id;
    const { token } = claim;
    const counters = {
      itemsSeen: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      itemsUnchanged: 0,
      itemsRejected: 0,
      itemsWarned: 0,
    };
    const samples: importRepo.ImportErrorSample[] = [];
    const sample = (
      index: number,
      externalId: string | null,
      issue: ItemIssue,
      severity: importRepo.ImportErrorSample['severity'],
    ): void => {
      if (samples.length >= env.FEED_IMPORT_MAX_ERROR_SAMPLES) return;
      samples.push({
        index,
        externalId: externalId === null ? null : truncateCodePoints(externalId, 64),
        field: issue.field,
        code: issue.code,
        severity,
      });
    };

    try {
      // -- preconditions (no I/O beyond the claim tx) -------------------------
      const { fetch, feed } = claim;
      if (!feed || !fetch || fetch.feedId !== feed.id) {
        throw new ImportError('FETCH_NOT_IMPORTABLE', 'feed or fetch row missing');
      }
      if (fetch.status !== 'SUCCESS' || !fetch.rawArchiveRef || !fetch.contentHash) {
        throw new ImportError('FETCH_NOT_IMPORTABLE', 'fetch has no verified archived body');
      }
      if (claim.siteDomain === null) throw new ImportError('SITE_NOT_FOUND', 'merchant site missing');
      const resolved = resolveFeedMapping(feed.format, feed.itemMapping);
      if (!resolved.ok) throw new ImportError(resolved.code, resolved.message);
      const mapping = resolved.mapping;
      const siteDomain = claim.siteDomain;

      const expected: ExpectedArchive = {
        tenantId,
        feedId: feed.id,
        fetchId: fetch.id,
        format: feed.format,
        ref: fetch.rawArchiveRef,
        contentHash: fetch.contentHash,
        contentType: fetch.contentType,
        maxBytes: env.FEED_FETCH_MAX_BYTES,
      };

      // -- pass 1: integrity before any write ---------------------------------
      await verifyArchiveIntegrity(archive, expected);

      // -- pass 2: parse + normalize + batched upsert --------------------------
      const pending: RawFeedItem[] = [];
      const extractor = parserFor(feed.format).createItemExtractor(
        mapping,
        {
          maxItems: env.FEED_IMPORT_MAX_ITEMS,
          maxFieldChars: env.FEED_IMPORT_MAX_FIELD_CHARS,
          maxDepth: env.FEED_IMPORT_MAX_DEPTH,
          maxElementsPerItem: env.FEED_IMPORT_MAX_ELEMENTS_PER_ITEM,
          maxAttributesPerElement: env.FEED_IMPORT_MAX_ATTRIBUTES_PER_ELEMENT,
        },
        (item) => pending.push(item),
      );
      // externalId → offer; first occurrence within the batch wins.
      let batch = new Map<string, { index: number; offer: NormalizedOffer }>();
      // Lease renewal also happens on a timer so a long stretch without a
      // flush (e.g. mostly-rejected items) never lets the lease lapse.
      let lastBeat = Date.now();
      const heartbeatEveryMs = Math.max(250, Math.floor(env.FEED_IMPORT_LEASE_MS / 3));
      const maybeHeartbeat = async (): Promise<void> => {
        if (Date.now() - lastBeat < heartbeatEveryMs) return;
        const alive = await withTenantTransaction(db, tenantId, (tx) =>
          importRepo.heartbeatImport(tx, tenantId, importId, token, leaseUntil(), counters),
        );
        if (!alive) throw new ImportLeaseLostError(importId);
        lastBeat = Date.now();
      };

      const flush = async (): Promise<void> => {
        if (batch.size === 0) return;
        const entries = [...batch.values()];
        batch = new Map();
        const now = new Date();
        const delta = { created: 0, updated: 0, unchanged: 0, duplicates: 0 };
        await withTenantTransaction(db, tenantId, async (tx) => {
          const alive = await importRepo.heartbeatImport(tx, tenantId, importId, token, leaseUntil(), counters);
          if (!alive) throw new ImportLeaseLostError(importId);
          const existing = await offersRepository.findExistingByExternalIds(
            tx,
            tenantId,
            feed.id,
            entries.map((e) => e.offer.externalId),
          );
          const rows: MerchantOfferInsert[] = [];
          for (const { index, offer } of entries) {
            const prior = existing.get(offer.externalId);
            if (prior?.lastSeenClaimToken === token) {
              // Same identity already accepted earlier in this document by
              // this attempt (a takeover has a new token and re-writes).
              delta.duplicates += 1;
              sample(index, offer.externalId, { field: 'externalId', code: 'DUPLICATE_EXTERNAL_ID' }, 'rejected');
              continue;
            }
            if (!prior) delta.created += 1;
            else if (prior.contentHash === offer.contentHash) delta.unchanged += 1;
            else delta.updated += 1;
            rows.push(toInsertRow(offer, { tenantId, feed, importId, token, now }));
          }
          await offersRepository.upsertOffers(tx, rows);
        });
        lastBeat = Date.now();
        counters.itemsCreated += delta.created;
        counters.itemsUpdated += delta.updated;
        counters.itemsUnchanged += delta.unchanged;
        counters.itemsRejected += delta.duplicates;
      };

      const drain = async (): Promise<void> => {
        while (pending.length > 0) {
          const raw = pending.shift()!;
          counters.itemsSeen += 1;
          const result = normalizeFeedItem(raw, mapping, { siteDomain });
          if (result.kind === 'rejected') {
            counters.itemsRejected += 1;
            sample(raw.index, result.externalId, result.issue, 'rejected');
            continue;
          }
          if (result.warnings.length > 0) {
            counters.itemsWarned += 1;
            for (const w of result.warnings) sample(raw.index, result.offer.externalId, w, 'warning');
          }
          if (batch.has(result.offer.externalId)) {
            counters.itemsRejected += 1;
            sample(raw.index, result.offer.externalId, { field: 'externalId', code: 'DUPLICATE_EXTERNAL_ID' }, 'rejected');
            continue;
          }
          batch.set(result.offer.externalId, { index: raw.index, offer: result.offer });
          if (batch.size >= env.FEED_IMPORT_BATCH_SIZE) await flush();
        }
      };

      await streamVerifiedXmlText(archive, expected, async (text) => {
        extractor.write(text);
        await drain();
        await maybeHeartbeat();
      });
      extractor.close();
      await drain();
      await flush();

      // -- finalize ------------------------------------------------------------
      const accepted = counters.itemsCreated + counters.itemsUpdated + counters.itemsUnchanged;
      if (accepted === 0) throw new ImportError('NO_VALID_ITEMS', 'document produced no valid offers');
      const status = counters.itemsRejected > 0 ? 'PARTIAL' : 'SUCCESS';

      const finalized = await withTenantTransaction(db, tenantId, async (tx) => {
        // Deactivation is reserved for a fully clean document (ADR-0018
        // §Deactivation): PARTIAL and FAILED imports never deactivate.
        const deactivated =
          status === 'SUCCESS'
            ? await offersRepository.deactivateUnseenOffers(tx, tenantId, feed.id, importId)
            : 0;
        const row = await importRepo.finalizeImport(tx, tenantId, importId, token, {
          status,
          finishedAt: new Date(),
          counters,
          itemsDeactivated: deactivated,
          errorCode: null,
          errorMessage: null,
          errorSamples: samples,
        });
        // Lease lost → roll back the deactivation together with the finalize.
        if (!row) throw new ImportLeaseLostError(importId);
        return row;
      });
      logger?.info(
        { importId, feedId: feed.id, status, ...counters, itemsDeactivated: finalized.itemsDeactivated },
        'feed import finished',
      );
      return finalized;
    } catch (err) {
      if (err instanceof ImportLeaseLostError) {
        logger?.warn({ importId }, 'feed import lease lost; another worker owns it');
        return readImport(tenantId, importId);
      }
      const { code } = classify(err);
      if (code === 'IMPORT_FAILED') logger?.error({ err, importId }, 'feed import failed unexpectedly');
      else logger?.warn({ importId, code }, 'feed import failed');
      return finalizeFailed(tenantId, importId, token, counters, samples, err);
    }
  }

  return {
    async performImport(tenantId, importId) {
      let outcome = await tryClaim(tenantId, importId);

      if (outcome.kind === 'feed-busy') {
        // Another import of the same feed is running: wait for it, retry once.
        await pollFeedIdle(tenantId, importId);
        outcome = await tryClaim(tenantId, importId);
        if (outcome.kind === 'feed-busy') return readImport(tenantId, importId);
      }
      if (outcome.kind === 'terminal') return outcome.row;
      if (outcome.kind === 'owned-elsewhere') {
        // Same import claimed by a live worker — observe, never duplicate.
        return pollImport(tenantId, importId, (r) => r.status !== 'QUEUED' && r.status !== 'PROCESSING');
      }
      return run(tenantId, outcome);
    },
  };

  async function pollFeedIdle(tenantId: string, importId: string): Promise<void> {
    const deadline = Date.now() + env.FEED_IMPORT_LEASE_MS;
    while (Date.now() < deadline) {
      const busy = await withTenantTransaction(db, tenantId, async (tx) => {
        const row = await importRepo.findImportById(tx, tenantId, importId);
        if (!row) throw new FeedImportNotFoundError(importId);
        const recent = await importRepo.listImportsForFeed(tx, tenantId, row.feedId, 200);
        // An expired lease is not "busy": the next claim attempt recovers it.
        const now = Date.now();
        return recent.some(
          (r) =>
            r.id !== importId &&
            r.status === 'PROCESSING' &&
            r.leaseExpiresAt !== null &&
            r.leaseExpiresAt.getTime() >= now,
        );
      });
      if (!busy) return;
      await new Promise((resolve) => setTimeout(resolve, FEED_IDLE_POLL_MS));
    }
  }
}

function toInsertRow(
  offer: NormalizedOffer,
  ctx: { tenantId: string; feed: feedsRepo.FeedRow; importId: string; token: string; now: Date },
): MerchantOfferInsert {
  return {
    id: newId(),
    tenantId: ctx.tenantId,
    merchantSiteId: ctx.feed.merchantSiteId,
    feedId: ctx.feed.id,
    externalId: offer.externalId,
    sku: offer.sku,
    gtin: offer.gtin,
    title: offer.title,
    description: offer.description,
    brand: offer.brand,
    merchantCategory: offer.merchantCategory,
    productUrl: offer.productUrl,
    imageUrl: offer.imageUrl,
    currency: offer.price.currency,
    priceMinor: offer.price.amount,
    listPriceMinor: offer.listPrice?.amount ?? null,
    vatRateBp: offer.vatRateBp,
    vatIncluded: offer.vatIncluded,
    availability: offer.availability,
    stockQuantity: offer.stockQuantity,
    status: 'ACTIVE',
    contentHash: offer.contentHash,
    contentChangedAt: ctx.now,
    lastSeenImportId: ctx.importId,
    lastSeenClaimToken: ctx.token,
    firstSeenAt: ctx.now,
    lastSeenAt: ctx.now,
  };
}
