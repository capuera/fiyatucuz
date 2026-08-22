import { z } from 'zod';

// ---------------------------------------------------------------------------
// Domain normalization (ADR-0015 §Domain normalization)
// ---------------------------------------------------------------------------
//
// Canonical rules applied in order:
//   1. trim leading/trailing whitespace
//   2. lowercase
//   3. strip scheme (http:// or https:// only)
//   4. reject any user info / port / path / query / fragment (a domain is
//      a host, not a URL)
//   5. Punycode-encode any IDN via Node's URL parser (URL.hostname already
//      returns the ASCII form for IDNs)
//   6. **Strip a single leading `www.` label** — documented explicitly here.
//      Rationale: end users treat `www.example.com` and `example.com` as
//      the same site; requiring two separate registrations + verifications
//      is confusing and doesn't add security. Only the LEADING `www.` is
//      stripped: `sub.www.example.com` is left alone, and non-`www`
//      subdomains (e.g. `shop.example.com`) are preserved intact.
//   7. reject bare IPs, `localhost`, and any host without a TLD.

const HOST_SHAPE_RE =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export class InvalidDomainError extends Error {
  readonly code = 'INVALID_DOMAIN' as const;
  constructor(public readonly input: string, reason: string) {
    super(`invalid domain "${input}": ${reason}`);
    this.name = 'InvalidDomainError';
  }
}

export function normalizeDomain(input: string): string {
  if (typeof input !== 'string') throw new InvalidDomainError(String(input), 'not a string');
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new InvalidDomainError(input, 'empty');
  if (trimmed.length > 253) throw new InvalidDomainError(input, 'exceeds 253 chars');

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidDomainError(input, 'not a parseable host');
  }

  if (url.username !== '' || url.password !== '') {
    throw new InvalidDomainError(input, 'must not include userinfo');
  }
  if (url.port !== '') {
    throw new InvalidDomainError(input, 'must not include a port');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new InvalidDomainError(input, 'must not include a path');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new InvalidDomainError(input, 'must not include query or fragment');
  }

  let host = url.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);

  if (host === 'localhost') throw new InvalidDomainError(input, 'localhost is not a public host');
  if (IPV4_RE.test(host)) throw new InvalidDomainError(input, 'IP addresses are not allowed');
  if (host.startsWith('[') || host.includes(':')) {
    throw new InvalidDomainError(input, 'IPv6 or port syntax is not allowed');
  }
  if (!HOST_SHAPE_RE.test(host)) {
    throw new InvalidDomainError(input, 'host shape invalid — expected labels.tld');
  }

  return host;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

// Slugs: URL-safe lowercase-alnum with single hyphens, 3..48 chars,
// no leading/trailing hyphen, no consecutive hyphens.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$/;

export const UuidParamSchema = z.string().uuid();

export const CountryCodeSchema = z
  .string()
  .regex(/^[A-Za-z]{2}$/, 'country_code must be 2 letters')
  .transform((s) => s.toUpperCase());

export const CreateMerchantBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .refine(
        (v) => v.length >= 3 && v.length <= 48 && SLUG_RE.test(v),
        'slug must be 3..48 chars: [a-z0-9] with optional single hyphens',
      ),
    legalName: z.string().trim().min(1).max(200).optional(),
    taxNumber: z.string().trim().min(1).max(64).optional(),
    taxOffice: z.string().trim().min(1).max(128).optional(),
    countryCode: CountryCodeSchema.optional(),
    city: z.string().trim().min(1).max(128).optional(),
    website: z.string().url().max(2048).optional(),
    logoUrl: z.string().url().max(2048).optional(),
  })
  .strict();

export const UpdateMerchantBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    legalName: z.string().trim().min(1).max(200).nullable().optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']).optional(),
    taxNumber: z.string().trim().min(1).max(64).nullable().optional(),
    taxOffice: z.string().trim().min(1).max(128).nullable().optional(),
    countryCode: CountryCodeSchema.nullable().optional(),
    city: z.string().trim().min(1).max(128).nullable().optional(),
    website: z.string().url().max(2048).nullable().optional(),
    logoUrl: z.string().url().max(2048).nullable().optional(),
  })
  .strict();

export const CreateMerchantSiteBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    // Domain is validated here for basic shape; normalizeDomain does the
    // canonical transformation + strict checks at the service boundary.
    domain: z.string().trim().min(3).max(253),
    logoUrl: z.string().url().max(2048).optional(),
  })
  .strict();

export const UpdateMerchantSiteBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']).optional(),
    logoUrl: z.string().url().max(2048).nullable().optional(),
  })
  .strict();

export const CreateVerificationChallengeBodySchema = z
  .object({
    method: z.enum(['DNS_TXT', 'HTML_FILE', 'META_TAG']),
  })
  .strict();

export type CreateMerchantInput = z.infer<typeof CreateMerchantBodySchema>;
export type UpdateMerchantInput = z.infer<typeof UpdateMerchantBodySchema>;
export type CreateMerchantSiteInput = z.infer<typeof CreateMerchantSiteBodySchema>;
export type UpdateMerchantSiteInput = z.infer<typeof UpdateMerchantSiteBodySchema>;
export type CreateVerificationChallengeInput = z.infer<
  typeof CreateVerificationChallengeBodySchema
>;
