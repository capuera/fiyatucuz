import { Writable } from 'node:stream';

import { pino, type Logger } from 'pino';
import { describe, expect, it } from 'vitest';

import { LOG_REDACTION_PATHS } from '../src/lib/logger.js';

/**
 * Verify pino's redaction paths cover every sensitive field the auth surface
 * exposes. Uses a captured stream so no line reaches stdout during the test.
 */
function captureLogger(): { logger: Logger; captured: string[] } {
  const captured: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      captured.push(String(chunk));
      cb();
    },
  });
  const logger = pino(
    {
      level: 'trace',
      base: null,
      timestamp: false,
      redact: {
        paths: [...LOG_REDACTION_PATHS],
        censor: '[REDACTED]',
        remove: false,
      },
    },
    stream,
  );
  return { logger, captured };
}

const SENTINEL = 'THIS_SHOULD_NEVER_APPEAR_IN_LOGS_XYZ42';

describe('security: pino redaction (ADIM 10.1 §Pino log redaction)', () => {
  it('redacts req.headers.cookie / authorization', () => {
    const { logger, captured } = captureLogger();
    logger.info({
      req: {
        headers: {
          cookie: `fu_session=${SENTINEL}`,
          authorization: `Bearer ${SENTINEL}`,
          'set-cookie': `fu_refresh=${SENTINEL}`,
        },
      },
    });
    const line = captured.join('');
    expect(line).not.toContain(SENTINEL);
    expect(line).toContain('[REDACTED]');
  });

  it('redacts one-level-nested password / passwordHash / password_hash fields', () => {
    const { logger, captured } = captureLogger();
    logger.info({
      user: { password: SENTINEL, passwordHash: SENTINEL, password_hash: SENTINEL },
    });
    // fast-redact's `*.password` matches exactly one wildcard segment. The
    // one-level shape here (user.password) is the pattern the auth surface
    // actually uses; deeper log shapes must add specific paths.
    const line = captured.join('');
    expect(line).not.toContain(`"password":"${SENTINEL}"`);
    expect(line).not.toContain(`"passwordHash":"${SENTINEL}"`);
    expect(line).not.toContain(`"password_hash":"${SENTINEL}"`);
  });

  it('redacts sessionToken / refreshToken / tokenHash / rawToken / accessToken', () => {
    const { logger, captured } = captureLogger();
    logger.info({
      tokens: {
        sessionToken: SENTINEL,
        refreshToken: SENTINEL,
        session_token: SENTINEL,
        refresh_token: SENTINEL,
        tokenHash: SENTINEL,
        token_hash: SENTINEL,
        rawToken: SENTINEL,
        raw_token: SENTINEL,
        accessToken: SENTINEL,
        access_token: SENTINEL,
      },
    });
    const line = captured.join('');
    expect(line).not.toContain(SENTINEL);
  });

  it('redacts hmacSecret variants', () => {
    const { logger, captured } = captureLogger();
    logger.info({ config: { hmacSecret: SENTINEL, hmac_secret: SENTINEL } });
    const line = captured.join('');
    expect(line).not.toContain(SENTINEL);
  });
});
