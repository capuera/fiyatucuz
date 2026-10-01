/**
 * Feed parser registry (ADR-0016 §Parser abstraction, ADR-0018 §Streaming
 * parse).
 *
 * Each parser offers a security preflight (`validate`) and a STREAMING item
 * extractor factory (`createItemExtractor`). There is deliberately no
 * whole-document `parse(text)` — feeds are never materialized in memory.
 *
 * XML formats (GOOGLE_MERCHANT_XML, CUSTOM_XML) produce raw items via the
 * saxes-based {@link XmlItemExtractor}; the mapping decides which elements
 * become offer fields. CSV import is deferred (ADIM 15) and still throws
 * `ParserNotImplementedError`.
 */

import type { FeedItemMapping } from '../import/mapping.js';
import { XmlItemExtractor, type RawFeedItem, type XmlItemLimits } from '../import/xml-items.js';
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
    super(`import for ${format} is not implemented yet`);
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
   * Streaming extractor: feed decoded text chunks, receive one raw item per
   * mapped item element. Throws `ParserNotImplementedError` for formats whose
   * import is not implemented (CSV).
   */
  createItemExtractor(
    mapping: FeedItemMapping,
    limits: XmlItemLimits,
    onItem: (item: RawFeedItem) => void,
  ): XmlItemExtractor;
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
  createItemExtractor(
    mapping: FeedItemMapping,
    limits: XmlItemLimits,
    onItem: (item: RawFeedItem) => void,
  ): XmlItemExtractor {
    return new XmlItemExtractor(mapping, limits, onItem);
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
  createItemExtractor(): never {
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
