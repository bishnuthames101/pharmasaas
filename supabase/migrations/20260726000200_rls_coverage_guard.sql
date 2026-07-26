-- The release gate for this project's entire security model.
--
-- Isolation here is binary: one table in `public` with RLS switched off, or
-- switched on but with no policy comparing tenant_id, is a full cross-tenant
-- leak reachable with the public anon key. Human review does not catch that
-- reliably, so the invariant is machine-checked and asserted in CI.
--
-- Exposed as a function rather than a direct catalog query so the check can run
-- through PostgREST with the service key, with no separate Postgres connection.

-- Tables that legitimately hold no tenant_id, and so are exempt from the
-- tenant-scoping half of the check. They must still have RLS enabled, forced,
-- and carry at least one policy.
create table public.rls_global_tables (
  table_name text primary key,
  reason text not null,
  -- Exempts the table from `no_tenant_scoped_policy` only. The table must still
  -- carry at least one policy.
  allow_no_tenant_scope boolean not null default true,
  -- Far stronger: exempts the table from needing *any* policy, which makes it
  -- reachable only by the service role. Grant this sparingly.
  allow_no_policies boolean not null default false
);

comment on table public.rls_global_tables is
  'Allowlist of intentionally cross-tenant tables. Adding a row here is a '
  'security decision — each flag disables part of the coverage check.';

insert into public.rls_global_tables
  (table_name, reason, allow_no_tenant_scope, allow_no_policies)
values
  ('tenants',
   'The tenant registry itself; scoped by id, not tenant_id.',
   true, false),
  ('tenant_users',
   'Membership mapping; scoped by tenant_id and user_id.',
   true, false),
  ('rls_global_tables',
   'Metadata for the coverage check; deliberately service-role only.',
   true, true);

alter table public.rls_global_tables enable row level security;
alter table public.rls_global_tables force row level security;

-- No policies at all: only the service role (which bypasses RLS) may read it.
revoke all on public.rls_global_tables from anon, authenticated;

create type public.rls_gap_kind as enum (
  'rls_disabled',
  'rls_not_forced',
  'no_policies',
  'no_tenant_scoped_policy'
);

-- Reports every table in `public` that violates the isolation invariant.
-- An empty result is the pass condition.
create or replace function public.rls_coverage_gaps()
returns table (
  table_name text,
  gap public.rls_gap_kind,
  detail text
)
language sql
stable
security definer
set search_path = ''
as $$
  with public_tables as (
    select c.oid, c.relname::text as name, c.relrowsecurity, c.relforcerowsecurity
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
  ),
  policy_counts as (
    select p.polrelid, count(*) as total,
           -- A policy only counts as tenant-scoping if its USING or WITH CHECK
           -- expression actually mentions tenant_id. `using (true)` or
           -- `using (auth.uid() is not null)` are the classic fatal bugs:
           -- authenticated is not the same as authorized.
           count(*) filter (
             where pg_catalog.pg_get_expr(p.polqual, p.polrelid) like '%tenant_id%'
                or pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) like '%tenant_id%'
           ) as tenant_scoped
    from pg_catalog.pg_policy p
    group by p.polrelid
  ),
  has_tenant_column as (
    select a.attrelid
    from pg_catalog.pg_attribute a
    where a.attname = 'tenant_id'
      and a.attnum > 0
      and not a.attisdropped
  )
  select t.name, 'rls_disabled'::public.rls_gap_kind,
         'RLS is not enabled on this table.'
  from public_tables t
  where not t.relrowsecurity

  union all

  select t.name, 'rls_not_forced'::public.rls_gap_kind,
         'RLS is enabled but not FORCED, so the table owner bypasses it.'
  from public_tables t
  where t.relrowsecurity and not t.relforcerowsecurity

  union all

  select t.name, 'no_policies'::public.rls_gap_kind,
         'RLS is enabled but no policy exists, so the table is unreadable and '
         'likely misconfigured.'
  from public_tables t
  left join policy_counts pc on pc.polrelid = t.oid
  where t.relrowsecurity
    and coalesce(pc.total, 0) = 0
    and t.name not in (
      select g.table_name from public.rls_global_tables g
      where g.allow_no_policies
    )

  union all

  select t.name, 'no_tenant_scoped_policy'::public.rls_gap_kind,
         'Table has a tenant_id column but no policy referencing it.'
  from public_tables t
  join has_tenant_column htc on htc.attrelid = t.oid
  left join policy_counts pc on pc.polrelid = t.oid
  where coalesce(pc.tenant_scoped, 0) = 0
    and t.name not in (
      select g.table_name from public.rls_global_tables g
      where g.allow_no_tenant_scope
    )

  order by 1, 2
$$;

comment on function public.rls_coverage_gaps() is
  'CI release gate. Returns one row per RLS misconfiguration in the public '
  'schema; an empty result means the isolation invariant holds.';

-- Deliberately service-role only. This function describes the shape of the
-- security model, which is not something a tenant user needs or should see.
revoke execute on function public.rls_coverage_gaps() from public, anon, authenticated;
grant execute on function public.rls_coverage_gaps() to service_role;
