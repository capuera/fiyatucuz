import { randomUUID } from 'node:crypto';

import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import type { Db } from '@fiyatucuz/db';
import Fastify, { LogController } from 'fastify';
import type { Logger } from 'pino';

import type { ApiEnv } from './config/env.js';
import { registerHealthRoutes } from './routes/health.js';
import { InProcessJobQueue } from './lib/jobs/InProcessJobQueue.js';
import { InProcessBroadcaster } from './lib/realtime/InProcessBroadcaster.js';
import type { JobQueue } from './lib/jobs/JobQueue.js';
import type { Broadcaster } from './lib/realtime/Broadcaster.js';
import {
  createAuthService,
  createOAuthRegistry,
  registerAuthMiddleware,
  registerAuthRoutes,
  type AuthEnv,
  type AuthService,
  type OAuthRegistry,
} from './modules/auth/index.js';
import {
  createMerchantService,
  registerMerchantRoutes,
  type MerchantService,
} from './modules/merchants/index.js';
import {
  createFeedService,
  registerFeedRoutes,
  type FeedEnv,
  type FeedService,
} from './modules/feeds/index.js';

export interface ServerDependencies {
  env: ApiEnv;
  authEnv: AuthEnv;
  feedEnv: FeedEnv;
  logger: Logger;
  db: Db;
  jobs?: JobQueue;
  broadcaster?: Broadcaster;
}

