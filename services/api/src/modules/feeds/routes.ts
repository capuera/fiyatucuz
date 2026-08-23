import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import {
  MerchantNotFoundError,
  MerchantSiteNotFoundError,
} from '../merchants/index.js';

import type { FeedFetchRow, FeedRow } from './repository.js';
import {
  FeedFetchNotFoundError,
  FeedNotFoundError,
  InvalidFeedUrlError,
  type FeedService,
} from './service.js';
import {
  CreateFeedBodySchema,
  UpdateFeedBodySchema,
  UuidParamSchema,
} from './validation.js';

// ---------------------------------------------------------------------------
// Guards + helpers
// ---------------------------------------------------------------------------

function requireAuthAndTenant(
  request: FastifyRequest,
  reply: FastifyReply,
): { userId: string; tenantId: string } | null {
  if (!request.user) {
    reply.code(401).send({ code: 'UNAUTHENTICATED', message: 'authentication required' });
    return null;
  }
  if (!request.tenantId) {
    reply
      .code(403)
      .send({ code: 'TENANT_CONTEXT_REQUIRED', message: 'X-Tenant-Id header required' });
    return null;
  }
  return { userId: request.user.id, tenantId: request.tenantId };
}

function replyError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ code, message });
}

function replyInvalidInput(reply: FastifyReply, err: ZodError | string): FastifyReply {
  const message = typeof err === 'string' ? err : (err.issues[0]?.message ?? 'invalid input');
  return replyError(reply, 400, 'INVALID_INPUT', message);
}

function requireUuidParam(reply: FastifyReply, name: string, value: unknown): string | null {
  const parsed = UuidParamSchema.safeParse(value);
  if (!parsed.success) {
    replyError(reply, 400, 'INVALID_INPUT', `${name} must be a UUID`);
    return null;
  }
  return parsed.data;
}

// Response mapper — feed_fetches has no secret column at the moment; retained
// for symmetry with the merchants module so any future sensitive columns are
// stripped at a single choke point.
function fetchToEnvelope(row: FeedFetchRow): FeedFetchRow {
  return row;
}

