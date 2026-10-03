// Public surface of @fiyatucuz/db.
//
// Consumers (services/api, future services/worker-*) should only depend on this
// barrel. The schema barrel is exported at the sub-path `@fiyatucuz/db/schema`
// so that Drizzle Kit and repositories can reach it without pulling the client.

export { loadDbEnv, type DbEnv } from './env.js';
export { createDbHandle, type Db, type Sql, type DbHandle } from './client.js';
export { transaction, type Tx } from './transaction.js';
export { withTenantTransaction, TENANT_GUC, TenantContextError } from './tenant.js';
export { newId } from './id.js';

// Re-export the drizzle-orm SQL operators consumers actually use. This keeps
// bounded contexts from taking a direct dependency on drizzle-orm and lets
// us swap the underlying library later without a cross-repo refactor.
export { and, asc, desc, eq, or, sql, inArray, isNotNull, isNull, not } from 'drizzle-orm';
export {
  applyMigrations,
  ensureMigrationsTable,
  listAppliedMigrations,
  listMigrationFiles,
  getMigrationStatus,
  readMigrationTarget,
  assertExpectedDatabase,
  MigrationTargetMismatchError,
  MIGRATIONS_TABLE,
  type AppliedMigration,
  type MigrationRunResult,
  type MigrationStatus,
  type MigrationTarget,
} from './migrator.js';
export {
  tryAcquireMigrationLock,
  holdsMigrationLock,
  releaseMigrationLock,
  MigrationLockUnavailableError,
  MigrationLockLostError,
  MIGRATION_LOCK_NAMESPACE,
  MIGRATION_LOCK_RESOURCE,
} from './migration-lock.js';
export {
  loadMigrationDbEnv,
  MigrationEnvError,
  MIGRATION_URL_VAR,
  MIGRATION_EXPECTED_DB_VAR,
  MIGRATION_POOL_MAX,
  redactSecrets,
  secretsOfDatabaseUrl,
  describeError,
  type MigrationDbEnv,
} from './migration-env.js';
export {
  loadReportingDbEnv,
  createReportingHandle,
  withReportingTransaction,
  type ReportingTransactionOptions,
} from './reporting.js';
