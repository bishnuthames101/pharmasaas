# Deploying PharmaSaaS

Everything below is a one-time setup except step 6, which you run before every
release.

---

## 1. Supabase

One project serves every pharmacy. You already have one.

**Project settings → API** gives you the three values the app needs.
**Project settings → Database → Connection string → Session pooler** gives you
the fourth.

> Use the **session pooler** URL (port 5432), not the direct
> `db.<ref>.supabase.co` host. The direct host publishes only an IPv6 record and
> is unreachable from many networks — including this one, which is why
> `scripts/db.ts` exists rather than `supabase link`.

### Email (do this before real customers sign up)

Supabase's built-in mailer is rate limited to a handful of messages an hour and
will not reliably reach arbitrary domains. The app currently works around this:
accounts are created pre-confirmed, and staff get a password from their owner
rather than an emailed invite.

That is fine for launch. Before you rely on **password reset**, configure custom
SMTP under **Authentication → Emails → SMTP settings** (Resend, Postmark, SES —
any will do). Nothing in the code changes; the flow simply starts working.

---

## 2. GitHub

```bash
git remote add origin git@github.com:<you>/pharmasaas.git
git push -u origin main
```

Then **Settings → Secrets and variables → Actions** and add:

| Secret                      | Where it comes from              |
| --------------------------- | -------------------------------- |
| `SUPABASE_URL`              | Project settings → API           |
| `SUPABASE_ANON_KEY`         | Project settings → API           |
| `SUPABASE_SERVICE_ROLE_KEY` | Project settings → API (secret)  |
| `SUPABASE_DB_URL`           | Session pooler connection string |

Also create an **environment** named `production` (Settings → Environments) and
add yourself as a required reviewer. The `migrate` job waits on that approval,
so no migration reaches production without a human saying yes.

---

## 3. Vercel

1. **Add New → Project**, import the GitHub repo. Vercel detects Next.js.
2. Environment variables (Production, Preview, Development):

   ```
   NEXT_PUBLIC_SUPABASE_URL
   NEXT_PUBLIC_SUPABASE_ANON_KEY
   SUPABASE_SERVICE_ROLE_KEY     ← mark as Sensitive
   NEXT_PUBLIC_ROOT_DOMAIN       ← e.g. pharmasaas.com
   ```

3. Deploy. `main` is production; every PR gets a preview.

Preview deployments run on `*.vercel.app`, which has no wildcard DNS, so tenants
there are reached by path (`/t/{slug}`). That is handled automatically — see
`src/lib/tenant/urls.ts`.

---

## 4. Domain and wildcard subdomains

Only needed when you want `sunrise.yourdomain.com` instead of
`yourdomain.com/t/sunrise`. The application already supports both and needs no
code change to switch.

1. Vercel → **Settings → Domains** → add `yourdomain.com`.
2. Add `*.yourdomain.com` as well.
3. **Wildcard domains on Vercel require the nameserver method.** Change your
   registrar's nameservers to the ones Vercel shows. CNAME/A records will not
   work for a wildcard, and Vercel cannot issue the wildcard TLS certificate
   without controlling DNS.
4. Set `NEXT_PUBLIC_ROOT_DOMAIN=yourdomain.com` and redeploy.

Certificates are issued automatically once the nameservers propagate (minutes to
a few hours).

---

## 5. Appoint yourself platform admin

`platform_admins` is deliberately not writable from the application — that is
what stops anyone promoting themselves. Adding a row is a manual act.

Sign up normally first, then run this in the Supabase **SQL editor**:

```sql
insert into public.platform_admins (user_id, email, note)
select id, email, 'founder'
from auth.users
where email = 'you@example.com';
```

The console is then at `yourdomain.com/admin`. A non-admin gets a 404 there.

---

## 6. Before every release

```bash
pnpm verify:all
```

which runs, in order:

| Step             | What it protects                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `typecheck`      | —                                                                                                                   |
| `lint`           | —                                                                                                                   |
| `test`           | Tenant routing rules                                                                                                |
| `audit:security` | Service-key confinement, RLS coverage, `search_path` on definer functions, no `anon` grants, tenant-leading indexes |
| `test:rls`       | 134 cross-tenant assertions against a real database                                                                 |

Plus, whenever you touch the coverage gate itself:

```bash
pnpm test:rls-gate   # proves the gate still catches broken tables and views
```

CI runs all of these on every PR.

---

## 7. Smoke test after deploying

1. **Sign up** a new pharmacy from `/signup`. You should land on its dashboard.
2. **Add a medicine** under Inventory, then **add stock** to it.
3. **Sell it** at the counter; check the invoice number is `INV-1`.
4. **Print the receipt** — batch and expiry must appear on the line.
5. **Return part of it** from Sales; stock goes back to the same batch.
6. **Reports** shows the takings; profit appears only for an owner.
7. **Cross-tenant probe** — the important one. Sign in to pharmacy A, then open
   pharmacy B's URL. You must get "No access", never data.
8. **Cashier probe** — add a cashier, sign in as them, open a medicine. There
   must be no Cost column and no Adjust button.

`pnpm seed:demo` creates a realistic pharmacy if you would rather not key all of
that by hand.

---

## Known gaps

Honest list of what is not done, so nobody discovers these the hard way.

- **No Content-Security-Policy.** Next injects inline scripts for hydration, so
  a real CSP needs a per-request nonce threaded through `src/proxy.ts`. A
  permissive `unsafe-inline` policy would look like protection while providing
  none, so none is set. Other security headers are in `next.config.ts`.
- **Rate limiting is per server instance**, held in memory. It blunts credential
  stuffing from one source; it is not a fleet-wide guarantee. For that, use
  Upstash or Supabase-side throttling. See `src/lib/rate-limit.ts`.
- **The RLS suite runs against the shared dev project**, not an ephemeral
  database. It cleans up after itself, but two runs at once will interfere.
  Supabase branching would fix this.
- **No automated backup verification.** Supabase takes daily backups on paid
  plans; nobody has tested a restore.
- **Password reset is unavailable until SMTP is configured** (see step 1).
- **The prescription ID is pasted by hand at the counter.** It works, but
  selecting from the customer's recent prescriptions would be better.
