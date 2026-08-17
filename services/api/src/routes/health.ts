import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

/**
 * Foundation health endpoints.
 * - GET /health: liveness — the process is up.
 * - GET /ready: readiness — the process is up AND declared dependencies are usable.
 *   Currently identical to /health because no dependencies are wired yet.
 */
export const registerHealthRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  server.get('/health', async () => ({ status: 'ok' as const }));

  server.get('/ready', async () => ({ status: 'ok' as const, dependencies: {} }));
};
