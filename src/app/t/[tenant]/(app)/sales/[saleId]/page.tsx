import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { tenantHref } from '@/lib/tenant/urls';
import { ReturnForm } from './return-form';

export default async function SaleDetailPage(
  props: PageProps<'/t/[tenant]/sales/[saleId]'>,
) {
  const { tenant: slug, saleId } = await props.params;
  const access = await getTenantAccess(slug);
  if (!access.ok) notFound();

  const supabase = await createClient();

  const { data: sale } = await supabase
    .from('sales')
    .select(
      'id, invoice_no, sale_date, subtotal, discount, tax, total, paid, payment_method, status, customers(name, phone)',
    )
    .eq('id', saleId)
    .maybeSingle();

  if (!sale) notFound();

  const { data: items } = await supabase
    .from('sale_items')
    .select(
      'id, qty, qty_returned, unit_price, discount, tax, total, medicines(name, unit), batches(batch_no, expiry_date)',
    )
    .eq('sale_id', saleId);

  const customer = sale.customers as unknown as {
    name: string;
    phone: string | null;
  } | null;

  const lines = (items ?? []).map((item) => {
    const med = item.medicines as unknown as {
      name: string;
      unit: string;
    } | null;
    const batch = item.batches as unknown as {
      batch_no: string;
      expiry_date: string;
    } | null;
    return {
      id: item.id as string,
      name: med?.name ?? 'Unknown',
      unit: med?.unit ?? '',
      batchNo: batch?.batch_no ?? '—',
      expiryDate: batch?.expiry_date ?? '—',
      qty: Number(item.qty),
      qtyReturned: Number(item.qty_returned),
      unitPrice: Number(item.unit_price),
      total: Number(item.total),
    };
  });

  const canRefund =
    access.role !== 'cashier' &&
    sale.status !== 'returned' &&
    sale.status !== 'void';

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href={await tenantHref(slug, '/sales')}
            className="text-muted-foreground text-sm hover:underline"
          >
            ← Sales
          </Link>
          <h1 className="mt-1 font-mono text-2xl font-semibold">
            {sale.invoice_no}
          </h1>
          <p className="text-muted-foreground text-sm">
            {new Date(sale.sale_date as string).toLocaleString()} ·{' '}
            {customer?.name ?? 'Walk-in'} · {sale.payment_method ?? 'cash'}
          </p>
        </div>
        <Link
          href={await tenantHref(slug, `/pos/receipt/${sale.id}`)}
          className="border-border rounded-md border px-3 py-2 text-sm"
        >
          Print receipt
        </Link>
      </div>

      <section className="grid gap-4 sm:grid-cols-4">
        {[
          { label: 'Subtotal', value: Number(sale.subtotal).toFixed(2) },
          { label: 'Discount', value: Number(sale.discount).toFixed(2) },
          { label: 'Tax', value: Number(sale.tax).toFixed(2) },
          { label: 'Total', value: Number(sale.total).toFixed(2) },
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

      {canRefund ? (
        <ReturnForm slug={slug} saleId={saleId} lines={lines} />
      ) : (
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Item</th>
                <th className="px-4 py-2 text-left font-medium">Batch</th>
                <th className="px-4 py-2 text-right font-medium">Qty</th>
                <th className="px-4 py-2 text-right font-medium">Returned</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id} className="border-border border-t">
                  <td className="px-4 py-2">{line.name}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {line.batchNo}
                    <span className="text-muted-foreground block">
                      exp {line.expiryDate}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {line.qty} {line.unit}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {line.qtyReturned || '—'}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {line.total.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
