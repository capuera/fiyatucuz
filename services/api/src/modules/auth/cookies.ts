import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AuthEnv } from './env.js';
import type { AuthTokens } from './service.js';

/**
 * Cookie strategy (see ADR-0014):
 *
 * - fu_session: HttpOnly + SameSite=Lax + Secure(env) + Path=/
 *     Carries the raw session token. Sent on every request; consumed by the
 *     auth middleware.
 *
 * - fu_refresh: HttpOnly + SameSite=Lax + Secure(env) + Path=/v1/auth
 *     Carries the raw refresh token. Restricted to auth endpoints so it is
 *     never sent with normal API requests — smaller blast radius if any
 *     XSS-adjacent bug ever leaks the header to script (which HttpOnly
 *     already prevents, but defense-in-depth).
 *
 * Raw values are NEVER logged; the caller wrapping these helpers must not log
 * request bodies or Set-Cookie headers.
 */

export const SESSION_COOKIE = 'fu_session';
export const REFRESH_COOKIE = 'fu_refresh';
export const REFRESH_COOKIE_PATH = '/v1/auth';

interface CookieBaseOpts {
  readonly httpOnly: true;
  readonly sameSite: 'lax';
  readonly secure: boolean;
  readonly path: string;
  readonly domain?: string;
}

function baseOpts(env: AuthEnv, path: string): CookieBaseOpts {
  const opts: CookieBaseOpts = {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.AUTH_COOKIE_SECURE,
    path,
    ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
  };
  return opts;
}

function ttlSeconds(expiresAt: Date): number {
  return Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
}

/**
 * Set both auth cookies. Called by /register, /login, /refresh handlers with
 * freshly issued tokens. Uses @fastify/cookie's setCookie (attached to the
 * reply by the plugin).
 */
export function setAuthCookies(reply: FastifyReply, env: AuthEnv, tokens: AuthTokens): void {
  reply.setCookie(SESSION_COOKIE, tokens.sessionToken, {
    ...baseOpts(env, '/'),
    maxAge: ttlSeconds(tokens.sessionExpiresAt),
    expires: tokens.sessionExpiresAt,
  });
  reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...baseOpts(env, REFRESH_COOKIE_PATH),
    maxAge: ttlSeconds(tokens.refreshExpiresAt),
    expires: tokens.refreshExpiresAt,
  });
}

/**
 * Clear both auth cookies. Called by /logout regardless of whether the
 * server-side revocation found a live session.
 */
export function clearAuthCookies(reply: FastifyReply, env: AuthEnv): void {
  reply.clearCookie(SESSION_COOKIE, baseOpts(env, '/'));
  reply.clearCookie(REFRESH_COOKIE, baseOpts(env, REFRESH_COOKIE_PATH));
}

export function readSessionCookie(request: FastifyRequest): string | undefined {
  return request.cookies?.[SESSION_COOKIE];
}

export function readRefreshCookie(request: FastifyRequest): string | undefined {
  return request.cookies?.[REFRESH_COOKIE];
}
