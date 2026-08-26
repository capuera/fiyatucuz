import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FeedEnv } from '../env.js';

import { LocalFilesystemFeedArchive } from './local.js';
import { FeedArchiveError, type FeedArchive } from './types.js';

/**
 * Resolve the effective local root:
 *   - explicit env value if set,
 *   - otherwise a NON-PRODUCTION fallback under the OS temp directory.
 *
 * Production callers MUST set `FEED_ARCHIVE_LOCAL_ROOT` explicitly — this is
 * enforced by {@link assertProductionFeedArchiveSafety} at boot.
 */
export function resolveLocalArchiveRoot(env: FeedEnv): string {
  if (env.FEED_ARCHIVE_LOCAL_ROOT && env.FEED_ARCHIVE_LOCAL_ROOT.length > 0) {
    return env.FEED_ARCHIVE_LOCAL_ROOT;
  }
  // Dev/test fallback lives outside the repo — always on the OS temp
  // volume, never inside the source tree.
  return join(tmpdir(), 'fiyatucuz-feed-archive');
}

export function createFeedArchive(env: FeedEnv): FeedArchive {
  if (env.FEED_ARCHIVE_DRIVER === 'local') {
    return new LocalFilesystemFeedArchive(resolveLocalArchiveRoot(env));
  }
  // The zod schema restricts the enum, but keep an exhaustive-guard error
  // for future drivers so an unknown value fails loudly at build time.
  const driver: string = env.FEED_ARCHIVE_DRIVER;
  throw new FeedArchiveError(
    'ARCHIVE_ROOT_INVALID',
    `unknown FEED_ARCHIVE_DRIVER: ${driver}`,
  );
}
