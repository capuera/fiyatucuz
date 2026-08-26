import { isAbsolute, relative, resolve as resolvePath } from 'node:path';

import { loadEnv } from '@fiyatucuz/config';
import { z } from 'zod';

/**
 * Feed-fetch environment (ADR-0016 §Fetch limits, §SSRF, ADR-0017 §Config).
 *
 * FEED_FETCH_ALLOW_PRIVATE_ADDRESSES is a TEST-ONLY override that skips the
 * private-IP / loopback / metadata-endpoint checks so integration tests can
 * spin up an HTTP server on 127.0.0.1. Boot fails when NODE_ENV=production
 * and this is true — enforced by assertProductionFeedFetchSafety() below.
 *
 * FEED_ARCHIVE_DRIVER / FEED_ARCHIVE_LOCAL_ROOT configure raw-body archiving
 * (ADR-0017). In production the local root MUST be an explicit absolute
 * path outside the source tree — enforced by
 * assertProductionFeedArchiveSafety(). In dev/test, an OS-tmpdir fallback
 * is used (see archive/factory.ts §resolveLocalArchiveRoot).
 */
const BooleanishSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const FeedEnvSchema = z.object({
  FEED_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
  FEED_FETCH_MAX_BYTES: z.coerce.number().int().min(1024).max(1024 * 1024 * 1024).default(50 * 1024 * 1024),
  FEED_FETCH_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(3),
  FEED_FETCH_USER_AGENT: z.string().min(1).max(200).default('FiyatUcuzFeedBot/1.0'),
  FEED_FETCH_ALLOW_PRIVATE_ADDRESSES: BooleanishSchema.default(false),
  FEED_ARCHIVE_DRIVER: z.enum(['local']).default('local'),
  FEED_ARCHIVE_LOCAL_ROOT: z.string().min(1).optional(),
});

export type FeedEnv = z.infer<typeof FeedEnvSchema>;

export function loadFeedEnv(source: Record<string, string | undefined> = process.env): FeedEnv {
  return loadEnv(FeedEnvSchema, source);
}

export class InsecureProductionFeedFetchError extends Error {
  readonly code = 'INSECURE_PRODUCTION_FEED_FETCH' as const;
  constructor() {
    super(
      'FEED_FETCH_ALLOW_PRIVATE_ADDRESSES must NOT be true when NODE_ENV=production. ' +
        'That flag is for tests only; production must reject private/loopback/metadata targets.',
    );
    this.name = 'InsecureProductionFeedFetchError';
  }
}

export function assertProductionFeedFetchSafety(env: FeedEnv, nodeEnv: string): void {
  if (nodeEnv === 'production' && env.FEED_FETCH_ALLOW_PRIVATE_ADDRESSES === true) {
    throw new InsecureProductionFeedFetchError();
  }
}

export class InsecureProductionFeedArchiveError extends Error {
  readonly code = 'INSECURE_PRODUCTION_FEED_ARCHIVE' as const;
  constructor(reason: string) {
    super(
      `Feed archive is not safely configured for NODE_ENV=production: ${reason}. ` +
        'Set FEED_ARCHIVE_LOCAL_ROOT to an explicit absolute path on a dedicated ' +
        'data volume — the OS temp directory fallback is dev-only.',
    );
    this.name = 'InsecureProductionFeedArchiveError';
  }
}

/**
 * Refuse to boot into production with an implicit / repo-adjacent archive
 * root. Dev/test may still fall back to the OS temp directory via
 * {@link ./archive/factory.ts §resolveLocalArchiveRoot}.
 */
export function assertProductionFeedArchiveSafety(env: FeedEnv, nodeEnv: string): void {
  if (nodeEnv !== 'production') return;
  if (env.FEED_ARCHIVE_DRIVER !== 'local') return; // future drivers own their own checks
  const root = env.FEED_ARCHIVE_LOCAL_ROOT;
  if (!root || root.length === 0) {
    throw new InsecureProductionFeedArchiveError('FEED_ARCHIVE_LOCAL_ROOT is unset');
  }
  if (!isAbsolute(root)) {
    throw new InsecureProductionFeedArchiveError(
      `FEED_ARCHIVE_LOCAL_ROOT is not absolute: "${root}"`,
    );
  }
  // Heuristic: the archive root must not live inside the repository / cwd.
  // A production archive under the deployment's working directory would
  // vanish on redeploy and could accidentally end up served by a
  // co-located web server. Use `path.relative` so the check works on both
  // POSIX (`/opt/app/data`) and Windows (`D:\Deploy\App\data`) — a subpath
  // yields a relative that neither starts with `..` nor is absolute; an
  // outside path yields `..\…` or an absolute drive path (Windows).
  const cwd = resolvePath(process.cwd());
  const rel = relative(cwd, resolvePath(root));
  const insideCwd = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (insideCwd) {
    throw new InsecureProductionFeedArchiveError(
      `FEED_ARCHIVE_LOCAL_ROOT="${root}" lives inside the process cwd`,
    );
  }
}
