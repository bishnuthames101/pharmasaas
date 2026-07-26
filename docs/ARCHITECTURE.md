# PharmaSaaS — Research Report & Claude Code Build Guide (v2)

**Multi-tenant Pharmacy Management System — Shared Database + Row Level Security**
Stack: Next.js (fullstack, App Router) · **One** Supabase PostgreSQL project · Vercel (deployed via GitHub) · Built with Claude Code CLI

---

## 1. Executive Summary

You are building a B2B SaaS where each pharmacy (tenant) signs up and gets its own isolated workspace — all inside **one Supabase project and one Postgres database**. Isolation is logical, not physical:

- Every domain table carries a `tenant_id` column.
- **Postgres Row Level Security (RLS)** enforces that a user can only ever read/write rows belonging to their own tenant. The database itself is the security boundary — even a buggy query in app code cannot leak another pharmacy's data, because Postgres refuses to return those rows.
- One Supabase Auth instance serves all users; a membership table (`tenant_users`) maps users → tenants → roles, and the active tenant is stamped into the JWT's `app_metadata` so RLS policies can check it without extra queries.
- One Next.js codebase on Vercel serves everyone; middleware maps `sunrise.pharmasaas.com` → the sunrise tenant.

Compared to database-per-tenant, this model gives you: **near-zero marginal cost per tenant** (a new pharmacy is just a row insert — onboarding is instant, no provisioning pipeline), **one migration to run** instead of a fleet rollout, one backup, one dashboard, and shared Auth (a pharmacist at two pharmacies has one account). The trade-off is that isolation now lives entirely in your RLS policies — so those policies, and testing them, are the most important engineering artifact in the project. This guide treats them accordingly.

Contents: architecture (§2–3), full schema with RLS policies (§4), auth & tenant membership design (§5), Next.js application design (§6), Vercel/GitHub deployment (§7), Claude Code workflow + `CLAUDE.md` (§8), phased build prompts (§9), and the gotcha checklist (§10).

---

## 2. Multi-Tenancy Model — Shared Schema + RLS

### 2.1 Why this is the right default

Shared-schema with RLS is the mainstream Supabase multi-tenancy pattern, and for good reasons:

- **Cost scales with usage, not tenant count.** 5 or 500 pharmacies run on the same project; you upgrade compute when load demands it, not when tenant #3 signs up.
- **Instant onboarding.** Signup → insert `tenants` row + membership + seed settings in one transaction → redirect to the app. No async job queue, no "we'll email you when ready."
- **One schema, one migration path.** `supabase db push` / migration files apply once. No fleet runner, no per-tenant drift.
- **Cross-tenant features are possible** when you want them later: platform-wide analytics, a shared master medicine catalog (huge win — see §4.3), multi-branch pharmacies under one owner account.
- **Postgres-enforced isolation is strong when done right.** RLS is evaluated inside the database on every query, including ones you didn't anticipate. Combined with `tenant_id` checks in policies and forced RLS on all tables, it is the industry-accepted isolation mechanism for SaaS at this tier.

### 2.2 What you must get right (the honest risks)

1. **RLS coverage is binary.** One table with RLS forgotten = full cross-tenant leak through the public anon key. Mitigation: a CI check that fails if any table in `public` has RLS disabled or lacks a tenant policy, plus automated cross-tenant access tests (§9, Phase 3).
2. **Every policy must check tenant, not just authentication.** `using (auth.uid() is not null)` is a classic fatal bug — authenticated ≠ authorized. Policies must compare `tenant_id` to the caller's tenant claim.
3. **Service-role code bypasses RLS.** Any server code using the service key must scope queries by tenant manually — keep service-role usage rare, wrapped, and reviewed.
4. **Indexes must lead with `tenant_id`** on large tables, or every tenant's queries scan everyone's rows.
5. **Noisy neighbors share compute.** A heavy report from one big chain affects others; mitigate with sensible query design and upgrade compute as you grow. (If one tenant ever truly outgrows the pool, you can still migrate *that* tenant out later — the `tenant_id` column makes their data trivially exportable.)

---

## 3. System Architecture

