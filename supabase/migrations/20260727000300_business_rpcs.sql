-- Business RPCs: FEFO allocation, sale completion, goods receipt, returns, and
-- stock adjustment.
--
-- ===========================================================================
-- WHY THESE ARE SECURITY DEFINER, AND WHAT THAT OBLIGES
-- ===========================================================================
--
-- The reference design keeps business RPCs SECURITY INVOKER so RLS applies
-- inside them. That works only if the caller independently holds write rights
-- on every table the RPC touches — and a cashier completing a sale would then
-- need UPDATE on `batches`, which via PostgREST also lets them rewrite selling
-- prices and invent stock. Selling and repricing would become the same
-- privilege.
--
-- So these run SECURITY DEFINER, `batches` carries no cashier write policy, and
-- `sales`/`sale_items` carry no write policy at all. Stock can then only move
-- through this audited path, and every sale is guaranteed to have an invoice
-- number, FEFO allocation, and a controlled-register entry.
--
-- The price of that is absolute: **RLS does not apply inside these functions.**
-- Each one therefore must, without exception:
--   1. derive the tenant from public.tenant_id() and never from a parameter;
--   2. re-verify active membership via public.tenant_role(), because a JWT
--      claim outlives a revoked membership;
--   3. constrain EVERY id it is handed with `and tenant_id = v_tenant`, since
--      a caller can pass any UUID they like.
--
-- Rule 3 is the one that bites. A single missing tenant predicate here is a
-- cross-tenant write, and the coverage gate cannot see inside a function body.
-- The suite in supabase/tests/domain-rpcs.test.ts exists to probe exactly this.

-- ---------------------------------------------------------------------------
-- Shared guard
-- ---------------------------------------------------------------------------

create or replace function public.require_tenant_role(p_roles text[])
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := public.tenant_id();
  v_role text := public.tenant_role();
begin
  if v_tenant is null then
    raise exception 'No active pharmacy selected'
      using errcode = 'insufficient_privilege';
  end if;

  -- tenant_role() reads tenant_users, so a deactivated member is refused here
  -- even though their token still names this pharmacy.
  if v_role is null then
    raise exception 'You are not an active member of this pharmacy'
      using errcode = 'insufficient_privilege';
  end if;

  if not (v_role = any(p_roles)) then
    raise exception 'Your role (%) may not perform this action', v_role
      using errcode = 'insufficient_privilege';
  end if;

  return v_tenant;
end;
$$;

