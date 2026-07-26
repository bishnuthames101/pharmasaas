# PharmaSaaS — Build Progress

Phase status against the plan in `docs/ARCHITECTURE.md` §9.

| Phase | Scope                               | Status                    |
| ----- | ----------------------------------- | ------------------------- |
| 0     | Scaffold & tooling                  | Done                      |
| 1     | Tenancy core, RLS foundation, proxy | Done, verified on live DB |
| 2     | Auth & instant onboarding           | Done, verified end to end |
| 3     | Pharmacy schema + business RPCs     | Not started               |
| 4     | Inventory module                    | Not started               |
| 5     | Purchases & suppliers               | Not started               |
| 6     | POS & sales                         | Not started               |
| 7     | Customers, prescriptions, reports   | Not started               |
| 8     | Platform admin                      | Not started               |
| 9     | Hardening & deploy                  | Not started               |

## Decisions log

- **2026-07-26** — Supabase: hosted project only, no local Docker stack. The
  RLS suite therefore runs against a real dev project rather than an ephemeral
  local database. Revisit if we want isolated per-PR databases in CI.
- **2026-07-26** — Package manager: pnpm, installed globally via npm because
  `corepack enable` needs Administrator rights on this machine (Node lives in
  `C:\Program Files`).
- **2026-07-26** — Tenant addressing: path-based (`/t/{slug}`) is the working
  mode, with subdomain resolution already implemented and preferred when
  present. This defers buying a domain and configuring wildcard DNS to Phase 9
  without any later code change.
- **2026-07-26** — Locale: NPR currency, 13% VAT exclusive, Gregorian dates,
  English UI.
- **2026-07-26** — Next.js scaffolded at **16.2.12**, which renames
  `middleware.ts` to `src/proxy.ts` (Node runtime only) and makes `params`,
  `cookies()` and `headers()` async. Recorded in `CLAUDE.md` so later phases
  do not regress to Next 15 idioms.

## Phase 0 — Scaffold

Done:

- `create-next-app` with TypeScript strict, Tailwind v4, ESLint, `src/`,
  App Router, `@/*` alias.
- Dependencies: `@supabase/supabase-js`, `@supabase/ssr`, `zod`, `date-fns`,
  `clsx`, `tailwind-merge`, `class-variance-authority`, `lucide-react`.
- Dev tooling: `vitest`, `prettier` (+ Tailwind plugin), `tsx`, `dotenv`, and
  the Supabase CLI as a **local dev dependency** so no global install is
  needed (`pnpm exec supabase`).
- `src/env.ts` — Zod-validated environment with server secrets isolated behind
  a lazy `serverEnv()` accessor.
- `src/lib/tenant/subdomain.ts` — pure tenant resolution (subdomain + path
  modes, reserved-slug list) with unit tests.
- `src/proxy.ts` — rewrites tenant requests onto `/t/{slug}` and sets
  `x-tenant-slug`.
- `supabase/` initialised via `supabase init`.

Deliberately deferred to Phase 1: the cached `tenants` lookup in the proxy
(unknown/suspended tenants currently fall through instead of 404ing), and the
Supabase server/admin clients.

## Phase 1 — Tenancy core & RLS foundation

**Status: applied and verified** against the live Supabase project
(`sohbmvmlxpuwnoksctko`, ap-southeast-1) on 2026-07-26.

- `pnpm db:push` — both migrations applied.
- `pnpm test:rls` — 15/15 passing, including every cross-tenant probe.
- `pnpm test:rls-gate` — the coverage gate provably fires on all four failure
  modes (see below).
- End-to-end: `/t/sunrise` and `sunrise.localhost:3000` render the pharmacy
  name from the database; a suspended tenant shows the notice instead of data;
  an unknown slug 404s; and the anon key is refused on `public.tenants`.

### Connection note

`supabase link` was avoided — it requires a dashboard access token, whereas the
database password alone is enough. Migrations run through `scripts/db.ts`, which
supplies `--db-url` from `.env.local`. The connection **must** use the
session-mode pooler (`aws-0-ap-southeast-1.pooler.supabase.com:5432`): the
direct host `db.<ref>.supabase.co` publishes only an AAAA record and does not
resolve on this IPv4-only network.

### The gate is proven, not assumed

