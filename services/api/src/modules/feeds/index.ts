// Public surface of the feeds module.
//
// Per ADR-0003 (modular monolith), other modules import ONLY from this
// barrel — never from routes.ts, service.ts, repository.ts, fetcher.ts,
// ssrf.ts, parser/*.

export {
  loadFeedEnv,
  assertProductionFeedFetchSafety,
  assertProductionFeedArchiveSafety,
  InsecureProductionFeedFetchError,
  InsecureProductionFeedArchiveError,
  type FeedEnv,
} from './env.js';

export {
  createFeedArchive,
  resolveLocalArchiveRoot,
  LocalFilesystemFeedArchive,
  buildArchiveRef,
  parseArchiveRef,
  extForFormat,
  FEED_ARCHIVE_SCHEME,
  FeedArchiveError,
  type FeedArchive,
  type FeedArchiveExt,
  type FeedArchiveErrorCode,
  type FeedArchiveKey,
  type FeedArchiveRef,
  type FeedArchiveWriter,
  type ParsedArchiveRef,
} from './archive/index.js';

export {
  createFeedService,
  FEED_FETCH_JOB,
  FEED_IMPORT_JOB,
  FeedImportNotFoundError,
  FeedNotFoundError,
  FeedFetchNotFoundError,
  InvalidFeedUrlError,
  type FeedService,
  type FeedServiceDeps,
  type FeedFetchJobPayload,
  type FeedImportJobPayload,
  type EnqueueFetchResult,
} from './service.js';

// -- Import / normalization (ADR-0018) ---------------------------------------

export {
  FeedItemMappingSchema,
  GOOGLE_MERCHANT_PRESET,
  resolveFeedMapping,
  mappingPaths,
  type FeedItemMapping,
  type FeedItemMappingInput,
  type MappedField,
  type OfferAvailability,
  type DecimalSeparator,
} from './import/mapping.js';
export {
  XmlItemExtractor,
  XmlDocumentError,
  type RawFeedItem,
  type XmlItemLimits,
} from './import/xml-items.js';
export {
  normalizeFeedItem,
  contentHashOf,
  OFFER_FIELD_LIMITS,
  type NormalizedOffer,
  type NormalizeResult,
  type ItemIssue,
} from './import/normalize/offer.js';
export {
  parsePrice,
  parseAmountMinor,
  splitPrice,
  resolveCurrency,
  SUPPORTED_CURRENCIES,
} from './import/normalize/money.js';
export { normalizeGtin } from './import/normalize/identifiers.js';
export { normalizeProductUrl, normalizeImageUrl } from './import/normalize/url.js';
export { normalizeText, truncateCodePoints, codePointLength } from './import/normalize/text.js';
export {
  normalizeAvailability,
  normalizeStock,
  normalizeVatRateBp,
  normalizeBoolean,
} from './import/normalize/attributes.js';
export {
  assertArchiveRefMatches,
  verifyArchiveIntegrity,
  streamVerifiedXmlText,
  type ExpectedArchive,
} from './import/verified-archive.js';
export { ImportError, ImportLeaseLostError, type ImportErrorCode } from './import/errors.js';
export {
  createFeedImporter,
  type FeedImporter,
  type FeedImporterDeps,
} from './import/importer.js';
export type {
  FeedImportRow,
  FeedImportStatus,
  ImportCounters,
  ImportErrorSample,
} from './import/repository.js';
export * as feedImportsRepository from './import/repository.js';

export {
  createSafeFeedFetcher,
  FetchError,
  type SafeFeedFetcher,
  type SafeFeedFetcherOptions,
  type FetchInput,
  type FetchResult,
  type FetchSuccessResult,
  type FetchNotModifiedResult,
  type FetchFailureResult,
  type FetchRejectedResult,
  type FetchErrorCode,
} from './fetcher.js';

export {
  validateSafeUrl,
  validateSyntactic,
  isPrivateIP,
  SafeUrlError,
  type SafeUrl,
  type SafeUrlValidatorOptions,
  type SsrfErrorCode,
} from './ssrf.js';

export {
  parserFor,
  GoogleMerchantXmlParser,
  CustomXmlParser,
  CsvParser,
  ParserNotImplementedError,
  UnsupportedFeedFormatError,
  XmlSecurityError,
  type FeedParser,
  type FeedValidationResult,
} from './parser/index.js';

export { StreamingXmlSecurityScanner } from './parser/xml-security.js';

export {
  assertUtf8XmlPrefix,
  detectXmlBom,
  extractContentTypeCharset,
  extractXmlDeclEncoding,
  XML_ENCODING_PREFIX_MAX_BYTES,
  XmlEncodingError,
  type BomKind,
  type XmlEncodingCode,
} from './parser/xml-encoding.js';

export {
  CreateFeedBodySchema,
  UpdateFeedBodySchema,
  type CreateFeedInput,
  type UpdateFeedInput,
} from './validation.js';

export type {
  FeedRow,
  FeedInsert,
  FeedFormat,
  FeedStatus,
  FeedFetchRow,
  FeedFetchInsert,
  FeedFetchStatus,
} from './repository.js';

export { registerFeedRoutes, type FeedRoutesOptions } from './routes.js';

export * as feedsRepository from './repository.js';
