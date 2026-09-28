import { isIP } from 'node:net';

/**
 * Client IP normalization for values derived from Fastify `request.ip`.
 *
 * With `trustProxy` enabled, Fastify (via @fastify/proxy-addr) returns the
 * first untrusted X-Forwarded-For entry verbatim — it is never validated. IIS
 * ARR, for example, can emit `203.0.113.10:60028` (client IP + TCP port).
 * Such a value must not reach the PostgreSQL `inet` column (22P02) nor be used
 * as a rate-limit key (a fresh port per TCP connection = a fresh bucket).
 *
 * This module only fixes the *format* of the value. Whether the value can be
 * spoofed depends on trustProxy and on how the reverse proxy writes
 * X-Forwarded-For (append vs overwrite vs pass-through) — nothing here
 * changes that.
 */

// Longest legitimate input: "[" + 45-char IPv6 (with dotted IPv4 tail) + "]" + ":65535" = 53.
const MAX_RAW_LENGTH = 64;

const BRACKETED_RE = /^\[([^[\]]+)\](?::(\d{1,5}))?$/;
const IPV4_WITH_PORT_RE = /^([0-9.]+):(\d{1,5})$/;
// Canonical (WHATWG-serialized) IPv4-mapped IPv6: ::ffff:XXXX:XXXX
const V4_MAPPED_CANONICAL_RE = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

function isValidPort(port: string): boolean {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * Canonicalize an IPv6 literal. Zone identifiers (`fe80::1%eth0`) are
 * rejected: they are host-local, meaningless for a remote client and not
 * something we want to feed into `inet`. IPv4-mapped addresses collapse to
 * plain IPv4 so the same client never yields two different keys.
 */
function normalizeIpv6(addr: string): string | null {
  if (addr.includes('%')) return null;
  if (isIP(addr) !== 6) return null;

  // WHATWG URL host serialization gives a stable, lowercase, compressed form
  // (and renders any dotted IPv4 tail as hex), so every spelling of the same
  // address maps to one string.
  let canonical: string;
  try {
    canonical = new URL(`http://[${addr}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }

  const mapped = V4_MAPPED_CANONICAL_RE.exec(canonical);
  if (mapped) {
    const hi = Number.parseInt(mapped[1] ?? '', 16);
    const lo = Number.parseInt(mapped[2] ?? '', 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return canonical;
}

/**
 * Normalize a raw client address to a bare IPv4/IPv6 string safe for the
 * PostgreSQL `inet` type, or `null` when it cannot be parsed unambiguously.
 *
 * Accepted: `IPv4`, `IPv4:port`, `IPv6`, `[IPv6]`, `[IPv6]:port`,
 * IPv4-mapped IPv6. An unbracketed IPv6 is never port-stripped — without
 * brackets a trailing `:NNNN` group is indistinguishable from a port.
 */
export function normalizeClientIp(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > MAX_RAW_LENGTH) return null;
  const s = raw.trim();
  if (s.length === 0) return null;

  if (isIP(s) === 4) return s;

  const bracketed = BRACKETED_RE.exec(s);
  if (bracketed) {
    const port = bracketed[2];
    if (port !== undefined && !isValidPort(port)) return null;
    return normalizeIpv6(bracketed[1] ?? '');
  }

  const v4WithPort = IPV4_WITH_PORT_RE.exec(s);
  if (v4WithPort) {
    const [, host = '', port = ''] = v4WithPort;
    return isIP(host) === 4 && isValidPort(port) ? host : null;
  }

  return normalizeIpv6(s);
}

/** Prefix for the shared bucket used when the forwarded address is unusable. */
export const INVALID_CLIENT_IP_KEY_PREFIX = 'invalid-client-ip:';

/**
 * Rate-limit key for a request.
 *
 * - Normal case: the normalized client IP (port stripped, IPv4-mapped folded).
 * - Unparseable `request.ip` (garbage / malformed forwarded value): fall back
 *   to a fixed bucket scoped by the TCP socket peer. The raw forwarded string
 *   is never used, so varying it per request cannot mint new buckets. Behind
 *   a same-host reverse proxy the peer is the proxy (127.0.0.1), so all such
 *   requests share one bucket — that only throttles other malformed-IP
 *   requests; clients with a valid IP keep their own buckets. The prefix
 *   cannot parse as an IP, so this bucket never collides with a real client.
 */
export function clientIpRateLimitKey(
  ip: string | undefined,
  socketPeer: string | undefined,
): string {
  const normalized = normalizeClientIp(ip);
  if (normalized !== null) return normalized;
  return `${INVALID_CLIENT_IP_KEY_PREFIX}${normalizeClientIp(socketPeer) ?? 'unknown'}`;
}