`scripts/verify-rls-gate.ts` creates four deliberately broken tables, asserts
each is reported, then drops them:

| Probe                            | Expected report           |
| -------------------------------- | ------------------------- |
| RLS never enabled                | `rls_disabled`            |
| Enabled but not forced           | `rls_not_forced`          |
| Forced but no policy             | `no_policies`             |
| `using (auth.uid() is not null)` | `no_tenant_scoped_policy` |

The last is the one that matters: a policy that looks protective, passes review,
and grants every authenticated user on the platform access to every pharmacy.
The gate catches it.

Done:

- `supabase/migrations/20260726000100_tenancy_core.sql` — `tenants`,
  `tenant_users`, the `tenant_id()` / `tenant_role()` / `is_tenant_member()`
  helpers, and RLS policies on both tables (enabled **and** forced).
- `supabase/migrations/20260726000200_rls_coverage_guard.sql` —
  `rls_coverage_gaps()`, a service-role-only catalog query that reports any
  table in `public` with RLS off, RLS unforced, no policies, or a `tenant_id`
  column that no policy references. Empty result is the pass condition.
- `src/lib/supabase/{server,client,admin}.ts` — the anon/session client used
  for all data access, the browser client for auth forms, and the service-role
  client with a `scopedAdmin(tenantId)` wrapper. `admin.ts` imports
  `server-only`, making a client-side import a build error.
- `src/lib/tenant/lookup.ts` — slug → tenant with a 60s in-process cache.
- `src/lib/tenant/context.ts` — `getTenantAccess()`, which separately checks
  tenant existence, active membership, and JWT-claim/subdomain agreement.
- `src/app/t/[tenant]/layout.tsx` — 404 on unknown/malformed slugs, explanation
  page on suspended tenants.
- `supabase/tests/` — cross-tenant isolation suite plus the coverage gate.
- `docs/ROLES.md` — the role matrix RLS policies are generated from.

### Deviations from the reference guide, and why

1. **Helper functions live in `public`, not `auth`.** Supabase manages the
   `auth` schema and may drop custom objects there during an upgrade. Policy
   behaviour is identical; only the qualified name changes
   (`public.tenant_id()`).
2. **`tenant_role()` and `is_tenant_member()` are `SECURITY DEFINER`.** They are
   called from the RLS policies on `tenant_users`; reading that table under the
   caller's own RLS would recurse infinitely. Both are parameter-free or
   `auth.uid()`-scoped, so neither can be used to probe other users.
3. **The tenant DB lookup happens in the tenant layout, not the proxy.** Next
   16's own documentation states the proxy "is not intended for slow data
   fetching". The proxy stays pure string work; the layout does the cached
   lookup, where the membership check has to happen anyway.
4. **Helper calls in policies are wrapped as `(select public.tenant_id())`** so
   Postgres hoists them into an InitPlan and evaluates once per statement
   instead of once per row.

### Known gap, deferred to Phase 3

RLS filters rows, not columns. `batches.cost_price` is readable via the API by
any staff member of a pharmacy, including cashiers, because they must read
`batches` to sell. Column `GRANT`s cannot help — everyone connects as the same
`authenticated` Postgres role. Fixing it properly means moving cost into a
separate role-gated table. Documented in `docs/ROLES.md`; needs a decision.

## Phase 2 — Auth & instant onboarding

**Status: built and verified end to end** against the live database.

### Migrations

- `20260726000300_onboarding.sql` — `settings` (owner-writable, all-staff
  readable, no insert/delete policy at all), `reserved_slugs`,
  `slug_available()`, and `provision_tenant()`.
- `20260726000400_auth_admin_helpers.sql` — `user_id_by_email()` and
  `revoke_user_sessions()`, both service-role only.

### Flows

- **Signup** — pharmacy name, live-checked slug, owner email and password.
  Creates the auth user, then calls `provision_tenant`, which inserts tenant +
  owner membership + settings in one transaction. If provisioning fails the
  just-created auth user is deleted, so a failed signup cannot leave an orphan
  who can sign in but belongs to nothing.
- **Tenant login** (`/t/{slug}/login`) — verifies active membership in _this_
  pharmacy after the password check, and restamps the JWT claim when a member
  arrives with a token pointed at a different pharmacy.
