-- Instant onboarding: the settings a new pharmacy starts with, the reserved
-- slug registry, and the function that provisions a tenant atomically.
--
-- The whole point of the shared-database model is that signup is a few inserts
-- rather than a provisioning pipeline. What matters is that those inserts are
-- all-or-nothing: a tenant with no owner membership is an unreachable orphan,
-- and a tenant with no settings row breaks the POS on first sale.

-- ---------------------------------------------------------------------------
-- Per-pharmacy settings
-- ---------------------------------------------------------------------------

create table public.settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  pharmacy_name text,
  address text,
  phone text,
  currency text not null default 'NPR',
  tax_mode text not null default 'exclusive'
    check (tax_mode in ('exclusive', 'inclusive')),
  default_tax_rate numeric not null default 13,
  expiry_alert_days int[] not null default '{30,60,90}',
  invoice_prefix text not null default 'INV',

  -- Per-tenant invoice counter. Deliberately a column under a row lock rather
  -- than a Postgres sequence: sequences are global and non-transactional, so
  -- they would both interleave numbers across pharmacies and leave gaps on
  -- rollback. Tax authorities generally require gapless per-entity numbering.
  next_invoice_seq bigint not null default 1,

  low_stock_threshold_default int not null default 10,
  created_at timestamptz not null default now()
);

comment on table public.settings is
  'One row per pharmacy, created during signup. Holds the invoice counter.';

comment on column public.settings.next_invoice_seq is
  'Next invoice number. Incremented under FOR UPDATE inside complete_sale to '
  'keep numbering gapless and per-tenant.';

alter table public.settings enable row level security;
alter table public.settings force row level security;

-- Everyone in the pharmacy needs to read settings (the POS needs tax mode,
-- currency and invoice prefix), but only an owner may change them.
create policy settings_select on public.settings
  for select to authenticated
  using (tenant_id = (select public.tenant_id()));

create policy settings_update on public.settings
  for update to authenticated
  using (
    tenant_id = (select public.tenant_id())
    and (select public.tenant_role()) = 'owner'
  )
  with check (
    tenant_id = (select public.tenant_id())
    and (select public.tenant_role()) = 'owner'
  );

-- No insert or delete policy: rows are created by provision_tenant() and
-- removed only by cascade when the tenant is deleted.

revoke all on public.settings from anon;
grant select, update on public.settings to authenticated;

-- ---------------------------------------------------------------------------
-- Reserved slugs
-- ---------------------------------------------------------------------------
--
-- Kept in the database so registration cannot be bypassed by calling the API
-- directly. The application keeps its own copy in src/lib/tenant/subdomain.ts
-- because the proxy must resolve routes without a database round trip; a test
-- in the RLS suite asserts the two lists agree.

create table public.reserved_slugs (
  slug text primary key,
  reason text
);

insert into public.reserved_slugs (slug, reason) values
  ('admin', 'Platform admin surface'),
  ('api', 'Infrastructure'),
  ('app', 'Infrastructure'),
  ('assets', 'Infrastructure'),
  ('auth', 'Infrastructure'),
  ('blog', 'Marketing surface'),
  ('cdn', 'Infrastructure'),
  ('dashboard', 'Ambiguous with the tenant dashboard'),
  ('demo', 'Reserved for sales demos'),
  ('dev', 'Environment name'),
  ('docs', 'Marketing surface'),
  ('ftp', 'Infrastructure'),
  ('help', 'Support surface'),
  ('localhost', 'Reserved hostname'),
  ('mail', 'Infrastructure'),
  ('signup', 'Marketing surface'),
  ('staging', 'Environment name'),
  ('static', 'Infrastructure'),
  ('status', 'Status page'),
  ('support', 'Support surface'),
  ('test', 'Environment name'),
  ('www', 'Reserved hostname');

alter table public.reserved_slugs enable row level security;
alter table public.reserved_slugs force row level security;

-- No policies: reachable only through the security definer functions below and
-- by the service role. Registered in the coverage allowlist accordingly.
revoke all on public.reserved_slugs from anon, authenticated;

insert into public.rls_global_tables
  (table_name, reason, allow_no_tenant_scope, allow_no_policies)
values
  ('reserved_slugs',
   'Platform-wide registration blocklist; read only via definer functions.',
   true, true);

-- ---------------------------------------------------------------------------
-- Slug availability
-- ---------------------------------------------------------------------------

-- Called from the signup form as the user types.
--
-- SECURITY DEFINER so it can consult `tenants` and `reserved_slugs` without
-- granting anonymous visitors read access to either. It answers one boolean
-- about a slug the caller already chose, so it reveals only whether a given
-- subdomain is taken — which is inherently public once that subdomain resolves.
create or replace function public.slug_available(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_slug is not null
    and p_slug ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'
    and length(p_slug) between 2 and 32
    and not exists (select 1 from public.reserved_slugs r where r.slug = p_slug)
    and not exists (select 1 from public.tenants t where t.slug = p_slug)
$$;

comment on function public.slug_available(text) is
  'True when a slug is well formed, not reserved, and not already taken.';

revoke execute on function public.slug_available(text) from public;
grant execute on function public.slug_available(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tenant provisioning
-- ---------------------------------------------------------------------------

-- Creates a pharmacy, its owner membership, and its settings row as one unit.
--
-- A plpgsql function body runs inside the calling statement's transaction, so
-- any failure here rolls back all three inserts — there is no window in which a
-- tenant exists without an owner.
--
-- Granted to `service_role` only, never to `authenticated`. It takes the owner's
-- user id as a parameter, so exposing it to end users would let anyone create a
-- pharmacy owned by someone else. The server action calls it with the admin
-- client after it has created the auth user itself.
create or replace function public.provision_tenant(
  p_slug text,
  p_name text,
  p_owner_id uuid,
  p_phone text default null,
  p_address text default null
)
returns public.tenants
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant public.tenants;
  v_slug text := lower(trim(p_slug));
begin
  if not public.slug_available(v_slug) then
    raise exception 'Slug "%" is unavailable', v_slug
      using errcode = 'unique_violation';
  end if;

  if p_owner_id is null then
    raise exception 'An owner is required to provision a tenant'
      using errcode = 'null_value_not_allowed';
  end if;

  insert into public.tenants (slug, name)
  values (v_slug, trim(p_name))
  returning * into v_tenant;

  insert into public.tenant_users (tenant_id, user_id, role)
  values (v_tenant.id, p_owner_id, 'owner');

  insert into public.settings (tenant_id, pharmacy_name, phone, address)
  values (v_tenant.id, trim(p_name), p_phone, p_address);

  return v_tenant;
end;
$$;

comment on function public.provision_tenant(text, text, uuid, text, text) is
  'Atomically creates a pharmacy, its owner membership, and its settings row. '
  'Service-role only: it trusts p_owner_id.';

revoke execute on function public.provision_tenant(text, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.provision_tenant(text, text, uuid, text, text)
  to service_role;
