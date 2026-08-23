import { newId, withTenantTransaction, type Db, type Tx } from '@fiyatucuz/db';
import type { Logger } from 'pino';

import type { Job, JobQueue } from '../../lib/jobs/JobQueue.js';
import {
  MerchantNotFoundError,
  MerchantSiteNotFoundError,
  type MerchantService,
} from '../merchants/index.js';

import type { FeedEnv } from './env.js';
import {
  createSafeFeedFetcher,
  FetchError,
  type FetchResult,
  type SafeFeedFetcher,
} from './fetcher.js';
import * as repo from './repository.js';
import { SafeUrlError, validateSafeUrl } from './ssrf.js';
import type { CreateFeedInput, UpdateFeedInput } from './validation.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FeedNotFoundError extends Error {
  readonly code = 'FEED_NOT_FOUND' as const;
  readonly httpStatus = 404;
  constructor(public readonly feedId: string) {
    super('feed not found');
    this.name = 'FeedNotFoundError';
  }
}

export class FeedFetchNotFoundError extends Error {
  readonly code = 'FEED_FETCH_NOT_FOUND' as const;
  readonly httpStatus = 404;
  constructor(public readonly fetchId: string) {
    super('feed fetch not found');
    this.name = 'FeedFetchNotFoundError';
  }
}

export class InvalidFeedUrlError extends Error {
  readonly code = 'INVALID_FEED_URL' as const;
  readonly httpStatus = 400;
  constructor(message: string, public readonly ssrfCode?: string) {
    super(message);
    this.name = 'InvalidFeedUrlError';
  }
}

// Re-export merchant + fetcher errors so callers can `instanceof`-narrow.
export { MerchantNotFoundError, MerchantSiteNotFoundError, FetchError, SafeUrlError };

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export const FEED_FETCH_JOB = 'feed.fetch' as const;

export interface FeedFetchJobPayload {
  readonly tenantId: string;
  readonly feedId: string;
  readonly fetchId: string;
}

export interface EnqueueFetchResult {
  readonly fetchId: string;
  readonly status: 'QUEUED';
}

export interface FeedService {
  createFeed(
    tenantId: string,
    merchantId: string,
    siteId: string,
    input: CreateFeedInput,
  ): Promise<repo.FeedRow>;
  listFeeds(
    tenantId: string,
    merchantId: string,
    siteId: string,
  ): Promise<readonly repo.FeedRow[]>;
  getFeed(
    tenantId: string,
    merchantId: string,
    siteId: string,
    feedId: string,
  ): Promise<repo.FeedRow>;
  updateFeed(
    tenantId: string,
    merchantId: string,
    siteId: string,
    feedId: string,
    patch: UpdateFeedInput,
  ): Promise<repo.FeedRow>;

  enqueueFetch(
    tenantId: string,
    merchantId: string,
    siteId: string,
    feedId: string,
  ): Promise<EnqueueFetchResult>;

  listFetches(
    tenantId: string,
    merchantId: string,
    siteId: string,
    feedId: string,
  ): Promise<readonly repo.FeedFetchRow[]>;

  getFetch(
    tenantId: string,
    merchantId: string,
    siteId: string,
    feedId: string,
    fetchId: string,
  ): Promise<repo.FeedFetchRow>;

  /**
   * Execute a QUEUED fetch synchronously. Called from the job handler in
   * production; called directly from tests to bypass the JobQueue's
   * fire-and-forget scheduling.
   */
  performFetch(tenantId: string, fetchId: string): Promise<repo.FeedFetchRow>;

  /** Register the feed.fetch handler on the provided JobQueue. */
  registerJobHandlers(jobs: JobQueue): void;
}

