@AGENTS.md

# PharmaSaaS — multi-tenant pharmacy management SaaS (shared DB + RLS)

## Stack

Next.js 16 (App Router, `src/`, TypeScript strict) · React 19.2 · ONE Supabase
project (Postgres, Auth, Storage) · Tailwind v4 · Vercel via GitHub · pnpm

## Next.js 16 conventions (differ from older training data)

- Request-time APIs are **async**: `await cookies()`, `await headers()`,
  `await params`, `await searchParams`. Synchronous access was removed in 16.
- Middleware is now **`src/proxy.ts`** exporting a function named `proxy`.
  It always runs on the **Node.js runtime** (not edge) and that is not
  configurable. `middleware.ts` is deprecated — do not create it.
- Turbopack is the default for `next dev` and `next build`.
- `next lint` was removed; lint via the ESLint CLI (`pnpm lint`).
- Use the generated `PageProps<'/route'>` / `LayoutProps<'/route'>` helper
  types rather than hand-writing props. Run `pnpm typegen` if they go stale.
- Read the docs in `node_modules/next/dist/docs/` before using an unfamiliar
  API — they are authoritative for this version.

## Tenancy model (non-negotiable)

- Single database. Every domain table has
  `tenant_id uuid not null references tenants(id) default auth.tenant_id()`.
- Isolation is enforced by RLS, always: every table in `public` has RLS
  **enabled and forced**, with policies comparing `tenant_id = auth.tenant_id()`.
  A table without a tenant-checking policy is a release blocker.
- `auth.tenant_id()` reads `app_metadata.tenant_id` from the JWT (server-set
  only). `auth.tenant_role()` re-verifies active membership in `tenant_users`.
- Roles per tenant: `owner | pharmacist | cashier` (`tenant_users.role`);
  role gates live in RLS `with check` clauses, mirrored in the UI.
  The authoritative matrix is `docs/ROLES.md`.
- The service-role client (`src/lib/supabase/admin.ts`) bypasses RLS: use ONLY
  for auth admin ops (invites, metadata stamping, session revoke) and
  platform-admin features. Every use must manually scope by tenant and be
  called out in the change summary.
- Never accept `tenant_id` from client input; never pass `tenant_id` as an RPC
  parameter — RPCs derive it from `auth.tenant_id()`.
- Routing: `{slug}.ROOT_DOMAIN` → proxy rewrite to `/t/[tenant]`. A path-based
  fallback (`/t/{slug}/...`) is supported for localhost and preview URLs.
  The app always verifies the JWT tenant matches the resolved tenant.

## Domain rules (pharmacy)

- Inventory is batch-level; all quantities stored in smallest sellable units
  (`units_per_pack` / `packs_per_box` conversions happen once, at receipt).
- Sales allocate stock FEFO (earliest expiry first, expired excluded) via the
  `fefo_allocate` / `complete_sale` RPCs using `FOR UPDATE SKIP LOCKED` —
  never decrement stock from JS.
- **Cost lives in `batch_costs`, never on `batches` or `sale_items`.** RLS
  filters rows, not columns, so cost can only be hidden from cashiers by
  living in its own role-gated table. Profit is computed by joining
  `sale_items → batches → batch_costs` at report time, never snapshotted.
- **The mutating RPCs are `SECURITY DEFINER`** (`complete_sale`,
  `receive_purchase`, `sales_return`, `adjust_stock`, `fefo_allocate`), so
  cashiers need no direct write rights on `batches`. This means RLS is OFF
  inside them: every one must call `public.require_tenant_role(...)` and
  constrain every id it is passed with `and tenant_id = v_tenant`. Adding an
  unfiltered query there is a cross-tenant write.
- `sales` and `sale_items` have **no insert/update/delete policy at all** —
  every sale must go through `complete_sale` so it cannot skip invoice
  numbering, FEFO, or the controlled register.
- Invoice numbers: per-tenant gapless sequence in `settings.next_invoice_seq`,
  incremented under a row lock. Never a global sequence.
- `is_prescription_required` and `is_controlled` flags on medicines;
  controlled dispensing writes `controlled_dispense_log`.
- Money is `numeric`, never float. Tax rates configurable per item.
- Locale defaults: currency NPR, tax mode exclusive, default rate 13%,
  Gregorian dates, English UI.
- Storage paths are always `{tenant_id}/...` with matching storage RLS.

## Migrations & tests

- `supabase/migrations`: timestamped, append-only. Never edit an applied file —
  add a new migration instead.
- `supabase/tests`: RLS isolation tests (tenant A must never see tenant B) and
  FEFO/concurrency tests. These gate merges in CI.

## Commands

```
pnpm dev · pnpm build · pnpm typecheck · pnpm lint · pnpm format
pnpm test · pnpm test:rls · pnpm typegen
pnpm db:push · pnpm db:diff · pnpm db:reset
```

## Working agreements

- Plan before any multi-file change; show the plan before editing.
- After edits: `pnpm typecheck && pnpm lint` plus affected tests; fix before
  finishing.
- Server Components by default; Zod-validate every mutation input.
- Small commits per completed step; update `docs/PROGRESS.md` per phase.
