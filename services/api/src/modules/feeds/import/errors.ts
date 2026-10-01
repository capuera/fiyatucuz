/**
 * Document-level import failures (ADR-0018 §Partial failure). Any of these
 * ends the import as FAILED and suppresses deactivation of unseen offers.
 * Item-level problems are NOT errors — they are rejection/warning counts.
 */

export type ImportErrorCode =
  | 'FETCH_NOT_IMPORTABLE'
  | 'FORMAT_NOT_SUPPORTED'
  | 'MAPPING_REQUIRED'
  | 'MAPPING_INVALID'
  | 'SITE_NOT_FOUND'
  | 'ARCHIVE_REF_INVALID'
  | 'ARCHIVE_REF_MISMATCH'
  | 'ARCHIVE_READ_FAILED'
  | 'ARCHIVE_TOO_LARGE'
  | 'ARCHIVE_INTEGRITY_MISMATCH'
  | 'XML_ENCODING_REJECTED'
  | 'XML_SECURITY_REJECTED'
  | 'XML_INVALID_UTF8'
  | 'XML_MALFORMED'
  | 'XML_TOO_DEEP'
  | 'TOO_MANY_ITEMS'
  | 'NO_VALID_ITEMS'
  | 'SUPERSEDED'
  | 'LEASE_EXPIRED'
  | 'IMPORT_FAILED';

export class ImportError extends Error {
  constructor(
    public readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

/** The worker's lease was taken over; it must stop without finalizing. */
export class ImportLeaseLostError extends Error {
  constructor(public readonly importId: string) {
    super(`import ${importId} lease lost to another worker`);
    this.name = 'ImportLeaseLostError';
  }
}
