import { defineConfig } from 'drizzle-kit';

// Drizzle Kit reads DATABASE_URL from process.env at CLI time. The runtime env
// contract is owned by src/env.ts (loadDbEnv); this file only wires the CLI.
//
// If DATABASE_URL is missing, drizzle-kit commands will fail with a clear error.
// That is the intended behavior — the CLI must never silently target an empty
// or default database.
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  casing: 'snake_case',
  strict: true,
  verbose: true,
  ...(databaseUrl ? { dbCredentials: { url: databaseUrl } } : {}),
});