```
                    ┌──────────────────────────────────────────────┐
 *.pharmasaas.com ─►│           Vercel (one deployment)             │
                    │  Next.js App Router                           │
                    │  middleware: hostname → tenant slug → header  │
                    │  ┌────────────┐ ┌──────────────────────────┐ │
                    │  │ Marketing/ │ │ Tenant app: POS,          │ │
                    │  │ Signup/    │ │ inventory, purchases,     │ │
                    │  │ Admin      │ │ Rx, reports, settings     │ │
                    │  └────────────┘ └──────────────────────────┘ │
                    └───────────────────────┬──────────────────────┘
                                            │ @supabase/ssr (anon key + user JWT)
                                            ▼
                    ┌──────────────────────────────────────────────┐
                    │        ONE Supabase project                   │
                    │  Postgres: all tables tenant_id + RLS         │
                    │  Auth: all users; app_metadata.tenant_id      │
                    │  Storage: one bucket, tenant-prefixed paths   │
                    │    + storage RLS policies                     │
                    └──────────────────────────────────────────────┘
```

**Request flow:**

1. Middleware extracts the subdomain, looks up the tenant (cached), rewrites to `/t/[tenant]/...`, sets `x-tenant-id`.
2. The user's JWT already carries `app_metadata.tenant_id` (stamped at signup/tenant-switch). The app **verifies JWT tenant == subdomain tenant** — if a user logged into Sunrise opens Moon's subdomain, they get a "switch pharmacy" screen, not data.
3. All queries go through the normal anon-key Supabase client with the user's session. RLS does the filtering; app code never needs `.eq('tenant_id', …)` for security (though adding it anyway is good belt-and-suspenders and helps the planner).
4. Writes of `tenant_id` are not trusted from the client: column defaults + `with check` policies pin inserts to the caller's tenant.

---

## 4. Database Design (single project)

### 4.1 Tenancy core

```sql
create table tenants (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,                 -- subdomain
  name text not null,
  status text not null default 'active',     -- active|suspended
  plan text not null default 'trial',
  created_at timestamptz default now()
);

create table tenant_users (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','pharmacist','cashier')),
  is_active boolean default true,
  created_at timestamptz default now(),
  primary key (tenant_id, user_id)
);

-- Helper functions used by every policy (STABLE → cached per statement)
create or replace function auth.tenant_id() returns uuid
language sql stable as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'tenant_id','')::uuid
$$;

create or replace function auth.tenant_role() returns text
language sql stable as $$
  select tu.role from tenant_users tu
  where tu.tenant_id = auth.tenant_id() and tu.user_id = auth.uid() and tu.is_active
$$;
```

Design decisions:

- **`tenant_id` in `app_metadata`** (server-set only — users cannot edit app_metadata, unlike user_metadata) makes RLS checks a pure JWT read: fast, no join per row. The membership table remains the source of truth; `auth.tenant_id()` is the *claim*, and `auth.tenant_role()` re-verifies active membership for role-gated policies.
- **Multi-pharmacy users** (an owner with two branches) are supported: multiple `tenant_users` rows; "switching pharmacy" = a server action using the service-role admin API to update `app_metadata.tenant_id` and refresh the session.
- The signup flow (transaction): create auth user → insert tenant → insert owner membership → stamp `app_metadata.tenant_id` → seed `settings` row. Implemented as a `security definer` Postgres function or a server action with the service client.

### 4.2 Standard RLS pattern (applied to every domain table)

```sql
-- Template — repeat for each table
alter table medicines enable row level security;
alter table medicines force row level security;   -- applies even to table owner

create policy tenant_select on medicines for select
  using (tenant_id = auth.tenant_id());

create policy tenant_insert on medicines for insert
  with check (tenant_id = auth.tenant_id()
              and auth.tenant_role() in ('owner','pharmacist'));

create policy tenant_update on medicines for update
  using (tenant_id = auth.tenant_id())
  with check (tenant_id = auth.tenant_id()
              and auth.tenant_role() in ('owner','pharmacist'));

create policy tenant_delete on medicines for delete
  using (tenant_id = auth.tenant_id() and auth.tenant_role() = 'owner');
```

Rules of the pattern:

