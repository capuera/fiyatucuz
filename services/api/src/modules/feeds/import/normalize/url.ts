/**
 * URL policies (ADR-0018 §URL policy). Two distinct policies:
 *
 *   product URL — http(s), no credentials, ≤ 2048 chars, AND the host must be
 *                 the merchant site's normalized domain or a subdomain of it
 *                 (traffic destinations must belong to the Merchant Website).
 *   image URL   — http(s), no credentials, ≤ 2048 chars; ANY host (CDNs).
 *
 * Neither URL is ever fetched by the import pipeline, so no SSRF surface is
 * added here. `javascript:`, `data:`, `file:` etc. fail the scheme check.
 */

export const MAX_URL_CHARS = 2048;

export type UrlErrorCode =
  | 'URL_INVALID'
  | 'URL_TOO_LONG'
  | 'URL_SCHEME_NOT_ALLOWED'
  | 'URL_CREDENTIALS_NOT_ALLOWED'
  | 'URL_DOMAIN_MISMATCH';

export type UrlResult =
  | { readonly ok: true; readonly href: string }
  | { readonly ok: false; readonly code: UrlErrorCode };

function parseHttpUrl(raw: string): { ok: true; url: URL } | { ok: false; code: UrlErrorCode } {
  if (raw.length > MAX_URL_CHARS) return { ok: false, code: 'URL_TOO_LONG' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: 'URL_INVALID' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: 'URL_SCHEME_NOT_ALLOWED' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, code: 'URL_CREDENTIALS_NOT_ALLOWED' };
  }
  if (url.hostname === '') return { ok: false, code: 'URL_INVALID' };
  if (url.href.length > MAX_URL_CHARS) return { ok: false, code: 'URL_TOO_LONG' };
  return { ok: true, url };
}

/** Image URL policy — any http(s) host. */
export function normalizeImageUrl(raw: string): UrlResult {
  const r = parseHttpUrl(raw);
  return r.ok ? { ok: true, href: r.url.href } : r;
}

/**
 * Product URL policy — host must equal `siteDomain` (merchant_sites.
 * normalized_domain: lowercase, punycode, "www." stripped) or be a subdomain
 * of it. Suffix tricks ("evilshop.com" vs "shop.com") do not match.
 */
export function normalizeProductUrl(raw: string, siteDomain: string): UrlResult {
  const r = parseHttpUrl(raw);
  if (!r.ok) return r;
  const host = r.url.hostname.toLowerCase().replace(/\.$/, '');
  const domain = siteDomain.toLowerCase().replace(/\.$/, '');
  if (domain.length === 0 || (host !== domain && !host.endsWith(`.${domain}`))) {
    return { ok: false, code: 'URL_DOMAIN_MISMATCH' };
  }
  return { ok: true, href: r.url.href };
}
