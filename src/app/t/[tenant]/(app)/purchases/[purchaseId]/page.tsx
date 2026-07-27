import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { tenantHref } from '@/lib/tenant/urls';

export default async function PurchaseDetailPage(
  props: PageProps<'/t/[tenant]/purchases/[purchaseId]'>,
) {
  const { tenant: slug, purchaseId } = await props.params;
  const access = await getTenantAccess(slug);
  if (!access.ok || access.role === 'cashier') notFound();

  const supabase = await createClient();

  const { data: purchase } = await supabase
    .from('purchases')
    .select(
      'id, invoice_no, purchase_date, subtotal, total, paid, status, suppliers(name, balance)',
    )
    .eq('id', purchaseId)
    .maybeSingle();

  if (!purchase) notFound();

  const { data: items } = await supabase
    .from('purchase_items')
    .select(
      'id, qty, unit_cost, total, medicines(name, unit), batches(batch_no, expiry_date)',
    )
    .eq('purchase_id', purchaseId);

  const supplier = purchase.suppliers as unknown as {
    name: string;
    balance: number;
  } | null;
  const outstanding = Number(purchase.total) - Number(purchase.paid);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-8">
      <div>
        <Link
          href={await tenantHref(slug, '/purchases')}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Purchases
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">
          {purchase.invoice_no ?? 'Goods receipt'}
        </h1>
        <p className="text-muted-foreground text-sm">
          {supplier?.name ?? 'No supplier'} · {purchase.purchase_date}
        </p>
      </div>

      <section className="grid gap-4 sm:grid-cols-4">
        {[
          { label: 'Total', value: Number(purchase.total).toFixed(2) },
          { label: 'Paid', value: Number(purchase.paid).toFixed(2) },
          { label: 'Outstanding', value: outstanding.toFixed(2) },
          { label: 'Status', value: purchase.status as string },
        ].map((stat) => (
          <div key={stat.label} className="border-border rounded-lg border p-4">
            <p className="text-muted-foreground text-xs tracking-wide uppercase">
              {stat.label}
            </p>
            <p className="mt-1 text-lg font-medium tabular-nums">
              {stat.value}
            </p>
          </div>
        ))}
      </section>

      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full min-w-2xl text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Medicine</th>
              <th className="px-4 py-2 text-left font-medium">Batch</th>
              <th className="px-4 py-2 text-left font-medium">Expiry</th>
              <th className="px-4 py-2 text-right font-medium">Qty</th>
              <th className="px-4 py-2 text-right font-medium">Unit cost</th>
              <th className="px-4 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {(items ?? []).map((item) => {
              const med = item.medicines as unknown as {
                name: string;
                unit: string;
              } | null;
              const batch = item.batches as unknown as {
                batch_no: string;
                expiry_date: string;
              } | null;
              return (
                <tr key={item.id} className="border-border border-t">
                  <td className="px-4 py-2">{med?.name ?? '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {batch?.batch_no ?? '—'}
                  </td>
                  <td className="px-4 py-2">{batch?.expiry_date ?? '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {Number(item.qty)} {med?.unit}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {Number(item.unit_cost).toFixed(2)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {Number(item.total).toFixed(2)}
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
