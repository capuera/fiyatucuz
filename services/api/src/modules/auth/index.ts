// Public surface of the auth module.
//
// Per ADR-0003 (modular monolith), other modules import ONLY from this
// barrel — never from routes.ts, service.ts, repository.ts, etc.

export { loadAuthEnv, type AuthEnv } from './env.js';

export {
  createAuthService,
  UserAlreadyExistsError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  WeakPasswordError,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  type AuthService,
  type AuthServiceDeps,
  type AuthenticatedUser,
  type AuthSession,
  type AuthTokens,
  type RegisterInput,
  type LoginInput,
  type RequestMeta,
} from './service.js';

export {
  SESSION_COOKIE,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  setAuthCookies,
  clearAuthCookies,
  readSessionCookie,
  readRefreshCookie,
} from './cookies.js';

export { registerAuthMiddleware, TENANT_HEADER } from './middleware.js';

export { registerAuthRoutes } from './routes.js';

export {
  createOAuthRegistry,
  NotImplementedError as OAuthNotImplementedError,
  OAuthProviderNotConfiguredError,
  type OAuthProvider,
  type OAuthProviderName,
  type OAuthRegistry,
  type OAuthVerifiedIdentity,
} from './oauth/index.js';
