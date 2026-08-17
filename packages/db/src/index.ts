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
export { and, eq, or, sql, inArray, isNotNull, isNull, not } from 'drizzle-orm';
export {
  applyMigrations,
  ensureMigrationsTable,
  listAppliedMigrations,
  MIGRATIONS_TABLE,
  type AppliedMigration,
  type MigrationRunResult,
} from './migrator.js';
export {
  loadReportingDbEnv,
  createReportingHandle,
  withReportingTransaction,
  type ReportingTransactionOptions,
} from './reporting.js';
