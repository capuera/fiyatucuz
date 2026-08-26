/**
 * Raw feed archive abstraction (ADR-0017).
 *
 * The interface is deliberately narrow so future backends (S3-compatible,
 * Azure Blob, GCS) can slot in without touching feed business logic. The
 * only thing that leaves this module is an opaque {@link FeedArchiveRef}
 * string — never a filesystem path, bucket name, or vendor-specific handle.
 *
 * Streaming: `openWriter` returns an object the caller drives chunk-by-chunk
 * so the fetch pipeline can hash + validate + archive in one pass over the
 * response body, never materializing it into a single buffer.
 */

import type { FeedFormat } from '../repository.js';

/**
 * Opaque reference persisted in `feed_fetches.raw_archive_ref`. The exact
 * URI grammar is documented in {@link ./reference.ts}; consumers must treat
 * the string as opaque and route reads/deletes back through this interface.
 */
export type FeedArchiveRef = string;

/**
 * Trusted, non-user-controlled identity of the object we're about to write.
 * All three IDs MUST be validated UUIDs — the local adapter rebuilds a
 * filesystem path from them, so anything other than a UUID would be an
 * SSRF/traversal risk.
 */
export interface FeedArchiveKey {
  readonly tenantId: string;
  readonly feedId: string;
  readonly fetchId: string;
  readonly format: FeedFormat;
}

/**
 * A one-shot writer for a single archive object. Discipline:
 *
 *   const w = await archive.openWriter(key);
 *   try {
 *     for await (const chunk of body) await w.write(chunk);
 *     const ref = await w.finalize();
 *     return ref;
 *   } catch (e) {
 *     await w.abort();
 *     throw e;
 *   }
 *
 * `finalize` must be atomic-ish: no observable archive object exists under
 * its final name until `finalize` returns. `abort` must clean up temporary
 * artifacts even when called after a partial write.
 */
export interface FeedArchiveWriter {
  write(chunk: Uint8Array): Promise<void>;
  finalize(): Promise<FeedArchiveRef>;
  abort(): Promise<void>;
}

export interface FeedArchive {
  openWriter(key: FeedArchiveKey): Promise<FeedArchiveWriter>;
  /**
   * Return the archived bytes as a streaming async iterable. Callers MUST
   * consume the stream to completion or destroy it to release resources.
   * Never load the whole body into memory here.
   */
  read(ref: FeedArchiveRef): Promise<AsyncIterable<Uint8Array>>;
  exists(ref: FeedArchiveRef): Promise<boolean>;
  /** Idempotent — deleting a non-existent ref is a no-op. */
  delete(ref: FeedArchiveRef): Promise<void>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type FeedArchiveErrorCode =
  | 'INVALID_ARCHIVE_REF'
  | 'ARCHIVE_NOT_FOUND'
  | 'ARCHIVE_ALREADY_EXISTS'
  | 'ARCHIVE_ROOT_INVALID'
  | 'ARCHIVE_WRITE_FAILED'
  | 'ARCHIVE_READ_FAILED'
  | 'ARCHIVE_UNSAFE_PATH';

export class FeedArchiveError extends Error {
  constructor(
    public readonly code: FeedArchiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FeedArchiveError';
  }
}
