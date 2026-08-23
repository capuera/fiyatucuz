import { isIP, isIPv4, isIPv6 } from 'node:net';
import { promises as dnsPromises } from 'node:dns';

/**
 * SSRF-safe URL validator (ADR-0016 §SSRF).
 *
 * Merchant-supplied URLs are UNTRUSTED. Two layers of defense:
 *
 * 1. **Syntactic** — scheme, no userinfo, no unusual ports, no cloud
 *    metadata hostnames, no literal loopback / private / reserved hosts.
 *    Runs even when private-address checks are disabled for tests.
 *
 * 2. **Network** — resolve the hostname (all A/AAAA records) and reject if
 *    ANY resolved IP falls in a private, loopback, link-local, multicast,
 *    or reserved range. Runs unless `allowPrivateAddresses` is true (test
 *    mode; boot-fails in production, see env.ts).
 *
 * **DNS rebinding limitation**: this validator resolves once and then the
 * caller connects using the hostname (letting Node's fetch re-resolve).
 * A malicious authoritative DNS can return a public IP to our probe and a
 * private IP to the subsequent connect (TOCTOU window). Fully closing that
 * requires binding the HTTP connect to the validated IP (undici custom
 * connector) — deferred to production hardening; documented in ADR-0016.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SsrfErrorCode =
  | 'INVALID_URL'
  | 'SSRF_REJECTED'
  | 'DNS_FAILURE';

export class SafeUrlError extends Error {
  readonly httpStatus = 400 as const;
  constructor(
    public readonly code: SsrfErrorCode,
    message: string,
    public readonly reason?: string,
  ) {
    super(message);
    this.name = 'SafeUrlError';
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

// Literal hostnames that are always rejected, even before DNS.
const HOSTNAME_BLOCKLIST = new Set<string>([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
]);

// Suffix-match blocklist — reject any host ending in these labels.
const HOSTNAME_SUFFIX_BLOCKLIST = [
  '.internal',
  '.local',
  '.localdomain',
  '.arpa',
];

// IP-address literal blocklist (checked before DNS lookup for host-as-IP URLs).
const IPV4_METADATA_LITERALS = new Set<string>([
  '169.254.169.254',   // AWS + GCP + Azure IMDS
  '169.254.170.2',     // ECS metadata
  '0.0.0.0',
]);

const IPV6_METADATA_LITERALS = new Set<string>([
  'fd00:ec2::254',     // AWS IPv6 metadata
]);

// ---------------------------------------------------------------------------
// IP range checks
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const b = Number.parseInt(p, 10);
    if (!Number.isInteger(b) || b < 0 || b > 255 || String(b) !== p) return null;
    n = (n << 8) + b;
  }
  // Node bitwise ops are 32-bit signed; convert to unsigned.
  return n >>> 0;
}

function isPrivateIPv4(ip: string): { blocked: boolean; reason?: string } {
  const n = ipv4ToInt(ip);
  if (n === null) return { blocked: true, reason: 'invalid IPv4 literal' };
  // Ranges (RFC 1918, RFC 6890, RFC 5735, RFC 3927, RFC 5771):
  //   0.0.0.0/8         → "this network"
  //   10.0.0.0/8        → private
  //   100.64.0.0/10     → CGNAT
  //   127.0.0.0/8       → loopback
  //   169.254.0.0/16    → link-local (includes IMDS)
  //   172.16.0.0/12     → private
  //   192.0.0.0/24      → protocol assignments (0.0.0.0 subnet)
  //   192.168.0.0/16    → private
  //   198.18.0.0/15     → benchmark
  //   224.0.0.0/4       → multicast
  //   240.0.0.0/4       → reserved
  //   255.255.255.255   → broadcast
  const ranges: Array<[number, number, string]> = [
    [0x00000000, 0xFF000000, 'unspecified / this-network 0.0.0.0/8'],
    [0x0A000000, 0xFF000000, 'private 10.0.0.0/8'],
    [0x64400000, 0xFFC00000, 'CGNAT 100.64.0.0/10'],
    [0x7F000000, 0xFF000000, 'loopback 127.0.0.0/8'],
    [0xA9FE0000, 0xFFFF0000, 'link-local 169.254.0.0/16'],
    [0xAC100000, 0xFFF00000, 'private 172.16.0.0/12'],
    [0xC0000000, 0xFFFFFF00, 'protocol assignments 192.0.0.0/24'],
    [0xC0A80000, 0xFFFF0000, 'private 192.168.0.0/16'],
    [0xC6120000, 0xFFFE0000, 'benchmark 198.18.0.0/15'],
    [0xE0000000, 0xF0000000, 'multicast 224.0.0.0/4'],
    [0xF0000000, 0xF0000000, 'reserved 240.0.0.0/4'],
    [0xFFFFFFFF, 0xFFFFFFFF, 'broadcast'],
  ];
  for (const [base, mask, reason] of ranges) {
    // JS bitwise operators are signed-32-bit; force unsigned on the AND
    // result so ranges above 0x80000000 (e.g. 172.16.0.0/12) match. Base
    // literals fit in unsigned 32-bit already.
    if (((n & mask) >>> 0) === base) return { blocked: true, reason };
  }
  if (IPV4_METADATA_LITERALS.has(ip)) {
    return { blocked: true, reason: 'cloud metadata endpoint' };
  }
  return { blocked: false };
}

function normalizeIPv6(ip: string): string {
  // Strip zone id + brackets, lowercase.
  return ip.replace(/^\[|\]$/g, '').split('%')[0]!.toLowerCase();
}

function isPrivateIPv6(rawIp: string): { blocked: boolean; reason?: string } {
  const ip = normalizeIPv6(rawIp);
  if (ip === '::' || ip === '::0' || ip === '0:0:0:0:0:0:0:0') {
    return { blocked: true, reason: 'unspecified ::' };
  }
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') {
    return { blocked: true, reason: 'IPv6 loopback ::1' };
  }
  // IPv4-mapped: ::ffff:a.b.c.d — apply IPv4 rules to the embedded address.
  const mapped = ip.match(/^::ffff:([0-9]{1,3}(?:\.[0-9]{1,3}){3})$/);
  if (mapped) {
    return isPrivateIPv4(mapped[1]!);
  }
  // Prefix-based checks (case-insensitive; ip already lowercased).
  const prefixBlocks: Array<[RegExp, string]> = [
    [/^fe[89ab][0-9a-f]:/, 'link-local fe80::/10'],
    [/^fc/, 'unique-local fc00::/7'],
    [/^fd/, 'unique-local fd00::/8'],
    [/^ff/, 'multicast ff00::/8'],
    [/^2001:db8:/, 'documentation 2001:db8::/32'],
    [/^100::/, 'discard-only 100::/64'],
    [/^64:ff9b::/, 'NAT64 well-known'],
    [/^::ffff:/, 'IPv4-mapped that failed to normalize'],
  ];
  for (const [re, reason] of prefixBlocks) {
    if (re.test(ip)) return { blocked: true, reason };
  }
  if (IPV6_METADATA_LITERALS.has(ip)) {
    return { blocked: true, reason: 'cloud metadata endpoint' };
  }
  return { blocked: false };
}

export function isPrivateIP(ip: string): { blocked: boolean; reason?: string } {
  if (isIPv4(ip)) return isPrivateIPv4(ip);
  if (isIPv6(ip)) return isPrivateIPv6(ip);
  return { blocked: true, reason: 'unrecognized IP literal' };
}

// ---------------------------------------------------------------------------
// URL syntactic check
// ---------------------------------------------------------------------------

export interface SyntacticValidationResult {
  readonly url: URL;
  readonly hostname: string;
  readonly hostnameIsIP: boolean;
}

export interface SyntacticOptions {
  /** TEST-ONLY: skip the IP-literal range check for loopback/private hosts. */
  readonly allowPrivateAddresses?: boolean;
}

