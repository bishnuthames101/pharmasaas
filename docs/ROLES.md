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
| Batch cost price        | R     | R          | —       | See "Cost visibility" below.                 |
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

## Cost visibility — an open decision

RLS filters **rows**, not **columns**. Because `cost_price` currently lives on
`batches`, and cashiers must read `batches` to sell (they need `selling_price`,
expiry, and quantity), a cashier can read `cost_price` through the API even
though the UI never shows it. Column-level `GRANT`s cannot fix this: every user
connects as the same Postgres role (`authenticated`), and the pharmacy role is
application data, not a database role.

If margins must be genuinely hidden from counter staff, the fix is to move cost
into a separate `batch_costs` table carrying its own role-gated policy. That is
a deliberate schema change and is flagged for a decision in Phase 3 rather than
assumed here.

Until then: treat `cost_price` as visible to all staff of a pharmacy, and gate
**profit reporting** — the aggregate that actually matters commercially — to
owners via RPC.
