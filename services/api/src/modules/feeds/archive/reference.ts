/**
 * Archive reference (URI) grammar (ADR-0017 §Reference format).
 *
 *   feed-archive://<tenantId>/<feedId>/<fetchId>/raw.<ext>
 *
 * All three IDs are UUIDs. `ext` is `xml` for any XML-family feed or `csv`
 * for CSV feeds — derived from the trusted {@link FeedFormat}, never from a
 * filename supplied by the remote server or a merchant.
 *
 * The URI is deterministic for the (tenantId, feedId, fetchId) triple, which
 * means:
 *   - a read/delete needs only the ref (no lookup on the DB row).
 *   - a fetchId collision is impossible (fetchId is a v4 UUID).
 *   - the ref cannot leak an OS path, bucket, or vendor identifier.
 */

import type { FeedFormat } from '../repository.js';

import { FeedArchiveError, type FeedArchiveKey, type FeedArchiveRef } from './types.js';

export const FEED_ARCHIVE_SCHEME = 'feed-archive:';
const SCHEME_PREFIX = `${FEED_ARCHIVE_SCHEME}//`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FeedArchiveExt = 'xml' | 'csv';

export function extForFormat(format: FeedFormat): FeedArchiveExt {
  return format === 'CSV' ? 'csv' : 'xml';
}

export interface ParsedArchiveRef {
  readonly tenantId: string;
  readonly feedId: string;
  readonly fetchId: string;
  readonly ext: FeedArchiveExt;
}

export function buildArchiveRef(key: FeedArchiveKey): FeedArchiveRef {
  assertUuid('tenantId', key.tenantId);
  assertUuid('feedId', key.feedId);
  assertUuid('fetchId', key.fetchId);
  const ext = extForFormat(key.format);
  return `${SCHEME_PREFIX}${key.tenantId}/${key.feedId}/${key.fetchId}/raw.${ext}`;
}

export function parseArchiveRef(ref: string): ParsedArchiveRef {
  if (typeof ref !== 'string' || !ref.startsWith(SCHEME_PREFIX)) {
    throw new FeedArchiveError(
      'INVALID_ARCHIVE_REF',
      `not a feed-archive URI`,
    );
  }
  const path = ref.slice(SCHEME_PREFIX.length);

  // Reject anything that could resolve into a path we didn't intend. `..`,
  // backslashes (Windows), NUL bytes, and empty segments are all invalid
  // in our grammar — none of them appear in the canonical form.
  if (
    path.includes('..') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.includes('//') ||
    path.startsWith('/') ||
    path.endsWith('/')
  ) {
    throw new FeedArchiveError('INVALID_ARCHIVE_REF', 'reference contains forbidden characters');
  }

  const parts = path.split('/');
  if (parts.length !== 4) {
    throw new FeedArchiveError(
      'INVALID_ARCHIVE_REF',
      `expected 4 path segments, got ${parts.length}`,
    );
  }
  const [tenantId, feedId, fetchId, leaf] = parts as [string, string, string, string];
  assertUuid('tenantId', tenantId);
  assertUuid('feedId', feedId);
  assertUuid('fetchId', fetchId);

  let ext: FeedArchiveExt;
  if (leaf === 'raw.xml') ext = 'xml';
  else if (leaf === 'raw.csv') ext = 'csv';
  else {
    throw new FeedArchiveError(
      'INVALID_ARCHIVE_REF',
      `leaf must be raw.xml or raw.csv, got "${leaf}"`,
    );
  }
  return { tenantId, feedId, fetchId, ext };
}

function assertUuid(field: string, value: string): void {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new FeedArchiveError('INVALID_ARCHIVE_REF', `${field} is not a UUID`);
  }
}