export function validateSyntactic(
  raw: string,
  opts: SyntacticOptions = {},
): SyntacticValidationResult {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new SafeUrlError('INVALID_URL', 'URL is empty');
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SafeUrlError('INVALID_URL', 'URL is not parseable');
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new SafeUrlError(
      'INVALID_URL',
      `scheme "${url.protocol.replace(/:$/, '')}" is not allowed`,
      'scheme',
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new SafeUrlError('INVALID_URL', 'URL must not include userinfo', 'userinfo');
  }
  if (!ALLOWED_PORTS.has(url.port) && !opts.allowPrivateAddresses) {
    // Non-standard ports are rejected in production. Tests that bind a
    // loopback HTTP server to a random port set allowPrivateAddresses.
    throw new SafeUrlError('INVALID_URL', `port ${url.port} is not allowed`, 'port');
  }

  // WHATWG URL returns IPv6 hostnames wrapped in brackets (`[::1]`); strip
  // them before every downstream check so isIP() sees the bare literal.
  let hostname = url.hostname.toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname.length === 0) {
    throw new SafeUrlError('INVALID_URL', 'URL must include a hostname');
  }

  // Literal-hostname blocklist.
  if (HOSTNAME_BLOCKLIST.has(hostname)) {
    throw new SafeUrlError('SSRF_REJECTED', `hostname "${hostname}" is blocked`, 'hostname-literal');
  }
  for (const suffix of HOSTNAME_SUFFIX_BLOCKLIST) {
    if (hostname.endsWith(suffix)) {
      throw new SafeUrlError(
        'SSRF_REJECTED',
        `hostname suffix "${suffix}" is blocked`,
        'hostname-suffix',
      );
    }
  }

  const ipKind = isIP(hostname);
  if (ipKind !== 0) {
    // Host is an IP literal. Check ranges immediately — no need for DNS —
    // unless the caller explicitly opted into the TEST-ONLY loopback path.
    if (!opts.allowPrivateAddresses) {
      const check = isPrivateIP(hostname);
      if (check.blocked) {
        throw new SafeUrlError(
          'SSRF_REJECTED',
          `IP literal is in a blocked range: ${check.reason}`,
          'ip-literal',
        );
      }
    }
    return { url, hostname, hostnameIsIP: true };
  }

  return { url, hostname, hostnameIsIP: false };
}

