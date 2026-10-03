import { describe, expect, it } from 'vitest';

import { runMigrationCli, EXIT_FAILURE, EXIT_USAGE } from '../src/cli/run-migrations.js';
import {
  describeError,
  loadMigrationDbEnv,
  MIGRATION_POOL_MAX,
  MigrationEnvError,
  redactSecrets,
  secretsOfDatabaseUrl,
} from '../src/index.js';

// Unit tests — no database is contacted. The only network attempt below goes
// to 127.0.0.1:1, which refuses immediately (no PostgreSQL listens there).

const SECRET = 'SUPER_SECRET_PASSWORD';
const MIGRATION_URL = `postgres://migration_user:${SECRET}@localhost:5432/fiyatucuz`;
const RUNTIME_URL = 'postgres://fiyatucuz_app_login:RUNTIME_ONLY_PW@localhost:5432/fiyatucuz';

describe('loadMigrationDbEnv', () => {
  it('DATABASE_MIGRATION_URL missing + DATABASE_URL present → fails (no fallback)', () => {
    expect(() =>
      loadMigrationDbEnv({
        DATABASE_URL: RUNTIME_URL,
        DATABASE_MIGRATION_EXPECTED_DB: 'fiyatucuz',
      }),
    ).toThrow(MigrationEnvError);
    expect(() =>
      loadMigrationDbEnv({
        DATABASE_URL: RUNTIME_URL,
        DATABASE_MIGRATION_EXPECTED_DB: 'fiyatucuz',
      }),
    ).toThrow(/DATABASE_MIGRATION_URL is required/);
  });

  it.each(['development', 'test', 'production', undefined])(
    'no fallback regardless of NODE_ENV=%s',
    (nodeEnv) => {
      expect(() =>
        loadMigrationDbEnv({
          NODE_ENV: nodeEnv,
          DATABASE_URL: RUNTIME_URL,
          DATABASE_MIGRATION_EXPECTED_DB: 'fiyatucuz',
        }),
      ).toThrow(/DATABASE_MIGRATION_URL is required/);
    },
  );

  it('empty / whitespace DATABASE_MIGRATION_URL counts as missing', () => {
    expect(() =>
      loadMigrationDbEnv({
        DATABASE_MIGRATION_URL: '   ',
        DATABASE_MIGRATION_EXPECTED_DB: 'fiyatucuz',
      }),
    ).toThrow(/DATABASE_MIGRATION_URL is required/);
  });

  it('uses DATABASE_MIGRATION_URL, never DATABASE_URL', () => {
    const env = loadMigrationDbEnv({
      DATABASE_URL: RUNTIME_URL,
      DATABASE_MIGRATION_URL: MIGRATION_URL,
      DATABASE_MIGRATION_EXPECTED_DB: 'fiyatucuz',
    });
    expect(env.db.DATABASE_URL).toBe(MIGRATION_URL);
    expect(env.expectedDatabase).toBe('fiyatucuz');
  });

  it('DATABASE_MIGRATION_EXPECTED_DB missing → fails', () => {
    expect(() => loadMigrationDbEnv({ DATABASE_MIGRATION_URL: MIGRATION_URL })).toThrow(
      /DATABASE_MIGRATION_EXPECTED_DB is required/,
    );
    expect(() =>
      loadMigrationDbEnv({
        DATABASE_MIGRATION_URL: MIGRATION_URL,
        DATABASE_MIGRATION_EXPECTED_DB: ' ',
      }),
    ).toThrow(/DATABASE_MIGRATION_EXPECTED_DB is required/);
  });

  it(`pool max is pinned to ${MIGRATION_POOL_MAX}, even if DATABASE_POOL_MAX says otherwise`, () => {
    const env = loadMigrationDbEnv({
      DATABASE_MIGRATION_URL: MIGRATION_URL,
      DATABASE_MIGRATION_EXPECTED_DB: 'fiyatucuz',
      DATABASE_POOL_MAX: '50',
    });
    expect(env.db.DATABASE_POOL_MAX).toBe(1);
  });

  it.each([
    ['not a URL', `not-a-url-${SECRET}`, /not a valid URL/],
    ['wrong scheme', `mysql://u:${SECRET}@localhost/db`, /postgres:\/\/ scheme/],
    ['unparseable with credentials', `postgres://u:${SECRET}@[bad`, /not a valid URL/],
  ])('invalid URL (%s) → error without the secret', (_label, url, re) => {
    let message = '';
    try {
      loadMigrationDbEnv({ DATABASE_MIGRATION_URL: url, DATABASE_MIGRATION_EXPECTED_DB: 'x' });
    } catch (e) {
      message = `${String(e)} ${JSON.stringify(e)}`;
    }
    expect(message).toMatch(re);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(url);
  });

  it('invalid pool tuning is reported without echoing values', () => {
    let message = '';
    try {
      loadMigrationDbEnv({
        DATABASE_MIGRATION_URL: MIGRATION_URL,
        DATABASE_MIGRATION_EXPECTED_DB: 'x',
        DATABASE_CONNECT_TIMEOUT_SECONDS: 'NaN-ish',
      });
    } catch (e) {
      message = String(e);
    }
    expect(message).toMatch(/Invalid migration environment: DATABASE_CONNECT_TIMEOUT_SECONDS/);
    expect(message).not.toContain(SECRET);
  });
});

