-- Reporting.
--
-- The interesting constraint here is profit. Cost lives in `batch_costs`,
-- readable only by owner and pharmacist, and it was deliberately never
-- snapshotted onto `sale_items`. So margin has to be reached by joining
-- sale_items → batches → batch_costs, and because these views are
-- `security_invoker`, that join simply returns nothing for a cashier.
--
-- The role gate on profit is therefore not a UI decision or a WHERE clause
-- someone can forget: it falls out of where the data lives.

-- ---------------------------------------------------------------------------
-- Daily sales summary
-- ---------------------------------------------------------------------------

create view public.sales_daily
with (security_invoker = true) as
select
  s.tenant_id,
  s.sale_date::date as day,
  count(*) as sale_count,
  sum(s.subtotal) as subtotal,
  sum(s.discount) as discount,
  sum(s.tax) as tax,
  sum(s.total) as total,
  sum(s.total) filter (where s.payment_method = 'credit') as credit_total,
  sum(s.total) filter (where s.payment_method <> 'credit'
                         or s.payment_method is null) as cash_total
from public.sales s
where s.status <> 'void'
group by s.tenant_id, s.sale_date::date;

grant select on public.sales_daily to authenticated;

-- ---------------------------------------------------------------------------
-- Profit by sale line
-- ---------------------------------------------------------------------------
--
-- Net of returns: `qty - qty_returned` is what was actually kept, so a refunded
-- item contributes neither revenue nor cost.

create view public.sale_profit
with (security_invoker = true) as
select
  si.tenant_id,
  si.sale_id,
  s.sale_date,
  si.medicine_id,
  m.name as medicine_name,
  m.category,
  (si.qty - si.qty_returned) as qty_net,
  si.unit_price,
  bc.cost_price,
  round((si.qty - si.qty_returned) * si.unit_price - si.discount, 2) as revenue,
  round((si.qty - si.qty_returned) * bc.cost_price, 2) as cost,
  round(
    ((si.qty - si.qty_returned) * si.unit_price - si.discount)
      - ((si.qty - si.qty_returned) * bc.cost_price),
    2
  ) as profit
from public.sale_items si
join public.sales s on s.id = si.sale_id
join public.medicines m on m.id = si.medicine_id
-- INNER join to batch_costs: for a cashier this yields no rows at all, which
-- is exactly the intent. Making it a LEFT join would leak revenue figures with
-- a null margin instead.
join public.batch_costs bc on bc.batch_id = si.batch_id
where s.status <> 'void';

comment on view public.sale_profit is
  'Per-line margin, net of returns. Returns nothing for cashiers because the '
  'join to batch_costs is barred to them by RLS.';

grant select on public.sale_profit to authenticated;

-- ---------------------------------------------------------------------------
-- Stock valuation
-- ---------------------------------------------------------------------------

create view public.stock_valuation
with (security_invoker = true) as
select
  b.tenant_id,
  b.medicine_id,
  m.name as medicine_name,
  m.category,
  m.unit,
  sum(b.qty_available) as qty_on_hand,
  sum(b.qty_available) filter (where b.expiry_date > current_date)
    as qty_saleable,
  round(sum(b.qty_available * bc.cost_price), 2) as cost_value,
  round(sum(b.qty_available * b.selling_price), 2) as retail_value
from public.batches b
join public.medicines m on m.id = b.medicine_id and m.tenant_id = b.tenant_id
join public.batch_costs bc on bc.batch_id = b.id
where b.qty_available > 0
group by b.tenant_id, b.medicine_id, m.name, m.category, m.unit;

grant select on public.stock_valuation to authenticated;

-- ---------------------------------------------------------------------------
-- Movement report
-- ---------------------------------------------------------------------------
--
-- Fast and slow movers over the last 90 days. Carries no cost, so it is
-- readable by pharmacists as well as owners.

create view public.medicine_movement
with (security_invoker = true) as
select
  m.tenant_id,
  m.id as medicine_id,
  m.name,
  m.category,
  m.unit,
  coalesce(sold.qty_sold, 0) as qty_sold_90d,
  coalesce(sold.revenue, 0) as revenue_90d,
  coalesce(stock.qty_on_hand, 0) as qty_on_hand,
  -- Roughly how long current stock lasts at the recent rate. Null when nothing
  -- has sold, since dividing by zero demand is meaningless rather than
  -- infinite.
  case
    when coalesce(sold.qty_sold, 0) > 0
    then round(coalesce(stock.qty_on_hand, 0) / (sold.qty_sold / 90.0), 0)
    else null
  end as days_of_cover
from public.medicines m
left join lateral (
  select
    sum(si.qty - si.qty_returned) as qty_sold,
    sum(si.total) as revenue
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  where si.medicine_id = m.id
    and si.tenant_id = m.tenant_id
    and s.sale_date >= now() - interval '90 days'
    and s.status <> 'void'
) sold on true
left join lateral (
  select sum(b.qty_available) as qty_on_hand
  from public.batches b
  where b.medicine_id = m.id
    and b.tenant_id = m.tenant_id
    and b.expiry_date > current_date
) stock on true
where m.is_active;

grant select on public.medicine_movement to authenticated;

-- ---------------------------------------------------------------------------
-- Controlled substances register
-- ---------------------------------------------------------------------------
--
-- Formatted for export to a regulator: who dispensed what, to whom, against
-- which prescription.

create view public.controlled_register
with (security_invoker = true) as
select
  cdl.tenant_id,
  cdl.created_at,
  m.name as medicine_name,
  m.strength,
  cdl.qty,
  m.unit,
  c.name as customer_name,
  c.phone as customer_phone,
  p.prescriber_name,
  p.prescriber_reg_no,
  s.invoice_no
from public.controlled_dispense_log cdl
join public.medicines m on m.id = cdl.medicine_id
left join public.customers c on c.id = cdl.customer_id
left join public.prescriptions p on p.id = cdl.prescription_id
left join public.sale_items si on si.id = cdl.sale_item_id
left join public.sales s on s.id = si.sale_id;

grant select on public.controlled_register to authenticated;
