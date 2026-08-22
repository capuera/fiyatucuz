import {
  eq,
  newId,
  transaction,
  type Db,
  type Tx,
} from '@fiyatucuz/db';
import { sessions, users } from '@fiyatucuz/db/schema';
import type { Logger } from 'pino';

import {
  listMembershipsForUser,
  type TenantMembershipRow,
} from '../tenants/index.js';

import type { AuthEnv } from './env.js';
import {
  getDummyPasswordHash,
  hashPassword,
  verifyPassword,
  WeakPasswordError,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
} from './password.js';
import * as repo from './repository.js';
import { assertSecretShape, generateRawToken, hashToken } from './token.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: repo.UserRow['status'];
}

export interface AuthTokens {
  readonly sessionToken: string;
  readonly sessionExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
}

export interface AuthSession {
  readonly user: AuthenticatedUser;
  readonly memberships: readonly TenantMembershipRow[];
  readonly tokens: AuthTokens;
}

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly displayName?: string | null;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
}

export interface RequestMeta {
  readonly userAgent?: string | undefined;
  readonly ipAddress?: string | undefined;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class UserAlreadyExistsError extends Error {
  readonly code = 'USER_ALREADY_EXISTS' as const;
  readonly httpStatus = 409;
  constructor(public readonly emailNormalized: string) {
    super('user already exists');
    this.name = 'UserAlreadyExistsError';
  }
}

/** Deliberately generic: covers user-not-found, wrong-password, non-ACTIVE user. */
export class InvalidCredentialsError extends Error {
  readonly code = 'INVALID_CREDENTIALS' as const;
  readonly httpStatus = 401;
  constructor(public readonly reason: 'no_user' | 'bad_password' | 'blocked_user') {
    super('invalid credentials');
    this.name = 'InvalidCredentialsError';
  }
}

export class InvalidRefreshTokenError extends Error {
  readonly code = 'INVALID_REFRESH' as const;
  readonly httpStatus = 401;
  constructor(
    public readonly reason: 'missing' | 'not_found' | 'expired' | 'revoked' | 'reuse',
  ) {
    super('invalid refresh token');
    this.name = 'InvalidRefreshTokenError';
  }
}

export { WeakPasswordError, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH };

// ---------------------------------------------------------------------------
// Interface + factory
// ---------------------------------------------------------------------------

export interface AuthService {
  readonly env: AuthEnv;
  register(input: RegisterInput, meta?: RequestMeta): Promise<AuthSession>;
  login(input: LoginInput, meta?: RequestMeta): Promise<AuthSession>;
  refresh(rawRefreshToken: string | undefined, meta?: RequestMeta): Promise<AuthSession>;
  logout(rawSessionToken: string | undefined): Promise<void>;
  /** Middleware entry point. Returns null when token is missing/invalid/expired/user-non-ACTIVE. */
  authenticateBySessionToken(
    rawSessionToken: string | undefined,
  ): Promise<AuthenticatedUser | null>;
  /** Auth-bootstrap: routes through the ADIM-9.5 SECURITY DEFINER function. */
  listMembershipsForAuthenticatedUser(userId: string): Promise<readonly TenantMembershipRow[]>;
}

export interface AuthServiceDeps {
  readonly db: Db;
  readonly env: AuthEnv;
  readonly logger?: Logger;
}

// Canonical lowercase — no provider-specific rewrites. Matches identity
// module's normalizeEmail; duplicated here to keep the auth module able to
// build its own transactions without a cross-module round-trip on hot paths.
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toAuthenticatedUser(u: repo.UserRow): AuthenticatedUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    status: u.status,
  };
}

/**
 * Recognize PostgreSQL unique-violation (SQLSTATE 23505). postgres.js surfaces
 * errors with `.code` set; drizzle-orm bubbles them unwrapped from execute().
 * Kept narrowly scoped — the auth service is the only place we currently
 * expect to translate the low-level code into a domain error.
 */
