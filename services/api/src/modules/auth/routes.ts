import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { clearAuthCookies, readRefreshCookie, readSessionCookie, setAuthCookies } from './cookies.js';
import {
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  UserAlreadyExistsError,
  WeakPasswordError,
  type AuthService,
  type AuthSession,
} from './service.js';

// ---------------------------------------------------------------------------
// Request schemas — enforced with Zod at the boundary. Kept local to the
// routes module; contract stability (OpenAPI, generated clients) is a
// later-sprint concern per ADR-0006.
// ---------------------------------------------------------------------------

const RegisterBodySchema = z
  .object({
    email: z.string().email().max(320),
    password: z.string().min(8).max(128),
    displayName: z.string().min(1).max(128).optional(),
  })
  .strict();

const LoginBodySchema = z
  .object({
    email: z.string().email().max(320),
    password: z.string().min(1).max(128),
  })
  .strict();

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

interface AuthResponseEnvelope {
  user: {
    id: string;
    email: string;
    displayName: string | null;
    status: string;
  };
  memberships: Array<{
    tenantId: string;
    role: string;
    status: string;
  }>;
  session: {
    expiresAt: string;
  };
}

function toEnvelope(sess: AuthSession): AuthResponseEnvelope {
  // Do NOT include raw tokens in the JSON body — they live in Set-Cookie.
  return {
    user: {
      id: sess.user.id,
      email: sess.user.email,
      displayName: sess.user.displayName,
      status: sess.user.status,
    },
    memberships: sess.memberships.map((m) => ({
      tenantId: m.tenantId,
      role: m.role,
      status: m.status,
    })),
    session: {
      expiresAt: sess.tokens.sessionExpiresAt.toISOString(),
    },
  };
}

function requestMeta(request: FastifyRequest): { userAgent?: string; ipAddress?: string } {
  const ua = request.headers['user-agent'];
  return {
    ...(typeof ua === 'string' ? { userAgent: ua } : {}),
    ...(request.ip ? { ipAddress: request.ip } : {}),
  };
}

function replyError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ code, message });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface AuthRoutesOptions {
  readonly authService: AuthService;
}

export const registerAuthRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (server, opts) => {
  const { authService } = opts;

  // POST /register -----------------------------------------------------------
  server.post('/register', async (request, reply) => {
    const parsed = RegisterBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return replyError(reply, 400, 'INVALID_INPUT', parsed.error.issues[0]?.message ?? 'invalid input');
    }
    try {
      const session = await authService.register(
        {
          email: parsed.data.email,
          password: parsed.data.password,
          displayName: parsed.data.displayName ?? null,
        },
        requestMeta(request),
      );
      setAuthCookies(reply, authService.env, session.tokens);
      return reply.code(201).send(toEnvelope(session));
    } catch (err) {
      if (err instanceof UserAlreadyExistsError) {
        return replyError(reply, 409, err.code, 'user already exists');
      }
      if (err instanceof WeakPasswordError) {
        return replyError(reply, 400, err.code, 'password fails length policy');
      }
      throw err;
    }
  });

  // POST /login --------------------------------------------------------------
  server.post('/login', async (request, reply) => {
    const parsed = LoginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return replyError(reply, 400, 'INVALID_INPUT', parsed.error.issues[0]?.message ?? 'invalid input');
    }
    try {
      const session = await authService.login(parsed.data, requestMeta(request));
      setAuthCookies(reply, authService.env, session.tokens);
      return reply.code(200).send(toEnvelope(session));
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        // Unified error surface — do NOT distinguish no_user / bad_password /
        // blocked_user to the client. Reason is available for server logs.
        request.log?.debug({ reason: err.reason }, 'login rejected');
        return replyError(reply, 401, err.code, 'invalid credentials');
      }
      throw err;
    }
  });

  // POST /refresh ------------------------------------------------------------
  server.post('/refresh', async (request, reply) => {
    const rawRefresh = readRefreshCookie(request);
    try {
      const session = await authService.refresh(rawRefresh, requestMeta(request));
      setAuthCookies(reply, authService.env, session.tokens);
      return reply.code(200).send(toEnvelope(session));
    } catch (err) {
      if (err instanceof InvalidRefreshTokenError) {
        // On any refresh failure, clear both cookies so the client is forced
        // back through /login rather than looping.
        clearAuthCookies(reply, authService.env);
        return replyError(reply, 401, err.code, 'invalid refresh token');
      }
      throw err;
    }
  });

  // POST /logout -------------------------------------------------------------
  server.post('/logout', async (request, reply) => {
    const rawSession = readSessionCookie(request);
    await authService.logout(rawSession);
    clearAuthCookies(reply, authService.env);
    return reply.code(204).send();
  });
};
