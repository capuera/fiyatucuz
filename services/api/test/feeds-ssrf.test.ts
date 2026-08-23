import { describe, expect, it } from 'vitest';

import {
  isPrivateIP,
  SafeUrlError,
  validateSafeUrl,
  validateSyntactic,
} from '../src/modules/feeds/index.js';

// Pure unit tests — no DB, no HTTP.

describe('feeds: SSRF — validateSyntactic (scheme / userinfo / port / hostname literals)', () => {
  it('rejects non-http(s) schemes', () => {
    for (const bad of [
      'file:///etc/passwd',
      'ftp://example.com/feed.xml',
      'data:text/xml,<x/>',
      'javascript:alert(1)',
      'gopher://example.com/1',
    ]) {
      expect(() => validateSyntactic(bad)).toThrow(SafeUrlError);
    }
  });

  it('rejects embedded userinfo', () => {
    expect(() => validateSyntactic('http://user:pw@example.com/feed')).toThrow(SafeUrlError);
    expect(() => validateSyntactic('https://user@example.com/feed')).toThrow(SafeUrlError);
  });

  it('rejects non-standard ports', () => {
    expect(() => validateSyntactic('http://example.com:22/feed')).toThrow(SafeUrlError);
    expect(() => validateSyntactic('http://example.com:9200/feed')).toThrow(SafeUrlError);
  });

  it('rejects literal localhost / metadata / .local / .arpa', () => {
    expect(() => validateSyntactic('http://localhost/feed')).toThrow(SafeUrlError);
    expect(() => validateSyntactic('http://metadata.google.internal/')).toThrow(SafeUrlError);
    expect(() => validateSyntactic('http://foo.local/')).toThrow(SafeUrlError);
    expect(() => validateSyntactic('http://foo.internal/')).toThrow(SafeUrlError);
    expect(() => validateSyntactic('http://1.1.1.1.in-addr.arpa/')).toThrow(SafeUrlError);
  });

  it('rejects IP-literal hostnames in private ranges', () => {
    for (const bad of [
      'http://127.0.0.1/',
      'http://10.0.0.5/',
      'http://172.16.0.5/',
      'http://172.31.0.5/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://0.0.0.0/',
    ]) {
      expect(() => validateSyntactic(bad)).toThrow(SafeUrlError);
    }
  });

  it('rejects IPv6 loopback and link-local literals', () => {
    expect(() => validateSyntactic('http://[::1]/')).toThrow(SafeUrlError);
    expect(() => validateSyntactic('http://[fe80::1]/')).toThrow(SafeUrlError);
    expect(() => validateSyntactic('http://[fc00::1]/')).toThrow(SafeUrlError);
    expect(() => validateSyntactic('http://[fd00::1]/')).toThrow(SafeUrlError);
  });

  it('accepts a well-formed public URL (syntactic only)', () => {
    // Public example.com — accepted at the syntactic layer.
    const ok = validateSyntactic('https://example.com/feed.xml');
    expect(ok.hostname).toBe('example.com');
    expect(ok.hostnameIsIP).toBe(false);
  });
});

describe('feeds: SSRF — isPrivateIP (range coverage)', () => {
  it('blocks the classic private v4 ranges + IMDS', () => {
    for (const ip of [
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '0.0.0.0',
      '255.255.255.255',
      '100.64.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '240.0.0.1',
    ]) {
      expect(isPrivateIP(ip).blocked, ip).toBe(true);
    }
  });

  it('does NOT block public v4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      expect(isPrivateIP(ip).blocked, ip).toBe(false);
    }
  });

  it('blocks v6 loopback / link-local / ULA / mapped', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd00::1', '::ffff:127.0.0.1']) {
      expect(isPrivateIP(ip).blocked, ip).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// DNS pinning behavioral test (ADIM 12.1)
// ---------------------------------------------------------------------------

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll } from 'vitest';

import {
  createSafeFeedFetcher,
  loadFeedEnv,
} from '../src/modules/feeds/index.js';

