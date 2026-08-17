import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { readSessionCookie } from './cookies.js';
import type { AuthenticatedUser, AuthService } from './service.js';

export const TENANT_HEADER = 'x-tenant-id';

/**
 * Fastify plugin that populates `request.user` (if the session cookie is
 * valid) and `request.tenantId` (if the X-Tenant-Id header is present AND
 * the authenticated user has a membership in that tenant).
 *
 * This is deliberately a POPULATE-ONLY middleware:
 *   - It never rejects a request. A missing/invalid session leaves
 *     request.user undefined; individual routes decide whether they need
 *     auth and 401 themselves.
 *   - A missing/mismatched X-Tenant-Id header leaves request.tenantId
 *     undefined; tenant-scoped routes decide whether they need it and 400
 *     themselves.
 *
 * The tenant-membership check routes through
 * `listMembershipsForAuthenticatedUser`, which is the ADIM-9.5 SECURITY
 * DEFINER helper. `fiyatucuz_app` does NOT bypass RLS on `tenant_users`
 * anywhere in this codepath.
 */
export interface AuthMiddlewareOptions {
  readonly authService: AuthService;
}

const authMiddleware: FastifyPluginAsync<AuthMiddlewareOptions> = async (server, opts) => {
  server.decorateRequest('user', null);
  server.decorateRequest('tenantId', null);

  server.addHook('preHandler', async (request) => {
    const rawSession = readSessionCookie(request);
    const user = await opts.authService.authenticateBySessionToken(rawSession);
    if (!user) {
      // Leave user/tenantId as their decorated null defaults; routes handle 401.
      return;
    }
    // Fastify's decorated field is mutable at runtime; setting via a typed
    // assignment relies on the module augmentation below.
    (request as { user: AuthenticatedUser | null }).user = user;

    const requestedTenantHeader = request.headers[TENANT_HEADER];
    if (typeof requestedTenantHeader !== 'string' || requestedTenantHeader.length === 0) {
      return;
    }
    // Basic sanity gate: reject values that couldn't possibly be uuids to
    // avoid a database round-trip on garbage input. Full uuid parsing lives
    // in the SECURITY DEFINER function.
    if (!/^[0-9a-fA-F-]{20,64}$/.test(requestedTenantHeader)) return;

    const memberships =
      await opts.authService.listMembershipsForAuthenticatedUser(user.id);
    const match = memberships.find(
      (m) => m.tenantId === requestedTenantHeader && m.status === 'ACTIVE',
    );
    if (!match) return;
    (request as { tenantId: string | null }).tenantId = requestedTenantHeader;
  });
};

// fastify-plugin exposes the decorators/hooks to the parent scope. Without
// this wrapping the decorateRequest calls are encapsulated to the plugin
// scope and route handlers cannot see `request.user`.
export const registerAuthMiddleware = fp(authMiddleware, {
  name: '@fiyatucuz/auth-middleware',
  fastify: '5.x',
});

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by the auth middleware when a valid session cookie is presented. */
    user: AuthenticatedUser | null;
    /**
     * Populated when a valid X-Tenant-Id header is presented AND the
     * authenticated user has an ACTIVE membership in that tenant.
     * Consumers should open queries via withTenantTransaction(db, tenantId).
     */
    tenantId: string | null;
  }
}
