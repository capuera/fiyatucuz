import { loadEnv } from '@fiyatucuz/config';
import { z } from 'zod';

const ApiEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  // DATABASE_URL (and its pool-tuning variables) is owned by @fiyatucuz/db via
  // loadDbEnv() — declared there so there is a single source of truth for the
  // database env contract. REDIS_URL is not consumed at foundation phase; a
  // future infrastructure package will own it. Kept optional here so a value in
  // .env does not fail boot.
  REDIS_URL: z.string().url().optional(),
});

export type ApiEnv = z.infer<typeof ApiEnvSchema>;

export function loadApiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  return loadEnv(ApiEnvSchema, source);
}