function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code === '23505';
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  assertSecretShape(deps.env.AUTH_TOKEN_HMAC_SECRET);
  const { db, env, logger } = deps;

  const hash = (rawToken: string): string => hashToken(rawToken, env.AUTH_TOKEN_HMAC_SECRET);
  const newSessionExpiry = (): Date => new Date(Date.now() + env.AUTH_SESSION_TTL_SECONDS * 1000);
  const newRefreshExpiry = (): Date => new Date(Date.now() + env.AUTH_REFRESH_TTL_SECONDS * 1000);

  async function issueSessionAndRefresh(
    tx: Tx,
    userId: string,
    meta: RequestMeta | undefined,
  ): Promise<AuthTokens & { readonly sessionId: string }> {
    const rawSession = generateRawToken();
    const rawRefresh = generateRawToken();
    const sessionExpiresAt = newSessionExpiry();
    const refreshExpiresAt = newRefreshExpiry();

    const session = await repo.insertSession(tx, {
      id: newId(),
      userId,
      sessionTokenHash: hash(rawSession),
      expiresAt: sessionExpiresAt,
      ...(meta?.userAgent !== undefined ? { userAgent: meta.userAgent } : {}),
      ...(meta?.ipAddress !== undefined ? { ipAddress: meta.ipAddress } : {}),
    });

    await repo.insertRefreshToken(tx, {
      id: newId(),
      sessionId: session.id,
      tokenHash: hash(rawRefresh),
      expiresAt: refreshExpiresAt,
    });

    return {
      sessionId: session.id,
      sessionToken: rawSession,
      sessionExpiresAt,
      refreshToken: rawRefresh,
      refreshExpiresAt,
    };
  }

  return {
    env,

    async register(input, meta) {
      const emailNormalized = normalizeEmail(input.email);
      // Length policy enforced inside hashPassword — throws WeakPasswordError.
      const passwordHash = await hashPassword(input.password);

      const outcome = await transaction(db, async (tx) => {
        // Fast-path duplicate check: cheap when the caller is honest, but
        // does NOT close the race between the SELECT and the INSERT. The
        // authoritative gate is the DB UNIQUE constraint on
        // users.email_normalized (see 0002_identity_tenants.sql). Two
        // concurrent registrations that both pass the SELECT will race on
        // INSERT; one gets 23505 and we translate it back into the same
        // UserAlreadyExistsError — no 500. See ADIM 10.1 §Register race.
        const existing = await repo.findUserByNormalizedEmail(tx, emailNormalized);
        if (existing) throw new UserAlreadyExistsError(emailNormalized);

        let user: repo.UserRow;
        try {
          const inserted = await tx
            .insert(users)
            .values({
              id: newId(),
              email: input.email.trim(),
              emailNormalized,
              displayName: input.displayName ?? null,
              status: 'ACTIVE',
            })
            .returning();
          const row = inserted[0];
          if (!row) throw new Error('register: user insert returned no row');
          user = row;
        } catch (err) {
          if (isUniqueViolation(err)) {
            // Another concurrent transaction inserted the same
            // email_normalized between our SELECT and this INSERT. Same
            // observable behavior as the fast-path check.
            throw new UserAlreadyExistsError(emailNormalized);
          }
          throw err;
        }

        await repo.insertCredential(tx, {
          id: newId(),
          userId: user.id,
          passwordHash,
        });

        const tokens = await issueSessionAndRefresh(tx, user.id, meta);
        return { user, tokens };
      });

      // Freshly registered users have no memberships yet — call for shape
      // consistency with login() so both responses have the same envelope.
      const memberships = await listMembershipsForUser(db, outcome.user.id);
      return {
        user: toAuthenticatedUser(outcome.user),
        memberships,
        tokens: {
          sessionToken: outcome.tokens.sessionToken,
          sessionExpiresAt: outcome.tokens.sessionExpiresAt,
          refreshToken: outcome.tokens.refreshToken,
          refreshExpiresAt: outcome.tokens.refreshExpiresAt,
        },
      };
    },

    async login(input, meta) {
      const emailNormalized = normalizeEmail(input.email);

      const outcome = await transaction(db, async (tx) => {
        const user = await repo.findUserByNormalizedEmail(tx, emailNormalized);

        // No user: still perform a dummy Argon2id verify so the response-
        // time signal cannot enumerate registered emails.
        if (!user) {
          await verifyPassword(await getDummyPasswordHash(), input.password);
          throw new InvalidCredentialsError('no_user');
        }

        const cred = await repo.findCredentialByUserId(tx, user.id);
        let passwordOk = false;
        if (cred) {
          passwordOk = await verifyPassword(cred.passwordHash, input.password);
        } else {
          // OAuth-only user (no local credentials yet) — still burn Argon2 cycles.
          await verifyPassword(await getDummyPasswordHash(), input.password);
        }

        if (!passwordOk) throw new InvalidCredentialsError('bad_password');
        if (user.status !== 'ACTIVE') throw new InvalidCredentialsError('blocked_user');

        const tokens = await issueSessionAndRefresh(tx, user.id, meta);
        return { user, tokens };
      });

      const memberships = await listMembershipsForUser(db, outcome.user.id);
      return {
        user: toAuthenticatedUser(outcome.user),
        memberships,
        tokens: {
          sessionToken: outcome.tokens.sessionToken,
          sessionExpiresAt: outcome.tokens.sessionExpiresAt,
          refreshToken: outcome.tokens.refreshToken,
          refreshExpiresAt: outcome.tokens.refreshExpiresAt,
        },
      };
    },

    async refresh(rawRefreshToken, meta) {
      // meta is reserved for future "record refresh location" side effect;
      // rotateSessionToken already bumps last_seen_at.
      void meta;
      if (!rawRefreshToken || typeof rawRefreshToken !== 'string') {
        throw new InvalidRefreshTokenError('missing');
      }
      const presentedHash = hash(rawRefreshToken);

      // Discriminated-union return so the transaction commits its writes
      // before we throw. Concurrency: `lockRefreshTokenByHash` uses SELECT
      // ... FOR UPDATE (ADIM 10.1 §Refresh token concurrency), so two
      // concurrent refreshes with the same raw token serialize — the second
      // wakes to see revoked_at set and lands in the reuse branch, which
      // performs the revocation in the SAME transaction (so it commits
      // even though we then throw outside the tx).
      type Outcome =
        | { readonly kind: 'not_found' }
        | { readonly kind: 'expired' }
        | { readonly kind: 'revoked' }
        | { readonly kind: 'reuse'; readonly sessionId: string; readonly refreshTokenId: string }
        | {
            readonly kind: 'ok';
            readonly user: repo.UserRow;
            readonly tokens: AuthTokens;
          };

      const outcome = await transaction<Outcome>(db, async (tx) => {
        const stored = await repo.lockRefreshTokenByHash(tx, presentedHash);
        if (!stored) return { kind: 'not_found' };

        // REUSE: revoked token replayed OR the concurrent-refresh loser.
        // Burn down the whole session in THIS transaction so the writes
        // commit together with the SELECT FOR UPDATE lock release; then
        // return a marker and let the outer scope throw.
        if (stored.revokedAt !== null) {
          await repo.revokeSession(tx, stored.sessionId);
          await repo.revokeAllRefreshTokensForSession(tx, stored.sessionId);
          return { kind: 'reuse', sessionId: stored.sessionId, refreshTokenId: stored.id };
        }

        if (stored.expiresAt.getTime() <= Date.now()) return { kind: 'expired' };

        // Session + user check.
        const rows = await tx
          .select({ session: sessions, user: users })
          .from(sessions)
          .innerJoin(users, eq(users.id, sessions.userId))
          .where(eq(sessions.id, stored.sessionId))
          .limit(1);
        const pair = rows[0];
        if (!pair) return { kind: 'not_found' };
        if (pair.session.revokedAt !== null) return { kind: 'revoked' };
        if (pair.session.expiresAt.getTime() <= Date.now()) return { kind: 'expired' };
        if (pair.user.status !== 'ACTIVE') return { kind: 'revoked' };

        // Rotate — new session hash in place + new refresh row + revoke old
        // refresh with replaced_by_token_id. Commits when the callback returns.
        const rawSession = generateRawToken();
        const rawRefresh = generateRawToken();
        const sessionExpiresAt = newSessionExpiry();
        const refreshExpiresAt = newRefreshExpiry();

        await repo.rotateSessionToken(tx, pair.session.id, hash(rawSession), sessionExpiresAt);

        const newRefreshId = newId();
        await repo.insertRefreshToken(tx, {
          id: newRefreshId,
          sessionId: pair.session.id,
          tokenHash: hash(rawRefresh),
          expiresAt: refreshExpiresAt,
        });
        await repo.revokeRefreshTokenAndLinkReplacement(tx, stored.id, newRefreshId);

        return {
          kind: 'ok',
          user: pair.user,
          tokens: {
            sessionToken: rawSession,
            sessionExpiresAt,
            refreshToken: rawRefresh,
            refreshExpiresAt,
          },
        };
      });

      if (outcome.kind === 'not_found') throw new InvalidRefreshTokenError('not_found');
      if (outcome.kind === 'expired') throw new InvalidRefreshTokenError('expired');
      if (outcome.kind === 'revoked') throw new InvalidRefreshTokenError('revoked');
      if (outcome.kind === 'reuse') {
        logger?.warn(
          { sessionId: outcome.sessionId, refreshTokenId: outcome.refreshTokenId },
          'refresh token reuse detected; session revoked',
        );
        throw new InvalidRefreshTokenError('reuse');
      }

      const memberships = await listMembershipsForUser(db, outcome.user.id);
      return {
        user: toAuthenticatedUser(outcome.user),
        memberships,
        tokens: outcome.tokens,
      };
    },

    async logout(rawSessionToken) {
      // Idempotent: logout without a cookie succeeds. Malformed tokens fail
      // silently — logout must never surface a "your token was bad" signal.
      if (!rawSessionToken || typeof rawSessionToken !== 'string') return;
      const h = hash(rawSessionToken);
      await transaction(db, async (tx) => {
        const pair = await repo.findLiveSessionByHash(tx, h);
        if (!pair) return;
        await repo.revokeSession(tx, pair.session.id);
        await repo.revokeAllRefreshTokensForSession(tx, pair.session.id);
      });
    },

    async authenticateBySessionToken(rawSessionToken) {
      if (!rawSessionToken || typeof rawSessionToken !== 'string') return null;
      const h = hash(rawSessionToken);
      return transaction(db, async (tx) => {
        const pair = await repo.findLiveSessionByHash(tx, h);
        if (!pair) return null;
        return toAuthenticatedUser(pair.user);
      });
    },

    async listMembershipsForAuthenticatedUser(userId) {
      return listMembershipsForUser(db, userId);
    },
  };
}
