import { pino, type LoggerOptions, type Logger } from 'pino';

import type { ApiEnv } from '../config/env.js';

/**
 * Pino redaction paths (ADIM 10.1 §Pino log redaction).
 *
 * pino uses fast-redact for these; asterisks are wildcard path segments. The
 * paths cover every sensitive field the auth module ever names, plus the
 * Fastify request-log auto-serialized headers.
 *
 * Adding to this list is safe (fast-redact ignores paths that don't match a
 * given log record). Removing from it is a security review event.
 */
export const LOG_REDACTION_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.sessionToken',
  '*.session_token',
  '*.sessionTokenHash',
  '*.session_token_hash',
  '*.refreshToken',
  '*.refresh_token',
  '*.tokenHash',
  '*.token_hash',
  '*.rawToken',
  '*.raw_token',
  '*.accessToken',
  '*.access_token',
  '*.hmacSecret',
  '*.hmac_secret',
  // Merchant site verification (ADR-0015): raw verification challenge tokens
  // are as sensitive as auth tokens — a leaked one lets an attacker claim
  // ownership of a domain.
  '*.verificationToken',
  '*.verification_token',
  '*.verificationTokenHash',
  '*.verification_token_hash',
];

export function createLogger(env: ApiEnv): Logger {
  const isDev = env.NODE_ENV === 'development';
  const opts: LoggerOptions = {
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
    redact: {
      paths: [...LOG_REDACTION_PATHS],
      censor: '[REDACTED]',
      remove: false,
    },
  };
  return pino(opts);
}