function feedToEnvelope(row: FeedRow): FeedRow {
  return row;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface FeedRoutesOptions {
  readonly feedService: FeedService;
  /**
   * Rate limit for POST …/fetch only (ADIM 12.1 §Rate limit). Other feed
   * routes are unaffected. When `enabled` is false the per-route config is
   * omitted and the @fastify/rate-limit plugin does nothing for the route.
   */
  readonly fetchRateLimit?: {
    readonly enabled: boolean;
    readonly max: number;
    readonly timeWindow: number | string;
  };
}

export const registerFeedRoutes: FastifyPluginAsync<FeedRoutesOptions> = async (server, opts) => {
  const { feedService } = opts;
  const fetchRateLimitConfig =
    opts.fetchRateLimit && opts.fetchRateLimit.enabled
      ? {
          config: {
            rateLimit: {
              max: opts.fetchRateLimit.max,
              timeWindow: opts.fetchRateLimit.timeWindow,
            },
          },
        }
      : {};

  function mapError(err: unknown, reply: FastifyReply): boolean {
    if (err instanceof ZodError) {
      replyInvalidInput(reply, err);
      return true;
    }
    if (err instanceof InvalidFeedUrlError) {
      replyError(reply, err.httpStatus, err.code, err.message);
      return true;
    }
    if (
      err instanceof MerchantNotFoundError ||
      err instanceof MerchantSiteNotFoundError ||
      err instanceof FeedNotFoundError ||
      err instanceof FeedFetchNotFoundError
    ) {
      replyError(reply, err.httpStatus, err.code, err.message);
      return true;
    }
    return false;
  }

  // ---------- feeds -------------------------------------------------------

  server.get<{ Params: { merchantId: string; siteId: string } }>(
    '/:merchantId/sites/:siteId/feeds',
    async (request, reply) => {
      const gate = requireAuthAndTenant(request, reply);
      if (!gate) return reply;
      const merchantId = requireUuidParam(reply, 'merchantId', request.params.merchantId);
      if (!merchantId) return reply;
      const siteId = requireUuidParam(reply, 'siteId', request.params.siteId);
      if (!siteId) return reply;
      try {
        const rows = await feedService.listFeeds(gate.tenantId, merchantId, siteId);
        return reply.code(200).send({ items: rows.map(feedToEnvelope) });
      } catch (err) {
        if (mapError(err, reply)) return reply;
        throw err;
      }
    },
  );

  server.post<{ Params: { merchantId: string; siteId: string } }>(
    '/:merchantId/sites/:siteId/feeds',
    async (request, reply) => {
      const gate = requireAuthAndTenant(request, reply);
      if (!gate) return reply;
      const merchantId = requireUuidParam(reply, 'merchantId', request.params.merchantId);
      if (!merchantId) return reply;
      const siteId = requireUuidParam(reply, 'siteId', request.params.siteId);
      if (!siteId) return reply;
      const parsed = CreateFeedBodySchema.safeParse(request.body);
      if (!parsed.success) return replyInvalidInput(reply, parsed.error);
      try {
        const row = await feedService.createFeed(gate.tenantId, merchantId, siteId, parsed.data);
        return reply.code(201).send(feedToEnvelope(row));
      } catch (err) {
        if (mapError(err, reply)) return reply;
        throw err;
      }
    },
  );

  server.get<{ Params: { merchantId: string; siteId: string; feedId: string } }>(
    '/:merchantId/sites/:siteId/feeds/:feedId',
    async (request, reply) => {
      const gate = requireAuthAndTenant(request, reply);
      if (!gate) return reply;
      const merchantId = requireUuidParam(reply, 'merchantId', request.params.merchantId);
      if (!merchantId) return reply;
      const siteId = requireUuidParam(reply, 'siteId', request.params.siteId);
      if (!siteId) return reply;
      const feedId = requireUuidParam(reply, 'feedId', request.params.feedId);
      if (!feedId) return reply;
      try {
        const row = await feedService.getFeed(gate.tenantId, merchantId, siteId, feedId);
        return reply.code(200).send(feedToEnvelope(row));
      } catch (err) {
        if (mapError(err, reply)) return reply;
        throw err;
      }
    },
  );

  server.patch<{ Params: { merchantId: string; siteId: string; feedId: string } }>(
    '/:merchantId/sites/:siteId/feeds/:feedId',
    async (request, reply) => {
      const gate = requireAuthAndTenant(request, reply);
      if (!gate) return reply;
      const merchantId = requireUuidParam(reply, 'merchantId', request.params.merchantId);
      if (!merchantId) return reply;
      const siteId = requireUuidParam(reply, 'siteId', request.params.siteId);
      if (!siteId) return reply;
      const feedId = requireUuidParam(reply, 'feedId', request.params.feedId);
      if (!feedId) return reply;
      const parsed = UpdateFeedBodySchema.safeParse(request.body);
      if (!parsed.success) return replyInvalidInput(reply, parsed.error);
      try {
        const row = await feedService.updateFeed(
          gate.tenantId,
          merchantId,
          siteId,
          feedId,
          parsed.data,
        );
        return reply.code(200).send(feedToEnvelope(row));
      } catch (err) {
        if (mapError(err, reply)) return reply;
        throw err;
      }
    },
  );

  // ---------- fetches -----------------------------------------------------

  server.post<{ Params: { merchantId: string; siteId: string; feedId: string } }>(
    '/:merchantId/sites/:siteId/feeds/:feedId/fetch',
    fetchRateLimitConfig,
    async (request, reply) => {
      const gate = requireAuthAndTenant(request, reply);
      if (!gate) return reply;
      const merchantId = requireUuidParam(reply, 'merchantId', request.params.merchantId);
      if (!merchantId) return reply;
      const siteId = requireUuidParam(reply, 'siteId', request.params.siteId);
      if (!siteId) return reply;
      const feedId = requireUuidParam(reply, 'feedId', request.params.feedId);
      if (!feedId) return reply;
      try {
        const result = await feedService.enqueueFetch(
          gate.tenantId,
          merchantId,
          siteId,
          feedId,
        );
        // 202 Accepted — the fetch happens in a background job. Clients poll
        // GET /fetches/:fetchId to observe terminal state.
        return reply.code(202).send({
          fetchId: result.fetchId,
          status: result.status,
        });
      } catch (err) {
        if (mapError(err, reply)) return reply;
        throw err;
      }
    },
  );

  server.get<{ Params: { merchantId: string; siteId: string; feedId: string } }>(
    '/:merchantId/sites/:siteId/feeds/:feedId/fetches',
    async (request, reply) => {
      const gate = requireAuthAndTenant(request, reply);
      if (!gate) return reply;
      const merchantId = requireUuidParam(reply, 'merchantId', request.params.merchantId);
      if (!merchantId) return reply;
      const siteId = requireUuidParam(reply, 'siteId', request.params.siteId);
      if (!siteId) return reply;
      const feedId = requireUuidParam(reply, 'feedId', request.params.feedId);
      if (!feedId) return reply;
      try {
        const rows = await feedService.listFetches(gate.tenantId, merchantId, siteId, feedId);
        return reply.code(200).send({ items: rows.map(fetchToEnvelope) });
      } catch (err) {
        if (mapError(err, reply)) return reply;
        throw err;
      }
    },
  );

  server.get<{
    Params: { merchantId: string; siteId: string; feedId: string; fetchId: string };
  }>(
    '/:merchantId/sites/:siteId/feeds/:feedId/fetches/:fetchId',
    async (request, reply) => {
      const gate = requireAuthAndTenant(request, reply);
      if (!gate) return reply;
      const merchantId = requireUuidParam(reply, 'merchantId', request.params.merchantId);
      if (!merchantId) return reply;
      const siteId = requireUuidParam(reply, 'siteId', request.params.siteId);
      if (!siteId) return reply;
      const feedId = requireUuidParam(reply, 'feedId', request.params.feedId);
      if (!feedId) return reply;
      const fetchId = requireUuidParam(reply, 'fetchId', request.params.fetchId);
      if (!fetchId) return reply;
      try {
        const row = await feedService.getFetch(
          gate.tenantId,
          merchantId,
          siteId,
          feedId,
          fetchId,
        );
        return reply.code(200).send(fetchToEnvelope(row));
      } catch (err) {
        if (mapError(err, reply)) return reply;
        throw err;
      }
    },
  );
};
