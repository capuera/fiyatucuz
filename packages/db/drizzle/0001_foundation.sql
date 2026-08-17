-- FiyatUcuz — Foundation migration (0001_foundation.sql)
--
-- Purpose: establish the database-level primitives required before any bounded
-- context contributes a table. Hand-written per ADR-0012 (Database Foundation).
--
-- Contents
--   1. Extensions: pgcrypto, pg_trgm
--   2. Application role: fiyatucuz_app (RLS-enforced, NOLOGIN, no elevated privs)
--   3. Reporting role: fiyatucuz_reporting (BYPASSRLS, NOLOGIN, no writes)
--   4. Baseline schema privileges: USAGE on public only
--
-- Deliberately does NOT do:
--   - CREATE TABLE (no domain schema in this sprint)
--   - GRANT anything beyond schema USAGE (per-table grants land with each
--     domain migration alongside the tables they protect)
--   - CREATE LOGIN credentials or store any password (secrets live outside the
--     migration; ops provisions login roles that inherit from these roles)
--
-- Idempotent: safe to re-run on any state. The wrapping transaction is
-- provided by the migrator (packages/db/src/migrator.ts); do NOT add BEGIN /
-- COMMIT here.

-- 1. Extensions -------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Application role -------------------------------------------------------
--
-- fiyatucuz_app is the everyday role every module transacts as.
--
-- Attributes:
--   NOLOGIN        — credentials are provisioned outside the migration; a
--                    login role GRANT'ed into fiyatucuz_app is the standard
--                    pattern.
--   NOSUPERUSER    — RLS applies. Superuser would bypass every security
--                    check (RLS, permissions, constraints) and defeat the
--                    point of the role.
--   NOCREATEDB     — no reason for the app role to create databases.
--   NOCREATEROLE   — no reason for the app role to create/alter roles.
--   NOREPLICATION  — no reason for the app role to touch the WAL/replication.
--   (implicit NOBYPASSRLS — this role MUST be subject to RLS policies)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fiyatucuz_app') THEN
    CREATE ROLE fiyatucuz_app
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION;
  ELSE
    -- Self-heal: enforce the intended attributes even if the role pre-exists.
    ALTER ROLE fiyatucuz_app
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS;
  END IF;
END
$$;

-- 3. Reporting role ---------------------------------------------------------
--
-- fiyatucuz_reporting is the read-heavy analytics role.
--
-- BYPASSRLS — this is the ONLY supported mechanism to read across all tenants
-- without RLS filtering. Common misconception: `SET row_security = off` does
-- NOT bypass RLS; it merely raises an error if any policy would have been
-- applied (a pg_dump safety check). BYPASSRLS is the correct primitive.
--
-- Risk mitigation for BYPASSRLS:
--   - NOLOGIN in this migration — the role has no credentials at all yet.
--     Ops will later create a LOGIN role and GRANT'ed it into fiyatucuz_
--     reporting, injecting credentials only into reporting workers.
--   - No INSERT / UPDATE / DELETE grants; per-table SELECT grants land with
--     each domain migration and are the reporting role's only permissions.
--   - Reporting code paths never touch tenant-authenticated request handling
--     (see packages/db/src/reporting.ts: separate handle, separate env var).
--   - withReportingTransaction sets SET TRANSACTION READ ONLY as belt-and-
--     suspenders enforcement, so even a mistaken write grant cannot mutate.
--   - NOSUPERUSER — superuser bypasses every check (RLS, permissions,
--     constraints); BYPASSRLS is the minimum privilege for the requirement.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fiyatucuz_reporting') THEN
    CREATE ROLE fiyatucuz_reporting
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      BYPASSRLS;
  ELSE
    ALTER ROLE fiyatucuz_reporting
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      BYPASSRLS;
  END IF;
END
$$;

-- 4. Baseline schema privileges --------------------------------------------
--
-- Foundation-level only: both roles need USAGE on the `public` schema so
-- future GRANTs on individual tables can take effect.
--
-- Deliberately does NOT grant blanket SELECT / INSERT / UPDATE / DELETE on
-- future tables. Every domain migration must issue explicit per-table grants
-- appropriate to the table (owner-write for the app role, SELECT for the
-- reporting role). This keeps privileges auditable per table and prevents a
-- forgotten grant from ever silently escalating.

GRANT USAGE ON SCHEMA public TO fiyatucuz_app;
GRANT USAGE ON SCHEMA public TO fiyatucuz_reporting;