describe('secret redaction', () => {
  it('redactSecrets masks the full URL, the password and any user:pass@ form', () => {
    const secrets = secretsOfDatabaseUrl(MIGRATION_URL);
    const text = `failed for ${MIGRATION_URL}; pw=${SECRET}; other=postgres://a:b@h/d`;
    const out = redactSecrets(text, secrets);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(MIGRATION_URL);
    expect(out).toContain('postgres://a:***@h/d');
  });

  it('percent-encoded passwords are covered in raw and decoded form', () => {
    const url = 'postgres://u:p%40ss%2Fword@localhost/db';
    const out = redactSecrets(`raw p%40ss%2Fword decoded p@ss/word`, secretsOfDatabaseUrl(url));
    expect(out).not.toContain('p%40ss%2Fword');
    expect(out).not.toContain('p@ss/word');
  });

  it('describeError never serializes extra properties (e.g. ERR_INVALID_URL.input)', () => {
    const e = Object.assign(new TypeError('Invalid URL'), {
      code: 'ERR_INVALID_URL',
      input: MIGRATION_URL,
    });
    const out = describeError(e, secretsOfDatabaseUrl(MIGRATION_URL));
    expect(out).toBe('TypeError [ERR_INVALID_URL]: Invalid URL');
  });

  it('describeError redacts secrets that appear in the message itself', () => {
    const out = describeError(
      new Error(`cannot reach ${MIGRATION_URL}`),
      secretsOfDatabaseUrl(MIGRATION_URL),
    );
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(MIGRATION_URL);
  });
});

describe('migration CLI (no database)', () => {
  async function run(argv: string[], env: Record<string, string | undefined>) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMigrationCli({
      argv,
      env,
      migrationsDir: '/nonexistent',
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('only DATABASE_URL present → exit 1, no fallback, no secret printed', async () => {
    const r = await run(['--status'], {
      DATABASE_URL: RUNTIME_URL,
      DATABASE_MIGRATION_EXPECTED_DB: 'fiyatucuz',
    });
    expect(r.code).toBe(EXIT_FAILURE);
    expect(r.err).toMatch(/DATABASE_MIGRATION_URL is required/);
    expect(`${r.out}${r.err}`).not.toContain('RUNTIME_ONLY_PW');
    expect(r.out).toBe('');
  });

  it('expected DB missing → exit 1', async () => {
    const r = await run([], { DATABASE_MIGRATION_URL: MIGRATION_URL });
    expect(r.code).toBe(EXIT_FAILURE);
    expect(r.err).toMatch(/DATABASE_MIGRATION_EXPECTED_DB is required/);
    expect(`${r.out}${r.err}`).not.toContain(SECRET);
  });

  it('unknown argument → exit 2 (usage), argument is redacted', async () => {
    const r = await run(['--force', `postgres://x:${SECRET}@h/d`], {});
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.err).toMatch(/unknown argument/);
    expect(r.err).not.toContain(SECRET);
  });

  it('a bare "--" from the script runner is ignored', async () => {
    const r = await run(['--', '--status'], {});
    expect(r.code).toBe(EXIT_FAILURE); // fails on missing env, not on usage
    expect(r.err).toMatch(/DATABASE_MIGRATION_URL is required/);
  });

  it('connection failure output contains neither URL nor password', async () => {
    const url = `postgres://migration_user:${SECRET}@127.0.0.1:1/fiyatucuz`;
    const r = await run(['--status'], {
      DATABASE_MIGRATION_URL: url,
      DATABASE_MIGRATION_EXPECTED_DB: 'fiyatucuz',
      DATABASE_CONNECT_TIMEOUT_SECONDS: '2',
    });
    expect(r.code).toBe(EXIT_FAILURE);
    expect(r.err).toMatch(/\[db:migrate\] failed:/);
    expect(`${r.out}${r.err}`).not.toContain(SECRET);
    expect(`${r.out}${r.err}`).not.toContain(url);
  });
});
