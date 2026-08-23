// Public surface of the feeds module.
//
// Per ADR-0003 (modular monolith), other modules import ONLY from this
// barrel — never from routes.ts, service.ts, repository.ts, fetcher.ts,
// ssrf.ts, parser/*.

export {
  loadFeedEnv,
  assertProductionFeedFetchSafety,
  InsecureProductionFeedFetchError,
  type FeedEnv,
} from './env.js';

export {
  createFeedService,
  FEED_FETCH_JOB,
  FeedNotFoundError,
  FeedFetchNotFoundError,
  InvalidFeedUrlError,
  type FeedService,
  type FeedServiceDeps,
  type FeedFetchJobPayload,
  type EnqueueFetchResult,
} from './service.js';

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