- `tenant_id uuid not null references tenants(id)` with `default auth.tenant_id()` on every table — inserts can omit it and can never spoof it (the `with check` rejects mismatches).
- **Never** write a policy that doesn't compare `tenant_id`.
- Role gates vary by table (cashiers: sell yes, edit prices no; profit data & stock adjustments: owner-heavy). Define a role matrix in `docs/ROLES.md` and generate policies from it.
- Composite indexes: `(tenant_id, <query column>)` on every large table; tenant-scoped uniqueness: `unique (tenant_id, invoice_no)`, `unique (tenant_id, medicine_id, batch_no, expiry_date)`, `unique (tenant_id, barcode)` etc.

### 4.3 Domain schema (pharmacy)

Same clinical/retail model as any serious pharmacy system — batch-level inventory, FEFO dispensing, expiry alerting, prescription and controlled-substance handling — now with `tenant_id` woven through:

```sql
create table settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  pharmacy_name text, address text, phone text,
  currency text default 'NPR',
  tax_mode text default 'exclusive',
  default_tax_rate numeric default 0,
  expiry_alert_days int[] default '{30,60,90}',
  invoice_prefix text default 'INV',
  next_invoice_seq bigint default 1,
  low_stock_threshold_default int default 10
);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) default auth.tenant_id(),
  name text not null, phone text, email text, address text, pan_vat_no text,
  balance numeric default 0, created_at timestamptz default now()
);

create table medicines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) default auth.tenant_id(),
  name text not null, generic_name text, composition text, strength text,
  form text, manufacturer text, category text, rack_location text,
  barcode text, unit text default 'pcs',
  units_per_pack int default 1, packs_per_box int default 1,
  is_prescription_required boolean default false,
  is_controlled boolean default false,
  tax_rate numeric, min_stock int, max_stock int,
  is_active boolean default true, created_at timestamptz default now(),
  unique (tenant_id, barcode)
);
create index on medicines (tenant_id);
create index medicines_search on medicines using gin (to_tsvector('simple',
  coalesce(name,'')||' '||coalesce(generic_name,'')||' '||coalesce(composition,'')));

create table batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) default auth.tenant_id(),
  medicine_id uuid not null references medicines(id),
  batch_no text not null, expiry_date date not null,
  qty_available numeric not null default 0,     -- smallest units
  cost_price numeric not null, selling_price numeric not null, mrp numeric,
  received_at timestamptz default now(),
  unique (tenant_id, medicine_id, batch_no, expiry_date)
);
create index on batches (tenant_id, medicine_id, expiry_date);  -- FEFO

create table purchases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) default auth.tenant_id(),
  supplier_id uuid references suppliers(id),
  invoice_no text, purchase_date date default current_date,
  subtotal numeric, tax numeric, discount numeric, total numeric,
  paid numeric default 0, status text default 'received',
  created_by uuid references auth.users(id), created_at timestamptz default now()
);

create table purchase_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) default auth.tenant_id(),
  purchase_id uuid references purchases(id) on delete cascade,
  medicine_id uuid references medicines(id),
  batch_id uuid references batches(id),
  qty numeric, unit_cost numeric, total numeric
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) default auth.tenant_id(),
  name text not null, phone text, address text,
  dob date, gender text, allergies text, notes text,
  credit_balance numeric default 0, created_at timestamptz default now()
);
create index on customers (tenant_id, phone);

create table sales (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) default auth.tenant_id(),
  invoice_no text not null,
  customer_id uuid references customers(id),
  sale_date timestamptz default now(),
  subtotal numeric, discount numeric, tax numeric, total numeric,
  paid numeric, payment_method text,
  status text default 'completed',
  sold_by uuid references auth.users(id),
  unique (tenant_id, invoice_no)
);
create index on sales (tenant_id, sale_date);

create table sale_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) default auth.tenant_id(),
  sale_id uuid references sales(id) on delete cascade,
  medicine_id uuid references medicines(id),
  batch_id uuid not null references batches(id),
  qty numeric not null, unit_price numeric, discount numeric, tax numeric,
  total numeric
);

create table prescriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) default auth.tenant_id(),
  customer_id uuid references customers(id),
  sale_id uuid references sales(id),
  prescriber_name text, prescriber_reg_no text,
  image_path text,                     -- storage: {tenant_id}/rx/{uuid}.jpg
  notes text, issued_date date,
  refills_allowed int default 0, refills_used int default 0,
  created_at timestamptz default now()
);

create table stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) default auth.tenant_id(),
  batch_id uuid references batches(id),
  qty_change numeric not null,
  reason text not null,       -- damage|expiry_writeoff|count_correction|return_to_supplier
  notes text, adjusted_by uuid references auth.users(id),
  created_at timestamptz default now()
);

create table controlled_dispense_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) default auth.tenant_id(),
  sale_item_id uuid references sale_items(id),
  medicine_id uuid references medicines(id),
  customer_id uuid references customers(id),
  prescription_id uuid references prescriptions(id),
  qty numeric, dispensed_by uuid references auth.users(id),
  created_at timestamptz default now()
);

create table audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null default auth.tenant_id(),
  actor uuid, action text not null, entity text, entity_id text,
  before jsonb, after jsonb, created_at timestamptz default now()
);
```

