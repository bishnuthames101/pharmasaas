-- Expose `search_vector` through `medicine_stock`.
--
-- The inventory list filters the view, not the base table, so without the
-- column projected here PostgREST reports
-- `column medicine_stock.search_vector does not exist` and every search comes
-- back empty. Caught by the Phase 4 smoke test.
--
-- The column is a `tsvector`, which is not useful to render and is excluded
-- from the app's own `select` lists; it exists here purely so the view can be
-- searched.

-- Dropped and recreated rather than replaced: CREATE OR REPLACE VIEW may only
-- append columns, and `search_vector` belongs with the other medicine columns
-- rather than tacked on after the aggregates.
drop view if exists public.medicine_stock;

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
  m.search_vector,
  coalesce(s.stock_on_hand, 0) as stock_on_hand,
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