export interface FeedServiceDeps {
  readonly db: Db;
  readonly env: FeedEnv;
  readonly merchants: MerchantService;
  readonly jobs: JobQueue;
  readonly fetcher?: SafeFeedFetcher;
  readonly logger?: Logger;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function definedOnly<T extends Record<string, unknown>>(obj: T): {
  [K in keyof T]?: Exclude<T[K], undefined>;
} {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/**
 * Truncate a message that will be persisted to `feed_fetches.error_message`.
 * The DB column is text, but we cap length here so an unexpectedly verbose
 * upstream never fills the row. Also strips raw newlines to keep single-
 * line log/UI consumption predictable.
 */
function sanitizeErrorMessage(input: string, cap = 500): string {
  const oneLine = input.replace(/\s+/g, ' ').trim();
  return oneLine.length > cap ? oneLine.slice(0, cap) : oneLine;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFeedService(deps: FeedServiceDeps): FeedService {
  const { db, env, merchants, jobs, logger } = deps;
  const fetcher: SafeFeedFetcher = deps.fetcher ?? createSafeFeedFetcher({ env });

  async function requireFeed(
    tx: Tx,
    tenantId: string,
    merchantId: string,
    siteId: string,
    feedId: string,
  ): Promise<repo.FeedRow> {
    // The merchant + site containment check runs through merchantService so
    // a foreign merchant/site surfaces MerchantNotFoundError / MerchantSite
    // NotFoundError before we even look at the feed row.
    await merchants.getMerchantSite(tenantId, merchantId, siteId);
    const row = await repo.findFeedById(tx, tenantId, siteId, feedId);
    if (!row) throw new FeedNotFoundError(feedId);
    return row;
  }

  async function requireSite(
    tenantId: string,
    merchantId: string,
    siteId: string,
  ): Promise<void> {
    await merchants.getMerchantSite(tenantId, merchantId, siteId);
  }

  async function preValidateUrl(url: string): Promise<void> {
    // We do URL validation up-front so `POST /feeds` and `PATCH /feeds`
    // reject a bad URL with a clean 400 before it ever lands in the DB.
    // The fetcher does its own per-hop validation at fetch time (against
    // resolved IPs) — this is the syntactic + hostname check.
    try {
      await validateSafeUrl(url, {
        ...(env.FEED_FETCH_ALLOW_PRIVATE_ADDRESSES
          ? { allowPrivateAddresses: true as const }
          : {}),
      });
    } catch (err) {
      if (err instanceof SafeUrlError) {
        throw new InvalidFeedUrlError(err.message, err.code);
      }
      throw err;
    }
  }

  return {
    async createFeed(tenantId, merchantId, siteId, input) {
      await requireSite(tenantId, merchantId, siteId);
      await preValidateUrl(input.url);

      return withTenantTransaction(db, tenantId, async (tx) => {
        return repo.insertFeed(tx, {
          id: newId(),
          tenantId,
          merchantSiteId: siteId,
          name: input.name,
          url: input.url,
          format: input.format,
          status: 'ACTIVE',
          fetchSchedule: input.fetchSchedule ?? null,
        });
      });
    },

    async listFeeds(tenantId, merchantId, siteId) {
      await requireSite(tenantId, merchantId, siteId);
      return withTenantTransaction(db, tenantId, (tx) =>
        repo.listFeedsForSite(tx, tenantId, siteId),
      );
    },

    async getFeed(tenantId, merchantId, siteId, feedId) {
      return withTenantTransaction(db, tenantId, (tx) =>
        requireFeed(tx, tenantId, merchantId, siteId, feedId),
      );
    },

    async updateFeed(tenantId, merchantId, siteId, feedId, patch) {
      if (patch.url !== undefined) await preValidateUrl(patch.url);
      return withTenantTransaction(db, tenantId, async (tx) => {
        await requireFeed(tx, tenantId, merchantId, siteId, feedId);
        const updated = await repo.updateFeed(
          tx,
          tenantId,
          siteId,
          feedId,
          definedOnly(patch),
        );
        if (!updated) throw new FeedNotFoundError(feedId);
        return updated;
      });
    },

    async enqueueFetch(tenantId, merchantId, siteId, feedId) {
      // Confirm the feed belongs to this tenant/site before allocating a
      // fetch row. Also opens transaction so INSERT sees app.tenant_id.
      const { fetchId } = await withTenantTransaction(db, tenantId, async (tx) => {
        const feed = await requireFeed(tx, tenantId, merchantId, siteId, feedId);
        const row = await repo.insertFetch(tx, {
          id: newId(),
          tenantId,
          feedId: feed.id,
          status: 'QUEUED',
        });
        return { fetchId: row.id };
      });
      // Fire-and-forget enqueue. The in-process JobQueue schedules via
      // setImmediate so the HTTP handler can return 202 before performFetch
      // runs. A production BullMQ+Redis implementation would return after
      // persisting the job to Redis; same call site works for both.
      await jobs.enqueue<FeedFetchJobPayload>({
        name: FEED_FETCH_JOB,
        payload: { tenantId, feedId, fetchId },
      });
      return { fetchId, status: 'QUEUED' };
    },

    async listFetches(tenantId, merchantId, siteId, feedId) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        await requireFeed(tx, tenantId, merchantId, siteId, feedId);
        return repo.listFetchesForFeed(tx, tenantId, feedId);
      });
    },

    async getFetch(tenantId, merchantId, siteId, feedId, fetchId) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        await requireFeed(tx, tenantId, merchantId, siteId, feedId);
        const row = await repo.findFetchById(tx, tenantId, feedId, fetchId);
        if (!row) throw new FeedFetchNotFoundError(fetchId);
        return row;
      });
    },

    async performFetch(tenantId, fetchId) {
      // Step 1: load the feed + move fetch → FETCHING in one tx.
      const preflight = await withTenantTransaction(db, tenantId, async (tx) => {
        const fetchRow = await repo.findFetchByIdAcrossFeeds(tx, tenantId, fetchId);
        if (!fetchRow) throw new FeedFetchNotFoundError(fetchId);
        if (fetchRow.status !== 'QUEUED') {
          // Idempotency: another worker already picked this up. Return what
          // is there; the caller can decide whether to retry.
          return { alreadyStarted: true as const, row: fetchRow };
        }
        const feed = await repo.findFeedByIdForTenant(tx, tenantId, fetchRow.feedId);
        if (!feed) {
          // Should be impossible under the composite FK, but fail closed.
          await repo.markFetchState(tx, tenantId, fetchId, {
            status: 'FAILED',
            errorCode: 'FEED_NOT_FOUND',
            errorMessage: 'feed row missing',
            finishedAt: new Date(),
          });
          throw new FeedNotFoundError(fetchRow.feedId);
        }
        const marked = await repo.markFetchState(tx, tenantId, fetchId, {
          status: 'FETCHING',
          startedAt: new Date(),
        });
        return { alreadyStarted: false as const, feed, row: marked ?? fetchRow };
      });

      if (preflight.alreadyStarted) return preflight.row;

      const { feed } = preflight;

      // Step 2: perform the actual fetch (no DB tx open during network I/O).
      let result: FetchResult;
      try {
        result = await fetcher.fetch({
          url: feed.url,
          format: feed.format,
          etag: feed.etag,
          lastModified: feed.lastModified,
        });
      } catch (err) {
        const msg = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
        logger?.error({ err, feedId: feed.id, fetchId }, 'feed fetch threw unexpectedly');
        result = { kind: 'failure', code: 'FETCH_FAILED', errorMessage: msg };
      }

      // Step 3: apply the terminal state + feed cursor.
      return withTenantTransaction(db, tenantId, async (tx) => {
        const now = new Date();
        if (result.kind === 'success') {
          const updated = await repo.markFetchState(tx, tenantId, fetchId, {
            status: 'SUCCESS',
            httpStatus: result.httpStatus,
            byteCount: result.byteCount,
            contentType: result.contentType,
            contentHash: result.contentHash,
            etag: result.etag,
            lastModified: result.lastModified,
            finishedAt: now,
          });
          await repo.updateFeedFetchCursor(tx, tenantId, feed.id, {
            lastFetchAt: now,
            lastSuccessfulFetchAt: now,
            etag: result.etag,
            lastModified: result.lastModified,
            status: 'ACTIVE',
          });
          if (!updated) throw new FeedFetchNotFoundError(fetchId);
          return updated;
        }
        if (result.kind === 'not_modified') {
          const updated = await repo.markFetchState(tx, tenantId, fetchId, {
            status: 'NOT_MODIFIED',
            httpStatus: 304,
            etag: result.etag,
            lastModified: result.lastModified,
            finishedAt: now,
          });
          await repo.updateFeedFetchCursor(tx, tenantId, feed.id, {
            lastFetchAt: now,
            etag: result.etag,
            lastModified: result.lastModified,
            status: 'ACTIVE',
          });
          if (!updated) throw new FeedFetchNotFoundError(fetchId);
          return updated;
        }
        const terminal = result.kind === 'rejected' ? 'REJECTED' : 'FAILED';
        const errorMessage = sanitizeErrorMessage(result.errorMessage);
        const patch: Partial<repo.FeedFetchInsert> = {
          status: terminal,
          errorCode: result.code,
          errorMessage,
          finishedAt: now,
        };
        if (result.kind === 'failure' && result.httpStatus !== undefined) {
          patch.httpStatus = result.httpStatus;
        }
        const updated = await repo.markFetchState(tx, tenantId, fetchId, patch);
        await repo.updateFeedFetchCursor(tx, tenantId, feed.id, {
          lastFetchAt: now,
          // Do not clobber last_successful_fetch_at on failure.
        });
        if (!updated) throw new FeedFetchNotFoundError(fetchId);
        return updated;
      });
    },

    registerJobHandlers(jobs: JobQueue) {
      // Arrow-callback preserves the enclosing method's `this` binding, so
      // `service.performFetch` is invoked correctly no matter how the
      // JobQueue calls the handler. No local `this` alias needed.
      jobs.register<FeedFetchJobPayload>(FEED_FETCH_JOB, async (job: Job<FeedFetchJobPayload>) => {
        // The job carries tenant context explicitly (ADR-0016 §JobQueue).
        // The handler intentionally does not log the raw feed URL — the
        // service does that at INSERT/UPDATE time.
        await this.performFetch(job.payload.tenantId, job.payload.fetchId);
      });
    },
  };
}
