# @fiyatucuz/config

Shared configuration helpers.

Currently provides:

- `loadEnv(schema)` — validate `process.env` (or any equivalent record) against a Zod schema; throws `EnvError` on failure.
