/**
 * XML encoding gate (ADIM 12.2 — encoding security closure).
 *
 * The streaming XML security scanner in {@link ./xml-security.ts} decodes bytes
 * as UTF-8 and greps ASCII tokens. That is sound only if the feed is genuinely
 * UTF-8. A pathological feed declaring `encoding="UTF-16"` and encoding its
 * `<!DOCTYPE …>` as double-byte sequences would otherwise slip past the scan.
 *
 * This module enforces a strict UTF-8-only policy on XML feeds by:
 *   1. Detecting a leading BOM (UTF-8 accepted, UTF-16/UTF-32 rejected).
 *   2. Parsing the XML declaration `encoding="…"` — must be UTF-8 or absent.
 *   3. Enforcing Content-Type `charset=` — must be UTF-8 or absent.
 *   4. Rejecting when a Content-Type charset and an XML declaration encoding
 *      disagree, even if neither is individually rejectable.
 *
 * Detection reads only the first N bytes of the response body
 * ({@link XML_ENCODING_PREFIX_MAX_BYTES}) — never the full feed. The fetcher
 * buffers that prefix before feeding chunks into the security scanner; the
 * total memory footprint of the encoding gate is O(prefix) ≤ ~1 KiB.
 */

export type XmlEncodingCode =
  | 'NON_UTF8_BOM'
  | 'NON_UTF8_CONTENT_TYPE_CHARSET'
  | 'NON_UTF8_XML_DECLARATION'
  | 'ENCODING_CONFLICT';

export class XmlEncodingError extends Error {
  readonly code = 'XML_ENCODING_REJECTED' as const;
  constructor(
    public readonly subcode: XmlEncodingCode,
    message: string,
  ) {
    super(message);
    this.name = 'XmlEncodingError';
  }
}

/**
 * Cap on how many bytes the encoding gate inspects. Large enough to fit any
 * legal XML declaration + charset parameter with slack; small enough that
 * buffering the prefix is O(≈1 KiB) even on gigabyte feeds.
 */
export const XML_ENCODING_PREFIX_MAX_BYTES = 1024;

export type BomKind = 'utf-8' | 'utf-16le' | 'utf-16be' | 'utf-32le' | 'utf-32be' | null;

const BOM_UTF8: readonly number[] = [0xef, 0xbb, 0xbf];
const BOM_UTF16_LE: readonly number[] = [0xff, 0xfe];
const BOM_UTF16_BE: readonly number[] = [0xfe, 0xff];
const BOM_UTF32_LE: readonly number[] = [0xff, 0xfe, 0x00, 0x00];
const BOM_UTF32_BE: readonly number[] = [0x00, 0x00, 0xfe, 0xff];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

export function detectXmlBom(bytes: Uint8Array): BomKind {
  // Order matters: UTF-32 LE (`FF FE 00 00`) starts with the same two bytes
  // as UTF-16 LE (`FF FE`), so the 4-byte check must run first.
  if (startsWith(bytes, BOM_UTF32_LE)) return 'utf-32le';
  if (startsWith(bytes, BOM_UTF32_BE)) return 'utf-32be';
  if (startsWith(bytes, BOM_UTF8)) return 'utf-8';
  if (startsWith(bytes, BOM_UTF16_LE)) return 'utf-16le';
  if (startsWith(bytes, BOM_UTF16_BE)) return 'utf-16be';
  return null;
}

/**
 * Extract the `charset` parameter from a Content-Type header. Returns the
 * lower-cased value (whitespace-trimmed, unquoted) or `null` when absent.
 */
export function extractContentTypeCharset(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  // charset="value" or charset=value; value may contain -/_/digits/letters.
  const m = contentType.match(/;\s*charset\s*=\s*(?:"([^"]+)"|([^;\s"]+))/i);
  if (!m) return null;
  const raw = (m[1] ?? m[2] ?? '').trim();
  return raw ? raw.toLowerCase() : null;
}

