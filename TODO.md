# TODO

State as of 2026-07-28. All nine build phases are complete, applied to the live
Supabase project, and verified — 21 unit tests, 7 security checks, 134 RLS
tests. What follows is everything that is _not_ done, in the order it matters.

Nothing in Part 1 requires code. Parts 2–4 do.

---

## Part 1 — Setup (nothing works in production until these are done)

### 1.1 Try it locally · 2 min · no prerequisites

```bash
pnpm dev
```

Sign up at `http://localhost:3000/signup`. The database currently has **no
users** — the demo tenant was removed before the repo went public, so start
fresh.

Worth doing immediately, because it is the fastest way to see whether the thing
is actually what you wanted before investing in deployment.

To see the design decision that shaped the whole schema: add a cashier under
**Staff**, sign in as them, open any medicine. There is no Cost column and no
Adjust button — not hidden by the interface, simply not returned by the
database.

`pnpm seed:demo` fills a pharmacy with 12 medicines, 2 suppliers, 5 customers
and ~20 sales if you would rather not key it all in. It prints the generated
password once.

### 1.2 Deploy to Vercel · ~10 min

1. [vercel.com/new](https://vercel.com/new) → import `bishnuthames101/pharmasaas`
2. Environment variables (copy the values from your local `.env.local`):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` — tick **Sensitive**
   - `NEXT_PUBLIC_ROOT_DOMAIN` — `localhost:3000` until you own a domain
3. Deploy

Tenants are reached by path (`/t/{slug}`) on `*.vercel.app`, which has no
wildcard DNS. That is handled automatically.

### 1.3 Make CI pass · ~5 min

The `security` and `migrate` jobs are **currently failing** — they have no
credentials. GitHub → **Settings → Secrets and variables → Actions**:

| Secret                      | Value                               |
| --------------------------- | ----------------------------------- |
| `SUPABASE_URL`              | same as `NEXT_PUBLIC_SUPABASE_URL`  |
| `SUPABASE_ANON_KEY`         | your anon key                       |
| `SUPABASE_SERVICE_ROLE_KEY` | your service key                    |
| `SUPABASE_DB_URL`           | the pooler string from `.env.local` |

Then **Settings → Environments** → create `production` → add yourself as a
required reviewer. That approval gate is what stands between a merge and a
production migration.

### 1.4 Appoint yourself platform admin · 1 min

Do this _after_ signing up in 1.1. Supabase → **SQL Editor**:

```sql
insert into public.platform_admins (user_id, email, note)
select id, email, 'founder'
from auth.users
where email = 'your@email.com';
```

The console is then at `/admin`. This is deliberately impossible from inside the
application — that is what stops anyone promoting themselves.

### 1.5 Custom SMTP · before real customers

**Password reset does not work at all until this is done.** Supabase's built-in
mailer is rate limited to a handful of messages an hour and will not reliably
reach arbitrary domains.

Authentication → Emails → SMTP settings. Resend, Postmark or SES all work. No
code changes; the flow simply starts working.

### 1.6 Wildcard domain · optional

Only if you want `sunrise.yourdomain.com` rather than `/t/sunrise`. Both modes
are already supported and switching needs no code change.

**Wildcard domains on Vercel require the nameserver method** — CNAME records
will not work, because Vercel cannot issue the wildcard certificate without
controlling DNS. Full steps in `docs/DEPLOY.md` §4.

---

## Part 2 — Functional gaps

Things a pharmacy would reasonably expect that are genuinely not built. Ordered
by how much their absence hurts.

### 2.1 No settings screen — **the most significant omission**

The `settings` table exists, is populated at signup, and has an owner-only
update policy. There is **no page to edit it.** An owner currently cannot change:

- pharmacy name, address, phone (as shown on receipts)
- tax rate and tax mode (inclusive/exclusive)
- invoice prefix
- expiry alert thresholds — the expiry board reads these, so the buckets are
  stuck at 30/60/90
- default low-stock threshold

All of it is editable directly in the Supabase table editor as a stopgap. A
page at `/settings` wiring these to the existing policy is perhaps an hour's
work and should probably come before anything else here.

### 2.2 Dashboard is a placeholder

It shows configuration (currency, tax rate, next invoice number), not an
operational summary. The guide called for today's takings, outstanding dues,
stock expiring soon, and low-stock items.

Every one of those numbers already exists in a view — `sales_daily`,
`customers.credit_balance`, `batch_expiry_board`, `medicine_stock.is_low_stock`
— so this is assembly, not new logic.

### 2.3 No supplier returns

`return_to_supplier` exists as a stock-adjustment reason, so stock leaves
correctly, but nothing credits the supplier's balance. Returning goods currently
requires a manual negative payment.

Wants a `return_to_supplier()` RPC mirroring `pay_supplier()` — adjust stock and
move the balance in one transaction, for the same reason payments do.

### 2.4 Prescription IDs are pasted by hand

At the counter, dispensing a prescription-only item means copying a UUID from
the Prescriptions page. It works and it is safe, but it is not something to hand
a busy cashier.

Should be a picker showing that customer's recent unexhausted prescriptions.

### 2.5 No purchase edit or cancel

A goods receipt keyed wrongly can only be corrected with stock adjustments. The
`purchases.status` column already allows `cancelled`; nothing sets it.

### 2.6 No stock-take workflow

Counting shelves means adjusting batches one at a time with
`count_correction`. A proper stock take — enter counted quantities, review
variance, commit — is a normal pharmacy routine.

### 2.7 Lists are unpaginated except inventory

Sales caps at 100 rows, customers at 100, purchases at 50, prescriptions at 50.
Fine for a year; not fine for three. Inventory already has server-side
pagination to copy.

---

## Part 3 — Known limitations

Deliberate, documented, and worth knowing before someone discovers them.

### 3.1 No Content-Security-Policy

Next injects inline scripts for hydration, so a real CSP needs a per-request
nonce threaded through `src/proxy.ts`. A permissive `unsafe-inline` policy would
look like protection while providing none, so none is set. The other security
headers are in `next.config.ts`.

### 3.2 Rate limiting is per instance and in memory

`src/lib/rate-limit.ts` blunts credential stuffing from one source. It is not a
fleet-wide guarantee — on multiple Vercel instances the effective limit
multiplies. For a real cap, use Upstash or Supabase-side throttling.

It also reads `x-forwarded-for`, which is trustworthy on Vercel and spoofable
behind a proxy that does not rewrite it.

### 3.3 The RLS suite runs against the shared dev project

It namespaces fixtures and cleans up after itself, but two concurrent runs will
interfere. Supabase branching would give each PR its own database.

### 3.4 No backup restore has ever been tested

Supabase takes daily backups on paid plans. Nobody has proven one can be
restored. A backup you have not restored is a hypothesis.

### 3.5 No browser end-to-end tests

Flows were verified by posting to the real form endpoints — the same server
actions a browser drives — plus one partial live browser run before the
extension disconnected. That covers the wire, not rendering or client-side
interaction.

The POS is the strongest candidate for Playwright, since its keyboard handling
(arrows, F2, F4, barcode auto-add) is exactly what HTTP-level testing cannot
reach.

### 3.6 Batch cost uses latest-wins, not weighted average

Topping up an existing batch number overwrites its cost. A batch is one physical
lot so its cost rarely moves, but if you buy the same batch number at genuinely
different prices, margin will be slightly wrong. `receive_purchase` is where
this changes.

---

## Part 4 — Worth considering later

- **Shared master drug catalogue.** The guide's §4.3 optional idea and a real
  advantage of the shared-database model: a global `drug_catalog` that pharmacies
  adopt entries from, so nobody re-types the same 3,000 medicines. Not built.
- **Offline-tolerant POS.** Power and connectivity are not guaranteed in Nepal,
  and a counter that stops selling when the internet drops is a serious problem.
  This is a large piece of work (local queue, conflict resolution) and would need
  care around FEFO, which is deliberately server-side.
- **Bikram Sambat dates.** You chose Gregorian; worth revisiting if customers
  expect BS on invoices.
- **Barcode label printing** for items that arrive without one.
- **Per-medicine profit breakdown** in the UI. `sale_profit` already returns it
  per line; only the aggregate is displayed.
- **Multi-branch reporting.** The tenant switcher works, but there is no
  consolidated view across pharmacies one owner holds.
- **`sale_items` has no index on `sale_id` alone** — it is covered by
  `(tenant_id, sale_id)`, which is correct for RLS, but worth an `EXPLAIN` if
  sale detail pages slow down.

---

## Reference

| Command               | What it does                                                 |
| --------------------- | ------------------------------------------------------------ |
| `pnpm dev`            | Run locally                                                  |
| `pnpm verify:all`     | Everything: types, lint, unit, security audit, 134 RLS tests |
| `pnpm test:rls`       | Cross-tenant isolation suite alone                           |
| `pnpm test:rls-gate`  | Proves the coverage gate still catches breakage              |
| `pnpm audit:security` | Static + database security checks                            |
| `pnpm db:push`        | Apply migrations                                             |
| `pnpm seed:demo`      | Realistic demo pharmacy                                      |

Detail lives in `docs/DEPLOY.md` (setup, smoke tests), `docs/ROLES.md` (the role
matrix RLS is generated from), and `docs/PROGRESS.md` (what was built each phase
and why).
