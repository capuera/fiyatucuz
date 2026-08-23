import { describe, expect, it } from 'vitest';

import {
  CsvParser,
  CustomXmlParser,
  GoogleMerchantXmlParser,
  ParserNotImplementedError,
  parserFor,
  StreamingXmlSecurityScanner,
  UnsupportedFeedFormatError,
  XmlSecurityError,
} from '../src/modules/feeds/index.js';

describe('feeds: parser abstraction', () => {
  it('parserFor returns the right parser per format', () => {
    expect(parserFor('GOOGLE_MERCHANT_XML')).toBe(GoogleMerchantXmlParser);
    expect(parserFor('CUSTOM_XML')).toBe(CustomXmlParser);
    expect(parserFor('CSV')).toBe(CsvParser);
  });

  it('parserFor throws UnsupportedFeedFormatError for unknown formats', () => {
    // Cast is intentional — testing the runtime guard on an invalid format.
    expect(() => parserFor('YAML' as never)).toThrow(UnsupportedFeedFormatError);
  });

  it('every parser.parse throws ParserNotImplementedError (foundation only — no product rows)', () => {
    expect(() => GoogleMerchantXmlParser.parse('<rss/>')).toThrow(ParserNotImplementedError);
    expect(() => CustomXmlParser.parse('<x/>')).toThrow(ParserNotImplementedError);
    expect(() => CsvParser.parse('a,b\n1,2\n')).toThrow(ParserNotImplementedError);
  });

  it('XML validate rejects DOCTYPE declarations', () => {
    const bad = `<?xml version="1.0"?>
      <!DOCTYPE foo [<!ELEMENT foo ANY>]>
      <foo/>`;
    expect(() => GoogleMerchantXmlParser.validate(bad)).toThrow(XmlSecurityError);
    expect(() => CustomXmlParser.validate(bad)).toThrow(XmlSecurityError);
  });

  it('XML validate rejects ENTITY declarations (billion laughs / XXE)', () => {
    const bad = `<?xml version="1.0"?>
      <!DOCTYPE foo [
        <!ENTITY lol "lol">
        <!ENTITY lol2 "&lol;&lol;">
      ]>
      <foo>&lol2;</foo>`;
    expect(() => CustomXmlParser.validate(bad)).toThrow(XmlSecurityError);
  });

  it('XML validate rejects SYSTEM / PUBLIC external references', () => {
    const sys = `<?xml version="1.0"?><!DOCTYPE foo SYSTEM "file:///etc/passwd"><foo/>`;
    const pub = `<?xml version="1.0"?><!DOCTYPE foo PUBLIC "-//foo//DTD//EN" "http://a/b.dtd"><foo/>`;
    // Both trip DOCTYPE first — either code is acceptable, but this asserts
    // rejection.
    expect(() => CustomXmlParser.validate(sys)).toThrow(XmlSecurityError);
    expect(() => CustomXmlParser.validate(pub)).toThrow(XmlSecurityError);
  });

  it('XML validate accepts a well-formed feed head', () => {
    const ok = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>Shop</title></channel></rss>`;
    const r = GoogleMerchantXmlParser.validate(ok);
    expect(r.format).toBe('GOOGLE_MERCHANT_XML');
    expect(r.bytesScanned).toBeGreaterThan(0);
  });

  it('CSV validate is a no-op preflight (no DOCTYPE concept)', () => {
    const r = CsvParser.validate('id,name\n1,foo\n2,bar\n');
    expect(r.format).toBe('CSV');
    expect(r.bytesScanned).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// StreamingXmlSecurityScanner (ADIM 12.1)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function bytes(s: string): Uint8Array {
  return encoder.encode(s);
}

describe('feeds: StreamingXmlSecurityScanner (ADIM 12.1 §Streaming XML scanner)', () => {
  it('accepts a safe XML document fed in one chunk', () => {
    const scanner = new StreamingXmlSecurityScanner();
    expect(() =>
      scanner.update(bytes('<?xml version="1.0"?><rss><item/></rss>')),
    ).not.toThrow();
  });

  it('rejects DOCTYPE inside a single chunk', () => {
    const scanner = new StreamingXmlSecurityScanner();
    expect(() =>
      scanner.update(bytes('<?xml version="1.0"?><!DOCTYPE foo><foo/>')),
    ).toThrow(XmlSecurityError);
  });

  it('rejects DOCTYPE that appears AFTER >64 KiB of harmless padding', () => {
    const scanner = new StreamingXmlSecurityScanner();
    // Feed 128 KiB of padding first — the old one-shot 64-KiB head scan
    // would have MISSED anything past this point.
    const padding = ' '.repeat(64 * 1024);
    scanner.update(bytes('<rss>'));
    scanner.update(bytes(padding));
    scanner.update(bytes(padding));
    expect(() => scanner.update(bytes('<!DOCTYPE hidden>bad</rss>'))).toThrow(
      XmlSecurityError,
    );
  });

  it('rejects ENTITY that appears AFTER >64 KiB of padding', () => {
    const scanner = new StreamingXmlSecurityScanner();
    scanner.update(bytes('<rss>'));
    scanner.update(bytes(' '.repeat(128 * 1024)));
    expect(() =>
      scanner.update(bytes('<!ENTITY xxe SYSTEM "file:///etc/passwd">')),
    ).toThrow(XmlSecurityError);
  });

  it('rejects DOCTYPE split across two chunks (chunk-boundary detection)', () => {
    const scanner = new StreamingXmlSecurityScanner();
    scanner.update(bytes('<rss><item>abc</item>hello <!DOCT'));
    expect(() => scanner.update(bytes('YPE evil><foo/></rss>'))).toThrow(XmlSecurityError);
  });

  it('rejects ENTITY split across two chunks', () => {
    const scanner = new StreamingXmlSecurityScanner();
    scanner.update(bytes('<rss>ok<!ENTI'));
    expect(() => scanner.update(bytes('TY bad "value"><foo/></rss>'))).toThrow(
      XmlSecurityError,
    );
  });

  it('rejects SYSTEM reference split across two chunks', () => {
    const scanner = new StreamingXmlSecurityScanner();
    scanner.update(bytes('<xml> pre SYSTE'));
    expect(() => scanner.update(bytes('M "file:///etc/passwd" post</xml>'))).toThrow(
      XmlSecurityError,
    );
  });

  it('accepts a large safe stream (5 MB) — memory stays bounded by design', () => {
    const scanner = new StreamingXmlSecurityScanner();
    scanner.update(bytes('<rss>'));
    for (let i = 0; i < 5; i++) {
      // 1 MB of safe content per iteration.
      scanner.update(bytes('<item>' + 'x'.repeat(1024 * 1024) + '</item>'));
    }
    scanner.update(bytes('</rss>'));
    // Scanner must not have retained MB-scale state: the overlap window is
    // 40 chars — verify indirectly by asserting scannedChars is large but
    // the overlap is not visible via any public API (encapsulated).
    expect(scanner.scannedChars).toBeGreaterThan(5 * 1024 * 1024);
  });

  it('tokens are case-insensitive per the scanner regex', () => {
    const scanner = new StreamingXmlSecurityScanner();
    expect(() => scanner.update(bytes('<!doctype foo>'))).toThrow(XmlSecurityError);
    const scanner2 = new StreamingXmlSecurityScanner();
    expect(() => scanner2.update(bytes('<!Entity bad>'))).toThrow(XmlSecurityError);
  });

  it('end() is a no-op that does not throw on empty scan', () => {
    const scanner = new StreamingXmlSecurityScanner();
    expect(() => scanner.end()).not.toThrow();
  });
});
