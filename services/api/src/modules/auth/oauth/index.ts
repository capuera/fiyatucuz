import type { AuthEnv } from '../env.js';

/**
 * OAuth provider abstraction — foundation only (ADR-0014).
 *
 * The real callback flow is deferred to a later sprint. In this sprint we
 * establish the shape so the auth service can be extended without a
 * cross-module refactor:
 *   - a provider is identified by name ('google' | 'apple')
 *   - it exposes verifyIdToken(idToken) → { providerAccountId, email? }
 *   - configuration comes from environment variables only (no secrets in
 *     source; no client_secret is ever included in a git commit)
 *
 * The provided Google/Apple implementations throw NotImplementedError so any
 * accidental call from live code fails loudly instead of silently succeeding
 * against a broken provider.
 */

export type OAuthProviderName = 'google' | 'apple';

export interface OAuthVerifiedIdentity {
  readonly provider: OAuthProviderName;
  readonly providerAccountId: string;
  readonly emailAtProvider?: string;
}

export interface OAuthProvider {
  readonly name: OAuthProviderName;
  /**
   * Verify an ID token issued by the provider and return the stable account
   * id + optional email. Implementations MUST validate:
   *   - signature (against provider JWKS)
   *   - issuer / audience
   *   - expiry
   *   - nonce (against the value set at authorize-time)
   */
  verifyIdToken(idToken: string): Promise<OAuthVerifiedIdentity>;
  /**
   * Return true iff the environment carries valid configuration for this
   * provider. Used by the factory to decide whether to register the provider
   * at all.
   */
  isConfigured(): boolean;
}

export class NotImplementedError extends Error {
  readonly code = 'OAUTH_NOT_IMPLEMENTED' as const;
  constructor(public readonly provider: OAuthProviderName) {
    super(`OAuth provider ${provider} is not yet implemented`);
    this.name = 'NotImplementedError';
  }
}

export class OAuthProviderNotConfiguredError extends Error {
  readonly code = 'OAUTH_NOT_CONFIGURED' as const;
  constructor(public readonly provider: OAuthProviderName, public readonly missing: string) {
    super(`OAuth provider ${provider} is not configured (missing ${missing})`);
    this.name = 'OAuthProviderNotConfiguredError';
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
//
// Dynamic imports would be cleaner but static imports let TypeScript+bundlers
// tree-shake nothing meaningful and are simpler to read. Provider ctors are
// lightweight (no I/O).

import { createAppleProvider } from './apple.js';
import { createGoogleProvider } from './google.js';

export interface OAuthRegistry {
  readonly google?: OAuthProvider;
  readonly apple?: OAuthProvider;
  /**
   * Look up a provider by name. Throws OAuthProviderNotConfiguredError if
   * the requested provider is not configured — the caller must handle the
   * absence explicitly instead of silently no-op'ing an auth attempt.
   */
  require(name: OAuthProviderName): OAuthProvider;
}

export function createOAuthRegistry(env: AuthEnv): OAuthRegistry {
  const google = createGoogleProvider(env);
  const apple = createAppleProvider(env);
  return {
    ...(google?.isConfigured() ? { google } : {}),
    ...(apple?.isConfigured() ? { apple } : {}),
    require(name) {
      const provider = name === 'google' ? google : apple;
      if (!provider) throw new OAuthProviderNotConfiguredError(name, 'provider ctor returned null');
      if (!provider.isConfigured()) {
        // Report which env var is expected. Kept intentionally coarse — a
        // wrong client_secret is not something this abstraction is going to
        // introspect; it's the provider implementation's job to fail on it
        // during verifyIdToken.
        const missing =
          name === 'google'
            ? 'AUTH_GOOGLE_CLIENT_ID + AUTH_GOOGLE_CLIENT_SECRET'
            : 'AUTH_APPLE_CLIENT_ID + AUTH_APPLE_TEAM_ID + AUTH_APPLE_KEY_ID + AUTH_APPLE_PRIVATE_KEY';
        throw new OAuthProviderNotConfiguredError(name, missing);
      }
      return provider;
    },
  };
}
