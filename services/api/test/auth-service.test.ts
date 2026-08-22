import { sql } from '@fiyatucuz/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  UserAlreadyExistsError,
  WeakPasswordError,
} from '../src/modules/auth/index.js';

import { makeTestAuthService } from './auth-helpers.js';
import { isPostgresReachable, makeTestDbHandle, truncateIdentityAndTenants } from './helpers.js';

const reachable = await isPostgresReachable();

describe.skipIf(!reachable)('auth — service layer (integration)', () => {
  const dbHandle = makeTestDbHandle();
  const svc = makeTestAuthService();

  beforeAll(async () => {
    await truncateIdentityAndTenants(dbHandle.sql);
  });

  afterEach(async () => {
    await truncateIdentityAndTenants(dbHandle.sql);
  });

  afterAll(async () => {
    await svc.close();
    await dbHandle.close();
  });

  // 1
  it('register: success returns user + tokens; hashes stored, not raw', async () => {
    const s = await svc.authService.register({ email: 'a@example.com', password: 'ValidPass1!' });
    expect(s.user.email).toBe('a@example.com');
    expect(s.user.status).toBe('ACTIVE');
    expect(s.tokens.sessionToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(s.tokens.refreshToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(s.tokens.sessionToken).not.toBe(s.tokens.refreshToken);

    // DB stores only hashes; raw tokens must not appear anywhere.
    const raw = s.tokens.sessionToken;
    const stored = await dbHandle.sql`select session_token_hash from sessions`;
    expect((stored[0] as { session_token_hash: string }).session_token_hash).not.toBe(raw);

    const credRow = await dbHandle.sql`select password_hash from credentials`;
    const ph = (credRow[0] as { password_hash: string }).password_hash;
    expect(ph.startsWith('$argon2id$')).toBe(true);
    expect(ph).not.toContain('ValidPass1!');
  });

  // 2
  it('register: duplicate email is rejected', async () => {
    await svc.authService.register({ email: 'dup@example.com', password: 'ValidPass1!' });
    await expect(
      svc.authService.register({ email: 'dup@example.com', password: 'OtherPass2!' }),
    ).rejects.toBeInstanceOf(UserAlreadyExistsError);
  });

  // 3
  it('register: duplicate email is case-insensitive', async () => {
    await svc.authService.register({ email: 'MixedCase@Example.com', password: 'ValidPass1!' });
    await expect(
      svc.authService.register({ email: 'mixedcase@example.COM', password: 'Other2!Pass' }),
    ).rejects.toBeInstanceOf(UserAlreadyExistsError);
  });

  // 4
  it('register: invalid password length is rejected (WeakPasswordError)', async () => {
    await expect(
      svc.authService.register({ email: 'weak@example.com', password: 'short' }),
    ).rejects.toBeInstanceOf(WeakPasswordError);

    const tooLong = 'x'.repeat(129);
    await expect(
      svc.authService.register({ email: 'huge@example.com', password: tooLong }),
    ).rejects.toBeInstanceOf(WeakPasswordError);
  });

  // 5
  it('login: success returns user + tokens', async () => {
    await svc.authService.register({ email: 'l@example.com', password: 'ValidPass1!' });
    const s = await svc.authService.login({ email: 'l@example.com', password: 'ValidPass1!' });
    expect(s.user.email).toBe('l@example.com');
    expect(s.tokens.sessionToken.length).toBeGreaterThan(0);
  });

  // 6
  it('login: wrong password → INVALID_CREDENTIALS (bad_password)', async () => {
    await svc.authService.register({ email: 'wp@example.com', password: 'ValidPass1!' });
    await expect(
      svc.authService.login({ email: 'wp@example.com', password: 'WrongPass2!' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', reason: 'bad_password' });
  });

  // 6b — no user path also returns INVALID_CREDENTIALS (unified surface)
  it('login: unknown user → INVALID_CREDENTIALS (no_user) — same code, different internal reason', async () => {
    await expect(
      svc.authService.login({ email: 'nobody@example.com', password: 'AnyPass1!' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', reason: 'no_user' });
  });

  // 7
  it('login: SUSPENDED user is rejected as INVALID_CREDENTIALS', async () => {
    await svc.authService.register({ email: 'susp@example.com', password: 'ValidPass1!' });
    await dbHandle.sql`update users set status = 'SUSPENDED' where email_normalized = 'susp@example.com'`;
    await expect(
      svc.authService.login({ email: 'susp@example.com', password: 'ValidPass1!' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', reason: 'blocked_user' });
  });

  // 8
  it('login: DEACTIVATED user is rejected as INVALID_CREDENTIALS', async () => {
    await svc.authService.register({ email: 'deact@example.com', password: 'ValidPass1!' });
    await dbHandle.sql`update users set status = 'DEACTIVATED' where email_normalized = 'deact@example.com'`;
    await expect(
      svc.authService.login({ email: 'deact@example.com', password: 'ValidPass1!' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', reason: 'blocked_user' });
  });

  // 9
  it('session: creation records user_id + hashed token, is not revoked, expires in the future', async () => {
    await svc.authService.register({ email: 'sess@example.com', password: 'ValidPass1!' });
    const rows = await dbHandle.sql`
      select session_token_hash, revoked_at, expires_at from sessions
    `;
    const row = rows[0] as { session_token_hash: string; revoked_at: Date | null; expires_at: Date };
    expect(row.session_token_hash).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(row.revoked_at).toBeNull();
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  // 10 & 11
  it('refresh: success rotates BOTH session and refresh tokens; old refresh marked revoked + replaced_by_token_id', async () => {
    const s1 = await svc.authService.register({ email: 'rot@example.com', password: 'ValidPass1!' });

    const s2 = await svc.authService.refresh(s1.tokens.refreshToken);
    // Session and refresh both changed.
    expect(s2.tokens.sessionToken).not.toBe(s1.tokens.sessionToken);
    expect(s2.tokens.refreshToken).not.toBe(s1.tokens.refreshToken);

    // Exactly two refresh rows exist. The old one is revoked and its
    // replaced_by_token_id points to the new one.
    const rows = await dbHandle.sql`
      select id, revoked_at, replaced_by_token_id from refresh_tokens order by created_at asc
    `;
    expect(rows.length).toBe(2);
    const [oldRow, newRow] = rows as Array<{
      id: string;
      revoked_at: Date | null;
      replaced_by_token_id: string | null;
    }>;
    expect(oldRow?.revoked_at).not.toBeNull();
    expect(oldRow?.replaced_by_token_id).toBe(newRow?.id);
    expect(newRow?.revoked_at).toBeNull();

    // Session id is the SAME row (rotated in place) — same expiration extended.
    const sessions = await dbHandle.sql`select id from sessions`;
    expect(sessions.length).toBe(1);
  });

  // 12
  it('refresh: presenting the OLD refresh token after rotation fails and detects reuse', async () => {
    const s1 = await svc.authService.register({ email: 'reuse@example.com', password: 'ValidPass1!' });
    await svc.authService.refresh(s1.tokens.refreshToken); // rotation happens here

    // Presenting the old raw refresh token now — this is the "reuse" case.
    await expect(svc.authService.refresh(s1.tokens.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH',
      reason: 'reuse',
    });
  });

  // 13
  it('refresh reuse detection: revokes the entire session + all its refresh tokens', async () => {
    const s1 = await svc.authService.register({ email: 'burn@example.com', password: 'ValidPass1!' });
    const s2 = await svc.authService.refresh(s1.tokens.refreshToken);

    // Trigger reuse detection with the original refresh token.
    await expect(svc.authService.refresh(s1.tokens.refreshToken)).rejects.toBeInstanceOf(
      InvalidRefreshTokenError,
    );

    // Session is revoked.
    const sessRows = await dbHandle.sql`select revoked_at from sessions`;
    expect((sessRows[0] as { revoked_at: Date | null }).revoked_at).not.toBeNull();

    // Every refresh token belonging to the session is revoked (both the
    // original and the s2-issued one).
    const rtRows = await dbHandle.sql`select revoked_at from refresh_tokens`;
    for (const r of rtRows as Array<{ revoked_at: Date | null }>) {
      expect(r.revoked_at).not.toBeNull();
    }

    // The s2 refresh token (which was the live one) is now dead too.
    await expect(svc.authService.refresh(s2.tokens.refreshToken)).rejects.toBeInstanceOf(
      InvalidRefreshTokenError,
    );
  });

  // 14 & 15
  it('logout: revokes the session; subsequent authenticateBySessionToken returns null', async () => {
    const s = await svc.authService.register({ email: 'lo@example.com', password: 'ValidPass1!' });

    const before = await svc.authService.authenticateBySessionToken(s.tokens.sessionToken);
    expect(before?.id).toBe(s.user.id);

    await svc.authService.logout(s.tokens.sessionToken);

    const after = await svc.authService.authenticateBySessionToken(s.tokens.sessionToken);
    expect(after).toBeNull();

    // Revoked session cannot be refreshed either.
    await expect(svc.authService.refresh(s.tokens.refreshToken)).rejects.toBeInstanceOf(
      InvalidRefreshTokenError,
    );
  });

  // 16
  it('refresh: expired refresh token is rejected (expired)', async () => {
    const s = await svc.authService.register({ email: 'exp@example.com', password: 'ValidPass1!' });
    // Force expiry directly in the DB.
    await dbHandle.sql`update refresh_tokens set expires_at = now() - interval '1 hour'`;
    await expect(svc.authService.refresh(s.tokens.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH',
      reason: 'expired',
    });
  });

  // 17 & 18
  it('tenant membership bootstrap: user sees only their own memberships', async () => {
    const alice = await svc.authService.register({
      email: 'boot-a@example.com',
      password: 'ValidPass1!',
    });
    const bob = await svc.authService.register({
      email: 'boot-b@example.com',
      password: 'ValidPass1!',
    });

    // Seed tenants + memberships directly (as superuser).
    const { newId } = await import('@fiyatucuz/db');
    const tA = newId();
    const tB = newId();
    await dbHandle.sql`
      insert into tenants (id, name, slug) values
        (${tA}, 'A', 'auth-boot-a'),
        (${tB}, 'B', 'auth-boot-b')
    `;
    await dbHandle.sql`
      insert into tenant_users (id, tenant_id, user_id, role) values
        (${newId()}, ${tA}, ${alice.user.id}, 'OWNER'),
        (${newId()}, ${tB}, ${alice.user.id}, 'MEMBER'),
        (${newId()}, ${tA}, ${bob.user.id},   'MEMBER')
    `;

    const alicesMemberships = await svc.authService.listMembershipsForAuthenticatedUser(
      alice.user.id,
    );
    expect(alicesMemberships).toHaveLength(2);
    expect(alicesMemberships.every((m) => m.userId === alice.user.id)).toBe(true);
    expect(alicesMemberships.map((m) => m.tenantId).sort()).toEqual([tA, tB].sort());

    const bobsMemberships = await svc.authService.listMembershipsForAuthenticatedUser(bob.user.id);
    expect(bobsMemberships).toHaveLength(1);
    expect(bobsMemberships[0]?.userId).toBe(bob.user.id);
    // Bob does not see Alice's tenant B membership.
    expect(bobsMemberships.every((m) => m.userId !== alice.user.id)).toBe(true);
  });

  // Extra: authenticateBySessionToken rejects a revoked session.
  it('authenticateBySessionToken: revoked session → null', async () => {
    const s = await svc.authService.register({ email: 'rev@example.com', password: 'ValidPass1!' });
    await dbHandle.sql`update sessions set revoked_at = now()`;
    const after = await svc.authService.authenticateBySessionToken(s.tokens.sessionToken);
    expect(after).toBeNull();
  });

  // Extra: authenticateBySessionToken rejects a session whose user is not ACTIVE.
  it('authenticateBySessionToken: SUSPENDED user → null even with valid session cookie', async () => {
    const s = await svc.authService.register({
      email: 'act@example.com',
      password: 'ValidPass1!',
    });
    await dbHandle.sql`update users set status = 'SUSPENDED'`;
    const after = await svc.authService.authenticateBySessionToken(s.tokens.sessionToken);
    expect(after).toBeNull();
  });

  // Extra: refresh with missing/malformed token → 'missing' or 'not_found'.
  it('refresh: missing raw token → InvalidRefreshTokenError(missing)', async () => {
    await expect(svc.authService.refresh(undefined)).rejects.toMatchObject({ reason: 'missing' });
    await expect(svc.authService.refresh('')).rejects.toMatchObject({ reason: 'missing' });
  });

  it('refresh: unknown raw token → InvalidRefreshTokenError(not_found)', async () => {
    await expect(svc.authService.refresh('not-a-real-token-value')).rejects.toMatchObject({
      reason: 'not_found',
    });
  });

  // Not-really-needed but doubles as sanity check that InvalidCredentialsError is throwable.
  it('login: rejects garbage email format via WeakPasswordError-free path', async () => {
    // The service does not itself validate email format — that's a route-level
    // concern. If a caller passes a random string it will still normalize and
    // fail with no_user.
    await expect(
      svc.authService.login({ email: 'not-an-email', password: 'AnyPass2!' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  // Regression: token module MUST use HMAC (not raw sha) and the stored value MUST NOT equal the raw.
  it('tokens: raw tokens never equal stored hashes', async () => {
    const s = await svc.authService.register({ email: 'hm@example.com', password: 'ValidPass1!' });
    const rows = await dbHandle.sql`
      select session_token_hash from sessions
    `;
    const stored = (rows[0] as { session_token_hash: string }).session_token_hash;
    expect(stored).not.toBe(s.tokens.sessionToken);
    // Both are base64url-shaped but distinct.
    expect(stored).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  // Doesn't fit numbered plan directly but confirms search_path-safe SQL bubbles cleanly
  it('SECURITY DEFINER regression: fiyatucuz_app still cannot bypass RLS on tenant_users', async () => {
    // Even after a full auth session exists, a plain SELECT as fiyatucuz_app
    // must still fail closed without a bound tenant.
    await expect(
      dbHandle.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
        return tx.execute(sql`select * from tenant_users`);
      }),
    ).rejects.toThrow();
  });

  // -- Concurrency regressions (ADIM 10.1) ----------------------------------

  it('register race: two concurrent registrations with the same email → one 201, one clean 409', async () => {
    const email = 'race@example.com';
    const [a, b] = await Promise.allSettled([
      svc.authService.register({ email, password: 'ValidPass1!' }),
      svc.authService.register({ email: email.toUpperCase(), password: 'ValidPass1!' }),
    ]);
    const outcomes = [a, b].map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as Error).name));
    // Exactly one succeeded; the other is UserAlreadyExistsError (translated
    // from PG 23505 by the service). Never an untranslated pg error /
    // Error / TypeError.
    const succeeded = outcomes.filter((o) => o === 'ok').length;
    const rejected = outcomes.filter((o) => o === 'UserAlreadyExistsError').length;
    expect(succeeded).toBe(1);
    expect(rejected).toBe(1);

    // Exactly one users row was created.
    const rows = await dbHandle.sql`select id from users where email_normalized = ${email.toLowerCase()}`;
    expect(rows.length).toBe(1);
  });

  it('refresh race: two concurrent refreshes with the same raw token → one 200, one reuse', async () => {
    const s = await svc.authService.register({
      email: 'refrace@example.com',
      password: 'ValidPass1!',
    });

    const [a, b] = await Promise.allSettled([
      svc.authService.refresh(s.tokens.refreshToken),
      svc.authService.refresh(s.tokens.refreshToken),
    ]);
    const oks = [a, b].filter((r) => r.status === 'fulfilled').length;
    const errs = [a, b].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    // Exactly one succeeded — the SELECT FOR UPDATE serializes and the second
    // wakes to see revoked_at set. This is the deterministic outcome we want.
    expect(oks).toBe(1);
    expect(errs.length).toBe(1);
    const loser = errs[0]?.reason;
    expect(loser).toBeInstanceOf(InvalidRefreshTokenError);
    // The loser correctly identifies reuse — the same-tx revocation branch
    // fires because the row is already revoked when it acquires the lock.
    expect((loser as InvalidRefreshTokenError).reason).toBe('reuse');

    // Reuse detection burns the whole session: session revoked, every
    // refresh row in the family revoked.
    const sessRow = await dbHandle.sql`select revoked_at from sessions`;
    expect((sessRow[0] as { revoked_at: Date | null }).revoked_at).not.toBeNull();
    const rtRows = await dbHandle.sql`select revoked_at from refresh_tokens`;
    for (const r of rtRows as Array<{ revoked_at: Date | null }>) {
      expect(r.revoked_at).not.toBeNull();
    }

    // No two valid replacement chains from the same parent token.
    const rt = await dbHandle.sql`
      select count(*)::int as c from refresh_tokens
    `;
    // Original + at most one new row inserted by the winner.
    expect((rt[0] as { c: number }).c).toBeLessThanOrEqual(2);
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/api] auth-service.test.ts: skipping — PG unreachable.');
}
