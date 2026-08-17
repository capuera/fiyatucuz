-- FiyatUcuz — Auth bootstrap (0003_auth_bootstrap.sql)
--
-- Resolves the "authentication bootstrap vs RLS" tension documented in
-- ADR-0013. When a user signs in, the auth service must enumerate the
-- tenants that user belongs to BEFORE any tenant context has been chosen.
-- Under RLS on tenant_users, fiyatucuz_app cannot perform that cross-tenant
-- read.
--
-- Solution: a narrowly scoped SECURITY DEFINER function owned by a dedicated
-- NOLOGIN, NOSUPERUSER, BYPASSRLS role (fiyatucuz_secdef). The function's
-- SQL is hard-coded to filter by the caller-supplied user id and cannot
-- mutate anything.
--
-- What this migration does NOT do:
--   - Does NOT grant BYPASSRLS to fiyatucuz_app.
--   - Does NOT weaken FORCE ROW LEVEL SECURITY on tenant_users.
--   - Does NOT introduce any login role with elevated privilege.
--   - Does NOT provide any INSERT / UPDATE / DELETE capability.
--
-- Idempotent. Safe under the migrator's per-file transaction wrapper (do
-- NOT add BEGIN / COMMIT).

-- =========================================================================
-- 1. fiyatucuz_secdef — owner of SECURITY DEFINER helpers
-- =========================================================================
--
-- Purpose: to own SECURITY DEFINER functions that must bypass RLS on a
-- very narrow, function-body-hard-coded query. This role:
--   - NEVER logs in (NOLOGIN)
--   - is NOT SUPERUSER (superuser would defeat every check)
--   - has BYPASSRLS so its owned functions can read RLS-protected tables
--     from within the function body only
--   - has no permissions on any table except those granted per function
--     (currently: SELECT on tenant_users)
--   - is not a role membership target for any application role
--
-- Nobody can `SET ROLE fiyatucuz_secdef` except superuser and members of
-- this role (there are none). Application code cannot escalate into it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fiyatucuz_secdef') THEN
    CREATE ROLE fiyatucuz_secdef
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      BYPASSRLS;
  ELSE
    ALTER ROLE fiyatucuz_secdef
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      BYPASSRLS;
  END IF;
END
$$;

-- fiyatucuz_secdef needs USAGE on public to reach tenant_users; it needs
-- SELECT on tenant_users because BYPASSRLS only skips RLS evaluation — it
-- does NOT grant object privileges.
GRANT USAGE  ON SCHEMA public   TO fiyatucuz_secdef;
GRANT SELECT ON tenant_users    TO fiyatucuz_secdef;

-- =========================================================================
-- 2. auth_bootstrap_memberships(p_user_id uuid)
-- =========================================================================
--
-- Returns every tenant_users row for the caller-supplied user id. Intended
-- to be called during authentication bootstrap — after we know WHO logged
-- in, but before we know WHICH tenant they've selected.
--
-- Security controls layered here:
--   - SECURITY DEFINER      — runs with owner privileges (fiyatucuz_secdef),
--                             which is the ONLY thing that lets it bypass
--                             RLS on tenant_users.
--   - SET search_path       — pg_catalog first, pg_temp last; nothing in
--                             the caller's search_path can shadow any
--                             identifier resolved inside the function.
--   - LANGUAGE sql          — static SQL only. No PL/pgSQL. No EXECUTE. No
--                             dynamic SQL is possible.
--   - STABLE                — cannot mutate; the planner may cache; and
--                             tests can assert this attribute.
--   - Fully qualified public.tenant_users — bypass-immune to any temp/user
--                             table with the same name.
--   - Hard-coded WHERE user_id = p_user_id — the only tenant_users rows
--                             the function can ever return are the ones
--                             belonging to the passed user.
--   - EXECUTE granted only to fiyatucuz_app; REVOKEd from PUBLIC and never
--                             granted to fiyatucuz_reporting.
--
-- Threat model note: the caller (fiyatucuz_app) is trusted to pass the
-- authenticated user's own id. That is the application's authentication
-- responsibility; if the application is compromised, so is the session.
-- The function will not leak across-user data on its own — passing user X
-- returns only X's rows, and X's rows only. An extra `app.user_id` GUC
-- cross-check is possible in a later sprint if we want defense in depth.

CREATE OR REPLACE FUNCTION public.auth_bootstrap_memberships(p_user_id uuid)
RETURNS TABLE (
  id            uuid,
  tenant_id     uuid,
  user_id       uuid,
  role          tenant_member_role,
  status        tenant_member_status,
  created_at    timestamptz,
  updated_at    timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
STABLE
AS $$
  SELECT
    tu.id,
    tu.tenant_id,
    tu.user_id,
    tu.role,
    tu.status,
    tu.created_at,
    tu.updated_at
  FROM public.tenant_users tu
  WHERE tu.user_id = p_user_id
$$;

-- Ownership transfer must happen after CREATE OR REPLACE (the OR-REPLACE
-- path leaves the existing owner in place; a fresh CREATE assigns to the
-- caller). Idempotent.
ALTER FUNCTION public.auth_bootstrap_memberships(uuid) OWNER TO fiyatucuz_secdef;

-- Defense-in-depth: PostgreSQL 15+ no longer grants EXECUTE to PUBLIC by
-- default, but we REVOKE explicitly anyway so this migration is correct on
-- older majors too and audits the intent.
REVOKE EXECUTE ON FUNCTION public.auth_bootstrap_memberships(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.auth_bootstrap_memberships(uuid) TO fiyatucuz_app;
-- Deliberately NOT granting EXECUTE to fiyatucuz_reporting: reporting has
-- BYPASSRLS itself, does not need this helper, and giving it EXECUTE would
-- widen the surface for no benefit.
