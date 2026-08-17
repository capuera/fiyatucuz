import { and, eq, isNull, sql, type Tx } from '@fiyatucuz/db';
import {
  credentials,
  refreshTokens,
  sessions,
  users,
} from '@fiyatucuz/db/schema';

// ---------------------------------------------------------------------------
// Row/insert type aliases derived from the Drizzle schema
// ---------------------------------------------------------------------------

export type UserRow = typeof users.$inferSelect;
export type CredentialRow = typeof credentials.$inferSelect;
export type CredentialInsert = typeof credentials.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type RefreshTokenInsert = typeof refreshTokens.$inferInsert;

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

export async function findCredentialByUserId(
  tx: Tx,
  userId: string,
): Promise<CredentialRow | null> {
  const rows = await tx
    .select()
    .from(credentials)
    .where(eq(credentials.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertCredential(
  tx: Tx,
  input: CredentialInsert,
): Promise<CredentialRow> {
  const rows = await tx.insert(credentials).values(input).returning();
  const row = rows[0];
  if (!row) throw new Error('insertCredential: RETURNING produced no row');
  return row;
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

export interface SessionWithUser {
  readonly session: SessionRow;
  readonly user: UserRow;
}

/**
 * Look up a live session + its user in one query. Returns null if the session
 * does not exist, is revoked, or is expired. Also filters out users whose
 * status is not ACTIVE — a suspended/deactivated user must not be treated as
 * authenticated even if they hold a valid session cookie.
 */
export async function findLiveSessionByHash(
  tx: Tx,
  sessionTokenHash: string,
): Promise<SessionWithUser | null> {
  const rows = await tx
    .select({
      session: sessions,
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.sessionTokenHash, sessionTokenHash),
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > now()`,
        eq(users.status, 'ACTIVE'),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function insertSession(tx: Tx, input: SessionInsert): Promise<SessionRow> {
  const rows = await tx.insert(sessions).values(input).returning();
  const row = rows[0];
  if (!row) throw new Error('insertSession: RETURNING produced no row');
  return row;
}

export async function rotateSessionToken(
  tx: Tx,
  sessionId: string,
  newHash: string,
  newExpiresAt: Date,
): Promise<SessionRow> {
  const rows = await tx
    .update(sessions)
    .set({
      sessionTokenHash: newHash,
      expiresAt: newExpiresAt,
      lastSeenAt: new Date(),
    })
    .where(eq(sessions.id, sessionId))
    .returning();
  const row = rows[0];
  if (!row) throw new Error('rotateSessionToken: session not found');
  return row;
}

export async function revokeSession(tx: Tx, sessionId: string): Promise<void> {
  await tx
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/**
 * Revoke every refresh_tokens row belonging to a session that is not already
 * revoked. Used by reuse-detection: on discovering a revoked refresh token
 * has been replayed, we burn down the entire family.
 */
export async function revokeAllRefreshTokensForSession(
  tx: Tx,
  sessionId: string,
): Promise<void> {
  await tx
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt)));
}

// ---------------------------------------------------------------------------
// refresh_tokens
// ---------------------------------------------------------------------------

export async function findRefreshTokenByHash(
  tx: Tx,
  tokenHash: string,
): Promise<RefreshTokenRow | null> {
  const rows = await tx
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertRefreshToken(
  tx: Tx,
  input: RefreshTokenInsert,
): Promise<RefreshTokenRow> {
  const rows = await tx.insert(refreshTokens).values(input).returning();
  const row = rows[0];
  if (!row) throw new Error('insertRefreshToken: RETURNING produced no row');
  return row;
}

export async function revokeRefreshTokenAndLinkReplacement(
  tx: Tx,
  oldId: string,
  newId: string,
): Promise<void> {
  await tx
    .update(refreshTokens)
    .set({ revokedAt: new Date(), replacedByTokenId: newId })
    .where(eq(refreshTokens.id, oldId));
}

// ---------------------------------------------------------------------------
// users — read-only helpers used by the auth service. Writes go through the
// identity module; we duplicate the read helpers here so the auth module can
// stay self-contained inside its own transactions.
// ---------------------------------------------------------------------------

export async function findUserById(tx: Tx, id: string): Promise<UserRow | null> {
  const rows = await tx.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findUserByNormalizedEmail(
  tx: Tx,
  emailNormalized: string,
): Promise<UserRow | null> {
  const rows = await tx
    .select()
    .from(users)
    .where(eq(users.emailNormalized, emailNormalized))
    .limit(1);
  return rows[0] ?? null;
}
