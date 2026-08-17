import { and, eq, type Tx } from '@fiyatucuz/db';
import {
  credentials,
  oauthIdentities,
  refreshTokens,
  sessions,
  users,
} from '@fiyatucuz/db/schema';

// ---------------------------------------------------------------------------
// Repository types derived from the Drizzle schema. Domain code should
// program to these, not to any manually maintained interface.
// ---------------------------------------------------------------------------

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;

export type CredentialRow = typeof credentials.$inferSelect;
export type CredentialInsert = typeof credentials.$inferInsert;

export type OAuthIdentityRow = typeof oauthIdentities.$inferSelect;
export type OAuthIdentityInsert = typeof oauthIdentities.$inferInsert;

export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;

export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type RefreshTokenInsert = typeof refreshTokens.$inferInsert;

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export async function findUserById(tx: Tx, id: string): Promise<UserRow | null> {
  const rows = await tx.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Case-insensitive lookup — callers must pass the normalized (lower-cased) form. */
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

export async function insertUser(tx: Tx, input: UserInsert): Promise<UserRow> {
  const rows = await tx.insert(users).values(input).returning();
  const row = rows[0];
  if (!row) throw new Error('insertUser: RETURNING produced no row');
  return row;
}

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
// oauth_identities
// ---------------------------------------------------------------------------

export async function findOAuthIdentity(
  tx: Tx,
  provider: OAuthIdentityRow['provider'],
  providerAccountId: string,
): Promise<OAuthIdentityRow | null> {
  const rows = await tx
    .select()
    .from(oauthIdentities)
    .where(
      and(
        eq(oauthIdentities.provider, provider),
        eq(oauthIdentities.providerAccountId, providerAccountId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function insertOAuthIdentity(
  tx: Tx,
  input: OAuthIdentityInsert,
): Promise<OAuthIdentityRow> {
  const rows = await tx.insert(oauthIdentities).values(input).returning();
  const row = rows[0];
  if (!row) throw new Error('insertOAuthIdentity: RETURNING produced no row');
  return row;
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

export async function findSessionById(tx: Tx, id: string): Promise<SessionRow | null> {
  const rows = await tx.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findSessionByTokenHash(
  tx: Tx,
  sessionTokenHash: string,
): Promise<SessionRow | null> {
  const rows = await tx
    .select()
    .from(sessions)
    .where(eq(sessions.sessionTokenHash, sessionTokenHash))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertSession(tx: Tx, input: SessionInsert): Promise<SessionRow> {
  const rows = await tx.insert(sessions).values(input).returning();
  const row = rows[0];
  if (!row) throw new Error('insertSession: RETURNING produced no row');
  return row;
}

// ---------------------------------------------------------------------------
// refresh_tokens
// ---------------------------------------------------------------------------

export async function insertRefreshToken(
  tx: Tx,
  input: RefreshTokenInsert,
): Promise<RefreshTokenRow> {
  const rows = await tx.insert(refreshTokens).values(input).returning();
  const row = rows[0];
  if (!row) throw new Error('insertRefreshToken: RETURNING produced no row');
  return row;
}

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
