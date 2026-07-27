-- Revoke the anon role from every view in `public`.
--
-- Supabase's default privileges grant `anon` and `authenticated` full access to
-- newly created objects. `apply_tenant_policies` revokes `anon` on the tables
-- it manages, but the reporting and inventory views were created directly and
-- inherited those defaults.
--
-- This was *not* a live leak: every view here is `security_invoker`, so reading
-- one re-checks the caller's own privileges against the tables beneath it, and
-- `anon` has none. Verified by hitting each view with the anon key — all six
-- returned `42501 permission denied`.
--
-- It is fixed anyway, because the grant is exactly one forgotten
-- `security_invoker = true` away from becoming a real breach, and defence in
-- depth is the whole point of the model. The security audit now fails the build
-- if `anon` regains any grant in `public`.

do $$
declare
  v_name text;
begin
  for v_name in
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v', 'm', 'r')
  loop
    execute format('revoke all on public.%I from anon', v_name);
  end loop;
end;
$$;

-- Stop the same defaults applying to anything created later. Supabase sets
-- these defaults for the roles that own migration objects, so both are covered.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public
  revoke all on tables from anon;