revoke execute on function public.require_tenant_role(text[]) from public, anon;
grant execute on function public.require_tenant_role(text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- FEFO preview (read-only, for the cart UI)
-- ---------------------------------------------------------------------------
--
-- SECURITY INVOKER and lock-free: it only shows which batches *would* be used,
-- so the POS can display batch and expiry per line. RLS applies normally.
create or replace function public.fefo_preview(
  p_medicine_id uuid,
  p_qty numeric
)
returns table (
  batch_id uuid,
  batch_no text,
  expiry_date date,
  qty_taken numeric,
  selling_price numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_remaining numeric := p_qty;
  v_batch record;
  v_take numeric;
begin
  for v_batch in
    select b.id, b.batch_no, b.expiry_date, b.qty_available, b.selling_price
    from public.batches b
    where b.medicine_id = p_medicine_id
      and b.qty_available > 0
      and b.expiry_date > current_date
    order by b.expiry_date asc, b.received_at asc
  loop
    exit when v_remaining <= 0;
    v_take := least(v_remaining, v_batch.qty_available);

    batch_id := v_batch.id;
    batch_no := v_batch.batch_no;
    expiry_date := v_batch.expiry_date;
    qty_taken := v_take;
    selling_price := v_batch.selling_price;
    return next;

    v_remaining := v_remaining - v_take;
  end loop;
end;
$$;

revoke execute on function public.fefo_preview(uuid, numeric) from public, anon;
grant execute on function public.fefo_preview(uuid, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- FEFO allocation (locking)
-- ---------------------------------------------------------------------------
--
-- Earliest expiry first, expired stock excluded, rows locked FOR UPDATE SKIP
-- LOCKED so two counters cannot sell the same units.
--
-- SKIP LOCKED is a deliberate trade: if another till is mid-sale on the
-- earliest batch, this one moves to the next batch rather than waiting. That
-- is very slightly non-FEFO under concurrency, and it is the right call —
-- blocking would freeze a queue of customers, and the alternative (no lock at
-- all) oversells.
create or replace function public.fefo_allocate(
  p_medicine_id uuid,
  p_qty numeric
)
returns table (batch_id uuid, qty_taken numeric, unit_price numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := public.tenant_id();
  v_remaining numeric := p_qty;
  v_batch record;
  v_take numeric;
begin
  if v_tenant is null then
    raise exception 'No active pharmacy selected'
      using errcode = 'insufficient_privilege';
  end if;

  if p_qty is null or p_qty <= 0 then
    raise exception 'Quantity must be greater than zero'
      using errcode = 'check_violation';
  end if;

  -- RLS is off in here: the tenant predicate below is the only thing stopping
  -- a caller from allocating out of another pharmacy's stock.
  for v_batch in
    select b.id, b.qty_available, b.selling_price
    from public.batches b
    where b.tenant_id = v_tenant
      and b.medicine_id = p_medicine_id
      and b.qty_available > 0
      and b.expiry_date > current_date
    order by b.expiry_date asc, b.received_at asc
    for update skip locked
  loop
    exit when v_remaining <= 0;
    v_take := least(v_remaining, v_batch.qty_available);

    batch_id := v_batch.id;
    qty_taken := v_take;
    unit_price := v_batch.selling_price;
    return next;

    v_remaining := v_remaining - v_take;
  end loop;

  if v_remaining > 0 then
    raise exception 'Insufficient stock: % more unit(s) needed', v_remaining
      using errcode = 'check_violation';
  end if;
end;
$$;

-- Not reachable from the API: standalone it would lock rows for the length of
-- one statement and then release them, which is worse than useless. It exists
-- to be called inside complete_sale's transaction.
revoke execute on function public.fefo_allocate(uuid, numeric)
  from public, anon, authenticated;
grant execute on function public.fefo_allocate(uuid, numeric) to service_role;

-- ---------------------------------------------------------------------------
-- complete_sale
-- ---------------------------------------------------------------------------
--
-- One transaction: allocate FEFO, decrement stock, assign a gapless per-tenant
-- invoice number, write the sale and its lines, and record any controlled
-- dispensing.
--
-- Payload:
--   {
--     "customer_id": uuid | null,
--     "payment_method": "cash" | "card" | "wallet" | "credit",
--     "paid": numeric,
--     "prescription_id": uuid | null,
--     "items": [{ "medicine_id": uuid, "qty": numeric, "discount": numeric }]
--   }
--
-- Note what the payload cannot contain: a price. Unit price always comes from
-- the batch, so a cashier cannot sell at a price of their choosing; they may
-- only apply a line discount.
create or replace function public.complete_sale(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_actor uuid := auth.uid();
  v_settings record;
  v_invoice_no text;
  v_sale_id uuid;
  v_customer_id uuid;
  v_prescription_id uuid;
  v_payment_method text;
  v_paid numeric(14, 2);
  v_item jsonb;
  v_medicine record;
  v_alloc record;
  v_line_discount numeric(14, 2);
  v_qty numeric(14, 3);
  v_rate numeric(5, 2);
  v_gross numeric(14, 2);
  v_net numeric(14, 2);
  v_tax numeric(14, 2);
  v_line_total numeric(14, 2);
  v_sale_item_id uuid;
  v_subtotal numeric(14, 2) := 0;
  v_discount_total numeric(14, 2) := 0;
  v_tax_total numeric(14, 2) := 0;
  v_total numeric(14, 2) := 0;
  v_alloc_discount numeric(14, 2);
  v_remaining_qty numeric(14, 3);
begin
  -- Cashiers sell; that is the whole point of the role.
  v_tenant := public.require_tenant_role(array['owner', 'pharmacist', 'cashier']);

  if p_payload->'items' is null
     or jsonb_array_length(p_payload->'items') = 0 then
    raise exception 'A sale must have at least one item'
      using errcode = 'check_violation';
  end if;

  v_customer_id := nullif(p_payload->>'customer_id', '')::uuid;
  v_prescription_id := nullif(p_payload->>'prescription_id', '')::uuid;
  v_payment_method := coalesce(nullif(p_payload->>'payment_method', ''), 'cash');
  v_paid := coalesce((p_payload->>'paid')::numeric, 0);

  -- Every id from the payload is checked against the caller's tenant. Without
  -- these, a caller could attach their sale to another pharmacy's customer.
  if v_customer_id is not null
     and not exists (select 1 from public.customers c
                     where c.id = v_customer_id and c.tenant_id = v_tenant) then
    raise exception 'Unknown customer' using errcode = 'foreign_key_violation';
  end if;

  if v_prescription_id is not null
     and not exists (select 1 from public.prescriptions p
                     where p.id = v_prescription_id and p.tenant_id = v_tenant) then
    raise exception 'Unknown prescription'
      using errcode = 'foreign_key_violation';
  end if;

  -- Row lock on the settings row makes invoice numbering gapless: any
  -- concurrent sale in this pharmacy waits here, and a rollback returns the
  -- number rather than burning it. A sequence would do neither.
  select * into v_settings
  from public.settings s
  where s.tenant_id = v_tenant
  for update;

  if not found then
    raise exception 'Pharmacy settings are missing' using errcode = 'no_data_found';
  end if;

  v_invoice_no := v_settings.invoice_prefix || '-' || v_settings.next_invoice_seq;

  insert into public.sales (
    tenant_id, invoice_no, customer_id, payment_method, paid, sold_by
  )
  values (
    v_tenant, v_invoice_no, v_customer_id, v_payment_method, v_paid, v_actor
  )
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_payload->'items')
  loop
    v_qty := (v_item->>'qty')::numeric;
    v_line_discount := coalesce((v_item->>'discount')::numeric, 0);

    if v_qty is null or v_qty <= 0 then
      raise exception 'Each line needs a quantity greater than zero'
        using errcode = 'check_violation';
    end if;

    select m.id, m.tax_rate, m.is_controlled, m.is_prescription_required
    into v_medicine
    from public.medicines m
    where m.id = (v_item->>'medicine_id')::uuid
      and m.tenant_id = v_tenant
      and m.is_active;

    if not found then
      raise exception 'Unknown or inactive medicine'
        using errcode = 'foreign_key_violation';
    end if;

    if v_medicine.is_prescription_required and v_prescription_id is null then
      raise exception 'This item requires a prescription'
        using errcode = 'check_violation';
    end if;

    v_rate := coalesce(v_medicine.tax_rate, v_settings.default_tax_rate, 0);

    -- A line may span several batches. The line discount is spread across the
    -- allocations in proportion to quantity, so the discount is applied once
    -- rather than once per batch.
    v_remaining_qty := v_qty;

    for v_alloc in
      select * from public.fefo_allocate(v_medicine.id, v_qty)
    loop
      v_alloc_discount := round(
        v_line_discount * (v_alloc.qty_taken / v_qty), 2);

      v_gross := round(v_alloc.qty_taken * v_alloc.unit_price, 2);
      v_net := v_gross - v_alloc_discount;

      if v_settings.tax_mode = 'inclusive' then
        -- The shelf price already contains the tax; extract it.
        v_tax := round(v_net - (v_net / (1 + v_rate / 100)), 2);
        v_line_total := v_net;
      else
        v_tax := round(v_net * v_rate / 100, 2);
        v_line_total := v_net + v_tax;
      end if;

      insert into public.sale_items (
        tenant_id, sale_id, medicine_id, batch_id,
        qty, unit_price, discount, tax, total
      )
      values (
        v_tenant, v_sale_id, v_medicine.id, v_alloc.batch_id,
        v_alloc.qty_taken, v_alloc.unit_price, v_alloc_discount, v_tax,
        v_line_total
      )
      returning id into v_sale_item_id;

      -- The rows are already locked by fefo_allocate, so this cannot race.
      update public.batches
      set qty_available = qty_available - v_alloc.qty_taken
      where id = v_alloc.batch_id
        and tenant_id = v_tenant;

      if v_medicine.is_controlled then
        insert into public.controlled_dispense_log (
          tenant_id, sale_item_id, medicine_id, customer_id,
          prescription_id, qty, dispensed_by
        )
        values (
          v_tenant, v_sale_item_id, v_medicine.id, v_customer_id,
          v_prescription_id, v_alloc.qty_taken, v_actor
        );
      end if;

      v_subtotal := v_subtotal + v_gross;
      v_discount_total := v_discount_total + v_alloc_discount;
      v_tax_total := v_tax_total + v_tax;
      v_total := v_total + v_line_total;
      v_remaining_qty := v_remaining_qty - v_alloc.qty_taken;
    end loop;
  end loop;

  update public.sales
  set subtotal = v_subtotal,
      discount = v_discount_total,
      tax = v_tax_total,
      total = v_total
  where id = v_sale_id;

  -- Credit sales add to what the customer owes.
  if v_payment_method = 'credit' and v_customer_id is not null then
    update public.customers
    set credit_balance = credit_balance + (v_total - v_paid)
    where id = v_customer_id and tenant_id = v_tenant;
  end if;

  if v_prescription_id is not null then
    update public.prescriptions
    set sale_id = coalesce(sale_id, v_sale_id),
        refills_used = least(refills_used + 1, refills_allowed)
    where id = v_prescription_id and tenant_id = v_tenant;
  end if;

  -- Only now is the number consumed, inside the same transaction.
  update public.settings
  set next_invoice_seq = next_invoice_seq + 1
  where tenant_id = v_tenant;

  insert into public.audit_log (tenant_id, actor, action, entity, entity_id, after)
  values (v_tenant, v_actor, 'sale.complete', 'sales', v_sale_id::text,
          jsonb_build_object('invoice_no', v_invoice_no, 'total', v_total));

  return jsonb_build_object(
    'sale_id', v_sale_id,
    'invoice_no', v_invoice_no,
    'subtotal', v_subtotal,
    'discount', v_discount_total,
    'tax', v_tax_total,
    'total', v_total
  );
end;
$$;

revoke execute on function public.complete_sale(jsonb) from public, anon;
grant execute on function public.complete_sale(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- receive_purchase
-- ---------------------------------------------------------------------------
--
-- Goods receipt. Converts pack quantities to smallest units once, here, and
-- never again; upserts the batch; records cost in the role-gated batch_costs
-- table; and moves the supplier balance.
--
-- Payload:
--   {
--     "supplier_id": uuid | null,
--     "invoice_no": text,
--     "purchase_date": date,
--     "paid": numeric,
--     "items": [{
--       "medicine_id": uuid, "batch_no": text, "expiry_date": date,
--       "qty": numeric,            -- in packs if pack_mode, else smallest units
--       "pack_mode": bool,
--       "unit_cost": numeric,      -- per smallest unit
--       "selling_price": numeric, "mrp": numeric
--     }]
--   }
create or replace function public.receive_purchase(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_actor uuid := auth.uid();
  v_purchase_id uuid;
  v_supplier_id uuid;
  v_item jsonb;
  v_medicine record;
  v_batch_id uuid;
  v_qty numeric(14, 3);
  v_unit_cost numeric(14, 2);
  v_line_total numeric(14, 2);
  v_subtotal numeric(14, 2) := 0;
  v_paid numeric(14, 2);
  v_expiry date;
begin
  v_tenant := public.require_tenant_role(array['owner', 'pharmacist']);

  if p_payload->'items' is null
     or jsonb_array_length(p_payload->'items') = 0 then
    raise exception 'A purchase must have at least one item'
      using errcode = 'check_violation';
  end if;

  v_supplier_id := nullif(p_payload->>'supplier_id', '')::uuid;
  v_paid := coalesce((p_payload->>'paid')::numeric, 0);

  if v_supplier_id is not null
     and not exists (select 1 from public.suppliers s
                     where s.id = v_supplier_id and s.tenant_id = v_tenant) then
    raise exception 'Unknown supplier' using errcode = 'foreign_key_violation';
  end if;

  insert into public.purchases (
    tenant_id, supplier_id, invoice_no, purchase_date, paid, created_by
  )
  values (
    v_tenant, v_supplier_id, nullif(p_payload->>'invoice_no', ''),
    coalesce((p_payload->>'purchase_date')::date, current_date),
    v_paid, v_actor
  )
  returning id into v_purchase_id;

  for v_item in select * from jsonb_array_elements(p_payload->'items')
  loop
    select m.id, m.units_per_pack into v_medicine
    from public.medicines m
    where m.id = (v_item->>'medicine_id')::uuid
      and m.tenant_id = v_tenant;

    if not found then
      raise exception 'Unknown medicine' using errcode = 'foreign_key_violation';
    end if;

    v_qty := (v_item->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Each line needs a quantity greater than zero'
        using errcode = 'check_violation';
    end if;

    -- The one place pack maths happens. Everything downstream is in units.
    if coalesce((v_item->>'pack_mode')::boolean, false) then
      v_qty := v_qty * v_medicine.units_per_pack;
    end if;

    v_unit_cost := (v_item->>'unit_cost')::numeric;
    v_expiry := (v_item->>'expiry_date')::date;

    if v_expiry is null then
      raise exception 'Each line needs an expiry date'
        using errcode = 'check_violation';
    end if;

    -- Same medicine, batch number and expiry means the same physical batch,
    -- so a second delivery tops it up rather than creating a duplicate.
    insert into public.batches (
      tenant_id, medicine_id, batch_no, expiry_date,
      qty_available, selling_price, mrp
    )
    values (
      v_tenant, v_medicine.id, v_item->>'batch_no', v_expiry, v_qty,
      coalesce((v_item->>'selling_price')::numeric, v_unit_cost),
      nullif(v_item->>'mrp', '')::numeric
    )
    on conflict (tenant_id, medicine_id, batch_no, expiry_date)
    do update set
      qty_available = public.batches.qty_available + excluded.qty_available,
      selling_price = coalesce(excluded.selling_price, public.batches.selling_price),
      mrp = coalesce(excluded.mrp, public.batches.mrp)
    returning id into v_batch_id;

    -- Latest cost wins for a topped-up batch. Weighted averaging would be more
    -- precise, but a batch is a single physical lot and its cost rarely moves.
    insert into public.batch_costs (batch_id, tenant_id, cost_price)
    values (v_batch_id, v_tenant, v_unit_cost)
    on conflict (batch_id) do update set cost_price = excluded.cost_price;

    v_line_total := round(v_qty * v_unit_cost, 2);
    v_subtotal := v_subtotal + v_line_total;

    insert into public.purchase_items (
      tenant_id, purchase_id, medicine_id, batch_id, qty, unit_cost, total
    )
    values (
      v_tenant, v_purchase_id, v_medicine.id, v_batch_id, v_qty,
      v_unit_cost, v_line_total
    );
  end loop;

  update public.purchases
  set subtotal = v_subtotal,
      total = v_subtotal,
      status = case when v_paid >= v_subtotal then 'received' else 'partial' end
  where id = v_purchase_id;

  if v_supplier_id is not null then
    update public.suppliers
    set balance = balance + (v_subtotal - v_paid)
    where id = v_supplier_id and tenant_id = v_tenant;
  end if;

  insert into public.audit_log (tenant_id, actor, action, entity, entity_id, after)
  values (v_tenant, v_actor, 'purchase.receive', 'purchases',
          v_purchase_id::text,
          jsonb_build_object('total', v_subtotal));

  return jsonb_build_object(
    'purchase_id', v_purchase_id,
    'subtotal', v_subtotal,
    'total', v_subtotal
  );
end;
$$;

revoke execute on function public.receive_purchase(jsonb) from public, anon;
grant execute on function public.receive_purchase(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- sales_return
-- ---------------------------------------------------------------------------
--
-- Returns go back to the batch they came from, which keeps expiry tracking
-- honest — restocking to "the newest batch" would quietly launder an old
-- batch's expiry date.
--
-- Payload: [{ "sale_item_id": uuid, "qty": numeric }]
create or replace function public.sales_return(
  p_sale_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_actor uuid := auth.uid();
  v_sale record;
  v_item jsonb;
  v_line record;
  v_qty numeric(14, 3);
  v_refund numeric(14, 2) := 0;
  v_line_refund numeric(14, 2);
  v_all_returned boolean;
begin
  -- Refunds are supervised: cashiers sell, they do not reverse.
  v_tenant := public.require_tenant_role(array['owner', 'pharmacist']);

  select * into v_sale
  from public.sales s
  where s.id = p_sale_id and s.tenant_id = v_tenant
  for update;

  if not found then
    raise exception 'Unknown sale' using errcode = 'foreign_key_violation';
  end if;

  if v_sale.status = 'void' then
    raise exception 'This sale has been voided' using errcode = 'check_violation';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item->>'qty')::numeric;

    select * into v_line
    from public.sale_items si
    where si.id = (v_item->>'sale_item_id')::uuid
      and si.sale_id = p_sale_id
      and si.tenant_id = v_tenant
    for update;

    if not found then
      raise exception 'Unknown sale line' using errcode = 'foreign_key_violation';
    end if;

    if v_qty is null or v_qty <= 0 then
      raise exception 'Return quantity must be greater than zero'
        using errcode = 'check_violation';
    end if;

    if v_line.qty_returned + v_qty > v_line.qty then
      raise exception 'Cannot return more than was sold'
        using errcode = 'check_violation';
    end if;

    -- Refund the line's share, tax and discount included, so a partial return
    -- refunds exactly what was charged for those units.
    v_line_refund := round(v_line.total * (v_qty / v_line.qty), 2);
    v_refund := v_refund + v_line_refund;

    update public.sale_items
    set qty_returned = qty_returned + v_qty
    where id = v_line.id;

    update public.batches
    set qty_available = qty_available + v_qty
    where id = v_line.batch_id and tenant_id = v_tenant;
  end loop;

  select bool_and(si.qty_returned >= si.qty) into v_all_returned
  from public.sale_items si
  where si.sale_id = p_sale_id and si.tenant_id = v_tenant;

  update public.sales
  set status = case when v_all_returned then 'returned' else 'partially_returned' end
  where id = p_sale_id and tenant_id = v_tenant;

  -- A credit sale's refund reduces what the customer owes rather than paying
  -- cash out of the till.
  if v_sale.payment_method = 'credit' and v_sale.customer_id is not null then
    update public.customers
    set credit_balance = credit_balance - v_refund
    where id = v_sale.customer_id and tenant_id = v_tenant;
  end if;

  insert into public.audit_log (tenant_id, actor, action, entity, entity_id, after)
  values (v_tenant, v_actor, 'sale.return', 'sales', p_sale_id::text,
          jsonb_build_object('refund', v_refund));

  return jsonb_build_object('sale_id', p_sale_id, 'refund', v_refund);
end;
$$;

revoke execute on function public.sales_return(uuid, jsonb) from public, anon;
grant execute on function public.sales_return(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- adjust_stock
-- ---------------------------------------------------------------------------
--
-- The only sanctioned way to change stock outside selling and receiving. Writes
-- the batch and the reason-coded adjustment together, so stock can never move
-- without a recorded reason.
create or replace function public.adjust_stock(
  p_batch_id uuid,
  p_qty_change numeric,
  p_reason text,
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
  v_batch record;
  v_new_qty numeric(14, 3);
begin
  v_tenant := public.require_tenant_role(array['owner', 'pharmacist']);

  select * into v_batch
  from public.batches b
  where b.id = p_batch_id and b.tenant_id = v_tenant
  for update;

  if not found then
    raise exception 'Unknown batch' using errcode = 'foreign_key_violation';
  end if;

  v_new_qty := v_batch.qty_available + p_qty_change;

  if v_new_qty < 0 then
    raise exception 'Adjustment would take stock below zero (have %, change %)',
      v_batch.qty_available, p_qty_change
      using errcode = 'check_violation';
  end if;

  update public.batches
  set qty_available = v_new_qty
  where id = p_batch_id and tenant_id = v_tenant;

  insert into public.stock_adjustments (
    tenant_id, batch_id, qty_change, reason, notes, adjusted_by
  )
  values (v_tenant, p_batch_id, p_qty_change, p_reason, p_notes, v_actor);

  insert into public.audit_log (tenant_id, actor, action, entity, entity_id, before, after)
  values (v_tenant, v_actor, 'stock.adjust', 'batches', p_batch_id::text,
          jsonb_build_object('qty_available', v_batch.qty_available),
          jsonb_build_object('qty_available', v_new_qty, 'reason', p_reason));

  return jsonb_build_object(
    'batch_id', p_batch_id,
    'qty_available', v_new_qty
  );
end;
$$;

revoke execute on function public.adjust_stock(uuid, numeric, text, text)
  from public, anon;
grant execute on function public.adjust_stock(uuid, numeric, text, text)
  to authenticated;
