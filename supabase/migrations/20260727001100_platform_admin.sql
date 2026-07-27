-- Platform administration.
--
-- This is the one surface that legitimately sees across tenants, which makes it
-- the most dangerous code in the project. Two rules follow:
--
--   1. Membership of `platform_admins` is not grantable from the application.
--      The table has no policies at all, so only the service role can read it
--      and only a migration or the Supabase dashboard can add a row. A platform
--      admin cannot promote anyone, including themselves.
--   2. Being a platform admin conveys nothing inside a tenant. It is a separate
--      axis from `tenant_users.role`, so it cannot be used to quietly acquire
--      owner rights in a pharmacy.

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  note text,
  created_at timestamptz not null default now()
);

comment on table public.platform_admins is
  'Operators of the platform itself. No RLS policies: service-role only, so '
  'this list cannot be modified through the application under any role.';

alter table public.platform_admins enable row level security;
alter table public.platform_admins force row level security;
revoke all on public.platform_admins from anon, authenticated;

insert into public.rls_global_tables
  (table_name, reason, allow_no_tenant_scope, allow_no_policies)
values
  ('platform_admins',
   'Platform operator list; deliberately unreachable from the application.',
   true, true);

-- ---------------------------------------------------------------------------
-- Tenant overview
-- ---------------------------------------------------------------------------
--
-- Deliberately a function granted to `service_role` only, not a view. A view
-- would be reachable by any authenticated caller the moment someone forgot a
-- policy; a function that `authenticated` cannot execute has no such failure
-- mode.
--
-- It reports counts and totals — never the contents of anyone's records.
create or replace function public.platform_tenant_overview()
returns table (
  id uuid,
  slug text,
  name text,
  status text,
  plan text,
  created_at timestamptz,
  user_count bigint,
  medicine_count bigint,
  sale_count bigint,
  last_sale_at timestamptz,
  sales_total numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    t.id, t.slug, t.name, t.status, t.plan, t.created_at,
    (select count(*) from public.tenant_users tu
      where tu.tenant_id = t.id and tu.is_active),
    (select count(*) from public.medicines m where m.tenant_id = t.id),
    (select count(*) from public.sales s where s.tenant_id = t.id),
    (select max(s.sale_date) from public.sales s where s.tenant_id = t.id),
    (select coalesce(sum(s.total), 0) from public.sales s
      where s.tenant_id = t.id and s.status <> 'void')
  from public.tenants t
  order by t.created_at desc
$$;

revoke execute on function public.platform_tenant_overview()
  from public, anon, authenticated;
grant execute on function public.platform_tenant_overview() to service_role;

-- ---------------------------------------------------------------------------
-- Suspend and reactivate
-- ---------------------------------------------------------------------------
--
-- Service-role only, and audited into the affected tenant's own audit log so
-- the pharmacy can see that it happened and when.
create or replace function public.platform_set_tenant_status(
  p_tenant_id uuid,
  p_status text,
  p_actor uuid default null
)
returns public.tenants
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant public.tenants;
begin
  if p_status not in ('active', 'suspended') then
    raise exception 'Status must be active or suspended'
      using errcode = 'check_violation';
  end if;

  update public.tenants
  set status = p_status
  where id = p_tenant_id
  returning * into v_tenant;

  if not found then
    raise exception 'Unknown tenant' using errcode = 'foreign_key_violation';
  end if;

  insert into public.audit_log (tenant_id, actor, action, entity, entity_id, after)
  values (p_tenant_id, p_actor, 'platform.tenant_status', 'tenants',
          p_tenant_id::text, jsonb_build_object('status', p_status));

  return v_tenant;
end;
$$;

revoke execute on function public.platform_set_tenant_status(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.platform_set_tenant_status(uuid, text, uuid)
  to service_role;
