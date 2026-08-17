import type { ZodError, ZodTypeAny, z } from 'zod';

export class EnvError extends Error {
  constructor(
    message: string,
    public readonly zodError: ZodError,
  ) {
    super(message);
    this.name = 'EnvError';
  }
}

/**
 * Parse an environment-record against a Zod schema.
 * Callers pass their platform's env (e.g. `process.env`, `import.meta.env`) explicitly
 * so this package stays platform-agnostic.
 * Throws `EnvError` with a readable summary on failure — never returns a partial value.
 */
export function loadEnv<S extends ZodTypeAny>(
  schema: S,
  source: Record<string, string | undefined>,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const summary = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new EnvError(`Invalid environment: ${summary}`, result.error);
  }
  return result.data;
}