// Return type is inferred so pino's Logger flows through cleanly instead of being
// widened to Fastify's stricter FastifyBaseLogger (which trips `exactOptionalPropertyTypes`).
export async function buildServer(deps: ServerDependencies) {
  // Boot-time production-cookie assertion is called from src/index.ts before
  // build; buildServer stays free of process-level assertions so it is safely
  // reusable from tests (server.inject) without simulating a whole boot.

  const server = Fastify({
    loggerInstance: deps.logger,
    logController: new LogController({ disableRequestLogging: false }),
    // trustProxy is configured explicitly (ADIM 10.1 §Trust proxy). Default
    // is `false` — the app trusts no forwarded headers unless the deployment
    // env says so. On Windows Server 2022 behind IIS/ARR, set
    // API_TRUST_PROXY=true (or the IP of the IIS box).
    trustProxy: deps.env.API_TRUST_PROXY,
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
  });

  // -- Security-hardening plugins (ADIM 10.1) -------------------------------
  //
  // Registration order matters:
  //   1. helmet   — sets security headers on every response, including errors
  //                 emitted by other plugins.
  //   2. cors     — must run before rate-limit so preflight OPTIONS on a
  //                 disallowed origin fails before consuming rate-limit budget.
  //   3. rate-limit — global plugin decorator; per-route budgets attach in
  //                 the auth routes.
  //   4. cookie   — must precede the auth middleware (which reads cookies).
  //   5. auth middleware, then routes.

  await server.register(fastifyHelmet, {
    // No CSP for JSON API — a CSP that breaks the eventual frontend is worse
    // than none for now; revisit when the web app has a stable shape.
    contentSecurityPolicy: false,
    // Enable HSTS only when we know we're serving over HTTPS (proxied by the
    // AUTH_COOKIE_SECURE flag, which the boot assertion pins to true in prod).
    strictTransportSecurity: deps.authEnv.AUTH_COOKIE_SECURE
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
  });

  const isProd = deps.env.NODE_ENV === 'production';
  const corsAllowlist = deps.env.CORS_ALLOWED_ORIGINS;
  if (isProd && corsAllowlist.length === 0) {
    throw new Error(
      'CORS_ALLOWED_ORIGINS must contain at least one explicit origin when NODE_ENV=production',
    );
  }
  await server.register(fastifyCors, {
    origin: (origin, cb) => {
      // Non-browser requests (curl, server-to-server) have no Origin header.
      // Fastify passes undefined; allow — CORS is a browser-defense, and
      // rejecting Origin-less requests would break health checks + tools.
      if (!origin) return cb(null, true);
      if (corsAllowlist.includes(origin)) return cb(null, true);
      // Deny by returning `false` (never reflect the caller-supplied Origin).
      cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Tenant-Id'],
    maxAge: 600,
  });

  await server.register(fastifyRateLimit, {
    // Register the plugin globally-decorated but off by default; individual
    // routes opt in with `config.rateLimit`. Keeps unauthenticated /health,
    // future public read paths etc. unaffected.
    global: false,
    // In-memory store. Redis is architecturally deferred (ADIM 10.1 §Rate
    // limiting); this per-instance limiter is correct behavior for a single-
    // node deploy and a conservative floor for a multi-node deploy.
    max: deps.env.RATE_LIMIT_AUTH_MAX,
    timeWindow: deps.env.RATE_LIMIT_AUTH_TIMEWINDOW,
    // Do not derive keys from headers we don't trust. When trustProxy is off
    // request.ip is the socket peer; when on, it's the forwarded client IP.
    keyGenerator: (req) => req.ip,
    enableDraftSpec: true,
  });
  if (!deps.env.RATE_LIMIT_ENABLED) {
    // Explicit off-switch for load-test / bulk-fixture scenarios. Emits a
    // structured warning so nobody ships prod with this flipped.
    deps.logger.warn('RATE_LIMIT_ENABLED=false; auth endpoints are NOT rate-limited');
  }

  // -- Domain plugins -------------------------------------------------------

  // Foundation-only abstractions. Real implementations land with the first workload.
  const jobs: JobQueue = deps.jobs ?? new InProcessJobQueue(deps.logger);
  const broadcaster: Broadcaster = deps.broadcaster ?? new InProcessBroadcaster();

  const authService: AuthService = createAuthService({
    db: deps.db,
    env: deps.authEnv,
    logger: deps.logger,
  });
  const oauth: OAuthRegistry = createOAuthRegistry(deps.authEnv);
  // Merchants share the auth HMAC secret (site verification tokens are hashed
  // with the same primitive as session/refresh tokens — see ADR-0015).
  const merchantService: MerchantService = createMerchantService({
    db: deps.db,
    hmacSecret: deps.authEnv.AUTH_TOKEN_HMAC_SECRET,
    logger: deps.logger,
  });
  // Feeds depend on the merchant service (site containment checks) + the
  // JobQueue for background fetch execution — ADIM 12 / ADR-0016.
  const feedService: FeedService = createFeedService({
    db: deps.db,
    env: deps.feedEnv,
    merchants: merchantService,
    jobs,
    logger: deps.logger,
  });
  feedService.registerJobHandlers(jobs);

  server.decorate('env', deps.env);
  server.decorate('db', deps.db);
  server.decorate('jobs', jobs);
  server.decorate('broadcaster', broadcaster);
  server.decorate('auth', authService);
  server.decorate('oauth', oauth);
  server.decorate('merchants', merchantService);
  server.decorate('feeds', feedService);

  // Cookie plugin must be registered before the auth middleware reads cookies.
  await server.register(fastifyCookie);
  await server.register(registerAuthMiddleware, { authService });

  await server.register(registerHealthRoutes);
  await server.register(registerAuthRoutes, {
    authService,
    rateLimit: {
      enabled: deps.env.RATE_LIMIT_ENABLED,
      max: deps.env.RATE_LIMIT_AUTH_MAX,
      timeWindow: deps.env.RATE_LIMIT_AUTH_TIMEWINDOW,
    },
    prefix: '/v1/auth',
  });
  await server.register(registerMerchantRoutes, {
    merchantService,
    prefix: '/v1/merchants',
  });
  await server.register(registerFeedRoutes, {
    feedService,
    // Rate-limit POST …/fetch only (ADIM 12.1). Read endpoints (GET feeds,
    // GET fetches) remain unlimited so a UI can freely poll fetch state.
    fetchRateLimit: {
      enabled: deps.env.RATE_LIMIT_ENABLED,
      max: deps.env.RATE_LIMIT_FEED_FETCH_MAX,
      timeWindow: deps.env.RATE_LIMIT_FEED_FETCH_TIMEWINDOW,
    },
    // Mount under /v1/merchants — feed routes are children of a site.
    prefix: '/v1/merchants',
  });

  return server;
}

declare module 'fastify' {
  interface FastifyInstance {
    env: ApiEnv;
    db: Db;
    jobs: JobQueue;
    broadcaster: Broadcaster;
    auth: AuthService;
    merchants: MerchantService;
    feeds: FeedService;
    oauth: OAuthRegistry;
  }
}
