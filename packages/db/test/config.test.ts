import { describe, expect, it } from 'vitest';

import { loadDbEnv } from '../src/index.js';

describe('loadDbEnv (unit — no database required)', () => {
  it('parses a valid DATABASE_URL and applies pgBouncer-safe defaults', () => {
    const env = loadDbEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    });

    expect(env.DATABASE_URL).toBe('postgres://u:p@localhost:5432/db');
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.DATABASE_CONNECT_TIMEOUT_SECONDS).toBe(10);
    expect(env.DATABASE_IDLE_TIMEOUT_SECONDS).toBe(30);
    expect(env.DATABASE_MAX_LIFETIME_SECONDS).toBe(1800);
    // pgBouncer transaction pooling requires prepared statements OFF.
    expect(env.DATABASE_PREPARED_STATEMENTS).toBe(false);
    expect(env.DATABASE_SSL).toBe(false);
  });

  it('coerces numeric strings for pool tuning', () => {
    const env = loadDbEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      DATABASE_POOL_MAX: '25',
      DATABASE_CONNECT_TIMEOUT_SECONDS: '7',
      DATABASE_IDLE_TIMEOUT_SECONDS: '15',
      DATABASE_MAX_LIFETIME_SECONDS: '600',
    });

    expect(env.DATABASE_POOL_MAX).toBe(25);
    expect(env.DATABASE_CONNECT_TIMEOUT_SECONDS).toBe(7);
    expect(env.DATABASE_IDLE_TIMEOUT_SECONDS).toBe(15);
    expect(env.DATABASE_MAX_LIFETIME_SECONDS).toBe(600);
  });

  it('accepts SSL as boolean-ish or the postgres.js mode strings', () => {
    const requireEnv = loadDbEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      DATABASE_SSL: 'require',
    });
    expect(requireEnv.DATABASE_SSL).toBe('require');

    const trueEnv = loadDbEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      DATABASE_SSL: 'true',
    });
    expect(trueEnv.DATABASE_SSL).toBe('require');

    const offEnv = loadDbEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      DATABASE_SSL: 'false',
    });
    expect(offEnv.DATABASE_SSL).toBe(false);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => loadDbEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-URL DATABASE_URL', () => {
    expect(() => loadDbEnv({ DATABASE_URL: 'not-a-url' })).toThrow(/DATABASE_URL/);
  });
});

describe('drizzle.config (unit — no database required)', () => {
  it('loads with expected shape', async () => {
    // Ensure dbCredentials block is exercised too.
    process.env.DATABASE_URL ??= 'postgres://u:p@localhost:5432/db';

    const mod = (await import('../drizzle.config.ts')) as {
      default: {
        schema: string;
        out: string;
        dialect: string;
        strict?: boolean;
        casing?: string;
        dbCredentials?: { url: string };
      };
    };
    const cfg = mod.default;

    expect(cfg.dialect).toBe('postgresql');
    expect(cfg.schema).toMatch(/schema\/index\.ts$/);
    expect(cfg.out).toMatch(/drizzle$/);
    expect(cfg.strict).toBe(true);
    expect(cfg.casing).toBe('snake_case');
    expect(cfg.dbCredentials?.url).toBeTypeOf('string');
  });
});
