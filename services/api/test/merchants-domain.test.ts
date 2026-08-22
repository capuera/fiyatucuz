import { describe, expect, it } from 'vitest';

import { InvalidDomainError, normalizeDomain } from '../src/modules/merchants/index.js';

describe('merchants: normalizeDomain (unit)', () => {
  it('lowercases + strips leading www + strips scheme + strips trailing slash', () => {
    expect(normalizeDomain('https://WWW.Example.com/')).toBe('example.com');
    expect(normalizeDomain('http://example.com')).toBe('example.com');
    expect(normalizeDomain('Example.com')).toBe('example.com');
    expect(normalizeDomain('www.example.com')).toBe('example.com');
  });

  it('preserves non-www subdomains', () => {
    expect(normalizeDomain('shop.example.com')).toBe('shop.example.com');
    expect(normalizeDomain('WWW.SHOP.example.com')).toBe('shop.example.com');
    // Only the LEADING www is stripped — inner "www" labels stay put.
    expect(normalizeDomain('sub.www.example.com')).toBe('sub.www.example.com');
  });

  it('trims whitespace', () => {
    expect(normalizeDomain('   example.com   ')).toBe('example.com');
  });

  it('handles international (IDN) domains by returning the Punycode form', () => {
    // WHATWG URL emits the ASCII Punycode form. We assert the SHAPE (starts
    // with `xn--`, contains only ASCII) rather than the exact byte-for-byte
    // encoding, which is ICU-version-dependent.
    const out = normalizeDomain('türk.example');
    expect(out).toMatch(/^xn--[a-z0-9-]+\.example$/);
    expect(out).not.toContain('ü');
  });

  it('rejects paths, queries, fragments, userinfo, ports', () => {
    expect(() => normalizeDomain('example.com/path')).toThrow(InvalidDomainError);
    expect(() => normalizeDomain('https://example.com/foo')).toThrow(InvalidDomainError);
    expect(() => normalizeDomain('example.com?x=1')).toThrow(InvalidDomainError);
    expect(() => normalizeDomain('example.com#frag')).toThrow(InvalidDomainError);
    expect(() => normalizeDomain('user:pw@example.com')).toThrow(InvalidDomainError);
    expect(() => normalizeDomain('example.com:8080')).toThrow(InvalidDomainError);
  });

  it('rejects bare IPs, localhost, and hosts without a TLD', () => {
    expect(() => normalizeDomain('192.168.1.1')).toThrow(InvalidDomainError);
    expect(() => normalizeDomain('http://10.0.0.1/')).toThrow(InvalidDomainError);
    expect(() => normalizeDomain('localhost')).toThrow(InvalidDomainError);
    expect(() => normalizeDomain('example')).toThrow(InvalidDomainError);
  });

  it('rejects empty / non-string / too-long input', () => {
    expect(() => normalizeDomain('')).toThrow(InvalidDomainError);
    expect(() => normalizeDomain('   ')).toThrow(InvalidDomainError);
    // 300 chars > 253 limit
    expect(() => normalizeDomain('a'.repeat(300) + '.com')).toThrow(InvalidDomainError);
  });
});
