import { describe, expect, it } from 'vitest';

import {
  INVALID_CLIENT_IP_KEY_PREFIX,
  clientIpRateLimitKey,
  normalizeClientIp,
} from '../src/lib/client-ip.js';

describe('normalizeClientIp', () => {
  const valid: Array<[string, string]> = [
    // IPv4
    ['203.0.113.10', '203.0.113.10'],
    ['0.0.0.0', '0.0.0.0'],
    ['127.0.0.1', '127.0.0.1'],
    // IPv4:port (IIS ARR "Include TCP port from client IP")
    ['203.0.113.10:60028', '203.0.113.10'],
    ['203.0.113.10:1', '203.0.113.10'],
    ['203.0.113.10:65535', '203.0.113.10'],
    // IPv6 — canonicalized (lowercase, compressed)
    ['2001:db8::1', '2001:db8::1'],
    ['2001:DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['::1', '::1'],
    ['::', '::'],
    // [IPv6] and [IPv6]:port
    ['[2001:db8::1]', '2001:db8::1'],
    ['[2001:db8::1]:443', '2001:db8::1'],
    ['[::1]:60028', '::1'],
    // IPv6 whose last group looks like a port stays intact (no bracket → no strip)
    ['2001:db8::8080', '2001:db8::8080'],
    // IPv4-mapped IPv6 → IPv4 (dotted, hex, upper-case, bracketed)
    ['::ffff:203.0.113.10', '203.0.113.10'],
    ['::FFFF:203.0.113.10', '203.0.113.10'],
    ['::ffff:cb00:710a', '203.0.113.10'],
    ['[::ffff:203.0.113.10]:60028', '203.0.113.10'],
    // Surrounding whitespace is tolerated
    ['  203.0.113.10  ', '203.0.113.10'],
    ['\t203.0.113.10:60028\n', '203.0.113.10'],
  ];

  it.each(valid)('%j → %j', (raw, expected) => {
    expect(normalizeClientIp(raw)).toBe(expected);
  });

  const invalid: Array<[string, string | undefined | null]> = [
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace only', '   '],
    ['garbage', 'abc'],
    ['hostname', 'example.com'],
    ['port > 65535', '1.2.3.4:99999'],
    ['port 0', '1.2.3.4:0'],
    ['empty port', '1.2.3.4:'],
    ['double port', '1.2.3.4:80:80'],
    ['bracketed invalid port', '[2001:db8::1]:99999'],
    ['bracketed IPv4', '[1.2.3.4]:80'],
    ['bracketed garbage', '[abc]:80'],
    ['unbalanced bracket', '[2001:db8::1:443'],
    ['IPv4 octet out of range', '256.1.1.1'],
    ['IPv4 leading zero', '01.2.3.4'],
    ['IPv4 too few octets', '1.2.3'],
    ['zone identifier', 'fe80::1%eth0'],
    ['zone identifier (url-encoded)', 'fe80::1%25eth0'],
    ['bracketed zone identifier', '[fe80::1%eth0]:443'],
    ['internal whitespace', '1.2.3.4 :80'],
    ['XFF list', '1.2.3.4, 5.6.7.8'],
    ['overly long', `1.2.3.4${' '.repeat(100)}`],
    ['overly long garbage', 'a'.repeat(10_000)],
  ];

  it.each(invalid)('%s → null', (_label, raw) => {
    expect(normalizeClientIp(raw)).toBeNull();
  });
});

describe('clientIpRateLimitKey', () => {
  it('same IPv4 with different ports maps to the same key', () => {
    const a = clientIpRateLimitKey('203.0.113.10:60028', '127.0.0.1');
    const b = clientIpRateLimitKey('203.0.113.10:60029', '127.0.0.1');
    expect(a).toBe('203.0.113.10');
    expect(b).toBe(a);
  });

  it('IPv4-mapped and plain IPv4 share a key', () => {
    expect(clientIpRateLimitKey('::ffff:203.0.113.10', '127.0.0.1')).toBe(
      clientIpRateLimitKey('203.0.113.10', '127.0.0.1'),
    );
  });

  it('different client IPs get different keys', () => {
    expect(clientIpRateLimitKey('203.0.113.10:1', '127.0.0.1')).not.toBe(
      clientIpRateLimitKey('203.0.113.11:1', '127.0.0.1'),
    );
  });

  it('invalid values collapse into one fixed bucket per socket peer (never the raw value)', () => {
    const keys = ['abc', 'xyz', '1.2.3.4:99999', 'a'.repeat(500), ''].map((raw) =>
      clientIpRateLimitKey(raw, '127.0.0.1'),
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(`${INVALID_CLIENT_IP_KEY_PREFIX}127.0.0.1`);
  });

  it('invalid bucket never collides with a real client key', () => {
    const invalidKey = clientIpRateLimitKey('abc', '127.0.0.1');
    expect(invalidKey).not.toBe(clientIpRateLimitKey('127.0.0.1', '127.0.0.1'));
    expect(normalizeClientIp(invalidKey)).toBeNull();
  });

  it('missing socket peer still yields a fixed key', () => {
    expect(clientIpRateLimitKey(undefined, undefined)).toBe(
      `${INVALID_CLIENT_IP_KEY_PREFIX}unknown`,
    );
  });
});
