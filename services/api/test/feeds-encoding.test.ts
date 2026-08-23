import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertUtf8XmlPrefix,
  createSafeFeedFetcher,
  detectXmlBom,
  extractContentTypeCharset,
  extractXmlDeclEncoding,
  loadFeedEnv,
  XML_ENCODING_PREFIX_MAX_BYTES,
  XmlEncodingError,
} from '../src/modules/feeds/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function u8(s: string): Uint8Array {
  return encoder.encode(s);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// Encode an ASCII string as UTF-16 LE / BE (2 bytes per code unit).
function utf16le(s: string, bom = true): Uint8Array {
  const bytes = new Uint8Array(s.length * 2 + (bom ? 2 : 0));
  let o = 0;
  if (bom) {
    bytes[o++] = 0xff;
    bytes[o++] = 0xfe;
  }
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    bytes[o++] = code & 0xff;
    bytes[o++] = (code >> 8) & 0xff;
  }
  return bytes;
}

function utf16be(s: string, bom = true): Uint8Array {
  const bytes = new Uint8Array(s.length * 2 + (bom ? 2 : 0));
  let o = 0;
  if (bom) {
    bytes[o++] = 0xfe;
    bytes[o++] = 0xff;
  }
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    bytes[o++] = (code >> 8) & 0xff;
    bytes[o++] = code & 0xff;
  }
  return bytes;
}

// UTF-8 BOM prefix.
const BOM_UTF8 = new Uint8Array([0xef, 0xbb, 0xbf]);
const BOM_UTF16_LE = new Uint8Array([0xff, 0xfe]);
const BOM_UTF16_BE = new Uint8Array([0xfe, 0xff]);
const BOM_UTF32_LE = new Uint8Array([0xff, 0xfe, 0x00, 0x00]);
const BOM_UTF32_BE = new Uint8Array([0x00, 0x00, 0xfe, 0xff]);

// ---------------------------------------------------------------------------
// Requirement 12: bounded prefix constant is small
// ---------------------------------------------------------------------------

