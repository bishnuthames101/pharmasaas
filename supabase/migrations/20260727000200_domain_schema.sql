-- The pharmacy domain: catalogue, batch-level stock, purchasing, sales,
-- prescriptions, and the audit trails.
--
-- Conventions used throughout:
--   * `tenant_id` defaults to public.tenant_id(), so inserts cannot spoof it
--     and the WITH CHECK policies reject any attempt to.
--   * Money is numeric(14,2). Never float — binary floating point cannot
--     represent 0.10, and a pharmacy's till must reconcile exactly.
--   * Quantities are numeric(14,3) in the SMALLEST sellable unit. Pack and box
--     conversion happens once, at goods receipt, and never again.
--   * Every index leads with tenant_id, or RLS-filtered queries would scan
--     every pharmacy's rows to return one pharmacy's.

-- ---------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade
    default public.tenant_id(),
  name text not null,
  phone text,
  email text,
  address text,
  pan_vat_no text,
  -- Positive means we owe the supplier. Maintained by receive_purchase and
  -- the payment RPC, never edited directly.
  balance numeric(14, 2) not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index suppliers_tenant_name_idx on public.suppliers (tenant_id, name);

-- ---------------------------------------------------------------------------
-- Medicines
-- ---------------------------------------------------------------------------

create table public.medicines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade
    default public.tenant_id(),
  name text not null,
  generic_name text,
  composition text,
  strength text,
  form text,
  manufacturer text,
  category text,
  rack_location text,
  barcode text,
  unit text not null default 'pcs',
  -- e.g. 10 tablets per strip, 10 strips per box → 100 smallest units per box.
  units_per_pack int not null default 1 check (units_per_pack > 0),
  packs_per_box int not null default 1 check (packs_per_box > 0),
  is_prescription_required boolean not null default false,
  is_controlled boolean not null default false,
  tax_rate numeric(5, 2),
  min_stock numeric(14, 3),
  max_stock numeric(14, 3),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  -- Scoped to the tenant: two pharmacies may legitimately use the same barcode
  -- for their own stock. Partial, so unbarcoded items do not collide on NULL.
  constraint medicines_barcode_unique unique (tenant_id, barcode)
);
create index medicines_tenant_name_idx on public.medicines (tenant_id, name);
create index medicines_tenant_active_idx on public.medicines (tenant_id, is_active);

-- POS search has to match brand, generic, and composition in one go — a
-- customer asks for "Brufen", "ibuprofen", or "the painkiller" interchangeably.
create index medicines_search_idx on public.medicines
  using gin (to_tsvector('simple',
    coalesce(name, '') || ' ' ||
    coalesce(generic_name, '') || ' ' ||
    coalesce(composition, '')));

-- ---------------------------------------------------------------------------
-- Batches
-- ---------------------------------------------------------------------------
--
-- Stock is tracked per batch, not per medicine, because expiry and cost are
-- properties of a batch. Note what is NOT here: cost_price. See batch_costs.

create table public.batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade
    default public.tenant_id(),
  medicine_id uuid not null references public.medicines(id) on delete restrict,
  batch_no text not null,
  expiry_date date not null,
  qty_available numeric(14, 3) not null default 0 check (qty_available >= 0),
  selling_price numeric(14, 2) not null check (selling_price >= 0),
  mrp numeric(14, 2),
  received_at timestamptz not null default now(),
  unique (tenant_id, medicine_id, batch_no, expiry_date)
);

-- The FEFO index. Allocation orders by expiry within a medicine, so this is
-- the single hottest index in the system.
create index batches_fefo_idx
  on public.batches (tenant_id, medicine_id, expiry_date)
  where qty_available > 0;

-- Drives the expiry board and expiry write-offs.
create index batches_expiry_idx on public.batches (tenant_id, expiry_date)
  where qty_available > 0;

-- ---------------------------------------------------------------------------
-- Batch costs — deliberately a separate table
-- ---------------------------------------------------------------------------
--
-- RLS filters rows, not columns, and every user connects as the same Postgres
-- role (`authenticated`), so column GRANTs cannot distinguish a cashier from an
-- owner. While cost_price lived on `batches` — a table cashiers MUST read to
-- sell, since they need price, expiry, and quantity — any cashier could read
-- the pharmacy's margins straight off the API, regardless of what the UI chose
-- to render.
--
-- Splitting cost into its own table makes the role gate expressible as an RLS
-- policy, which is enforced by Postgres rather than by our good intentions.
--
-- The cost of the split is one join in profit reporting. That is a good trade
-- for a control that actually holds.

