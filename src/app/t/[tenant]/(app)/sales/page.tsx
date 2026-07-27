import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { tenantHref } from '@/lib/tenant/urls';

export const metadata = { title: 'Sales' };

const STATUS_TONE: Record<string, string> = {
  completed: 'bg-primary/10 text-primary',
  partially_returned: 'bg-warning/10 text-warning',
  returned: 'bg-danger/10 text-danger',
  void: 'bg-muted text-muted-foreground',
};

export default async function SalesPage(props: PageProps<'/t/[tenant]/sales'>) {
  const { tenant: slug } = await props.params;
  const search = await props.searchParams;
  const access = await getTenantAccess(slug);
  if (!access.ok) notFound();

  const from = typeof search.from === 'string' ? search.from : '';
  const to = typeof search.to === 'string' ? search.to : '';

  const supabase = await createClient();

  let builder = supabase
    .from('sales')
    .select(
      'id, invoice_no, sale_date, total, paid, payment_method, status, customers(name)',
    )
    .order('sale_date', { ascending: false })
    .limit(100);

  if (from) builder = builder.gte('sale_date', `${from}T00:00:00`);
  if (to) builder = builder.lte('sale_date', `${to}T23:59:59`);

  const { data: sales } = await builder;
  const rows = sales ?? [];
  const takings = rows.reduce((sum, s) => sum + Number(s.total), 0);

  const salesHref = await tenantHref(slug, '/sales');
  const posHref = await tenantHref(slug, '/pos');

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Sales</h1>
          <p className="text-muted-foreground text-sm">
            {rows.length} sale{rows.length === 1 ? '' : 's'} · total{' '}
            <span className="tabular-nums">{takings.toFixed(2)}</span>
          </p>
        </div>
        <Link
          href={posHref}
          className="bg-primary text-primary-foreground rounded-md px-3 py-2 text-sm font-medium"
        >
          Open counter
        </Link>
      </div>

      <form
        action={salesHref}
        method="get"
        className="flex flex-wrap items-end gap-3"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="from" className="text-sm font-medium">
            From
          </label>
          <input
            id="from"
            name="from"
            type="date"
            defaultValue={from}
            className="border-border bg-background rounded-md border px-3 py-2 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="to" className="text-sm font-medium">
            To
          </label>
          <input
            id="to"
            name="to"
            type="date"
            defaultValue={to}
            className="border-border bg-background rounded-md border px-3 py-2 text-sm"
          />
        </div>
        <button
          type="submit"
          className="border-border rounded-md border px-4 py-2 text-sm font-medium"
        >
          Filter
        </button>
      </form>

      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full min-w-2xl text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Invoice</th>
              <th className="px-4 py-2 text-left font-medium">When</th>
              <th className="px-4 py-2 text-left font-medium">Customer</th>
              <th className="px-4 py-2 text-left font-medium">Method</th>
              <th className="px-4 py-2 text-right font-medium">Total</th>
              <th className="px-4 py-2 text-left font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="text-muted-foreground px-4 py-8 text-center"
                >
                  No sales in this period.
                </td>
              </tr>
            )}
            {rows.map((sale) => {
              const customer = sale.customers as unknown as {
                name: string;
              } | null;
              return (
                <tr key={sale.id} className="border-border border-t">
                  <td className="px-4 py-2">
                    <Link
                      href={`${salesHref}/${sale.id}`}
                      className="font-mono hover:underline"
                    >
                      {sale.invoice_no}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    {new Date(sale.sale_date as string).toLocaleString()}
                  </td>
                  <td className="px-4 py-2">
                    {customer?.name ?? (
                      <span className="text-muted-foreground">Walk-in</span>
                    )}
                  </td>
                  <td className="text-muted-foreground px-4 py-2">
                    {sale.payment_method ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {Number(sale.total).toFixed(2)}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        STATUS_TONE[sale.status as string] ?? ''
                      }`}
                    >
                      {(sale.status as string).replace('_', ' ')}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