// ---------------------------------------------------------------------------
// Full validate: syntactic + DNS
// ---------------------------------------------------------------------------

export interface SafeUrlValidatorOptions {
  readonly allowPrivateAddresses?: boolean;
  /** Injectable resolver so tests can bypass real DNS. */
  readonly lookup?: (
    hostname: string,
  ) => Promise<ReadonlyArray<{ address: string; family: 4 | 6 }>>;
}

export interface SafeUrl {
  readonly url: URL;
  readonly hostname: string;
  readonly resolvedAddresses: ReadonlyArray<{ address: string; family: 4 | 6 }>;
}

async function defaultLookup(
  hostname: string,
): Promise<ReadonlyArray<{ address: string; family: 4 | 6 }>> {
  try {
    const result = await dnsPromises.lookup(hostname, { all: true });
    return result.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
  } catch (err) {
    throw new SafeUrlError(
      'DNS_FAILURE',
      `DNS lookup failed for ${hostname}`,
      (err as { code?: string })?.code,
    );
  }
}

export async function validateSafeUrl(
  raw: string,
  opts: SafeUrlValidatorOptions = {},
): Promise<SafeUrl> {
  const syntactic = validateSyntactic(raw, {
    ...(opts.allowPrivateAddresses ? { allowPrivateAddresses: true as const } : {}),
  });
  if (syntactic.hostnameIsIP) {
    // IP-literal hostnames were already range-checked in validateSyntactic.
    // (When allowPrivateAddresses is true, we skip network checks — but a
    // literal IP does not need DNS regardless; the syntactic gate is enough.)
    if (opts.allowPrivateAddresses) {
      return {
        url: syntactic.url,
        hostname: syntactic.hostname,
        resolvedAddresses: [
          {
            address: syntactic.hostname,
            family: isIPv6(syntactic.hostname) ? 6 : 4,
          },
        ],
      };
    }
    return {
      url: syntactic.url,
      hostname: syntactic.hostname,
      resolvedAddresses: [
        {
          address: syntactic.hostname,
          family: isIPv6(syntactic.hostname) ? 6 : 4,
        },
      ],
    };
  }

  const lookup = opts.lookup ?? defaultLookup;
  let resolved: ReadonlyArray<{ address: string; family: 4 | 6 }>;
  try {
    resolved = await lookup(syntactic.hostname);
  } catch (err) {
    if (err instanceof SafeUrlError) throw err;
    throw new SafeUrlError(
      'DNS_FAILURE',
      `DNS lookup failed for ${syntactic.hostname}`,
      (err as { code?: string })?.code,
    );
  }
  if (resolved.length === 0) {
    throw new SafeUrlError('DNS_FAILURE', `no addresses resolved for ${syntactic.hostname}`);
  }

  if (!opts.allowPrivateAddresses) {
    for (const r of resolved) {
      const check = isPrivateIP(r.address);
      if (check.blocked) {
        throw new SafeUrlError(
          'SSRF_REJECTED',
          `resolved address ${r.address} is in a blocked range: ${check.reason}`,
          'resolved-ip',
        );
      }
    }
  }

  return { url: syntactic.url, hostname: syntactic.hostname, resolvedAddresses: resolved };
}
