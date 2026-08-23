import { createDbHandle, loadDbEnv } from '@fiyatucuz/db';

import { buildServer } from './server.js';
import { loadApiEnv } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { assertProductionCookieSecurity, loadAuthEnv } from './modules/auth/index.js';
import { assertProductionFeedFetchSafety, loadFeedEnv } from './modules/feeds/index.js';

async function main(): Promise<void> {
  const env = loadApiEnv();
  const logger = createLogger(env);

  // Load DB env separately so its schema and error messages are owned by
  // @fiyatucuz/db. createDbHandle is lazy — no TCP connection is opened here,
  // so this call is safe even when PostgreSQL is unreachable (liveness must
  // not depend on DB, per ADR-0012).
  const dbEnv = loadDbEnv();
  const dbHandle = createDbHandle(dbEnv);

  // Auth env owns AUTH_TOKEN_HMAC_SECRET and cookie / TTL configuration.
  // Fails fast if the HMAC secret is missing (see ADR-0014).
  const authEnv = loadAuthEnv();

  // Boot-time refuse-to-start when production would ship insecure cookies
  // (ADIM 10.1 §Production cookie security).
  assertProductionCookieSecurity(authEnv, env.NODE_ENV);

  // Feed env owns fetch timeouts, byte cap, redirect cap, user-agent, and
  // the TEST-ONLY private-address bypass. Boot-fails if the bypass is on
  // in production (ADR-0016 §SSRF).
  const feedEnv = loadFeedEnv();
  assertProductionFeedFetchSafety(feedEnv, env.NODE_ENV);

  const server = await buildServer({ env, authEnv, feedEnv, logger, db: dbHandle.db });

  try {
    await server.listen({ host: env.API_HOST, port: env.API_PORT });
  } catch (err) {
    logger.error({ err }, 'failed to start api');
    await dbHandle.close().catch(() => {
      /* already failing; nothing to do */
    });
    process.exit(1);
  }

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    try {
      await server.close();
      await dbHandle.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