create table public.batch_costs (
  batch_id uuid primary key references public.batches(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade
    default public.tenant_id(),
  cost_price numeric(14, 2) not null check (cost_price >= 0)
);
create index batch_costs_tenant_idx on public.batch_costs (tenant_id);

comment on table public.batch_costs is
  'Purchase cost per batch, split from `batches` so it can be role-gated. '
  'Readable by owner and pharmacist only.';

-- ---------------------------------------------------------------------------
-- Purchasing
-- ---------------------------------------------------------------------------

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade
    default public.tenant_id(),
  supplier_id uuid references public.suppliers(id) on delete set null,
  invoice_no text,
  purchase_date date not null default current_date,
  subtotal numeric(14, 2) not null default 0,
  tax numeric(14, 2) not null default 0,
  discount numeric(14, 2) not null default 0,
  total numeric(14, 2) not null default 0,
  paid numeric(14, 2) not null default 0,
  status text not null default 'received'
    check (status in ('received', 'partial', 'cancelled')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index purchases_tenant_date_idx
  on public.purchases (tenant_id, purchase_date desc);
create index purchases_tenant_supplier_idx
  on public.purchases (tenant_id, supplier_id);

create table public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade
    default public.tenant_id(),
  purchase_id uuid not null references public.purchases(id) on delete cascade,
  medicine_id uuid not null references public.medicines(id) on delete restrict,
  batch_id uuid references public.batches(id) on delete set null,
  qty numeric(14, 3) not null check (qty > 0),
  unit_cost numeric(14, 2) not null check (unit_cost >= 0),
  total numeric(14, 2) not null default 0
);
create index purchase_items_tenant_purchase_idx
  on public.purchase_items (tenant_id, purchase_id);

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade
    default public.tenant_id(),
  name text not null,
  phone text,
  address text,
  dob date,
  gender text,
  -- Clinically important at the counter, so it is on the customer record
  -- rather than buried in notes.
  allergies text,
  notes text,
  -- Positive means the customer owes the pharmacy.
  credit_balance numeric(14, 2) not null default 0,
  created_at timestamptz not null default now()
);
create index customers_tenant_phone_idx on public.customers (tenant_id, phone);
create index customers_tenant_name_idx on public.customers (tenant_id, name);

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------
--
-- No insert, update or delete policy is applied to sales or sale_items. Every
-- sale is created by complete_sale(), which is the only path that assigns an
-- invoice number, allocates FEFO, decrements stock, and writes the controlled
-- register. Leaving a direct write path open would let any of those be skipped.

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade
    default public.tenant_id(),
  invoice_no text not null,
  customer_id uuid references public.customers(id) on delete set null,
  sale_date timestamptz not null default now(),
  subtotal numeric(14, 2) not null default 0,
  discount numeric(14, 2) not null default 0,
  tax numeric(14, 2) not null default 0,
  total numeric(14, 2) not null default 0,
  paid numeric(14, 2) not null default 0,
  payment_method text,
  status text not null default 'completed'
    check (status in ('completed', 'returned', 'partially_returned', 'void')),
  sold_by uuid references auth.users(id) on delete set null,
  unique (tenant_id, invoice_no)
);
create index sales_tenant_date_idx on public.sales (tenant_id, sale_date desc);
create index sales_tenant_customer_idx on public.sales (tenant_id, customer_id);

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade
    default public.tenant_id(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  medicine_id uuid not null references public.medicines(id) on delete restrict,
  batch_id uuid not null references public.batches(id) on delete restrict,
  qty numeric(14, 3) not null check (qty > 0),
  unit_price numeric(14, 2) not null,
  discount numeric(14, 2) not null default 0,
  tax numeric(14, 2) not null default 0,
  total numeric(14, 2) not null default 0,
  qty_returned numeric(14, 3) not null default 0 check (qty_returned >= 0),
  constraint sale_items_return_within_sold check (qty_returned <= qty)
);
create index sale_items_tenant_sale_idx on public.sale_items (tenant_id, sale_id);
create index sale_items_tenant_medicine_idx
  on public.sale_items (tenant_id, medicine_id);
create index sale_items_tenant_batch_idx on public.sale_items (tenant_id, batch_id);

-- ---------------------------------------------------------------------------
-- Prescriptions
-- ---------------------------------------------------------------------------

