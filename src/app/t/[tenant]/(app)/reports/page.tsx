import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { tenantHref } from '@/lib/tenant/urls';

export const metadata = { title: 'Reports' };

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export default async function ReportsPage(
  props: PageProps<'/t/[tenant]/reports'>,
) {
  const { tenant: slug } = await props.params;
  const search = await props.searchParams;
  const access = await getTenantAccess(slug);
  if (!access.ok) notFound();

  if (access.role === 'cashier') {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-muted-foreground mt-2">
          Reporting is available to owners and pharmacists.
        </p>
      </main>
    );
  }

  const from = typeof search.from === 'string' ? search.from : isoDaysAgo(30);
  const to =
    typeof search.to === 'string'
      ? search.to
      : new Date().toISOString().slice(0, 10);

  const supabase = await createClient();
  const isOwner = access.role === 'owner';

  const [daily, profit, valuation, movement] = await Promise.all([
    supabase
      .from('sales_daily')
      .select('day, sale_count, total, tax, discount, credit_total, cash_total')
      .gte('day', from)
      .lte('day', to)
      .order('day', { ascending: false }),
    // Returns nothing for a pharmacist too — the join to batch_costs is
    // permitted for them, so this is genuinely owner-and-pharmacist data.
    supabase
      .from('sale_profit')
      .select('revenue, cost, profit, medicine_name, category')
      .gte('sale_date', `${from}T00:00:00`)
      .lte('sale_date', `${to}T23:59:59`),
    supabase
      .from('stock_valuation')
      .select('medicine_name, qty_on_hand, cost_value, retail_value'),
    supabase
      .from('medicine_movement')
      .select('name, qty_sold_90d, revenue_90d, qty_on_hand, days_of_cover')
      .order('qty_sold_90d', { ascending: false })
      .limit(10),
  ]);

  const days = daily.data ?? [];
  const takings = days.reduce((s, d) => s + Number(d.total), 0);
  const saleCount = days.reduce((s, d) => s + Number(d.sale_count), 0);

  const profitRows = profit.data ?? [];
  const revenue = profitRows.reduce((s, r) => s + Number(r.revenue), 0);
  const cost = profitRows.reduce((s, r) => s + Number(r.cost), 0);
  const margin = revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0;

  const stock = valuation.data ?? [];
  const stockCost = stock.reduce((s, r) => s + Number(r.cost_value), 0);
  const stockRetail = stock.reduce((s, r) => s + Number(r.retail_value), 0);

  const reportsHref = await tenantHref(slug, '/reports');

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Reports</h1>
          <p className="text-muted-foreground text-sm">
            {from} to {to}
          </p>
        </div>
        <form
          action={reportsHref}
          method="get"
          className="flex items-end gap-2"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="from" className="text-xs font-medium">
              From
            </label>
            <input
              id="from"
              name="from"
              type="date"
              defaultValue={from}
              className="border-border bg-background rounded-md border px-2 py-1 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="to" className="text-xs font-medium">
              To
            </label>
            <input
              id="to"
              name="to"
              type="date"
              defaultValue={to}
              className="border-border bg-background rounded-md border px-2 py-1 text-sm"
            />
          </div>
          <button
            type="submit"
            className="border-border rounded-md border px-3 py-1.5 text-sm"
          >
            Apply
          </button>
          <Link
            href={`${reportsHref}/export?from=${from}&to=${to}`}
            className="border-border rounded-md border px-3 py-1.5 text-sm"
          >
            Export CSV
          </Link>
        </form>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sales" value={saleCount.toString()} />
        <Stat label="Takings" value={takings.toFixed(2)} />
        <Stat label="Stock at cost" value={stockCost.toFixed(2)} />
        <Stat label="Stock at retail" value={stockRetail.toFixed(2)} />
      </section>

      {/* Margin is owner-only by policy; a pharmacist can read cost but the
          headline profit figure stays with the proprietor. */}
      {isOwner && (
        <section className="border-border flex flex-col gap-4 rounded-lg border p-5">
          <h2 className="font-semibold">Profit</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Revenue" value={revenue.toFixed(2)} />
            <Stat label="Cost of goods" value={cost.toFixed(2)} />
            <Stat
              label="Gross profit"
              value={`${(revenue - cost).toFixed(2)} (${margin.toFixed(1)}%)`}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            Net of returns, and computed by joining each sale line to the cost
            of the batch it came from.
          </p>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Daily takings</h2>
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Day</th>
                <th className="px-4 py-2 text-right font-medium">Sales</th>
                <th className="px-4 py-2 text-right font-medium">Cash etc.</th>
                <th className="px-4 py-2 text-right font-medium">Credit</th>
                <th className="px-4 py-2 text-right font-medium">Tax</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {days.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="text-muted-foreground px-4 py-8 text-center"
                  >
                    No sales in this period.
                  </td>
                </tr>
              )}
              {days.map((d) => (
                <tr key={d.day as string} className="border-border border-t">
                  <td className="px-4 py-2">{d.day as string}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {Number(d.sale_count)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {Number(d.cash_total ?? 0).toFixed(2)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {Number(d.credit_total ?? 0).toFixed(2)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {Number(d.tax).toFixed(2)}
                  </td>
                  <td className="px-4 py-2 text-right font-medium tabular-nums">
                    {Number(d.total).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Fastest movers (90 days)</h2>
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Medicine</th>
                <th className="px-4 py-2 text-right font-medium">Sold</th>
                <th className="px-4 py-2 text-right font-medium">Revenue</th>
                <th className="px-4 py-2 text-right font-medium">On hand</th>
                <th className="px-4 py-2 text-right font-medium">
                  Days of cover
                </th>
              </tr>
            </thead>
            <tbody>
              {(movement.data ?? []).map((m) => (
                <tr key={m.name as string} className="border-border border-t">
                  <td className="px-4 py-2">{m.name as string}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {Number(m.qty_sold_90d)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {Number(m.revenue_90d).toFixed(2)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {Number(m.qty_on_hand)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {m.days_of_cover === null ? '—' : Number(m.days_of_cover)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border rounded-lg border p-4">
      <p className="text-muted-foreground text-xs tracking-wide uppercase">
        {label}
      </p>
      <p className="mt-1 text-lg font-medium tabular-nums">{value}</p>
    </div>
  );
}
