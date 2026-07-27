import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { tenantHref } from '@/lib/tenant/urls';

export const metadata = { title: 'Purchases' };

export default async function PurchasesPage(
  props: PageProps<'/t/[tenant]/purchases'>,
) {
  const { tenant: slug } = await props.params;
  const access = await getTenantAccess(slug);
  if (!access.ok) notFound();

  if (access.role === 'cashier') {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-semibold">Purchases</h1>
        <p className="text-muted-foreground mt-2">
          Purchasing is limited to owners and pharmacists.
        </p>
      </main>
    );
  }

  const supabase = await createClient();

  const { data: purchases } = await supabase
    .from('purchases')
    .select(
      'id, invoice_no, purchase_date, total, paid, status, suppliers(name)',
    )
    .order('purchase_date', { ascending: false })
    .limit(50);

  const base = await tenantHref(slug, '/purchases');

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Purchases</h1>
          <p className="text-muted-foreground text-sm">
            Goods received from suppliers.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`${base}/suppliers`}
            className="border-border rounded-md border px-3 py-2 text-sm"
          >
            Suppliers
          </Link>
          <Link
            href={`${base}/reorder`}
            className="border-border rounded-md border px-3 py-2 text-sm"
          >
            Reorder report
          </Link>
          <Link
            href={`${base}/receive`}
            className="bg-primary text-primary-foreground rounded-md px-3 py-2 text-sm font-medium"
          >
            Receive goods
          </Link>
        </div>
      </div>

      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full min-w-2xl text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Date</th>
              <th className="px-4 py-2 text-left font-medium">Supplier</th>
              <th className="px-4 py-2 text-left font-medium">Invoice</th>
              <th className="px-4 py-2 text-right font-medium">Total</th>
              <th className="px-4 py-2 text-right font-medium">Outstanding</th>
              <th className="px-4 py-2 text-left font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {(purchases ?? []).length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="text-muted-foreground px-4 py-8 text-center"
                >
                  No goods received yet.
                </td>
              </tr>
            )}
            {(purchases ?? []).map((p) => {
              const supplier = p.suppliers as unknown as {
                name: string;
              } | null;
              const outstanding = Number(p.total) - Number(p.paid);
              return (
                <tr key={p.id} className="border-border border-t">
                  <td className="px-4 py-2">{p.purchase_date}</td>
                  <td className="px-4 py-2">
                    {supplier?.name ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <Link href={`${base}/${p.id}`} className="hover:underline">
                      {p.invoice_no ?? 'View'}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {Number(p.total).toFixed(2)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    <span className={outstanding > 0 ? 'text-warning' : ''}>
                      {outstanding.toFixed(2)}
                    </span>
                  </td>
                  <td className="text-muted-foreground px-4 py-2">
                    {p.status}
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