create table public.prescriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade
    default public.tenant_id(),
  customer_id uuid references public.customers(id) on delete set null,
  sale_id uuid references public.sales(id) on delete set null,
  prescriber_name text,
  prescriber_reg_no text,
  -- Storage object path, always {tenant_id}/rx/{uuid}. Enforced by the storage
  -- policies in the next migration.
  image_path text,
  notes text,
  issued_date date,
  refills_allowed int not null default 0 check (refills_allowed >= 0),
  refills_used int not null default 0 check (refills_used >= 0),
  created_at timestamptz not null default now(),
  constraint prescriptions_refills_within_allowed
    check (refills_used <= refills_allowed)
);
create index prescriptions_tenant_customer_idx
  on public.prescriptions (tenant_id, customer_id);

-- ---------------------------------------------------------------------------
-- Stock adjustments
-- ---------------------------------------------------------------------------

create table public.stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade
    default public.tenant_id(),
  batch_id uuid not null references public.batches(id) on delete cascade,
  -- Negative for shrinkage and write-offs, positive for found stock.
  qty_change numeric(14, 3) not null check (qty_change <> 0),
  reason text not null check (reason in (
    'damage', 'expiry_writeoff', 'count_correction',
    'return_to_supplier', 'found', 'theft'
  )),
  notes text,
  adjusted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index stock_adjustments_tenant_date_idx
  on public.stock_adjustments (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Controlled dispensing register
-- ---------------------------------------------------------------------------
--
-- A legal record. Append-only: no update or delete policy exists, and rows are
-- written only by complete_sale().

create table public.controlled_dispense_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade
    default public.tenant_id(),
  sale_item_id uuid references public.sale_items(id) on delete set null,
  medicine_id uuid not null references public.medicines(id) on delete restrict,
  customer_id uuid references public.customers(id) on delete set null,
  prescription_id uuid references public.prescriptions(id) on delete set null,
  qty numeric(14, 3) not null,
  dispensed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index controlled_dispense_tenant_date_idx
  on public.controlled_dispense_log (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------

create table public.audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade
    default public.tenant_id(),
  actor uuid references auth.users(id) on delete set null,
  action text not null,
  entity text,
  entity_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_tenant_date_idx
  on public.audit_log (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Policies, from docs/ROLES.md
-- ---------------------------------------------------------------------------
--
-- Argument order: select, insert, update, delete. NULL means no policy of that
-- kind; for select, NULL means "any member of the tenant".

select public.apply_tenant_policies('suppliers',
  array['owner', 'pharmacist'], array['owner', 'pharmacist'],
  array['owner', 'pharmacist'], array['owner']);

-- Cashiers read the catalogue to sell, but cannot change what anything costs.
select public.apply_tenant_policies('medicines',
  null, array['owner', 'pharmacist'], array['owner', 'pharmacist'],
  array['owner']);

-- Batches are readable by all staff (the POS needs price, expiry and quantity).
-- Direct writes are owner/pharmacist for corrections; the selling path moves
-- stock through complete_sale() instead.
select public.apply_tenant_policies('batches',
  null, array['owner', 'pharmacist'], array['owner', 'pharmacist'],
  array['owner']);

-- The whole point of the split: cashiers cannot read this table at all.
select public.apply_tenant_policies('batch_costs',
  array['owner', 'pharmacist'], array['owner', 'pharmacist'],
  array['owner', 'pharmacist'], array['owner']);

select public.apply_tenant_policies('purchases',
  array['owner', 'pharmacist'], array['owner', 'pharmacist'],
  array['owner', 'pharmacist'], array['owner']);

select public.apply_tenant_policies('purchase_items',
  array['owner', 'pharmacist'], array['owner', 'pharmacist'],
  array['owner', 'pharmacist'], array['owner']);

-- Cashiers add walk-in customers at the counter.
select public.apply_tenant_policies('customers',
  null, array['owner', 'pharmacist', 'cashier'],
  array['owner', 'pharmacist', 'cashier'], array['owner']);

-- Read-only to staff. All writes go through complete_sale / sales_return.
select public.apply_tenant_policies('sales', null, null, null, null);
select public.apply_tenant_policies('sale_items', null, null, null, null);

select public.apply_tenant_policies('prescriptions',
  null, array['owner', 'pharmacist', 'cashier'],
  array['owner', 'pharmacist'], array['owner']);

-- Written by adjust_stock(); readable by owner/pharmacist for the audit trail.
select public.apply_tenant_policies('stock_adjustments',
  array['owner', 'pharmacist'], null, null, null);

-- Append-only legal register: readable, never mutable.
select public.apply_tenant_policies('controlled_dispense_log',
  array['owner', 'pharmacist'], null, null, null);

-- Owner-only, and never mutable from the API.
select public.apply_tenant_policies('audit_log',
  array['owner'], null, null, null);
