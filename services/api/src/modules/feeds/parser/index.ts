/**
 * Feed parser abstraction — foundation only (ADR-0016 §Parser abstraction).
 *
 * Real domain-object mapping (products, offers) is DELIBERATELY deferred:
 * defining the catalog schema before the catalog sprint would prematurely
 * lock in choices we haven't earned. All parser implementations throw
 * `ParserNotImplementedError` for the mapping surface; only the security
 * preflight (`validateStream`) does real work here.
 */

import type { FeedFormat } from '../repository.js';

import { scanXmlSecurity, XmlSecurityError } from './xml-security.js';
export {
  assertUtf8XmlPrefix,
  detectXmlBom,
  extractContentTypeCharset,
  extractXmlDeclEncoding,
  XML_ENCODING_PREFIX_MAX_BYTES,
  XmlEncodingError,
  type BomKind,
  type XmlEncodingCode,
} from './xml-encoding.js';

export type ParserErrorCode =
  | 'PARSER_NOT_IMPLEMENTED'
  | 'UNSUPPORTED_FEED_FORMAT'
  | 'XML_SECURITY_REJECTED';

export class ParserNotImplementedError extends Error {
  readonly code = 'PARSER_NOT_IMPLEMENTED' as const;
  constructor(public readonly format: FeedFormat) {
    super(`parser for ${format} produces no domain objects yet (ADIM 12)`);
    this.name = 'ParserNotImplementedError';
  }
}

export class UnsupportedFeedFormatError extends Error {
  readonly code = 'UNSUPPORTED_FEED_FORMAT' as const;
  constructor(public readonly format: string) {
    super(`no parser registered for format "${format}"`);
    this.name = 'UnsupportedFeedFormatError';
  }
}

export { XmlSecurityError };

export interface FeedValidationResult {
  readonly format: FeedFormat;
  readonly bytesScanned: number;
}

export interface FeedParser {
  readonly format: FeedFormat;
  /** True iff this parser handles the given format. */
  supports(format: FeedFormat): boolean;
  /**
   * Fast preflight validation on the decoded head of a feed. XML parsers do
   * the DOCTYPE / ENTITY scan here; the CSV parser is a no-op preflight.
   * Throws on rejection (see XmlSecurityError). Never touches domain data.
   */
  validate(text: string): FeedValidationResult;
  /**
   * Parse the full decoded content into domain objects. Deliberately not
   * implemented in this sprint — throws `ParserNotImplementedError` so any
   * accidental call from live code fails loudly.
   */
  parse(text: string): never;
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

class XmlParserBase implements FeedParser {
  constructor(public readonly format: FeedFormat) {}
  supports(format: FeedFormat): boolean {
    return format === this.format;
  }
  validate(text: string): FeedValidationResult {
    scanXmlSecurity(text);
    return { format: this.format, bytesScanned: text.length };
  }
  parse(_text: string): never {
    throw new ParserNotImplementedError(this.format);
  }
}

class CsvFeedParser implements FeedParser {
  readonly format: FeedFormat = 'CSV';
  supports(format: FeedFormat): boolean {
    return format === 'CSV';
  }
  validate(text: string): FeedValidationResult {
    // CSV has no XXE/DTD concept; a well-formed feed check is a parser-time
    // concern that lives with the future domain-mapping implementation.
    return { format: 'CSV', bytesScanned: text.length };
  }
  parse(_text: string): never {
    throw new ParserNotImplementedError('CSV');
  }
}

export const GoogleMerchantXmlParser: FeedParser = new XmlParserBase('GOOGLE_MERCHANT_XML');
export const CustomXmlParser: FeedParser = new XmlParserBase('CUSTOM_XML');
export const CsvParser: FeedParser = new CsvFeedParser();

const ALL_PARSERS: readonly FeedParser[] = [GoogleMerchantXmlParser, CustomXmlParser, CsvParser];

export function parserFor(format: FeedFormat): FeedParser {
  const p = ALL_PARSERS.find((x) => x.supports(format));
  if (!p) throw new UnsupportedFeedFormatError(format);
  return p;
}