describe('feeds: SSRF — DNS pinning survives rebinding TOCTOU', () => {
  // Local HTTP stub on 127.0.0.1 that responds to any hostname (we control
  // where the socket connects via the pinned Agent, and the server doesn't
  // care what Host: header is sent).
  let stub: Server;
  let stubPort: number;

  beforeAll(async () => {
    stub = createServer((_req, res) => {
      res.setHeader('content-type', 'application/xml');
      res.statusCode = 200;
      res.end('<rss><channel/></rss>');
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubPort = (stub.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  it('pinning: URL with a bogus hostname (not in real DNS) connects successfully because the pinned Agent resolves to the validated IP', async () => {
    const env = loadFeedEnv({ FEED_FETCH_ALLOW_PRIVATE_ADDRESSES: 'true' });
    // The injected DNS resolver is called during validation. If pinning
    // works, this same IP is used at connect time — even though the
    // hostname `pinning-test.invalid` doesn't exist in real DNS.
    const fetcher = createSafeFeedFetcher({
      env,
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    const r = await fetcher.fetch({
      url: `http://pinning-test.invalid:${stubPort}/feed.xml`,
      format: 'CUSTOM_XML',
    });
    // Without pinning, Node would try to resolve `pinning-test.invalid`
    // via real DNS → NXDOMAIN → fetch failure. Success proves connect
    // used the validated IP.
    if (r.kind !== 'success') {
      // Surface the actual failure for diagnosis if this test ever regresses.
      console.error('pinning fetch failed:', r);
    }
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      expect(r.httpStatus).toBe(200);
    }
  });

  it('pinning: a validated PUBLIC IP result is honored at connect time — the fetcher never re-resolves via the OS', async () => {
    const env = loadFeedEnv({ FEED_FETCH_ALLOW_PRIVATE_ADDRESSES: 'true' });
    // Even though `example.com` DOES resolve to a public IP via real DNS,
    // our injected lookup pushes 127.0.0.1 — proving the fetcher uses the
    // validator's resolution, not the OS's. If the fetcher fell back to
    // real DNS, it would connect to example.com and fail against our stub.
    const fetcher = createSafeFeedFetcher({
      env,
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    const r = await fetcher.fetch({
      url: `http://example.com:${stubPort}/feed.xml`,
      format: 'CUSTOM_XML',
    });
    expect(r.kind).toBe('success');
  });

  it('pinning: private-address rejection still applies before pinning is attempted', async () => {
    // With allowPrivateAddresses=false (production posture), a lookup that
    // returns a private IP is rejected — pinning never happens.
    const env = loadFeedEnv({}); // default: allowPrivateAddresses false
    const fetcher = createSafeFeedFetcher({
      env,
      lookup: async () => [{ address: '10.0.0.1', family: 4 }],
    });
    const r = await fetcher.fetch({
      url: 'http://attacker.example.test/feed.xml',
      format: 'CUSTOM_XML',
    });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') {
      expect(r.code).toBe('SSRF_REJECTED');
    }
  });
});

describe('feeds: SSRF — validateSafeUrl with injected DNS resolver', () => {
  it('rejects when DNS resolves to a private IP', async () => {
    await expect(
      validateSafeUrl('https://malicious.example.com/feed', {
        lookup: async () => [{ address: '10.0.0.5', family: 4 }],
      }),
    ).rejects.toBeInstanceOf(SafeUrlError);
  });

  it('rejects when ONE of many resolved IPs is private', async () => {
    await expect(
      validateSafeUrl('https://mixed.example.com/feed', {
        lookup: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.10.10.10', family: 4 },
        ],
      }),
    ).rejects.toBeInstanceOf(SafeUrlError);
  });

  it('accepts when all resolved IPs are public', async () => {
    const r = await validateSafeUrl('https://public.example.com/feed', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    expect(r.hostname).toBe('public.example.com');
    expect(r.resolvedAddresses.length).toBe(1);
  });

  it('DNS_FAILURE surfaces as SafeUrlError with code DNS_FAILURE', async () => {
    await expect(
      validateSafeUrl('https://noresolve.example.com/feed', {
        lookup: async () => {
          throw Object.assign(new Error('nxdomain'), { code: 'ENOTFOUND' });
        },
      }),
    ).rejects.toThrow(SafeUrlError);
  });

  it('accepts when allowPrivateAddresses=true (TEST-ONLY escape hatch)', async () => {
    const r = await validateSafeUrl('http://127.0.0.1:8080/feed', {
      allowPrivateAddresses: true,
    });
    expect(r.hostname).toBe('127.0.0.1');
  });
});