// Regex targets the XML declaration ONLY. The declaration must be
// syntactically `<?xml ... ?>`; encoding value is captured from
// `encoding="…"` / `encoding='…'` (case-insensitive per the XML spec).
const XML_DECL_END_RE = /\?>/;
const XML_DECL_ENCODING_RE = /\bencoding\s*=\s*(['"])([^'"]+)\1/i;

/**
 * Extract the `encoding="…"` attribute from an XML declaration in the given
 * byte prefix. Returns the lower-cased name or `null` when the declaration
 * has no encoding attribute (or there is no declaration).
 *
 * The declaration MUST be encoded in an ASCII-compatible form for a UTF-8
 * document (see XML 1.0 §4.3.3), so decoding via `String.fromCharCode` on
 * the raw bytes is safe.
 */
export function extractXmlDeclEncoding(bytes: Uint8Array, bom: BomKind): string | null {
  // Skip the BOM if present. Non-UTF-8 BOMs are rejected before this runs.
  let start = 0;
  if (bom === 'utf-8') start = BOM_UTF8.length;

  // Bound the declaration scan window; a legal declaration is well under 200
  // bytes. `XML_ENCODING_PREFIX_MAX_BYTES` is the upper cap the caller passes.
  const end = Math.min(bytes.length, start + XML_ENCODING_PREFIX_MAX_BYTES);
  let head = '';
  for (let i = start; i < end; i++) {
    // Bytes are ASCII in a legal declaration; higher bytes just yield latin-1
    // chars that never match our regex.
    head += String.fromCharCode(bytes[i]!);
  }

  // Declaration must begin the document (after any BOM).
  if (!/^<\?xml[\s?]/i.test(head)) return null;
  const endIdx = head.search(XML_DECL_END_RE);
  if (endIdx < 0) return null;
  const decl = head.slice(0, endIdx + 2);
  const m = decl.match(XML_DECL_ENCODING_RE);
  return m ? (m[2] ?? '').toLowerCase() : null;
}

// Normalizes common aliases so `utf-8`, `utf8`, and `UTF_8` compare equal.
function normalizeEncodingName(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, '-');
}

function isUtf8Label(name: string): boolean {
  const n = normalizeEncodingName(name);
  return n === 'utf-8' || n === 'utf8';
}

function sameEncoding(a: string, b: string): boolean {
  const na = normalizeEncodingName(a);
  const nb = normalizeEncodingName(b);
  if (na === nb) return true;
  // Fold utf-8 / utf8 together.
  if ((na === 'utf-8' && nb === 'utf8') || (na === 'utf8' && nb === 'utf-8')) return true;
  return false;
}

/**
 * Enforce the UTF-8-only policy on the leading prefix of an XML feed body.
 *
 * The caller MUST bound `prefix` to at most {@link XML_ENCODING_PREFIX_MAX_BYTES}
 * bytes; this function will not read past that on its own, but the guarantee
 * that "encoding detection never buffers the whole feed" lives at the call
 * site (the fetcher).
 *
 * Throws {@link XmlEncodingError} on rejection. Returns silently on accept.
 */
export function assertUtf8XmlPrefix(
  prefix: Uint8Array,
  contentTypeCharset: string | null,
): void {
  const bom = detectXmlBom(prefix);
  if (bom && bom !== 'utf-8') {
    throw new XmlEncodingError(
      'NON_UTF8_BOM',
      `XML BOM declares ${bom} — only UTF-8 is accepted`,
    );
  }

  const xmlEnc = extractXmlDeclEncoding(prefix, bom);
  const cs = contentTypeCharset ? normalizeEncodingName(contentTypeCharset) : null;

  // Explicit conflict check: both sources present and disagree. Emitted with
  // its own subcode so operators can distinguish "you contradicted yourself"
  // from "you picked a non-UTF-8 encoding".
  if (cs && xmlEnc && !sameEncoding(cs, xmlEnc)) {
    throw new XmlEncodingError(
      'ENCODING_CONFLICT',
      `Content-Type charset "${cs}" conflicts with XML declaration encoding "${xmlEnc}"`,
    );
  }
  if (cs && !isUtf8Label(cs)) {
    throw new XmlEncodingError(
      'NON_UTF8_CONTENT_TYPE_CHARSET',
      `Content-Type charset "${cs}" is not UTF-8`,
    );
  }
  if (xmlEnc && !isUtf8Label(xmlEnc)) {
    throw new XmlEncodingError(
      'NON_UTF8_XML_DECLARATION',
      `XML declaration encoding "${xmlEnc}" is not UTF-8`,
    );
  }
}
