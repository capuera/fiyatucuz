import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import type { MerchantSiteRow } from './repository.js';
import {
  InvalidDomainError,
  MerchantNotFoundError,
  MerchantSlugAlreadyExistsError,
  MerchantSiteDomainAlreadyExistsError,
  MerchantSiteDomainAlreadyVerifiedElsewhereError,
  MerchantSiteNotFoundError,
  type MerchantService,
  VerificationChallengeMissingError,
  VerificationTokenMismatchError,
} from './service.js';
import {
  CreateMerchantBodySchema,
  CreateMerchantSiteBodySchema,
  CreateVerificationChallengeBodySchema,
  UpdateMerchantBodySchema,
  UpdateMerchantSiteBodySchema,
  UuidParamSchema,
} from './validation.js';

// ---------------------------------------------------------------------------
// Auth gate — every route requires a session AND a bound tenantId. The
// middleware populates these; routes decide whether to insist on them (they
// all do, here).
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

// Small helper: assert a route parameter is a UUID at the boundary so a
// malformed :merchantId doesn't reach the query layer.
function requireUuidParam(reply: FastifyReply, name: string, value: unknown): string | null {
  const parsed = UuidParamSchema.safeParse(value);
  if (!parsed.success) {
    replyError(reply, 400, 'INVALID_INPUT', `${name} must be a UUID`);
    return null;
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Response mappers — the DB row shape is fine to expose EXCEPT for the
// verification_token_hash column. Never leak it over the wire.
// ---------------------------------------------------------------------------

function siteToEnvelope(row: MerchantSiteRow) {
  const { verificationTokenHash: _hash, ...rest } = row;
  return rest;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface MerchantRoutesOptions {
  readonly merchantService: MerchantService;
  readonly rateLimit?: { readonly enabled: boolean; readonly max: number; readonly timeWindow: number | string };
}

export const registerMerchantRoutes: FastifyPluginAsync<MerchantRoutesOptions> = async (
  server,
  opts,
) => {
  const { merchantService } = opts;
  const rlOpts = opts.rateLimit;
  const _rateCfg =
    rlOpts && rlOpts.enabled
      ? { config: { rateLimit: { max: rlOpts.max, timeWindow: rlOpts.timeWindow } } }
      : {};
  void _rateCfg; // reserved for a future write-endpoint rate limit sweep

  // Unified error handler for merchants routes only. Falls through to
  // Fastify's default handler if the error isn't a domain error we recognise.
  function mapError(err: unknown, reply: FastifyReply): boolean {
    if (err instanceof ZodError) {
      replyInvalidInput(reply, err);
      return true;
    }
    if (err instanceof InvalidDomainError) {
      replyError(reply, 400, err.code, err.message);
      return true;
    }
    if (err instanceof MerchantSlugAlreadyExistsError) {
      replyError(reply, err.httpStatus, err.code, err.message);
      return true;
    }
    if (err instanceof MerchantNotFoundError || err instanceof MerchantSiteNotFoundError) {
      replyError(reply, err.httpStatus, err.code, err.message);
      return true;
    }
    if (
      err instanceof MerchantSiteDomainAlreadyExistsError ||
      err instanceof MerchantSiteDomainAlreadyVerifiedElsewhereError
    ) {
      replyError(reply, err.httpStatus, err.code, err.message);
      return true;
    }
    if (err instanceof VerificationTokenMismatchError || err instanceof VerificationChallengeMissingError) {
      replyError(reply, err.httpStatus, err.code, err.message);
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // /v1/merchants
  // -------------------------------------------------------------------------

  server.get('/', async (request, reply) => {
    const gate = requireAuthAndTenant(request, reply);
    if (!gate) return reply;
    const rows = await merchantService.listMerchants(gate.tenantId);
    return reply.code(200).send({ items: rows });
  });

  server.post('/', async (request, reply) => {
    const gate = requireAuthAndTenant(request, reply);
    if (!gate) return reply;
    const parsed = CreateMerchantBodySchema.safeParse(request.body);
    if (!parsed.success) return replyInvalidInput(reply, parsed.error);
    try {
      const row = await merchantService.createMerchant(gate.tenantId, parsed.data);
      return reply.code(201).send(row);
    } catch (err) {
      if (mapError(err, reply)) return reply;
      throw err;
    }
  });

  server.get<{ Params: { merchantId: string } }>('/:merchantId', async (request, reply) => {
    const gate = requireAuthAndTenant(request, reply);
    if (!gate) return reply;
    const merchantId = requireUuidParam(reply, 'merchantId', request.params.merchantId);
    if (!merchantId) return reply;
    try {
      const row = await merchantService.getMerchant(gate.tenantId, merchantId);
      return reply.code(200).send(row);
    } catch (err) {
      if (mapError(err, reply)) return reply;
      throw err;
    }
  });

  server.patch<{ Params: { merchantId: string } }>('/:merchantId', async (request, reply) => {
    const gate = requireAuthAndTenant(request, reply);
    if (!gate) return reply;
    const merchantId = requireUuidParam(reply, 'merchantId', request.params.merchantId);
    if (!merchantId) return reply;
    const parsed = UpdateMerchantBodySchema.safeParse(request.body);
    if (!parsed.success) return replyInvalidInput(reply, parsed.error);
    try {
      const row = await merchantService.updateMerchant(gate.tenantId, merchantId, parsed.data);
      return reply.code(200).send(row);
    } catch (err) {
      if (mapError(err, reply)) return reply;
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // /v1/merchants/:merchantId/sites
  // -------------------------------------------------------------------------

  server.get<{ Params: { merchantId: string } }>(
    '/:merchantId/sites',
    async (request, reply) => {
      const gate = requireAuthAndTenant(request, reply);
      if (!gate) return reply;
      const merchantId = requireUuidParam(reply, 'merchantId', request.params.merchantId);
      if (!merchantId) return reply;
      try {
        const rows = await merchantService.listMerchantSites(gate.tenantId, merchantId);
        return reply.code(200).send({ items: rows.map(siteToEnvelope) });
      } catch (err) {
        if (mapError(err, reply)) return reply;
        throw err;
      }
    },
  );

  server.post<{ Params: { merchantId: string } }>(
    '/:merchantId/sites',
    async (request, reply) => {
      const gate = requireAuthAndTenant(request, reply);
      if (!gate) return reply;
      const merchantId = requireUuidParam(reply, 'merchantId', request.params.merchantId);
      if (!merchantId) return reply;
      const parsed = CreateMerchantSiteBodySchema.safeParse(request.body);
      if (!parsed.success) return replyInvalidInput(reply, parsed.error);
      try {
        const row = await merchantService.createMerchantSite(gate.tenantId, merchantId, parsed.data);
        return reply.code(201).send(siteToEnvelope(row));
      } catch (err) {
        if (mapError(err, reply)) return reply;
        throw err;
      }
    },
  );

  server.get<{ Params: { merchantId: string; siteId: string } }>(
    '/:merchantId/sites/:siteId',
    async (request, reply) => {
      const gate = requireAuthAndTenant(request, reply);
      if (!gate) return reply;
      const merchantId = requireUuidParam(reply, 'merchantId', request.params.merchantId);
      if (!merchantId) return reply;
      const siteId = requireUuidParam(reply, 'siteId', request.params.siteId);
      if (!siteId) return reply;
      try {
        const row = await merchantService.getMerchantSite(gate.tenantId, merchantId, siteId);
        return reply.code(200).send(siteToEnvelope(row));
      } catch (err) {
        if (mapError(err, reply)) return reply;
        throw err;
      }
    },
  );

  server.patch<{ Params: { merchantId: string; siteId: string } }>(
    '/:merchantId/sites/:siteId',
    async (request, reply) => {
      const gate = requireAuthAndTenant(request, reply);
      if (!gate) return reply;
      const merchantId = requireUuidParam(reply, 'merchantId', request.params.merchantId);
      if (!merchantId) return reply;
      const siteId = requireUuidParam(reply, 'siteId', request.params.siteId);
      if (!siteId) return reply;
      const parsed = UpdateMerchantSiteBodySchema.safeParse(request.body);
      if (!parsed.success) return replyInvalidInput(reply, parsed.error);
      try {
        const row = await merchantService.updateMerchantSite(
          gate.tenantId,
          merchantId,
          siteId,
          parsed.data,
        );
        return reply.code(200).send(siteToEnvelope(row));
      } catch (err) {
        if (mapError(err, reply)) return reply;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /:merchantId/sites/:siteId/verification
  //
  // Returns the raw verification token ONCE — subsequent GETs on the site
  // will never re-expose it (site envelope drops verification_token_hash).
  // -------------------------------------------------------------------------

  server.post<{ Params: { merchantId: string; siteId: string } }>(
    '/:merchantId/sites/:siteId/verification',
    async (request, reply) => {
      const gate = requireAuthAndTenant(request, reply);
      if (!gate) return reply;
      const merchantId = requireUuidParam(reply, 'merchantId', request.params.merchantId);
      if (!merchantId) return reply;
      const siteId = requireUuidParam(reply, 'siteId', request.params.siteId);
      if (!siteId) return reply;
      const parsed = CreateVerificationChallengeBodySchema.safeParse(request.body);
      if (!parsed.success) return replyInvalidInput(reply, parsed.error);
      try {
        const { site, challenge } = await merchantService.createSiteVerificationChallenge(
          gate.tenantId,
          merchantId,
          siteId,
          parsed.data,
        );
        return reply.code(201).send({
          site: siteToEnvelope(site),
          challenge: {
            method: challenge.method,
            token: challenge.rawToken,
            instructions: challenge.instructions,
          },
        });
      } catch (err) {
        if (mapError(err, reply)) return reply;
        throw err;
      }
    },
  );
};

