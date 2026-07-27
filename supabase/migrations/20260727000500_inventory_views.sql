-- Inventory read models, and an extension to the coverage gate to cover views.
--
-- A view in Postgres runs with the privileges of its *owner* unless created
-- `with (security_invoker = true)`. Since these views are owned by the
-- migration role, an ordinary view over `medicines` would return every
-- pharmacy's rows to every caller — RLS silently skipped, no error anywhere.
-- That is the same class of failure the coverage gate exists to catch, and it
-- could not see views. Now it can.

-- ---------------------------------------------------------------------------
-- Full-text search column
-- ---------------------------------------------------------------------------
--
-- The expression index from the domain migration cannot be used by PostgREST's
-- `textSearch`, which needs a real column. A generated column keeps the vector
-- in sync automatically — there is no trigger to forget.

alter table public.medicines
  add column search_vector tsvector
  generated always as (
    to_tsvector('simple',
      coalesce(name, '') || ' ' ||
      coalesce(generic_name, '') || ' ' ||
      coalesce(composition, '') || ' ' ||
      coalesce(barcode, '') || ' ' ||
      coalesce(manufacturer, ''))
  ) stored;

drop index if exists public.medicines_search_idx;
create index medicines_search_idx on public.medicines using gin (search_vector);

-- ---------------------------------------------------------------------------
-- Stock on hand per medicine
-- ---------------------------------------------------------------------------
--
-- Stock is a property of batches, but every inventory screen wants it per
-- medicine. Computing it in a view keeps that aggregation in one place instead
-- of in each query.

create view public.medicine_stock
with (security_invoker = true) as
select
  m.id,
  m.tenant_id,
  m.name,
  m.generic_name,
  m.composition,
  m.strength,
  m.form,
  m.manufacturer,
  m.category,
  m.rack_location,
  m.barcode,
  m.unit,
  m.units_per_pack,
  m.packs_per_box,
  m.is_prescription_required,
  m.is_controlled,
  m.tax_rate,
  m.min_stock,
  m.max_stock,
  m.is_active,
  m.created_at,
  coalesce(s.stock_on_hand, 0) as stock_on_hand,
  -- What can actually be sold today. Expired units are still physically
  -- present and still need writing off, so they are counted separately rather
  -- than simply ignored.
  coalesce(s.saleable_on_hand, 0) as saleable_on_hand,
  coalesce(s.expired_on_hand, 0) as expired_on_hand,
  s.nearest_expiry,
  coalesce(s.batch_count, 0) as batch_count,
  (m.min_stock is not null
   and coalesce(s.saleable_on_hand, 0) < m.min_stock) as is_low_stock
from public.medicines m
left join lateral (
  select
    sum(b.qty_available) as stock_on_hand,
    sum(b.qty_available) filter (where b.expiry_date > current_date)
      as saleable_on_hand,
    sum(b.qty_available) filter (where b.expiry_date <= current_date)
      as expired_on_hand,
    min(b.expiry_date) filter (where b.qty_available > 0) as nearest_expiry,
    count(*) filter (where b.qty_available > 0) as batch_count
  from public.batches b
  where b.medicine_id = m.id
    and b.tenant_id = m.tenant_id
) s on true;

comment on view public.medicine_stock is
  'Medicines with stock aggregated from batches. security_invoker, so the '
  'caller''s RLS on medicines and batches applies.';

grant select on public.medicine_stock to authenticated;

-- ---------------------------------------------------------------------------
-- Expiry board
-- ---------------------------------------------------------------------------
--
-- Buckets come from settings.expiry_alert_days rather than being hardcoded,
-- because how far ahead a pharmacy wants to worry is a business decision.

create view public.batch_expiry_board
with (security_invoker = true) as
select
  b.id as batch_id,
  b.tenant_id,
  b.medicine_id,
  m.name as medicine_name,
  m.unit,
  b.batch_no,
  b.expiry_date,
  b.qty_available,
  b.selling_price,
  (b.expiry_date - current_date) as days_to_expiry,
  case
    when b.expiry_date <= current_date then 'expired'
    when b.expiry_date <= current_date + coalesce(st.expiry_alert_days[1], 30)
      then 'critical'
    when b.expiry_date <= current_date + coalesce(st.expiry_alert_days[2], 60)
      then 'warning'
    when b.expiry_date <= current_date + coalesce(st.expiry_alert_days[3], 90)
      then 'notice'
    else 'ok'
  end as bucket
from public.batches b
join public.medicines m
  on m.id = b.medicine_id and m.tenant_id = b.tenant_id
join public.settings st on st.tenant_id = b.tenant_id
where b.qty_available > 0;

comment on view public.batch_expiry_board is
  'Live batches bucketed by expiry using settings.expiry_alert_days.';

grant select on public.batch_expiry_board to authenticated;

-- ---------------------------------------------------------------------------
-- Coverage gate: now checks views too
-- ---------------------------------------------------------------------------
--
-- Returning `gap` as text rather than the enum, because adding a value to an
-- enum cannot be used in the same transaction that adds it, and migrations run
-- in one. Text keeps the gate extensible.

drop function if exists public.rls_coverage_gaps();
drop type if exists public.rls_gap_kind;

create or replace function public.rls_coverage_gaps()
returns table (
  table_name text,
  gap text,
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
    where n.nspname = 'public' and c.relkind = 'r'
  ),
  public_views as (
    select c.oid, c.relname::text as name, c.reloptions
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v', 'm')
  ),
  policy_counts as (
    select p.polrelid, count(*) as total,
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
    where a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
  )
  select t.name, 'rls_disabled', 'RLS is not enabled on this table.'
  from public_tables t where not t.relrowsecurity

  union all

  select t.name, 'rls_not_forced',
         'RLS is enabled but not FORCED, so the table owner bypasses it.'
  from public_tables t
  where t.relrowsecurity and not t.relforcerowsecurity

  union all

  select t.name, 'no_policies',
         'RLS is enabled but no policy exists.'
  from public_tables t
  left join policy_counts pc on pc.polrelid = t.oid
  where t.relrowsecurity and coalesce(pc.total, 0) = 0
    and t.name not in (select g.table_name from public.rls_global_tables g
                       where g.allow_no_policies)

  union all

  select t.name, 'no_tenant_scoped_policy',
         'Table has a tenant_id column but no policy referencing it.'
  from public_tables t
  join has_tenant_column htc on htc.attrelid = t.oid
  left join policy_counts pc on pc.polrelid = t.oid
  where coalesce(pc.tenant_scoped, 0) = 0
    and t.name not in (select g.table_name from public.rls_global_tables g
                       where g.allow_no_tenant_scope)

  union all

  -- A view without security_invoker runs as its owner and silently ignores the
  -- caller's RLS on every table beneath it.
  select v.name, 'view_not_security_invoker',
         'View does not set security_invoker=true, so it bypasses RLS.'
  from public_views v
  where not coalesce(
    array_to_string(v.reloptions, ',') like '%security_invoker=true%', false)

  order by 1, 2
$$;

comment on function public.rls_coverage_gaps() is
  'CI release gate. Reports RLS misconfiguration across tables and views in '
  'public; an empty result means the isolation invariant holds.';

revoke execute on function public.rls_coverage_gaps()
  from public, anon, authenticated;
grant execute on function public.rls_coverage_gaps() to service_role;
