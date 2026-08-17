import { pino, type Logger } from 'pino';

import type { ApiEnv } from '../config/env.js';

export function createLogger(env: ApiEnv): Logger {
  const isDev = env.NODE_ENV === 'development';
  return pino({
    level: env.LOG_LEVEL,
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard' },
          },
        }
      : {}),
    base: { service: 'api' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
