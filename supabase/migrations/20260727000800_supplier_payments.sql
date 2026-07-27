-- Supplier payments and the reorder report.
--
-- `receive_purchase` already moves the supplier balance when goods arrive. This
-- adds the other half of the ledger — money going out — plus the report that
-- says what to buy next.

-- ---------------------------------------------------------------------------
-- Payment ledger
-- ---------------------------------------------------------------------------

create table public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade
    default public.tenant_id(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  purchase_id uuid references public.purchases(id) on delete set null,
  amount numeric(14, 2) not null check (amount > 0),
  paid_on date not null default current_date,
  method text,
  reference text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index supplier_payments_tenant_supplier_idx
  on public.supplier_payments (tenant_id, supplier_id, paid_on desc);

comment on table public.supplier_payments is
  'Money paid to suppliers. Written only by pay_supplier(), so the payment and '
  'the balance movement can never disagree.';

-- Read-only from the API: recorded by the RPC below, so a payment row and the
-- supplier balance are always written together.
select public.apply_tenant_policies('supplier_payments',
  array['owner', 'pharmacist'], null, null, null);

-- ---------------------------------------------------------------------------
-- pay_supplier
-- ---------------------------------------------------------------------------
--
-- A payment and the balance it settles must move together or the ledger lies.
-- Doing it in one function means there is no window where one has happened and
-- the other has not.
create or replace function public.pay_supplier(
  p_supplier_id uuid,
  p_amount numeric,
  p_method text default null,
  p_reference text default null,
  p_purchase_id uuid default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_actor uuid := auth.uid();
  v_supplier record;
  v_payment_id uuid;
begin
  v_tenant := public.require_tenant_role(array['owner', 'pharmacist']);

  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment must be greater than zero'
      using errcode = 'check_violation';
  end if;

  -- Locked so two concurrent payments cannot both read the same balance.
  select * into v_supplier
  from public.suppliers s
  where s.id = p_supplier_id and s.tenant_id = v_tenant
  for update;

  if not found then
    raise exception 'Unknown supplier' using errcode = 'foreign_key_violation';
  end if;

  if p_purchase_id is not null
     and not exists (select 1 from public.purchases pu
                     where pu.id = p_purchase_id and pu.tenant_id = v_tenant) then
    raise exception 'Unknown purchase' using errcode = 'foreign_key_violation';
  end if;

  insert into public.supplier_payments (
    tenant_id, supplier_id, purchase_id, amount, method, reference, notes,
    created_by
  )
  values (
    v_tenant, p_supplier_id, p_purchase_id, p_amount, p_method, p_reference,
    p_notes, v_actor
  )
  returning id into v_payment_id;

  -- Balance is what we owe, so paying reduces it. It may go negative, which
  -- correctly represents an advance or overpayment rather than being an error.
  update public.suppliers
  set balance = balance - p_amount
  where id = p_supplier_id and tenant_id = v_tenant;

  if p_purchase_id is not null then
    update public.purchases
    set paid = paid + p_amount,
        status = case when paid + p_amount >= total then 'received' else 'partial' end
    where id = p_purchase_id and tenant_id = v_tenant;
  end if;

  insert into public.audit_log (tenant_id, actor, action, entity, entity_id, after)
  values (v_tenant, v_actor, 'supplier.payment', 'suppliers',
          p_supplier_id::text,
          jsonb_build_object('amount', p_amount, 'payment_id', v_payment_id));

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'balance', v_supplier.balance - p_amount
  );
end;
$$;

revoke execute on function
  public.pay_supplier(uuid, numeric, text, text, uuid, text) from public, anon;
grant execute on function
  public.pay_supplier(uuid, numeric, text, text, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Reorder report
-- ---------------------------------------------------------------------------
--
-- What to buy, derived from min/max levels. `suggested_qty` tops stock back up
-- to `max_stock` where one is set, otherwise to the minimum — buying exactly
-- the shortfall would put the item straight back on this list.

create view public.reorder_report
with (security_invoker = true) as
select
  m.id as medicine_id,
  m.tenant_id,
  m.name,
  m.generic_name,
  m.unit,
  m.units_per_pack,
  m.min_stock,
  m.max_stock,
  coalesce(s.saleable_on_hand, 0) as saleable_on_hand,
  greatest(
    coalesce(m.max_stock, m.min_stock) - coalesce(s.saleable_on_hand, 0),
    0
  ) as suggested_qty,
  s.last_supplier_id,
  s.last_supplier_name,
  s.last_unit_cost
from public.medicines m
left join lateral (
  select
    (select sum(b.qty_available)
     from public.batches b
     where b.medicine_id = m.id
       and b.tenant_id = m.tenant_id
       and b.expiry_date > current_date) as saleable_on_hand,
    -- Who we last bought this from, and at what price, so the buyer does not
    -- have to go digging through purchase history.
    (select pu.supplier_id from public.purchase_items pi
     join public.purchases pu on pu.id = pi.purchase_id
     where pi.medicine_id = m.id and pi.tenant_id = m.tenant_id
     order by pu.purchase_date desc limit 1) as last_supplier_id,
    (select sup.name from public.purchase_items pi
     join public.purchases pu on pu.id = pi.purchase_id
     join public.suppliers sup on sup.id = pu.supplier_id
     where pi.medicine_id = m.id and pi.tenant_id = m.tenant_id
     order by pu.purchase_date desc limit 1) as last_supplier_name,
    (select pi.unit_cost from public.purchase_items pi
     join public.purchases pu on pu.id = pi.purchase_id
     where pi.medicine_id = m.id and pi.tenant_id = m.tenant_id
     order by pu.purchase_date desc limit 1) as last_unit_cost
) s on true
where m.is_active
  and m.min_stock is not null
  and coalesce(s.saleable_on_hand, 0) < m.min_stock;

comment on view public.reorder_report is
  'Active medicines below their minimum level, with a suggested order quantity '
  'and the last supplier and cost.';

grant select on public.reorder_report to authenticated;
