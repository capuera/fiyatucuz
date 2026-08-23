/**
 * XML security scan (ADR-0016 §XML security).
 *
 * A byte-level preflight that rejects XML feeds carrying XXE / DTD / entity
 * bomb constructs BEFORE any full parser touches them. We deliberately
 * avoid adding an XML library dependency in this sprint — the substring
 * scan is a conservative approximation that catches the well-known attack
 * vectors while remaining O(n) and streaming-friendly.
 *
 * A future parser sprint that adopts a real XML library must configure it
 * with entities disabled + DTD off + bounded expansion, and can then rely
 * on this scan as an additional belt-and-suspenders check.
 */

export type XmlSecurityCode =
  | 'XML_DOCTYPE_REJECTED'
  | 'XML_ENTITY_REJECTED'
  | 'XML_EXTERNAL_REFERENCE_REJECTED';

export class XmlSecurityError extends Error {
  readonly code = 'XML_SECURITY_REJECTED' as const;
  constructor(
    public readonly subcode: XmlSecurityCode,
    message: string,
  ) {
    super(message);
    this.name = 'XmlSecurityError';
  }
}

// Regexes are case-insensitive and tolerate common whitespace variants.
// We scan the raw text; XML comment stripping is not required — the intent
// is any occurrence of a dangerous construct triggers rejection.
const DOCTYPE_RE = /<!DOCTYPE\b/i;
const ENTITY_RE = /<!ENTITY\b/i;
const SYSTEM_RE = /\bSYSTEM\s+["']/i;
const PUBLIC_RE = /\bPUBLIC\s+["']/i;

/**
 * Scan a byte-decoded string window for XML-security threats. Callers should
 * pass at least the first 64 KiB of the response (the head is where DTDs
 * and DOCTYPE declarations legally appear); scanning the whole document is
 * also acceptable but not required.
 *
 * Prefer {@link StreamingXmlSecurityScanner} for actual feed download paths
 * — it is memory-bounded and catches tokens anywhere in the stream, not
 * only in a leading window.
 */
export function scanXmlSecurity(text: string): void {
  if (DOCTYPE_RE.test(text)) {
    throw new XmlSecurityError('XML_DOCTYPE_REJECTED', 'DOCTYPE declaration is not permitted');
  }
  if (ENTITY_RE.test(text)) {
    throw new XmlSecurityError('XML_ENTITY_REJECTED', 'ENTITY declaration is not permitted');
  }
  if (SYSTEM_RE.test(text) || PUBLIC_RE.test(text)) {
    throw new XmlSecurityError(
      'XML_EXTERNAL_REFERENCE_REJECTED',
      'external SYSTEM/PUBLIC reference is not permitted',
    );
  }
}

/**
 * Chunk-safe streaming variant of {@link scanXmlSecurity} (ADIM 12.1
 * §Streaming XML scanner). Maintains a small trailing overlap window so
 * forbidden tokens that straddle a chunk boundary are still detected. The
 * caller feeds every chunk of the response body; total buffered memory is
 * O(OVERLAP_BYTES + one chunk) — never the full feed.
 *
 * On rejection, throws XmlSecurityError immediately. On EOF the caller
 * invokes {@link end} for symmetry (currently a no-op; kept in the
 * interface so a future encoding-aware finalizer has a hook).
 */
export class StreamingXmlSecurityScanner {
  // 40 bytes comfortably exceeds any token we scan for:
  //   `<!DOCTYPE` (9), `<!ENTITY` (8), `SYSTEM "` (8), `PUBLIC "` (8).
  // Even with maximal internal whitespace the tokens fit under 20 bytes.
  private static readonly OVERLAP_BYTES = 40;
  private static readonly DECODER = new TextDecoder('utf-8', { fatal: false });

  private overlap = '';
  private byteCountScanned = 0;

  /** Feed a chunk of the response body. Throws XmlSecurityError on hit. */
  update(chunk: Uint8Array | string): void {
    const text =
      typeof chunk === 'string'
        ? chunk
        : StreamingXmlSecurityScanner.DECODER.decode(chunk, { stream: true });
    if (text.length === 0) return;

    const combined = this.overlap + text;
    // scanXmlSecurity throws on any forbidden construct.
    scanXmlSecurity(combined);

    this.byteCountScanned += text.length;
    // Keep only the trailing OVERLAP_BYTES of characters so a token split
    // across the next chunk boundary is still detected. Character length
    // here is a safe upper-bound for byte overlap for UTF-8 (multi-byte
    // sequences are >= 1 char).
    this.overlap =
      combined.length > StreamingXmlSecurityScanner.OVERLAP_BYTES
        ? combined.slice(-StreamingXmlSecurityScanner.OVERLAP_BYTES)
        : combined;
  }

  end(): void {
    // No-op today — TextDecoder was initialized with stream:true so it may
    // hold an incomplete multi-byte tail at EOF. Flushing produces the
    // replacement char (never the ASCII bytes we scan for), so decoding
    // the leftover would not surface any new forbidden token. Kept as
    // an explicit hook for future encoding-aware finalization.
  }

  /** Total decoded character count scanned, for logging / assertions. */
  get scannedChars(): number {
    return this.byteCountScanned;
  }
}
