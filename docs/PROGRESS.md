# PharmaSaaS — Build Progress

Phase status against the plan in `docs/ARCHITECTURE.md` §9.

| Phase | Scope                               | Status      |
| ----- | ----------------------------------- | ----------- |
| 0     | Scaffold & tooling                  | In progress |
| 1     | Tenancy core, RLS foundation, proxy | Not started |
| 2     | Auth & instant onboarding           | Not started |
| 3     | Pharmacy schema + business RPCs     | Not started |
| 4     | Inventory module                    | Not started |
| 5     | Purchases & suppliers               | Not started |
| 6     | POS & sales                         | Not started |
| 7     | Customers, prescriptions, reports   | Not started |
| 8     | Platform admin                      | Not started |
| 9     | Hardening & deploy                  | Not started |

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
