-- Tenancy core: the tenant registry, the membership table, and the helper
-- functions that every Row Level Security policy in this database is built on.
--
-- Isolation model: one shared database, one `tenant_id` column per domain
-- table, and RLS policies comparing that column to a claim carried in the
-- caller's JWT. Postgres is the security boundary — application code is never
-- trusted to filter by tenant.
--
-- Note on schema placement: the reference design put these helpers in the
-- `auth` schema. Supabase manages `auth` and may drop custom objects there
-- during an upgrade, so they live in `public` instead. Behaviour in policies is
-- identical.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  status text not null default 'active' check (status in ('active', 'suspended')),
  plan text not null default 'trial',
  created_at timestamptz not null default now(),

  -- Mirrors src/lib/tenant/subdomain.ts. Slugs become subdomains, so they must
  -- be DNS-safe; the reserved-name list is enforced in the signup path rather
  -- than here so it can evolve without a migration.
  constraint tenants_slug_format check (
    slug ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$' and length(slug) >= 2
  )
);

comment on table public.tenants is
  'One row per pharmacy. `slug` is the subdomain and the path segment.';

create table public.tenant_users (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'pharmacist', 'cashier')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

comment on table public.tenant_users is
  'Source of truth for who belongs to which pharmacy and in what role. The JWT '
  'claim is a cache of this; role-gated policies re-read this table.';

-- Listing "which pharmacies do I belong to" is a per-user lookup, and the
-- primary key leads with tenant_id, so it needs its own index.
create index tenant_users_user_id_idx on public.tenant_users (user_id);

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------

-- The active tenant, read straight from the JWT.
--
-- `app_metadata` is writable only by the service role, so a user cannot forge
-- this claim (unlike `user_metadata`, which they can edit freely).
--
-- SECURITY INVOKER: touches no tables, so there is nothing to escalate.
-- STABLE: lets the planner evaluate it once per statement instead of per row.
create or replace function public.tenant_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select nullif(
    auth.jwt() -> 'app_metadata' ->> 'tenant_id',
    ''
  )::uuid
$$;

comment on function public.tenant_id() is
  'Active tenant from the JWT app_metadata claim. Null when unauthenticated '
  'or when the user has not selected a tenant.';

-- The caller's role in their active tenant, re-read from the membership table.
--
-- SECURITY DEFINER is required, not merely convenient: this function is called
-- from the RLS policies on `tenant_users` itself, so if it read that table
-- under the caller's own RLS it would recurse infinitely. Defining it away from
-- RLS breaks the cycle. It leaks nothing — it returns only the caller's own
-- role, derived from auth.uid(), and accepts no parameters.
create or replace function public.tenant_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select tu.role
  from public.tenant_users tu
  where tu.tenant_id = public.tenant_id()
    and tu.user_id = auth.uid()
    and tu.is_active
$$;

comment on function public.tenant_role() is
  'Caller''s role in their active tenant, re-verified against tenant_users so a '
  'stale JWT cannot outlive a revoked membership.';

-- Whether the caller has an active membership in a given tenant.
--
-- SECURITY DEFINER for the same anti-recursion reason as tenant_role(): it is
-- used by the `tenants` select policy, which must not re-enter tenant_users
-- policies. Scoped to auth.uid(), so it cannot be used to probe other users.
create or replace function public.is_tenant_member(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_users tu
    where tu.tenant_id = p_tenant_id
      and tu.user_id = auth.uid()
      and tu.is_active
  )
$$;

comment on function public.is_tenant_member(uuid) is
  'True when the caller has an active membership in the given tenant. Used by '
  'the tenant switcher, which must see tenants outside the active JWT claim.';

revoke execute on function public.tenant_id() from public;
revoke execute on function public.tenant_role() from public;
revoke execute on function public.is_tenant_member(uuid) from public;

grant execute on function public.tenant_id() to authenticated;
grant execute on function public.tenant_role() to authenticated;
grant execute on function public.is_tenant_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
--
-- FORCE is applied alongside ENABLE so that even the table owner is subject to
-- the policies. The service role still bypasses RLS — that is a role attribute
-- (BYPASSRLS), which FORCE does not affect — which is exactly why service-role
-- usage is confined to src/lib/supabase/admin.ts.
--
-- Helper calls are wrapped in `(select ...)` so Postgres hoists them into an
-- InitPlan and evaluates them once per statement rather than once per row.

alter table public.tenants enable row level security;
alter table public.tenants force row level security;

-- A user sees their active tenant plus any other pharmacy they belong to, so
-- the tenant switcher can render without service-role access.
create policy tenants_select on public.tenants
  for select to authenticated
  using (
    id = (select public.tenant_id())
    or (select public.is_tenant_member(id))
  );

-- Only an owner may rename or re-plan their own pharmacy. Creation and
-- deletion have no policy at all: signup runs through a security definer
-- function and deletion is a platform-admin action.
create policy tenants_update on public.tenants
  for update to authenticated
  using (
    id = (select public.tenant_id())
    and (select public.tenant_role()) = 'owner'
  )
  with check (
    id = (select public.tenant_id())
    and (select public.tenant_role()) = 'owner'
  );

alter table public.tenant_users enable row level security;
alter table public.tenant_users force row level security;

-- Two distinct reads are needed: the staff list for the active pharmacy, and
-- the caller's own memberships across pharmacies (for the tenant switcher).
create policy tenant_users_select on public.tenant_users
  for select to authenticated
  using (
    tenant_id = (select public.tenant_id())
    or user_id = (select auth.uid())
  );

-- Staff management is owner-only, and confined to the active tenant. The
-- `with check` on insert is what stops a caller from granting themselves
-- membership in someone else's pharmacy.
create policy tenant_users_insert on public.tenant_users
  for insert to authenticated
  with check (
    tenant_id = (select public.tenant_id())
    and (select public.tenant_role()) = 'owner'
  );

create policy tenant_users_update on public.tenant_users
  for update to authenticated
  using (
    tenant_id = (select public.tenant_id())
    and (select public.tenant_role()) = 'owner'
  )
  with check (
    tenant_id = (select public.tenant_id())
    and (select public.tenant_role()) = 'owner'
  );

create policy tenant_users_delete on public.tenant_users
  for delete to authenticated
  using (
    tenant_id = (select public.tenant_id())
    and (select public.tenant_role()) = 'owner'
  );

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- Supabase grants table privileges to `anon` and `authenticated` by default via
-- role defaults. Nothing here should be reachable anonymously, so `anon` is
-- revoked explicitly; RLS then narrows what `authenticated` can actually touch.

revoke all on public.tenants from anon;
revoke all on public.tenant_users from anon;

grant select, update on public.tenants to authenticated;
grant select, insert, update, delete on public.tenant_users to authenticated;
