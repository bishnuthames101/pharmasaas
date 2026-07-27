-- POS search.
--
-- The counter is the one place in this system where latency is felt by a queue
-- of people. A cashier types a few letters or scans a barcode and needs the
-- right row immediately, so this is one round trip returning exactly what a
-- cart line needs: the medicine, what is sellable, the FEFO batch, and its
-- price.
--
-- SECURITY INVOKER: RLS applies normally, so it cannot reach another pharmacy's
-- stock and needs no hand-written tenant predicate.
create or replace function public.pos_search(
  p_query text,
  p_limit int default 12
)
returns table (
  medicine_id uuid,
  name text,
  generic_name text,
  strength text,
  unit text,
  is_prescription_required boolean,
  is_controlled boolean,
  tax_rate numeric,
  saleable_on_hand numeric,
  batch_id uuid,
  batch_no text,
  expiry_date date,
  selling_price numeric,
  exact_barcode boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with matches as (
    select m.*,
           -- A scanned barcode is an exact answer, not a search result. It
           -- sorts first so a wedge scanner can select-and-enter blindly.
           (m.barcode is not null and m.barcode = trim(p_query)) as exact_barcode
    from public.medicines m
    where m.is_active
      and (
        trim(p_query) = '' or
        m.barcode = trim(p_query) or
        m.search_vector @@ websearch_to_tsquery('simple', p_query) or
        m.name ilike '%' || p_query || '%'
      )
  )
  select
    mm.id,
    mm.name,
    mm.generic_name,
    mm.strength,
    mm.unit,
    mm.is_prescription_required,
    mm.is_controlled,
    mm.tax_rate,
    coalesce(stock.saleable, 0) as saleable_on_hand,
    fefo.id as batch_id,
    fefo.batch_no,
    fefo.expiry_date,
    fefo.selling_price,
    mm.exact_barcode
  from matches mm
  left join lateral (
    select sum(b.qty_available) as saleable
    from public.batches b
    where b.medicine_id = mm.id
      and b.expiry_date > current_date
      and b.qty_available > 0
  ) stock on true
  -- The batch this line would actually draw from, so the cashier sees the
  -- expiry before selling rather than after.
  left join lateral (
    select b.id, b.batch_no, b.expiry_date, b.selling_price
    from public.batches b
    where b.medicine_id = mm.id
      and b.expiry_date > current_date
      and b.qty_available > 0
    order by b.expiry_date asc, b.received_at asc
    limit 1
  ) fefo on true
  order by mm.exact_barcode desc, coalesce(stock.saleable, 0) = 0, mm.name
  limit least(p_limit, 50)
$$;

comment on function public.pos_search(text, int) is
  'One-round-trip counter search: medicine, saleable stock, and the FEFO batch '
  'a sale would draw from. Barcode matches sort first.';

revoke execute on function public.pos_search(text, int) from public, anon;
grant execute on function public.pos_search(text, int) to authenticated;

-- ---------------------------------------------------------------------------
-- Sale receipt
-- ---------------------------------------------------------------------------
--
-- Everything the invoice needs in one call. SECURITY INVOKER, so a cashier can
-- reprint their own pharmacy's receipts and nobody else's.
create or replace function public.sale_receipt(p_sale_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'sale', to_jsonb(s) - 'tenant_id',
    'customer', (
      select jsonb_build_object('name', c.name, 'phone', c.phone)
      from public.customers c where c.id = s.customer_id
    ),
    'settings', (
      select jsonb_build_object(
        'pharmacy_name', st.pharmacy_name,
        'address', st.address,
        'phone', st.phone,
        'currency', st.currency,
        'tax_mode', st.tax_mode
      )
      from public.settings st where st.tenant_id = s.tenant_id
    ),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', m.name,
        'strength', m.strength,
        'unit', m.unit,
        'batch_no', b.batch_no,
        'expiry_date', b.expiry_date,
        'qty', si.qty,
        'unit_price', si.unit_price,
        'discount', si.discount,
        'tax', si.tax,
        'total', si.total
      ) order by m.name), '[]'::jsonb)
      from public.sale_items si
      join public.medicines m on m.id = si.medicine_id
      join public.batches b on b.id = si.batch_id
      where si.sale_id = s.id
    )
  )
  from public.sales s
  where s.id = p_sale_id
$$;

revoke execute on function public.sale_receipt(uuid) from public, anon;
grant execute on function public.sale_receipt(uuid) to authenticated;
