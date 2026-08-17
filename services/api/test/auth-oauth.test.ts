import { describe, expect, it } from 'vitest';

import {
  createOAuthRegistry,
  loadAuthEnv,
  OAuthNotImplementedError,
  OAuthProviderNotConfiguredError,
} from '../src/modules/auth/index.js';

// Unit-only — foundation shape. No DB, no network. These tests fail at CI
// time if someone accidentally wires the OAuth callback routes before the
// real verify flow is implemented (verifyIdToken must still throw
// NotImplementedError).

const BASE = {
  AUTH_TOKEN_HMAC_SECRET: 'test_only_fixed_hmac_secret_at_least_32_chars_long_xxxxxxx',
};

describe('auth — oauth foundation (unit)', () => {
  it('registry: providers omitted when unconfigured', () => {
    const env = loadAuthEnv({ ...BASE });
    const reg = createOAuthRegistry(env);
    expect(reg.google).toBeUndefined();
    expect(reg.apple).toBeUndefined();
  });

  it('registry: google configured when both CLIENT_ID and CLIENT_SECRET present', () => {
    const env = loadAuthEnv({
      ...BASE,
      AUTH_GOOGLE_CLIENT_ID: 'test-client-id',
      AUTH_GOOGLE_CLIENT_SECRET: 'test-client-secret',
    });
    const reg = createOAuthRegistry(env);
    expect(reg.google).toBeDefined();
    expect(reg.google?.name).toBe('google');
    expect(reg.google?.isConfigured()).toBe(true);
  });

  it('registry: apple configured requires all four env vars', () => {
    const partial = loadAuthEnv({ ...BASE, AUTH_APPLE_CLIENT_ID: 'com.example.app' });
    expect(createOAuthRegistry(partial).apple).toBeUndefined();

    const complete = loadAuthEnv({
      ...BASE,
      AUTH_APPLE_CLIENT_ID: 'com.example.app',
      AUTH_APPLE_TEAM_ID: 'TEAM123',
      AUTH_APPLE_KEY_ID: 'KEY123',
      AUTH_APPLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nZ\n-----END PRIVATE KEY-----',
    });
    const reg = createOAuthRegistry(complete);
    expect(reg.apple).toBeDefined();
    expect(reg.apple?.name).toBe('apple');
    expect(reg.apple?.isConfigured()).toBe(true);
  });

  it('registry.require throws OAuthProviderNotConfiguredError when missing', () => {
    const env = loadAuthEnv({ ...BASE });
    const reg = createOAuthRegistry(env);
    expect(() => reg.require('google')).toThrow(OAuthProviderNotConfiguredError);
    expect(() => reg.require('apple')).toThrow(OAuthProviderNotConfiguredError);
  });

  it('google.verifyIdToken throws NotImplementedError (foundation only)', async () => {
    const env = loadAuthEnv({
      ...BASE,
      AUTH_GOOGLE_CLIENT_ID: 'x',
      AUTH_GOOGLE_CLIENT_SECRET: 'y',
    });
    const reg = createOAuthRegistry(env);
    const provider = reg.require('google');
    await expect(provider.verifyIdToken('anything')).rejects.toBeInstanceOf(
      OAuthNotImplementedError,
    );
  });

  it('apple.verifyIdToken throws NotImplementedError (foundation only)', async () => {
    const env = loadAuthEnv({
      ...BASE,
      AUTH_APPLE_CLIENT_ID: 'com.example.app',
      AUTH_APPLE_TEAM_ID: 'TEAM123',
      AUTH_APPLE_KEY_ID: 'KEY123',
      AUTH_APPLE_PRIVATE_KEY: 'k',
    });
    const reg = createOAuthRegistry(env);
    const provider = reg.require('apple');
    await expect(provider.verifyIdToken('anything')).rejects.toBeInstanceOf(
      OAuthNotImplementedError,
    );
  });
});