describe('feeds encoding (ADIM 12.2): bounded-prefix guarantee', () => {
  it('XML_ENCODING_PREFIX_MAX_BYTES is small and constant', () => {
    // The whole point is that we NEVER buffer more than a small prefix for
    // encoding detection — a change here that raises this to megabytes would
    // silently break the "does not buffer the whole feed" invariant.
    expect(XML_ENCODING_PREFIX_MAX_BYTES).toBeGreaterThanOrEqual(64);
    expect(XML_ENCODING_PREFIX_MAX_BYTES).toBeLessThanOrEqual(4096);
  });

  it('assertUtf8XmlPrefix returns for a short (< prefix cap) valid UTF-8 body without touching more bytes', () => {
    // Function is pure & synchronous; caller bounds input length.
    const small = u8('<?xml version="1.0" encoding="UTF-8"?><rss/>');
    expect(small.length).toBeLessThan(XML_ENCODING_PREFIX_MAX_BYTES);
    expect(() => assertUtf8XmlPrefix(small, null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Requirement 2, 3, 4, 5: BOM detection
// ---------------------------------------------------------------------------

describe('feeds encoding (ADIM 12.2): detectXmlBom', () => {
  it('req 2: detects UTF-8 BOM', () => {
    expect(detectXmlBom(concat(BOM_UTF8, u8('<rss/>')))).toBe('utf-8');
  });

  it('req 3: detects UTF-16 LE BOM (not confused with UTF-32 LE)', () => {
    expect(detectXmlBom(concat(BOM_UTF16_LE, u8('<')))).toBe('utf-16le');
  });

  it('req 4: detects UTF-16 BE BOM', () => {
    expect(detectXmlBom(concat(BOM_UTF16_BE, u8('<')))).toBe('utf-16be');
  });

  it('req 5a: detects UTF-32 LE BOM (checked BEFORE UTF-16 LE)', () => {
    // First 4 bytes are FF FE 00 00 — must classify as UTF-32 LE, not UTF-16.
    expect(detectXmlBom(concat(BOM_UTF32_LE, u8('X')))).toBe('utf-32le');
  });

  it('req 5b: detects UTF-32 BE BOM', () => {
    expect(detectXmlBom(concat(BOM_UTF32_BE, u8('X')))).toBe('utf-32be');
  });

  it('returns null when no BOM present (plain UTF-8 body)', () => {
    expect(detectXmlBom(u8('<?xml version="1.0"?><rss/>'))).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Requirement 6, 7, 8: XML declaration encoding parsing
// ---------------------------------------------------------------------------

describe('feeds encoding (ADIM 12.2): extractXmlDeclEncoding', () => {
  it('req 6a: extracts encoding="UTF-8" (uppercase)', () => {
    const b = u8('<?xml version="1.0" encoding="UTF-8"?><x/>');
    expect(extractXmlDeclEncoding(b, null)).toBe('utf-8');
  });

  it('req 6b: extracts encoding="utf-8" (lowercase)', () => {
    const b = u8("<?xml version='1.0' encoding='utf-8'?><x/>");
    expect(extractXmlDeclEncoding(b, null)).toBe('utf-8');
  });

  it('req 7: extracts encoding="UTF-16" for rejection', () => {
    const b = u8('<?xml version="1.0" encoding="UTF-16"?><x/>');
    expect(extractXmlDeclEncoding(b, null)).toBe('utf-16');
  });

  it('returns null when no encoding attribute is present', () => {
    const b = u8('<?xml version="1.0"?><x/>');
    expect(extractXmlDeclEncoding(b, null)).toBe(null);
  });

  it('returns null when there is no XML declaration at all', () => {
    const b = u8('<x/>');
    expect(extractXmlDeclEncoding(b, null)).toBe(null);
  });

  it('skips UTF-8 BOM when parsing the declaration', () => {
    const b = concat(BOM_UTF8, u8('<?xml version="1.0" encoding="UTF-8"?><x/>'));
    expect(extractXmlDeclEncoding(b, 'utf-8')).toBe('utf-8');
  });
});

// ---------------------------------------------------------------------------
// Requirement 9: Content-Type charset extraction
// ---------------------------------------------------------------------------

describe('feeds encoding (ADIM 12.2): extractContentTypeCharset', () => {
  it('extracts a bare charset value (lower-cased)', () => {
    expect(extractContentTypeCharset('text/xml; charset=UTF-16')).toBe('utf-16');
  });

  it('extracts a quoted charset value', () => {
    expect(extractContentTypeCharset('application/xml; charset="ISO-8859-1"')).toBe('iso-8859-1');
  });

  it('returns null when no charset parameter', () => {
    expect(extractContentTypeCharset('application/xml')).toBe(null);
  });

  it('returns null on null/empty input', () => {
    expect(extractContentTypeCharset(null)).toBe(null);
    expect(extractContentTypeCharset('')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Requirements 2-10 — full policy on assertUtf8XmlPrefix
// ---------------------------------------------------------------------------

describe('feeds encoding (ADIM 12.2): assertUtf8XmlPrefix policy', () => {
  it('req 1 + 2: accepts a UTF-8 body with UTF-8 BOM', () => {
    const bytes = concat(BOM_UTF8, u8('<?xml version="1.0" encoding="UTF-8"?><rss/>'));
    expect(() => assertUtf8XmlPrefix(bytes, null)).not.toThrow();
  });

  it('req 1: accepts a plain UTF-8 body with no BOM and no declaration', () => {
    expect(() => assertUtf8XmlPrefix(u8('<rss/>'), null)).not.toThrow();
  });

  it('req 3: rejects UTF-16 LE BOM with NON_UTF8_BOM', () => {
    try {
      assertUtf8XmlPrefix(concat(BOM_UTF16_LE, u8('<')), null);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(XmlEncodingError);
      expect((err as XmlEncodingError).subcode).toBe('NON_UTF8_BOM');
    }
  });

  it('req 4: rejects UTF-16 BE BOM with NON_UTF8_BOM', () => {
    try {
      assertUtf8XmlPrefix(concat(BOM_UTF16_BE, u8('<')), null);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as XmlEncodingError).subcode).toBe('NON_UTF8_BOM');
    }
  });

  it('req 5: rejects UTF-32 LE and BE BOMs with NON_UTF8_BOM', () => {
    for (const bom of [BOM_UTF32_LE, BOM_UTF32_BE]) {
      try {
        assertUtf8XmlPrefix(concat(bom, u8('X')), null);
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as XmlEncodingError).subcode).toBe('NON_UTF8_BOM');
      }
    }
  });

  it('req 6: accepts encoding="UTF-8" case-insensitively (also utf-8 / utf8 / UTF_8)', () => {
    for (const enc of ['UTF-8', 'utf-8', 'utf8', 'UTF_8', 'Utf-8']) {
      const b = u8(`<?xml version="1.0" encoding="${enc}"?><rss/>`);
      expect(() => assertUtf8XmlPrefix(b, null)).not.toThrow();
    }
  });

  it('req 7: rejects encoding="UTF-16" with NON_UTF8_XML_DECLARATION', () => {
    const b = u8('<?xml version="1.0" encoding="UTF-16"?><rss/>');
    try {
      assertUtf8XmlPrefix(b, null);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as XmlEncodingError).subcode).toBe('NON_UTF8_XML_DECLARATION');
    }
  });

  it('req 8a: rejects encoding="ISO-8859-1" / "iso-8859-9"', () => {
    for (const enc of ['ISO-8859-1', 'iso-8859-9', 'ISO-8859-15']) {
      const b = u8(`<?xml version="1.0" encoding="${enc}"?><rss/>`);
      try {
        assertUtf8XmlPrefix(b, null);
        expect.fail(`should have thrown for ${enc}`);
      } catch (err) {
        expect((err as XmlEncodingError).subcode).toBe('NON_UTF8_XML_DECLARATION');
      }
    }
  });

  it('req 8b: rejects encoding="Windows-1252" / "windows-1254"', () => {
    for (const enc of ['Windows-1252', 'windows-1254', 'WINDOWS-1250']) {
      const b = u8(`<?xml version="1.0" encoding="${enc}"?><rss/>`);
      try {
        assertUtf8XmlPrefix(b, null);
        expect.fail(`should have thrown for ${enc}`);
      } catch (err) {
        expect((err as XmlEncodingError).subcode).toBe('NON_UTF8_XML_DECLARATION');
      }
    }
  });

  it('req 9: rejects Content-Type charset=utf-16 with NON_UTF8_CONTENT_TYPE_CHARSET', () => {
    try {
      assertUtf8XmlPrefix(u8('<rss/>'), 'utf-16');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as XmlEncodingError).subcode).toBe('NON_UTF8_CONTENT_TYPE_CHARSET');
    }
  });

  it('req 9b: rejects Content-Type charset=iso-8859-1', () => {
    try {
      assertUtf8XmlPrefix(u8('<rss/>'), 'iso-8859-1');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as XmlEncodingError).subcode).toBe('NON_UTF8_CONTENT_TYPE_CHARSET');
    }
  });

  it('req 10: Content-Type charset=utf-8 + XML declaration encoding="iso-8859-1" is rejected as ENCODING_CONFLICT', () => {
    const b = u8('<?xml version="1.0" encoding="ISO-8859-1"?><rss/>');
    try {
      assertUtf8XmlPrefix(b, 'utf-8');
      expect.fail('should have thrown');
    } catch (err) {
      // ENCODING_CONFLICT is preferred when both sources are present and
      // disagree; either code is a strict UTF-8 rejection.
      expect(['ENCODING_CONFLICT', 'NON_UTF8_XML_DECLARATION']).toContain(
        (err as XmlEncodingError).subcode,
      );
    }
  });

  it('req 10b: matching encodings across Content-Type and XML declaration → accepted', () => {
    const b = u8('<?xml version="1.0" encoding="utf-8"?><rss/>');
    expect(() => assertUtf8XmlPrefix(b, 'utf-8')).not.toThrow();
    // Alias equivalence: charset=utf8 and declaration=utf-8 should also pass.
    expect(() => assertUtf8XmlPrefix(b, 'utf8')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fetcher-level integration (requirements 11 and 13)
//
// We spin up a stub HTTP server and hit it with the real fetcher. This
// proves the encoding gate is wired end-to-end and short-circuits BEFORE
// the streaming XML security scanner runs on the malformed bytes.
// ---------------------------------------------------------------------------

describe('feeds encoding (ADIM 12.2): fetcher enforces UTF-8 policy end-to-end', () => {
  let server: Server;
  let baseUrl: string;
  // Per-request response body configured via `stub.next`.
  let nextBody: Uint8Array = new Uint8Array();
  let nextContentType = 'application/xml';

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader('content-type', nextContentType);
      res.statusCode = 200;
      res.end(Buffer.from(nextBody));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function makeFetcher() {
    // Loopback IP + private-address escape hatch for tests only.
    return createSafeFeedFetcher({
      env: loadFeedEnv({
        FEED_FETCH_ALLOW_PRIVATE_ADDRESSES: 'true',
        FEED_FETCH_TIMEOUT_MS: '5000',
      }),
    });
  }

  it('req 11: a UTF-16 LE-encoded <!DOCTYPE …> body is rejected as XML_ENCODING_REJECTED — the security gate never sees it as ASCII', async () => {
    // The whole attack: a legal-looking UTF-16 XML that carries a DOCTYPE.
    // In UTF-8 world "<!DOCTYPE foo>" is ASCII; in UTF-16 the same string
    // is interleaved zero bytes, so the substring scanner (UTF-8 decoder)
    // would decode garbage and MISS the token. The encoding gate must
    // reject before that scan even runs.
    nextBody = utf16le('<?xml version="1.0"?><!DOCTYPE foo SYSTEM "file:///etc/passwd"><foo/>');
    nextContentType = 'application/xml';
    const fetcher = makeFetcher();
    const r = await fetcher.fetch({ url: `${baseUrl}/utf16.xml`, format: 'CUSTOM_XML' });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') {
      expect(r.code).toBe('XML_ENCODING_REJECTED');
      // The subcode fired is NON_UTF8_BOM (LE BOM is at byte 0).
      expect(r.errorMessage).toContain('NON_UTF8_BOM');
    }
  });

  it('req 11b: UTF-16 BE body also rejected before the security scan', async () => {
    nextBody = utf16be('<?xml version="1.0"?><!DOCTYPE foo><foo/>');
    nextContentType = 'application/xml';
    const r = await makeFetcher().fetch({
      url: `${baseUrl}/utf16be.xml`,
      format: 'CUSTOM_XML',
    });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') {
      expect(r.code).toBe('XML_ENCODING_REJECTED');
    }
  });

  it('req 9 end-to-end: Content-Type charset=utf-16 with a benign body → XML_ENCODING_REJECTED', async () => {
    // Body is genuinely UTF-8, but the header lies. Reject on the header.
    nextBody = u8('<?xml version="1.0"?><rss/>');
    nextContentType = 'application/xml; charset=utf-16';
    const r = await makeFetcher().fetch({
      url: `${baseUrl}/lying-header.xml`,
      format: 'CUSTOM_XML',
    });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') {
      expect(r.code).toBe('XML_ENCODING_REJECTED');
      expect(r.errorMessage).toContain('NON_UTF8_CONTENT_TYPE_CHARSET');
    }
  });

  it('req 7 end-to-end: XML declaration encoding="UTF-16" → XML_ENCODING_REJECTED', async () => {
    nextBody = u8('<?xml version="1.0" encoding="UTF-16"?><rss/>');
    nextContentType = 'application/xml';
    const r = await makeFetcher().fetch({
      url: `${baseUrl}/decl16.xml`,
      format: 'CUSTOM_XML',
    });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') {
      expect(r.code).toBe('XML_ENCODING_REJECTED');
      expect(r.errorMessage).toContain('NON_UTF8_XML_DECLARATION');
    }
  });

  it('req 8 end-to-end: XML declaration encoding="ISO-8859-9" → XML_ENCODING_REJECTED', async () => {
    nextBody = u8('<?xml version="1.0" encoding="ISO-8859-9"?><rss/>');
    nextContentType = 'application/xml';
    const r = await makeFetcher().fetch({
      url: `${baseUrl}/iso.xml`,
      format: 'CUSTOM_XML',
    });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') {
      expect(r.code).toBe('XML_ENCODING_REJECTED');
    }
  });

  it('req 13: an accepted UTF-8 body still has its ENTIRE body scanned — a DOCTYPE past the encoding-prefix cap is caught by the XML security scanner', async () => {
    // 4 KiB of harmless padding + a DOCTYPE well past XML_ENCODING_PREFIX_MAX_BYTES.
    // If the fetcher accidentally routed the buffered prefix around the
    // scanner (e.g. forgot to flush it or truncated it), a padding-heavy
    // body with a late DOCTYPE would slip through.
    const padding = 'a'.repeat(XML_ENCODING_PREFIX_MAX_BYTES * 4);
    nextBody = u8(
      `<?xml version="1.0"?><root><pad>${padding}</pad><!DOCTYPE evil><evil/></root>`,
    );
    nextContentType = 'application/xml';
    const r = await makeFetcher().fetch({
      url: `${baseUrl}/deep-doctype.xml`,
      format: 'CUSTOM_XML',
    });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') {
      // NOT XML_ENCODING_REJECTED — the encoding is UTF-8 and legal. The
      // stream-wide security scanner catches the late DOCTYPE.
      expect(r.code).toBe('XML_SECURITY_REJECTED');
    }
  });

  it('req 13b: short UTF-8 body (under the encoding prefix cap) with DOCTYPE — still caught by security scanner after gate flushes prefix', async () => {
    // Below XML_ENCODING_PREFIX_MAX_BYTES; the encoding-gate flush path
    // (short-body branch) must still deliver every byte to the scanner.
    nextBody = u8('<?xml version="1.0"?><!DOCTYPE tiny><tiny/>');
    nextContentType = 'application/xml';
    const r = await makeFetcher().fetch({
      url: `${baseUrl}/tiny-doctype.xml`,
      format: 'CUSTOM_XML',
    });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') {
      expect(r.code).toBe('XML_SECURITY_REJECTED');
    }
  });

  it('req 1 sanity: a plain UTF-8 body with no declaration and no BOM is accepted', async () => {
    nextBody = u8('<rss><channel><title>ok</title></channel></rss>');
    nextContentType = 'application/xml';
    const r = await makeFetcher().fetch({
      url: `${baseUrl}/plain.xml`,
      format: 'CUSTOM_XML',
    });
    expect(r.kind).toBe('success');
  });

  it('req 2 sanity: UTF-8 BOM at the head is accepted', async () => {
    nextBody = concat(BOM_UTF8, u8('<?xml version="1.0" encoding="UTF-8"?><rss/>'));
    nextContentType = 'application/xml; charset=utf-8';
    const r = await makeFetcher().fetch({
      url: `${baseUrl}/bom.xml`,
      format: 'CUSTOM_XML',
    });
    expect(r.kind).toBe('success');
  });
});