**Optional but recommended: a shared master drug catalog.** A global `drug_catalog` table (no `tenant_id`; read-only to all authenticated users, writable only by you) holding common generic/brand/composition data. Tenants "adopt" entries into their own `medicines` rows. This is a genuine advantage of the shared-DB model — every pharmacy stops re-typing the same 3,000 medicines.

### 4.4 Business-critical RPCs (Postgres functions, not JS)

All `security invoker` so RLS applies inside them; all read tenant from `auth.tenant_id()` — **never** accept `tenant_id` as a parameter:

1. `fefo_allocate(p_medicine_id uuid, p_qty numeric)` — allocates batches ordered by `expiry_date asc`, excluding expired, with `for update skip locked` row locks so two cashiers can't oversell the same batch.
2. `complete_sale(p_payload jsonb)` — one transaction: validate + FEFO-decrement batches, insert sale + items, assign invoice number from `settings.next_invoice_seq` (row-locked increment → gapless per-tenant numbering), write controlled-dispense log rows, update customer credit.
3. `receive_purchase(p_payload jsonb)` — upsert batches, increment stock, update supplier balance.
4. `sales_return(p_sale_id uuid, p_items jsonb)` — restock to originating batches, adjust ledgers.

### 4.5 Storage

One private bucket (`tenant-files`); every object path starts with the tenant id: `{tenant_id}/rx/{uuid}.jpg`. Storage RLS policy: `(storage.foldername(name))[1] = auth.tenant_id()::text` for select/insert/delete. Serve via short-lived signed URLs.

---

## 5. Auth Flows

- **Pharmacy signup** (public, on the marketing site): creates auth user + tenant + owner membership + settings in one server-side transaction, stamps `app_metadata.tenant_id`, redirects to `{slug}.pharmasaas.com`.
- **Staff invites**: owner invites by email (`auth.admin.inviteUserByEmail` via a guarded server action using the service key); accept-invite page creates the membership and stamps the claim. Public self-signup into an existing tenant is disabled.
- **Login** at `{slug}.pharmasaas.com/login` — one shared Auth, but the page validates post-login that the user has an active membership in *this* subdomain's tenant; otherwise offer their tenants list.
- **Tenant switching** (multi-branch owners): server action updates `app_metadata.tenant_id` + `supabase.auth.refreshSession()`, then redirect to the other subdomain.
- **JWT staleness caveat**: after switching or being deactivated, the old JWT lives until refresh — which is why `auth.tenant_role()` re-checks the membership table (`is_active`) on role-gated writes, and deactivation also revokes sessions via the admin API.

---

## 6. Next.js Application Design

```
app/
  (marketing)/            # pharmasaas.com — landing, pricing, signup
  (platform-admin)/       # admin.pharmasaas.com — you: tenants, usage, suspend
  t/[tenant]/             # tenant app (middleware rewrites subdomain here)
    (auth)/login/
    dashboard/
    pos/
    inventory/            # medicines, batches, expiry board, adjustments
    purchases/
    customers/
    prescriptions/
    reports/
    settings/             # pharmacy profile, users & roles, taxes
middleware.ts             # hostname → tenant rewrite (proxy.ts on Next 16)
lib/
  supabase/server.ts      # createServerClient via @supabase/ssr
  supabase/admin.ts       # service-role client — server-only, wrapped, rare
  tenant/context.ts       # getTenant() from x-tenant-id + membership guard
supabase/
  migrations/             # ONE set of migrations for the whole app
  tests/                  # RLS + FEFO SQL tests
```

