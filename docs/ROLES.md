# Role Matrix

Three roles exist per pharmacy, stored in `tenant_users.role`. They are
**per-tenant**: the same person can be an owner at one pharmacy and a cashier at
another.

This document is the source of truth. RLS policies are written from it, and the
UI mirrors it. Where the two disagree, the RLS policy is what actually holds —
the UI is only there so people aren't shown buttons that will fail.

| Role         | Intent                                                          |
| ------------ | --------------------------------------------------------------- |
| `owner`      | Proprietor. Full control, including money, staff, and settings. |
| `pharmacist` | Runs the pharmacy day to day: stock, purchasing, dispensing.    |
| `cashier`    | Works the counter. Sells; does not change what things cost.     |

## Matrix

`R` read · `W` create/update · `D` delete · `—` no access

| Area                    | owner | pharmacist | cashier | Notes                                        |
| ----------------------- | ----- | ---------- | ------- | -------------------------------------------- |
| Pharmacy settings       | RW    | R          | —       | Tax mode, invoice prefix, expiry thresholds. |
| Staff & roles           | RWD   | —          | —       | Invite, deactivate, change role.             |
| Medicines (catalogue)   | RWD   | RW         | R       | Cashiers search to sell; cannot edit.        |
| Medicine pricing & tax  | RW    | RW         | R       | Selling price and tax rate.                  |
| Batches                 | RWD   | RW         | R       | Created on goods receipt.                    |
| Batch cost price        | R     | R          | —       | Own table `batch_costs`; RLS-enforced.       |
| Stock adjustments       | RWD   | RW         | —       | Reason-coded; always audit-logged.           |
| Suppliers               | RWD   | RW         | —       |                                              |
| Purchases (GRN)         | RWD   | RW         | —       | Via `receive_purchase`.                      |
| Supplier payments       | RW    | RW         | —       |                                              |
| Customers               | RWD   | RW         | RW      | Cashiers add walk-ins at the counter.        |
| Customer credit ledger  | RW    | RW         | R       | Only owner/pharmacist settle balances.       |
| Sales (POS)             | RW    | RW         | RW      | Always via `complete_sale`.                  |
| Sales returns           | RW    | RW         | —       | Refunds need supervision.                    |
| Prescriptions           | RWD   | RW         | RW      | Cashiers attach an image to a sale.          |
| Controlled dispense log | R     | R          | —       | Append-only; written by `complete_sale`.     |
| Reports — sales & stock | R     | R          | —       |                                              |
| Reports — profit & cost | R     | —          | —       | Owner only.                                  |
| Audit log               | R     | —          | —       |                                              |

## How this is enforced

Row-level rules become policy clauses. The standard pattern per table:

```sql
create policy tenant_select on <table> for select to authenticated
  using (tenant_id = (select public.tenant_id()));

create policy tenant_insert on <table> for insert to authenticated
  with check (
    tenant_id = (select public.tenant_id())
    and (select public.tenant_role()) in ('owner', 'pharmacist')
  );

create policy tenant_update on <table> for update to authenticated
  using (tenant_id = (select public.tenant_id()))
  with check (
    tenant_id = (select public.tenant_id())
    and (select public.tenant_role()) in ('owner', 'pharmacist')
  );

create policy tenant_delete on <table> for delete to authenticated
  using (
    tenant_id = (select public.tenant_id())
    and (select public.tenant_role()) = 'owner'
  );
```

Two rules that are not negotiable:

- Every policy compares `tenant_id`. A policy that only checks
  `auth.uid() is not null` grants every authenticated user on the platform
  access to every pharmacy — authenticated is not authorized.
- Helper calls are wrapped as `(select public.tenant_id())` so Postgres
  evaluates them once per statement rather than once per row.

## Cost visibility — resolved in Phase 3

RLS filters **rows**, not **columns**, and every user connects as the same
Postgres role (`authenticated`), so column-level `GRANT`s cannot tell a cashier
from an owner. While `cost_price` lived on `batches` — a table cashiers _must_
read to sell, since they need price, expiry, and quantity — any cashier could
read the pharmacy's margins straight off the API no matter what the UI rendered.

**Cost now lives in `public.batch_costs`**, keyed by `batch_id`, with a policy
restricting it to `owner` and `pharmacist`. The role gate is now a row filter,
which is something Postgres can actually enforce.

Cost is therefore never snapshotted onto `sale_items` either — that would
reintroduce the same leak on a table cashiers can read. Profit is computed at
report time by joining `sale_items → batches → batch_costs`, which is accurate
because a batch's cost is fixed when it is received.

The price of the split is one extra join in profit reporting. That is a good
trade for a control that holds.

## Why the write RPCs are `SECURITY DEFINER`

Keeping the business RPCs `SECURITY INVOKER` would require the caller to hold
write rights on every table they touch. A cashier completing a sale would then
need `UPDATE` on `batches` — which through PostgREST also lets them rewrite
selling prices and invent stock. Selling and repricing would collapse into one
privilege.

So the mutating RPCs run `SECURITY DEFINER`, `batches` carries no cashier write
policy, and `sales` / `sale_items` carry **no write policy at all**. Stock can
only move through the audited RPC path, and every sale is guaranteed an invoice
number, FEFO allocation, and a controlled-register entry.

The obligation this creates: RLS does **not** apply inside those functions, so
each must derive the tenant from `public.tenant_id()`, re-verify membership via
`public.require_tenant_role()`, and constrain every id it is passed with
`and tenant_id = v_tenant`. A missing predicate there is a cross-tenant write
that the coverage gate cannot see. `supabase/tests/domain-rpcs.test.ts` probes
exactly this.
