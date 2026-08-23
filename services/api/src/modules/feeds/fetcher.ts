import { createHash } from 'node:crypto';
import type { LookupFunction } from 'node:net';

import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

import type { FeedEnv } from './env.js';
import {
  assertUtf8XmlPrefix,
  extractContentTypeCharset,
  XML_ENCODING_PREFIX_MAX_BYTES,
  XmlEncodingError,
} from './parser/xml-encoding.js';
import { StreamingXmlSecurityScanner, XmlSecurityError } from './parser/xml-security.js';
import type { FeedFormat } from './repository.js';
import { SafeUrlError, validateSafeUrl, type SafeUrlValidatorOptions } from './ssrf.js';

// ---------------------------------------------------------------------------
// Errors (bounded, wire-safe codes — ADR-0016 §Error model)
// ---------------------------------------------------------------------------

export type FetchErrorCode =
  | 'INVALID_URL'
  | 'SSRF_REJECTED'
  | 'DNS_FAILURE'
  | 'CONNECT_TIMEOUT'
  | 'READ_TIMEOUT'
  | 'TOO_MANY_REDIRECTS'
  | 'CONTENT_TOO_LARGE'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'HTTP_ERROR'
  | 'XML_ENCODING_REJECTED'
  | 'XML_SECURITY_REJECTED'
  | 'FETCH_FAILED';