Middleware follows the `vercel/platforms` pattern (handles `localhost:3000`, `*.vercel.app` previews, and prod): extract subdomain → cached `tenants` lookup (in-memory LRU or Upstash, short TTL) → rewrite to `/t/[slug]` → set `x-tenant-id`. Since there's only one database now, the "tenant client factory" disappears — every request uses the standard `@supabase/ssr` server client, and RLS handles isolation.

Frontend notes (unchanged from v1): POS is keyboard-first (search by name/generic/barcode, barcode-wedge input, FEFO batch shown per line, split payments, thermal 80mm + A4 print CSS); inventory has an expiry board (expired / <30d / <90d) and low-stock views; all money mutations call the RPCs; recommended libs: Tailwind + shadcn/ui, TanStack Table, React Hook Form + Zod, Recharts, date-fns.

---

## 7. Deployment — GitHub → Vercel + one Supabase project

1. Create one Supabase project; keep `supabase/migrations` in the repo, applied via Supabase CLI (`supabase db push` locally; a GitHub Action running `supabase db push --linked` on merge to `main`, or the Supabase GitHub integration with branching if you want preview databases).
2. Push repo to GitHub → import in Vercel. `main` → production, PRs → previews.
3. Domains: add root domain + **wildcard `*.pharmasaas.com`**. Wildcard on Vercel requires the **nameserver method** (point the domain's nameservers to Vercel); Vercel then auto-issues a wildcard cert covering every tenant subdomain.
4. Env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (sensitive, server-only), `ROOT_DOMAIN`. That's it — a fraction of the v1 surface.
5. CI on PR: lint, typecheck, unit tests, **and the RLS test suite against a shadow database** (Supabase CLI local stack in CI: `supabase start` + run SQL tests). RLS tests are the release gate.

---

## 8. Claude Code CLI Workflow

Same discipline as before: `CLAUDE.md` as the contract; **plan mode** (`Shift+Tab` twice or `/plan`) before every multi-file change; kick off big features by having Claude interview you (*"Interview me in detail using the AskUserQuestion tool about technical implementation, UI/UX, edge cases, and tradeoffs"*); one phase per session with progress notes to `docs/PROGRESS.md` before `/clear`; verification (`pnpm typecheck && pnpm lint && pnpm test`) enforced via a hook, not prose; deny-rules on `.env*`; review diffs yourself on the RLS/RPC phase especially.

### `CLAUDE.md` — drop in repo root

```markdown
# PharmaSaaS — multi-tenant pharmacy management SaaS (shared DB + RLS)

## Stack
Next.js (App Router, TypeScript strict) · ONE Supabase project (Postgres,
Auth, Storage) · Tailwind + shadcn/ui · Vercel via GitHub · pnpm

## Tenancy model (non-negotiable)
- Single database. Every domain table has tenant_id uuid not null
  references tenants(id) default auth.tenant_id().
- Isolation is enforced by RLS, always: every table in public has RLS
  ENABLED and FORCED with policies comparing tenant_id = auth.tenant_id().
  A table without a tenant-checking policy is a release blocker.
- auth.tenant_id() reads app_metadata.tenant_id from the JWT (server-set
  only). auth.tenant_role() re-verifies active membership in tenant_users.
- Roles per tenant: owner | pharmacist | cashier (tenant_users.role);
  role gates live in RLS with check clauses, mirrored in UI.
- Service-role client (lib/supabase/admin.ts) bypasses RLS: use ONLY for
  auth admin ops (invites, metadata stamping, session revoke) and
  platform-admin features; every use must manually scope by tenant and be
  flagged in the diff summary.
- Never accept tenant_id from client input; never pass tenant_id as an
  RPC parameter — RPCs derive it from auth.tenant_id().
- Subdomain {slug}.ROOT_DOMAIN → middleware rewrite to /t/[tenant];
  app verifies JWT tenant matches the subdomain tenant.

## Domain rules (pharmacy)
- Inventory is batch-level; all quantities in smallest sellable units
  (units_per_pack / packs_per_box conversions on receipt).
- Sales allocate stock FEFO (earliest expiry first, expired excluded)
  via RPC fefo_allocate/complete_sale with FOR UPDATE SKIP LOCKED —
  never decrement stock from JS.
- Invoice numbers: per-tenant gapless sequence in settings.next_invoice_seq.
- Rx-required and controlled flags on medicines; controlled dispensing
  writes controlled_dispense_log.
- Money = numeric, never float. Tax rates configurable per item.
- Storage paths always {tenant_id}/... with matching storage RLS.

## Migrations & tests
- supabase/migrations: timestamped, append-only; never edit applied files.
- supabase/tests: RLS isolation tests (tenant A must never see tenant B)
  and FEFO/concurrency tests. These must pass in CI before merge.

## Commands
pnpm dev · pnpm typecheck · pnpm lint · pnpm test · supabase start ·
pnpm test:rls

## Working agreements
- Plan mode for any multi-file change; show the plan before editing.
- After edits: typecheck + lint + affected tests; fix before finishing.
- Server components by default; Zod-validate every mutation input.
- Small commits per completed step; update docs/PROGRESS.md per phase.
```

---

## 9. The Build Plan — Phased Prompts

Fresh session per phase; plan mode first, always.

### Phase 0 — Kickoff & scaffold (master prompt)

```
I'm building "PharmaSaaS": a multi-tenant pharmacy management SaaS.

Stack: Next.js App Router + TypeScript strict, Tailwind + shadcn/ui,
ONE Supabase project (Postgres + Auth + Storage), Vercel via GitHub, pnpm.

Multi-tenancy: single shared database. Every domain table has a tenant_id
column; isolation is enforced by Postgres Row Level Security comparing
tenant_id to a JWT claim (app_metadata.tenant_id). tenant_users maps
users → tenants → roles (owner/pharmacist/cashier). Subdomain per tenant
({slug}.pharmasaas.com) via middleware rewrite to /t/[tenant]. Onboarding
is instant: signup inserts tenant + membership + settings in one
transaction — no provisioning infrastructure.

First read CLAUDE.md. Then interview me using the AskUserQuestion tool
about anything ambiguous (currency/tax rules, invoice format, seed data,
languages, whether to include a shared master drug catalog). After the
interview, enter plan mode and produce a build plan matching:
scaffold → tenancy core + RLS foundation → auth/onboarding →
inventory → purchases → POS/sales → customers/prescriptions → reports →
platform admin → hardening/deploy. Then implement ONLY the scaffold:
Next.js app with the route-group structure from CLAUDE.md, Tailwind,
shadcn/ui, ESLint/Prettier, vitest, supabase CLI init (local stack),
zod-validated env.ts, stub middleware. Commit when green.
```

### Phase 1 — Tenancy core, RLS foundation, middleware

```
Plan mode first. Build the tenancy foundation:
1. Migration: tenants, tenant_users, auth.tenant_id() and
   auth.tenant_role() helper functions exactly as in docs/ARCHITECTURE.md.
2. A reusable SQL macro/pattern for the standard four tenant policies
   (select/insert/update/delete) and document the role matrix in
   docs/ROLES.md.
3. middleware.ts: subdomain extraction for localhost:3000, *.vercel.app
   previews, and ROOT_DOMAIN (mirror vercel/platforms); rewrite to
   /t/[tenant]; set x-tenant-id; cached tenant lookup (LRU, 60s TTL);
   clean 404 page for unknown/suspended tenants.
4. lib/supabase/server.ts (@supabase/ssr) and lib/supabase/admin.ts
   (service role, server-only, with a scopedAdmin(tenantId) wrapper).
5. supabase/tests: the FIRST RLS tests — seed two tenants + one user
   each, assert cross-tenant select/insert/update/delete all fail on
   tenants and tenant_users. Add pnpm test:rls running against the local
   supabase stack, and a CI check that fails if any public table has RLS
   disabled (query pg_tables/pg_policies).
Typecheck, lint, tests green; commit.
```

### Phase 2 — Auth & instant onboarding

```
Plan mode first.
1. Public signup (marketing site): pharmacy name, slug (live availability
   check; reserved: www/admin/api/app), owner email + password. Server
   action: create user, tenant, owner membership, settings row in one
   transaction (security definer function), stamp app_metadata.tenant_id,
   redirect to {slug} subdomain dashboard.
2. Tenant login at /t/[tenant]/login; after login verify active
   membership in THIS tenant, else show the user's tenant list.
3. Settings → Users: owner invites staff by email
   (auth.admin.inviteUserByEmail via scopedAdmin), accept-invite page
   creates membership + stamps claim; deactivate flow revokes sessions.
4. Tenant switcher for users with multiple memberships (updates
   app_metadata.tenant_id, refreshes session, redirects).
Extend RLS tests: invited cashier can read medicines but not update
cost_price; deactivated user loses access after refresh.
```

### Phase 3 — Pharmacy schema + business RPCs (the critical phase)

```
Plan mode first — and I will review this diff carefully.
Create the full domain schema from docs/ARCHITECTURE.md §4.3 with
tenant_id defaults, composite (tenant_id, …) indexes, tenant-scoped
unique constraints, and the standard RLS policy set per table with the
role matrix from docs/ROLES.md. Then the RPCs (security invoker, tenant
derived from auth.tenant_id(), never a parameter):
fefo_allocate (FOR UPDATE SKIP LOCKED, expired excluded),
complete_sale (single transaction incl. gapless per-tenant invoice
numbering from settings.next_invoice_seq), receive_purchase, sales_return.
Storage: private bucket tenant-files with path-prefix RLS policies.
Tests: FEFO edge cases (multi-batch spanning, exact depletion,
insufficient stock, expired exclusion, concurrent allocation via two
parallel connections) and cross-tenant RLS assertions on EVERY new table
(generate these programmatically from the table list so none is missed).
```

### Phase 4 — Inventory module

```
Plan mode first. Build /t/[tenant]/inventory:
medicines CRUD (unit hierarchy, rx/controlled flags, tax, min/max,
rack, barcode), full-text search, TanStack Table with server pagination
and stock-on-hand; per-medicine batch view; expiry board
(expired / <30d / <90d from settings.expiry_alert_days); low-stock
report; reason-coded stock adjustments (audit-logged). Zod on all
server actions; audit_log writes on create/update/adjust.
```

### Phase 5 — Purchases & suppliers

```
Plan mode first. Suppliers CRUD + balance ledger. Purchase entry (GRN):
supplier, line items → receive_purchase RPC (pack→unit conversion,
batch upsert with batch_no/expiry/cost/price/MRP). Purchase list/detail,
supplier payments, supplier returns (negative adjustment + ledger),
suggested-reorder report from min/max levels.
```

### Phase 6 — POS & sales

```
Plan mode first. /t/[tenant]/pos, keyboard-first: search by
name/generic/barcode (barcode-wedge input), cart lines showing the
FEFO-picked batch + expiry, qty/discount edits, rx-required interception
(attach or reference a prescription), payment (cash/card/wallet/credit +
split; credit hits customer ledger), completion strictly via
complete_sale RPC. Thermal 80mm + A4 invoice print CSS. Sales history,
detail, and sales-return via sales_return RPC. Controlled items →
controlled_dispense_log. Integration tests for the full sale flow.
```

### Phase 7 — Customers, prescriptions, reports

```
Plan mode first.
1. Customers: CRUD, purchase/medication history, credit ledger + settle.
2. Prescriptions: image upload to tenant-files ({tenant_id}/rx/…),
   signed URLs, prescriber details, refill tracking, sale linkage.
3. Reports: dashboard (today's sales, dues, expiring soon, low stock);
   date-ranged sales & profit (revenue − batch cost), fast/slow movers,
   stock valuation, expiry report, controlled register export, tax
   summary; CSV export each; Recharts. Profit views owner-only
   (RLS + UI).
```

### Phase 8 — Platform admin

```
Plan mode first. admin.{ROOT_DOMAIN} for me only (allowlisted platform
admin emails via a platform_admins table; service-role queries through
an explicit adminOnly() guard): tenant list with usage stats (sales
count, users, storage), suspend/reactivate (middleware already blocks
suspended tenants), and — if we adopted it — the shared drug_catalog
management UI. No platform admin route may ever render inside tenant
subdomains.
```

### Phase 9 — Hardening & deploy

```
Plan mode first.
1. Security pass: script asserting every public table has RLS
   enabled+forced with a tenant policy (CI gate); grep for raw service
   client usage outside admin.ts; rate-limit auth/signup routes;
   security headers; verify no service key in client bundle.
2. Perf pass: EXPLAIN the hot queries (POS search, dashboard) and
   confirm (tenant_id, …) index usage.
3. GitHub Actions: lint+typecheck+unit on PR; supabase local stack +
   test:rls on PR; db push to prod on merge (manual approval step).
4. docs/DEPLOY.md: Vercel-GitHub setup, env vars, root + wildcard
   domain via nameserver method, smoke-test checklist (signup →
   login → purchase → sale → invoice → report → cross-tenant probe).
5. Demo tenant seed script with realistic pharmacy data.
Full verification suite green; update PROGRESS.md; commit.
```

---

## 10. Gotchas & Risk Checklist

**RLS (your entire security model)**

- A single table with RLS off = platform-wide breach via the public anon key. The CI check in Phase 1/9 is non-negotiable.
- Policies must compare `tenant_id`, not merely require authentication.
- `force row level security` on every table (owner-role connections otherwise bypass).
- Views default to owner privileges — use `security_invoker = true` on any view, or it silently bypasses RLS.
- `security definer` functions bypass RLS: audit each one; business RPCs stay `security invoker`.
- Service-role usage is a leak vector by design — confine to `admin.ts`, wrap with tenant scoping, flag in reviews.
- JWT claims are cached until refresh: role/tenant changes need session refresh or revocation; `auth.tenant_role()` re-checking the membership table covers the write path.

**Performance**

- Every large-table index leads with `tenant_id`; verify with `EXPLAIN` (RLS adds the filter — make sure the planner uses the index, and prefer the `stable` helper functions so the claim is evaluated once per statement, not per row).
- Middleware runs on every request — tenant lookup must be cached.

**Domain correctness**

- FEFO with `FOR UPDATE SKIP LOCKED` or two cashiers oversell one batch.
- All quantities in smallest units; pack/strip/tablet conversion happens once, at goods receipt.
- `numeric` for money; tax configurable per item (rates/exemptions vary by country).
- Expired batches excluded from allocation and visually flagged; write-offs via reason-coded adjustments.
- Per-tenant gapless invoice numbering via the locked `settings.next_invoice_seq` — never a global sequence.

**Next.js / Vercel**

- Wildcard `*.domain` on Vercel needs the nameserver method for DNS + auto wildcard SSL.
- Next.js 16 renames `middleware.ts` → `proxy.ts`; check your version and the current `vercel/platforms` repo before scaffolding.
- Always verify JWT-tenant == subdomain-tenant server-side; never trust the URL alone.

**Claude Code discipline**

- Plan mode every phase; personally review Phase 3 (schema/RLS/RPCs) — the one phase where a plausible mistake is a data breach.
- Fresh session per phase; notes to `docs/PROGRESS.md` before clearing.
- Hooks for must-run checks; deny-rules on `.env*`; no real keys pasted into sessions.

---

## 11. Key References

- Supabase RLS docs & multi-tenancy discussion: `supabase.com/docs/guides/database/postgres/row-level-security`, `github.com/orgs/supabase/discussions/1615`
- RLS + workspace-claim reference implementation: `github.com/dikshantrajput/supabase-multi-tenancy`
- Vercel multi-tenant concepts & wildcard domains: `vercel.com/docs/multi-tenant`
- Official Next.js multi-tenant starter (middleware pattern): `github.com/vercel/platforms`
- Claude Code best practices (plan mode, CLAUDE.md, interview workflow): `code.claude.com/docs/en/best-practices`

---

### What changed vs. the v1 (database-per-tenant) guide

Removed: control plane / data plane split, Supabase Management API provisioning pipeline, encrypted per-tenant credentials, fleet migration runner, per-tenant client factory, async onboarding. Added: `tenant_id` + RLS pattern on every table, JWT tenant claim + membership model, instant transactional onboarding, RLS test suite as the CI release gate, optional shared master drug catalog. Cost model drops from ~$10–25/month *per tenant* to one project scaled by total load, and the ops burden drops by roughly an order of magnitude.
