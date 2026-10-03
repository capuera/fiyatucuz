import { createDbHandle } from '../client.js';
import {
  describeError,
  loadMigrationDbEnv,
  MigrationEnvError,
  redactSecrets,
  secretsOfDatabaseUrl,
} from '../migration-env.js';
import {
  applyMigrations,
  assertExpectedDatabase,
  getMigrationStatus,
  readMigrationTarget,
} from '../migrator.js';

/**
 * Migration CLI logic (ADIM 15A-1), separated from the process entry point
 * (cli/migrate.ts) so it can be tested without spawning processes.
 *
 * Modes:
 *   (default)  apply pending migrations
 *   --status   read-only: list applied / pending, change nothing
 *
 * Exit codes:
 *   0  command succeeded (for --status: pending migrations are NOT an error)
 *   1  configuration, connection, target-database or migration failure
 *   2  invalid arguments
 *
 * Order of operations is the safety contract: load + validate env (no
 * DATABASE_URL), connect, verify current_database() === expected, and only
 * then read status or apply. A mismatch aborts before any statement that
 * could create or modify anything.
 */

export interface MigrationCliOptions {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly migrationsDir: string;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

const PREFIX = '[db:migrate]';
const USAGE = `${PREFIX} usage: migrate [--status]`;

export async function runMigrationCli(options: MigrationCliOptions): Promise<number> {
  const out = options.out ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const err = options.err ?? ((line: string) => void process.stderr.write(`${line}\n`));

  // A bare "--" may be forwarded by package-manager script runners; ignore it.
  const args = options.argv.filter((a) => a !== '--');
  const unknown = args.filter((a) => a !== '--status');
  if (unknown.length > 0) {
    err(
      `${PREFIX} unknown argument(s): ${unknown.map((a) => JSON.stringify(redactSecrets(a))).join(' ')}`,
    );
    err(USAGE);
    return EXIT_USAGE;
  }
  const statusOnly = args.includes('--status');

  let secrets: string[] = [];
  try {
    const env = loadMigrationDbEnv(options.env);
    secrets = secretsOfDatabaseUrl(env.db.DATABASE_URL);
    const handle = createDbHandle(env.db);
    try {
      const target = await readMigrationTarget(handle.sql);
      out(
        `${PREFIX} target: database=${target.database} user=${target.user} server=${target.serverVersion}`,
      );
      assertExpectedDatabase(target, env.expectedDatabase);

      if (statusOnly) {
        const status = await getMigrationStatus(handle.sql, options.migrationsDir);
        if (!status.trackingTableExists) {
          out(`${PREFIX} tracking table not found — no migrations recorded yet`);
        }
        out(`${PREFIX} applied (${status.applied.length}):`);
        for (const id of status.applied) out(`  ${id}`);
        out(`${PREFIX} pending (${status.pending.length}):`);
        for (const id of status.pending) out(`  ${id}`);
        if (status.unknownApplied.length > 0) {
          out(
            `${PREFIX} recorded but missing from this checkout (${status.unknownApplied.length}):`,
          );
          for (const id of status.unknownApplied) out(`  ${id}`);
        }
        return EXIT_OK;
      }

      const result = await applyMigrations(handle.sql, options.migrationsDir);
      for (const id of result.applied) out(`${PREFIX} Applied ${id}`);
      out(`${PREFIX} Done: ${result.applied.length} applied, ${result.skipped.length} skipped.`);
      return EXIT_OK;
    } finally {
      await handle.close().catch(() => {
        /* closing a failed pool must not mask the original error */
      });
    }
  } catch (e) {
    const message = e instanceof MigrationEnvError ? e.message : describeError(e, secrets);
    err(`${PREFIX} failed: ${redactSecrets(message, secrets)}`);
    return EXIT_FAILURE;
  }
}