- **Global login** (`/login`) — one pharmacy goes straight there, several go to
  `/choose-pharmacy`, none signs back out.
- **Tenant switcher** — re-checks membership server-side before restamping.
- **Staff management** — owner adds staff with an initial password, and
  activates/deactivates them.

### Decisions

1. **Email confirmation is off; accounts are created confirmed.** Supabase's
   built-in mailer is rate limited to a handful of messages an hour and is not
   deliverable to arbitrary domains without custom SMTP. Custom SMTP is a
   Phase 9 deploy task.
2. **Staff get a password from the owner, not an emailed invite.** For the same
   deliverability reason, and because counter staff frequently have no work
   email at all. An invitation flow that depends on inbox access would not work
   in an actual pharmacy. `inviteUserByEmail` stays available for later.
3. **Sign-in errors do not distinguish "no such account" from "wrong
   password"**, so the form cannot be used to enumerate registered emails.
4. **Session revocation is honest about its limits.** `revoke_user_sessions()`
   deletes sessions and refresh tokens, so a deactivated user cannot extend
   their session — but an already-issued access token stays valid until it
   expires. Write access is cut off immediately regardless, because
   `tenant_role()` re-reads `tenant_users` instead of trusting the token. This
   is asserted in the tests.
5. **`switchTenant` and `setStaffActive` take the `useActionState` signature**
   rather than being bound directly to `action={}`. A bare `action={fn}` must
   return `void`, which would have meant discarding their error results.

### Verified

- `pnpm test:rls` — **35/35**, covering: reserved-slug list parity between the
  database and `subdomain.ts`; `slug_available` rules; `provision_tenant`
  atomicity and its rejection of tenant-user callers; `settings` cross-tenant
  isolation and the cashier/owner split; and the admin helpers' access control.
- **JWT claim staleness**, the subtlest part of the design, is pinned by three
  tests: a session signed in before stamping sees nothing; stamping _without_
  refreshing still sees nothing; only after `refreshSession()` does data appear.
  A fourth forges a claim pointing at a pharmacy the user does not belong to and
  asserts `tenant_role()` returns null and the write is refused — the claim
  alone is never sufficient.
- Route guards over HTTP: `/t/{slug}/dashboard` and `/settings/users` redirect
  unauthenticated callers to the tenant login; `/choose-pharmacy` redirects to
  `/login`; suspended tenants show the notice. Redirects are emitted in the
  correct form for each addressing mode (`/login` on a subdomain, `/t/{slug}/login`
  on a path).
- In a real browser: the signup page renders, the slug auto-derives from the
  pharmacy name, and the live availability check round-trips to the database —
  which also demonstrates that server actions work over the wire.

### End-to-end verification

The signup and login flows were exercised by posting to the real form endpoints
(the progressive-enhancement path Next renders for no-JS clients), which drives
the same server actions a browser does:

| Flow                                    | Result                                          |
| --------------------------------------- | ----------------------------------------------- |
| Signup                                  | `303 -> /t/{slug}/dashboard`                    |
| — tenant, owner membership, settings    | all three created, with phone/address/NPR/13%   |
| — session cookie                        | carries `app_metadata.tenant_id`                |
| Dashboard with that session             | `200`, renders name, NPR, 13%, `INV-1`, `owner` |
| Staff page with that session            | `200`, renders the owner and the add-staff form |
| Login, correct credentials              | `303 -> /t/{slug}/dashboard`                    |
| Login, wrong password                   | "Incorrect email or password"                   |
| Login, unknown account                  | _identical_ message — no email enumeration      |
| Login, valid account at wrong pharmacy  | "does not have access to Sunrise Pharmacy"      |
| Signed-in user opening another pharmacy | "No access" page; no settings or staff data     |

In a real browser (before the extension disconnected): the signup page renders,
the slug auto-derives from the pharmacy name, and the live availability check
round-trips to the database.

The cross-tenant denial page does name the pharmacy it is refusing access to.
That is deliberate and not a leak — the public login page at `/t/{slug}/login`
already shows the same name to anonymous visitors.

### Test data

The throwaway tenants and auth users created during these runs were deleted.
`sunrise` (active) and `moonlight` (suspended) remain as dev fixtures.
