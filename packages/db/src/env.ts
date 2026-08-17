import { loadEnv } from '@fiyatucuz/config';
import { z } from 'zod';

/**
 * Database environment schema.
 *
 * Prepared statements default to OFF so the client is safe under a pgBouncer
 * transaction pool out of the box; enable them only when connecting directly to
 * PostgreSQL (see ADR-0012).
 */
const DbEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  DATABASE_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(60).default(10),
  DATABASE_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
  DATABASE_MAX_LIFETIME_SECONDS: z.coerce.number().int().min(0).max(86400).default(1800),
  DATABASE_PREPARED_STATEMENTS: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(false),
  DATABASE_SSL: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'require', 'prefer', 'disable'])])
    .transform((v) => {
      if (v === true || v === 'true' || v === '1' || v === 'require') return 'require' as const;
      if (v === 'prefer') return 'prefer' as const;
      return false as const;
    })
    .default(false),
});

export type DbEnv = z.infer<typeof DbEnvSchema>;

export function loadDbEnv(source: Record<string, string | undefined> = process.env): DbEnv {
  return loadEnv(DbEnvSchema, source);
}
