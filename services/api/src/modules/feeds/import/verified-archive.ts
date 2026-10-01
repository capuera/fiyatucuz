/**
 * Re-reading an archived feed body for import (ADR-0018 §Archive re-read).
 *
 * The archive is trusted only as far as it can be re-verified:
 *   1. the reference must parse (ADR-0017 grammar) AND name exactly the
 *      expected tenant / feed / fetch / format;
 *   2. pass 1 streams the bytes once to recompute SHA-256 and compare it to
 *      feed_fetches.content_hash — a tampered archive is rejected BEFORE any
 *      offer is written;
 *   3. pass 2 streams again through the same gates the fetcher used — byte
 *      cap, UTF-8 prefix gate, StreamingXmlSecurityScanner — then a fatal
 *      UTF-8 decoder, and re-hashes so a swap between passes is detected.
 *
 * Neither pass buffers the body; memory is O(chunk + encoding prefix).
 */

import { createHash } from 'node:crypto';

import { extForFormat, parseArchiveRef } from '../archive/reference.js';
import type { FeedArchive } from '../archive/types.js';
import {
  assertUtf8XmlPrefix,
  extractContentTypeCharset,
  XML_ENCODING_PREFIX_MAX_BYTES,
  XmlEncodingError,
} from '../parser/xml-encoding.js';
import { StreamingXmlSecurityScanner, XmlSecurityError } from '../parser/xml-security.js';
import type { FeedFormat } from '../repository.js';

import { ImportError } from './errors.js';

/** Wraps an error thrown by the caller's onText so it is never relabeled. */
class ConsumerFailure {
  constructor(public readonly cause: unknown) {}
}

export interface ExpectedArchive {
  readonly tenantId: string;
  readonly feedId: string;
  readonly fetchId: string;
  readonly format: FeedFormat;
  readonly ref: string;
  /** feed_fetches.content_hash (hex SHA-256). */
  readonly contentHash: string;
  /** feed_fetches.content_type — its charset is re-checked by the gate. */
  readonly contentType: string | null;
  readonly maxBytes: number;
}

/** Throws ImportError unless the ref names exactly the expected object. */
export function assertArchiveRefMatches(e: ExpectedArchive): void {
  let parsed: ReturnType<typeof parseArchiveRef>;
  try {
    parsed = parseArchiveRef(e.ref);
  } catch {
    throw new ImportError('ARCHIVE_REF_INVALID', 'archive reference is malformed');
  }
  if (
    parsed.tenantId.toLowerCase() !== e.tenantId.toLowerCase() ||
    parsed.feedId.toLowerCase() !== e.feedId.toLowerCase() ||
    parsed.fetchId.toLowerCase() !== e.fetchId.toLowerCase() ||
    parsed.ext !== extForFormat(e.format)
  ) {
    throw new ImportError('ARCHIVE_REF_MISMATCH', 'archive reference does not match the fetch');
  }
}

async function openArchive(archive: FeedArchive, ref: string): Promise<AsyncIterable<Uint8Array>> {
  try {
    return await archive.read(ref);
  } catch {
    throw new ImportError('ARCHIVE_READ_FAILED', 'archive object could not be opened');
  }
}

/** Pass 1: hash-only verification. */
export async function verifyArchiveIntegrity(archive: FeedArchive, e: ExpectedArchive): Promise<void> {
  assertArchiveRefMatches(e);
  const hasher = createHash('sha256');
  let total = 0;
  try {
    for await (const chunk of await openArchive(archive, e.ref)) {
      total += chunk.length;
      if (total > e.maxBytes) throw new ImportError('ARCHIVE_TOO_LARGE', `archive exceeds ${e.maxBytes} bytes`);
      hasher.update(chunk);
    }
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw new ImportError('ARCHIVE_READ_FAILED', 'archive read failed');
  }
  if (hasher.digest('hex') !== e.contentHash) {
    throw new ImportError('ARCHIVE_INTEGRITY_MISMATCH', 'archive SHA-256 does not match the fetch record');
  }
}

/**
 * Pass 2: stream decoded, gate-checked XML text to `onText`. `onText` may
 * be async (the importer flushes DB batches from it); it is awaited per
 * chunk, which bounds buffered work to one chunk.
 */
export async function streamVerifiedXmlText(
  archive: FeedArchive,
  e: ExpectedArchive,
  onText: (text: string) => void | Promise<void>,
): Promise<void> {
  assertArchiveRefMatches(e);
  const hasher = createHash('sha256');
  const scanner = new StreamingXmlSecurityScanner();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const charset = extractContentTypeCharset(e.contentType);

  let total = 0;
  let prefix: Uint8Array[] = [];
  let prefixLen = 0;
  let gated = false;

  const gate = (bytes: Uint8Array): void => {
    try {
      assertUtf8XmlPrefix(bytes, charset);
      scanner.update(bytes);
    } catch (err) {
      if (err instanceof XmlEncodingError) {
        throw new ImportError('XML_ENCODING_REJECTED', `${err.subcode}: ${err.message}`);
      }
      if (err instanceof XmlSecurityError) {
        throw new ImportError('XML_SECURITY_REJECTED', `${err.subcode}: ${err.message}`);
      }
      throw err;
    }
  };
  const decode = (bytes: Uint8Array, stream: boolean): string => {
    try {
      return decoder.decode(bytes, { stream });
    } catch {
      throw new ImportError('XML_INVALID_UTF8', 'feed body is not valid UTF-8');
    }
  };
  const flushPrefix = async (): Promise<void> => {
    const combined = new Uint8Array(prefixLen);
    let offset = 0;
    for (const c of prefix) {
      combined.set(c, offset);
      offset += c.length;
    }
    prefix = [];
    prefixLen = 0;
    gated = true;
    gate(combined);
    await emit(decode(combined, true));
  };
  const emit = async (text: string): Promise<void> => {
    try {
      await onText(text);
    } catch (err) {
      throw new ConsumerFailure(err);
    }
  };

  const iterable = await openArchive(archive, e.ref);
  try {
    for await (const chunk of iterable) {
      total += chunk.length;
      if (total > e.maxBytes) throw new ImportError('ARCHIVE_TOO_LARGE', `archive exceeds ${e.maxBytes} bytes`);
      hasher.update(chunk);
      if (!gated) {
        prefix.push(chunk);
        prefixLen += chunk.length;
        if (prefixLen >= XML_ENCODING_PREFIX_MAX_BYTES) await flushPrefix();
        continue;
      }
      try {
        scanner.update(chunk);
      } catch (err) {
        if (err instanceof XmlSecurityError) {
          throw new ImportError('XML_SECURITY_REJECTED', `${err.subcode}: ${err.message}`);
        }
        throw err;
      }
      await emit(decode(chunk, true));
    }
    if (!gated) await flushPrefix();
    scanner.end();
    const tail = decode(new Uint8Array(0), false);
    if (tail.length > 0) await emit(tail);
  } catch (err) {
    // Errors raised by onText (extractor / DB) propagate unchanged; gate
    // errors are already ImportErrors; anything else came from the archive.
    if (err instanceof ConsumerFailure) throw err.cause;
    if (err instanceof ImportError) throw err;
    throw new ImportError('ARCHIVE_READ_FAILED', 'archive read failed');
  }
  if (hasher.digest('hex') !== e.contentHash) {
    throw new ImportError('ARCHIVE_INTEGRITY_MISMATCH', 'archive changed while it was being imported');
  }
}