export class FetchError extends Error {
  constructor(
    public readonly code: FetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FetchInput {
  readonly url: string;
  readonly format: FeedFormat;
  /** From feeds table — sent as conditional headers if present. */
  readonly etag?: string | null;
  readonly lastModified?: string | null;
}

export interface FetchSuccessResult {
  readonly kind: 'success';
  readonly httpStatus: number;
  readonly byteCount: number;
  readonly contentType: string | null;
  readonly contentHash: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface FetchNotModifiedResult {
  readonly kind: 'not_modified';
  readonly httpStatus: 304;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface FetchFailureResult {
  readonly kind: 'failure';
  readonly code: FetchErrorCode;
  readonly errorMessage: string;
  readonly httpStatus?: number;
}

export interface FetchRejectedResult {
  readonly kind: 'rejected';
  readonly code: FetchErrorCode;
  readonly errorMessage: string;
}

export type FetchResult =
  | FetchSuccessResult
  | FetchNotModifiedResult
  | FetchFailureResult
  | FetchRejectedResult;

// ---------------------------------------------------------------------------
// Content-type detection — used to steer parser selection.
// ---------------------------------------------------------------------------

const XML_MIME_RE = /(text|application)\/(xml|.*\+xml)/i;
const CSV_MIME_RE = /(text|application)\/csv/i;
// Text-ish that we treat as XML/CSV when the URL format hints agree.
const TEXT_MIME_RE = /^text\//i;

function contentTypeOk(format: FeedFormat, contentType: string | null): boolean {
  if (!contentType) return true; // some servers omit; do not fail on that alone
  const ct = contentType.toLowerCase();
  if (format === 'CSV') return CSV_MIME_RE.test(ct) || TEXT_MIME_RE.test(ct);
  return XML_MIME_RE.test(ct) || TEXT_MIME_RE.test(ct);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SafeFeedFetcherOptions {
  readonly env: FeedEnv;
  /** Injectable DNS lookup for tests. */
  readonly lookup?: SafeUrlValidatorOptions['lookup'];
}

export interface SafeFeedFetcher {
  fetch(input: FetchInput): Promise<FetchResult>;
}

/**
 * Build a per-request Undici `Agent` whose connector always resolves the
 * hostname to a caller-supplied IP (ADIM 12.1 §DNS pinning). Node's TLS
 * layer still receives the original hostname via SNI + servername, so
 * HTTPS certificate verification runs against the domain name; only the
 * TCP-level connect is pinned.
 *
 * Why this closes the DNS-rebinding TOCTOU:
 *   1. validateSafeUrl resolves the hostname and rejects if ANY resolved
 *      IP is in a blocked range.
 *   2. This Agent's `lookup` is called by Undici with the same hostname,
 *      but returns the exact IP we validated — never the OS resolver.
 *   3. So the socket-level connect goes to the validated IP, regardless
 *      of what a malicious authoritative DNS might return between our
 *      validation and the connect.
 *
 * TLS SNI: Undici passes `hostname` (not the resolved IP) to `tls.connect`
 * via the `servername` option; that value drives SNI and the CN/SAN check.
 */
function createPinnedAgent(ip: string, family: 4 | 6): Dispatcher {
  // Undici's connect.lookup is a Node-style DNS lookup. Handle both the
  // one-address and all-addresses variants — recent undici versions may
  // request `all: true` for happy-eyeballs style connect ordering.
  const lookup = (
    _hostname: string,
    options: { all?: boolean } | undefined,
    callback: (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void,
  ): void => {
    if (options && options.all) {
      callback(null, [{ address: ip, family }]);
      return;
    }
    callback(null, ip, family);
  };
  return new Agent({
    // Explicit cast — the LookupFunction type from `node:net` fixes the
    // single-address callback shape and can't express the all/one union
    // cleanly. Runtime behavior handles both.
    connect: { lookup: lookup as unknown as LookupFunction },
  });
}

export function createSafeFeedFetcher(opts: SafeFeedFetcherOptions): SafeFeedFetcher {
  const { env } = opts;
  const lookup = opts.lookup;

  return {
    async fetch(input: FetchInput): Promise<FetchResult> {
      const headers: Record<string, string> = {
        'user-agent': env.FEED_FETCH_USER_AGENT,
        accept: input.format === 'CSV'
          ? 'text/csv, text/*;q=0.5, */*;q=0.1'
          : 'application/xml, text/xml, text/*;q=0.5, */*;q=0.1',
        'accept-encoding': 'gzip',
      };
      if (input.etag) headers['if-none-match'] = input.etag;
      if (input.lastModified) headers['if-modified-since'] = input.lastModified;

      let currentUrl = input.url;
      let hops = 0;
      // Track the currently-active pinned agent so the redirect branch can
      // close the previous one and open a fresh one for the new hop.
      let activeAgent: Dispatcher | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let response: any = null;
      let contentTypeHeader: string | null = null;
      let etagHeader: string | null = null;
      let lastModifiedHeader: string | null = null;
      let httpStatus = 0;

      async function closeActiveAgent(): Promise<void> {
        if (activeAgent) {
          try {
            await activeAgent.close();
          } catch {
            /* ignore */
          }
          activeAgent = null;
        }
      }

      // Redirect loop with per-hop SSRF validation + per-hop pinned Agent.
      while (true) {
        let validated;
        try {
          validated = await validateSafeUrl(currentUrl, {
            ...(env.FEED_FETCH_ALLOW_PRIVATE_ADDRESSES
              ? { allowPrivateAddresses: true as const }
              : {}),
            ...(lookup ? { lookup } : {}),
          });
        } catch (err) {
          await closeActiveAgent();
          if (err instanceof SafeUrlError) {
            return { kind: 'rejected', code: err.code, errorMessage: err.message };
          }
          return { kind: 'rejected', code: 'FETCH_FAILED', errorMessage: 'url-validation failed' };
        }

        const pinAddress = validated.resolvedAddresses[0];
        if (!pinAddress) {
          await closeActiveAgent();
          return { kind: 'rejected', code: 'DNS_FAILURE', errorMessage: 'no address to pin' };
        }

        // Fresh Agent per hop — old one gets closed if this is a redirect.
        await closeActiveAgent();
        activeAgent = createPinnedAgent(pinAddress.address, pinAddress.family);

        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), env.FEED_FETCH_TIMEOUT_MS);
        try {
          response = await undiciFetch(currentUrl, {
            method: 'GET',
            headers,
            redirect: 'manual',
            signal: ac.signal,
            dispatcher: activeAgent,
          });
        } catch (err) {
          clearTimeout(t);
          await closeActiveAgent();
          const msg = err instanceof Error ? err.message : String(err);
          if (err instanceof Error && err.name === 'AbortError') {
            return { kind: 'failure', code: 'CONNECT_TIMEOUT', errorMessage: 'fetch aborted (timeout)' };
          }
          return { kind: 'failure', code: 'FETCH_FAILED', errorMessage: msg };
        }
        clearTimeout(t);

        httpStatus = response.status;

        // 304 Not Modified is NOT a redirect. Short-circuit.
        if (httpStatus === 304) {
          etagHeader = response.headers.get('etag') ?? null;
          lastModifiedHeader = response.headers.get('last-modified') ?? null;
          try {
            await response.body?.cancel();
          } catch {
            /* ignore */
          }
          await closeActiveAgent();
          return {
            kind: 'not_modified',
            httpStatus: 304,
            etag: etagHeader,
            lastModified: lastModifiedHeader,
          };
        }

        // 3xx redirect: get Location, re-enter loop with fresh validation
        // + fresh pinned agent.
        if (httpStatus >= 300 && httpStatus < 400) {
          const loc = response.headers.get('location');
          if (!loc) {
            await closeActiveAgent();
            return {
              kind: 'failure',
              code: 'HTTP_ERROR',
              errorMessage: `redirect ${httpStatus} with no Location header`,
              httpStatus,
            };
          }
          hops += 1;
          if (hops > env.FEED_FETCH_MAX_REDIRECTS) {
            await closeActiveAgent();
            return {
              kind: 'failure',
              code: 'TOO_MANY_REDIRECTS',
              errorMessage: `exceeded max redirects (${env.FEED_FETCH_MAX_REDIRECTS})`,
            };
          }
          try {
            currentUrl = new URL(loc, currentUrl).toString();
          } catch {
            await closeActiveAgent();
            return { kind: 'failure', code: 'INVALID_URL', errorMessage: 'invalid Location header' };
          }
          try {
            await response.body?.cancel();
          } catch {
            /* ignore */
          }
          continue;
        }

        // Not a redirect / not 304 → terminal-for-loop response.
        break;
      }

      // At this point `response` is the terminal (non-redirect, non-304)
      // response and `activeAgent` owns the underlying socket pool.
      contentTypeHeader = response.headers.get('content-type') ?? null;
      etagHeader = response.headers.get('etag') ?? null;
      lastModifiedHeader = response.headers.get('last-modified') ?? null;

      if (httpStatus < 200 || httpStatus >= 300) {
        try {
          await response.body?.cancel();
        } catch {
          /* ignore */
        }
        await closeActiveAgent();
        return {
          kind: 'failure',
          code: 'HTTP_ERROR',
          errorMessage: `upstream returned HTTP ${httpStatus}`,
          httpStatus,
        };
      }

      if (!contentTypeOk(input.format, contentTypeHeader)) {
        try {
          await response.body?.cancel();
        } catch {
          /* ignore */
        }
        await closeActiveAgent();
        return {
          kind: 'rejected',
          code: 'UNSUPPORTED_CONTENT_TYPE',
          errorMessage: `content-type "${contentTypeHeader ?? '(none)'}" is not accepted for format ${input.format}`,
        };
      }

      // Streaming download — hash + byte-cap + STREAM-WIDE XML security
      // scan (ADIM 12.1 §Streaming XML scanner) + UTF-8 encoding gate (ADIM
      // 12.2 §XML encoding). Nothing is buffered beyond the encoding prefix
      // (≤ XML_ENCODING_PREFIX_MAX_BYTES ≈ 1 KiB) + one chunk + the scanner's
      // ~40-byte overlap window.
      const hasher = createHash('sha256');
      let total = 0;
      const isXml = input.format !== 'CSV';
      const scanner = isXml ? new StreamingXmlSecurityScanner() : null;
      const contentTypeCharset = isXml ? extractContentTypeCharset(contentTypeHeader) : null;
      // Encoding gate state (XML only). We accumulate the first prefix bytes
      // BEFORE letting them reach the scanner — the scanner decodes as UTF-8
      // and would otherwise silently mis-scan a UTF-16 body. Once the gate
      // has decided (or the stream ends), the buffered prefix is flushed to
      // the scanner in one call.
      let encodingChecked = !isXml;
      const encodingBuffer: Uint8Array[] = [];
      let encodingBufferLen = 0;

      function flushEncodingBufferToScanner(): Uint8Array {
        // Concatenate accumulated prefix chunks and clear the buffer. Cheap
        // — the buffer is bounded to XML_ENCODING_PREFIX_MAX_BYTES.
        const combined = new Uint8Array(encodingBufferLen);
        let offset = 0;
        for (const c of encodingBuffer) {
          combined.set(c, offset);
          offset += c.length;
        }
        encodingBuffer.length = 0;
        encodingBufferLen = 0;
        return combined;
      }

      const body = response.body;
      if (!body) {
        await closeActiveAgent();
        return {
          kind: 'failure',
          code: 'FETCH_FAILED',
          errorMessage: 'response has no body stream',
          httpStatus,
        };
      }
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = value ?? new Uint8Array();
          total += chunk.length;
          if (total > env.FEED_FETCH_MAX_BYTES) {
            try {
              await reader.cancel();
            } catch {
              /* ignore */
            }
            await closeActiveAgent();
            return {
              kind: 'failure',
              code: 'CONTENT_TOO_LARGE',
              errorMessage: `body exceeded ${env.FEED_FETCH_MAX_BYTES} bytes`,
              httpStatus,
            };
          }
          hasher.update(chunk);

          if (isXml && !encodingChecked) {
            // Accumulate up to the prefix cap. Once we cross the threshold,
            // run the encoding assertion and hand the buffered prefix to
            // the security scanner as a single update.
            encodingBuffer.push(chunk);
            encodingBufferLen += chunk.length;
            if (encodingBufferLen >= XML_ENCODING_PREFIX_MAX_BYTES) {
              const prefix = flushEncodingBufferToScanner();
              try {
                assertUtf8XmlPrefix(prefix, contentTypeCharset);
              } catch (err) {
                try {
                  await reader.cancel();
                } catch {
                  /* ignore */
                }
                await closeActiveAgent();
                if (err instanceof XmlEncodingError) {
                  return {
                    kind: 'rejected',
                    code: 'XML_ENCODING_REJECTED',
                    errorMessage: `${err.subcode}: ${err.message}`,
                  };
                }
                throw err;
              }
              encodingChecked = true;
              // Flush the buffered prefix into the security scanner so it
              // sees the full stream (requirement: scanner still scans the
              // entire accepted UTF-8 stream).
              try {
                scanner!.update(prefix);
              } catch (err) {
                try {
                  await reader.cancel();
                } catch {
                  /* ignore */
                }
                await closeActiveAgent();
                if (err instanceof XmlSecurityError) {
                  return {
                    kind: 'rejected',
                    code: 'XML_SECURITY_REJECTED',
                    errorMessage: `${err.subcode}: ${err.message}`,
                  };
                }
                throw err;
              }
            }
            // else: still accumulating; do not feed the scanner yet.
            continue;
          }

          if (scanner) {
            try {
              scanner.update(chunk);
            } catch (err) {
              try {
                await reader.cancel();
              } catch {
                /* ignore */
              }
              await closeActiveAgent();
              if (err instanceof XmlSecurityError) {
                return {
                  kind: 'rejected',
                  code: 'XML_SECURITY_REJECTED',
                  errorMessage: `${err.subcode}: ${err.message}`,
                };
              }
              throw err;
            }
          }
        }
      } catch (err) {
        await closeActiveAgent();
        const msg = err instanceof Error ? err.message : String(err);
        return {
          kind: 'failure',
          code: 'READ_TIMEOUT',
          errorMessage: msg,
          httpStatus,
        };
      }

      // Short-body case: fewer than XML_ENCODING_PREFIX_MAX_BYTES bytes
      // arrived — still need to run the encoding gate on whatever we have.
      if (isXml && !encodingChecked) {
        const prefix = flushEncodingBufferToScanner();
        try {
          assertUtf8XmlPrefix(prefix, contentTypeCharset);
        } catch (err) {
          await closeActiveAgent();
          if (err instanceof XmlEncodingError) {
            return {
              kind: 'rejected',
              code: 'XML_ENCODING_REJECTED',
              errorMessage: `${err.subcode}: ${err.message}`,
            };
          }
          throw err;
        }
        try {
          scanner!.update(prefix);
        } catch (err) {
          await closeActiveAgent();
          if (err instanceof XmlSecurityError) {
            return {
              kind: 'rejected',
              code: 'XML_SECURITY_REJECTED',
              errorMessage: `${err.subcode}: ${err.message}`,
            };
          }
          throw err;
        }
      }
      scanner?.end();
      await closeActiveAgent();

      return {
        kind: 'success',
        httpStatus,
        byteCount: total,
        contentType: contentTypeHeader,
        contentHash: hasher.digest('hex'),
        etag: etagHeader,
        lastModified: lastModifiedHeader,
      };
    },
  };
}
