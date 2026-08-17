import { randomUUID } from 'node:crypto';

import fastifyCookie from '@fastify/cookie';
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

export interface ServerDependencies {
  env: ApiEnv;
  authEnv: AuthEnv;
  logger: Logger;
  db: Db;
  jobs?: JobQueue;
  broadcaster?: Broadcaster;
}

// Return type is inferred so pino's Logger flows through cleanly instead of being
// widened to Fastify's stricter FastifyBaseLogger (which trips `exactOptionalPropertyTypes`).
export async function buildServer(deps: ServerDependencies) {
  const server = Fastify({
    loggerInstance: deps.logger,
    logController: new LogController({ disableRequestLogging: false }),
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
  });

  // Foundation-only abstractions. Real implementations land with the first workload.
  const jobs: JobQueue = deps.jobs ?? new InProcessJobQueue(deps.logger);
  const broadcaster: Broadcaster = deps.broadcaster ?? new InProcessBroadcaster();

  const authService: AuthService = createAuthService({
    db: deps.db,
    env: deps.authEnv,
    logger: deps.logger,
  });
  const oauth: OAuthRegistry = createOAuthRegistry(deps.authEnv);

  server.decorate('env', deps.env);
  server.decorate('db', deps.db);
  server.decorate('jobs', jobs);
  server.decorate('broadcaster', broadcaster);
  server.decorate('auth', authService);
  server.decorate('oauth', oauth);

  // Cookie plugin must be registered before the auth middleware reads cookies.
  await server.register(fastifyCookie);
  await server.register(registerAuthMiddleware, { authService });

  await server.register(registerHealthRoutes);
  await server.register(registerAuthRoutes, { authService, prefix: '/v1/auth' });

  return server;
}

declare module 'fastify' {
  interface FastifyInstance {
    env: ApiEnv;
    db: Db;
    jobs: JobQueue;
    broadcaster: Broadcaster;
    auth: AuthService;
    oauth: OAuthRegistry;
  }
}
