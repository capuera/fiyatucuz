import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '../src/index.js';

import { isPostgresReachable, makeTestDbHandle } from './helpers.js';

const reachable = await isPostgresReachable();

const EXPECTED_TABLES = [
  'users',
  'credentials',
  'oauth_identities',
  'sessions',
  'refresh_tokens',
  'tenants',
  'tenant_users',
] as const;

async function tableExists(handle: DbHandle, name: string): Promise<boolean> {
  const rows = await handle.db.execute(
    sql`select 1 from pg_tables where schemaname = 'public' and tablename = ${name}`,
  );
  return (rows as Array<unknown>).length > 0;
}

async function fkExists(
  handle: DbHandle,
  table: string,
  column: string,
  refTable: string,
  refColumn: string,
): Promise<boolean> {
  const rows = await handle.db.execute(sql`
    select 1
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name
      join information_schema.referential_constraints rc
        on rc.constraint_name = tc.constraint_name
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = rc.unique_constraint_name
     where tc.constraint_type = 'FOREIGN KEY'
       and tc.table_name    = ${table}
       and kcu.column_name  = ${column}
       and ccu.table_name   = ${refTable}
       and ccu.column_name  = ${refColumn}
  `);
  return (rows as Array<unknown>).length > 0;
}

async function fkDeleteRule(
  handle: DbHandle,
  table: string,
  column: string,
): Promise<string | null> {
  const rows = await handle.db.execute(sql`
    select rc.delete_rule as rule
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name
      join information_schema.referential_constraints rc
        on rc.constraint_name = tc.constraint_name
     where tc.constraint_type = 'FOREIGN KEY'
       and tc.table_name = ${table}
       and kcu.column_name = ${column}
     limit 1
  `);
  const r = (rows as Array<{ rule: string }>)[0];
  return r?.rule ?? null;
}

async function uniqueExists(handle: DbHandle, name: string): Promise<boolean> {
  const rows = await handle.db.execute(
    sql`select 1 from pg_constraint where conname = ${name}`,
  );
  return (rows as Array<unknown>).length > 0;
}

async function indexExists(handle: DbHandle, name: string): Promise<boolean> {
  const rows = await handle.db.execute(
    sql`select 1 from pg_indexes where schemaname = 'public' and indexname = ${name}`,
  );
  return (rows as Array<unknown>).length > 0;
}

describe.skipIf(!reachable)('0002_identity_tenants — schema shape', () => {
  let handle: DbHandle;

  beforeAll(() => {
    handle = makeTestDbHandle();
  });

  afterAll(async () => {
    await handle.close();
  });

  it('creates all seven expected tables', async () => {
    for (const name of EXPECTED_TABLES) {
      expect(await tableExists(handle, name), `expected table "${name}" to exist`).toBe(true);
    }
  });

  it('users has case-insensitive uniqueness on email_normalized', async () => {
    expect(await uniqueExists(handle, 'users_email_normalized_unique')).toBe(true);
  });

  it('tenants slug is globally unique', async () => {
    expect(await uniqueExists(handle, 'tenants_slug_unique')).toBe(true);
  });

  it('tenant_users has (tenant_id, user_id) unique constraint', async () => {
    expect(await uniqueExists(handle, 'tenant_users_tenant_user_unique')).toBe(true);
  });

  it('oauth_identities has (provider, provider_account_id) unique constraint', async () => {
    expect(await uniqueExists(handle, 'oauth_identities_provider_account_unique')).toBe(true);
  });

  it('every expected foreign key exists', async () => {
    expect(await fkExists(handle, 'credentials', 'user_id', 'users', 'id')).toBe(true);
    expect(await fkExists(handle, 'oauth_identities', 'user_id', 'users', 'id')).toBe(true);
    expect(await fkExists(handle, 'sessions', 'user_id', 'users', 'id')).toBe(true);
    expect(await fkExists(handle, 'refresh_tokens', 'session_id', 'sessions', 'id')).toBe(true);
    expect(
      await fkExists(handle, 'refresh_tokens', 'replaced_by_token_id', 'refresh_tokens', 'id'),
    ).toBe(true);
    expect(await fkExists(handle, 'tenant_users', 'tenant_id', 'tenants', 'id')).toBe(true);
    expect(await fkExists(handle, 'tenant_users', 'user_id', 'users', 'id')).toBe(true);
  });

  it('user-facing foreign keys use ON DELETE RESTRICT (never CASCADE)', async () => {
    for (const [table, column] of [
      ['credentials', 'user_id'],
      ['oauth_identities', 'user_id'],
      ['sessions', 'user_id'],
      ['refresh_tokens', 'session_id'],
      ['tenant_users', 'tenant_id'],
      ['tenant_users', 'user_id'],
    ] as const) {
      const rule = await fkDeleteRule(handle, table, column);
      expect(rule, `${table}.${column} ON DELETE`).toBe('RESTRICT');
    }
  });

  it('refresh_tokens.replaced_by_token_id uses ON DELETE SET NULL', async () => {
    const rule = await fkDeleteRule(handle, 'refresh_tokens', 'replaced_by_token_id');
    expect(rule).toBe('SET NULL');
  });

  it('all documented indexes exist', async () => {
    for (const idx of [
      'oauth_identities_user_id_idx',
      'sessions_user_id_idx',
      'sessions_expires_at_idx',
      'refresh_tokens_session_id_idx',
      'refresh_tokens_expires_at_idx',
      'tenant_users_tenant_id_idx',
      'tenant_users_user_id_idx',
    ]) {
      expect(await indexExists(handle, idx), `expected index ${idx}`).toBe(true);
    }
  });

  it('all tables use TIMESTAMPTZ (never TIMESTAMP)', async () => {
    const rows = await handle.db.execute(sql`
      select table_name, column_name, data_type
        from information_schema.columns
       where table_schema = 'public'
         and column_name in ('created_at', 'updated_at', 'expires_at',
                             'revoked_at', 'last_seen_at',
                             'password_updated_at')
    `);
    for (const r of rows as Array<{ table_name: string; column_name: string; data_type: string }>) {
      expect(r.data_type, `${r.table_name}.${r.column_name}`).toBe(
        'timestamp with time zone',
      );
    }
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/db] schema.test.ts: skipping integration tests — PG unreachable.');
}
