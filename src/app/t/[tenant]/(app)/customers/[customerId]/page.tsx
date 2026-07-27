import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { tenantHref } from '@/lib/tenant/urls';
import { CustomerForm } from '../customer-form';
import { SettleForm } from './settle-form';

export default async function CustomerDetailPage(
  props: PageProps<'/t/[tenant]/customers/[customerId]'>,
) {
  const { tenant: slug, customerId } = await props.params;
  const access = await getTenantAccess(slug);
  if (!access.ok) notFound();

  const supabase = await createClient();

  const { data: customer } = await supabase
    .from('customers')
    .select(
      'id, name, phone, address, dob, gender, allergies, notes, credit_balance',
    )
    .eq('id', customerId)
    .maybeSingle();

  if (!customer) notFound();

  const { data: sales } = await supabase
    .from('sales')
    .select('id, invoice_no, sale_date, total, payment_method, status')
    .eq('customer_id', customerId)
    .order('sale_date', { ascending: false })
    .limit(25);

  // The medication history a pharmacist actually needs: what this person has
  // been dispensed, most recent first.
  const { data: history } = await supabase
    .from('sale_items')
    .select(
      'id, qty, sales!inner(sale_date, customer_id), medicines(name, strength, unit)',
    )
    .eq('sales.customer_id', customerId)
    .order('id', { ascending: false })
    .limit(40);

  const salesHref = await tenantHref(slug, '/sales');
  const balance = Number(customer.credit_balance);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-8">
      <div>
        <Link
          href={await tenantHref(slug, '/customers')}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Customers
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{customer.name}</h1>
        <p className="text-muted-foreground text-sm">
          {customer.phone ?? 'No phone'}
        </p>
      </div>

      {customer.allergies && (
        <p className="border-danger/40 bg-danger/10 text-danger rounded-lg border px-4 py-3 text-sm">
          <strong>Allergies:</strong> {customer.allergies}
        </p>
      )}

      <section className="border-border flex flex-wrap items-end justify-between gap-4 rounded-lg border p-5">
        <div>
          <p className="text-muted-foreground text-xs tracking-wide uppercase">
            Outstanding credit
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {balance.toFixed(2)}
          </p>
        </div>
        {balance > 0 && access.role !== 'cashier' && (
          <SettleForm slug={slug} customerId={customerId} balance={balance} />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Recent sales</h2>
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Invoice</th>
                <th className="px-4 py-2 text-left font-medium">When</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
                <th className="px-4 py-2 text-left font-medium">Method</th>
              </tr>
            </thead>
            <tbody>
              {(sales ?? []).length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="text-muted-foreground px-4 py-6 text-center"
                  >
                    No purchases yet.
                  </td>
                </tr>
              )}
              {(sales ?? []).map((s) => (
                <tr key={s.id} className="border-border border-t">
                  <td className="px-4 py-2">
                    <Link
                      href={`${salesHref}/${s.id}`}
                      className="font-mono hover:underline"
                    >
                      {s.invoice_no}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    {new Date(s.sale_date as string).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {Number(s.total).toFixed(2)}
                  </td>
                  <td className="text-muted-foreground px-4 py-2">
                    {s.payment_method ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Medication history</h2>
        {(history ?? []).length === 0 ? (
          <p className="border-border text-muted-foreground rounded-lg border p-6 text-center text-sm">
            Nothing dispensed yet.
          </p>
        ) : (
          <ul className="border-border divide-border divide-y rounded-lg border text-sm">
            {(history ?? []).map((item) => {
              const med = item.medicines as unknown as {
                name: string;
                strength: string | null;
                unit: string;
              } | null;
              const sale = item.sales as unknown as { sale_date: string };
              return (
                <li
                  key={item.id}
                  className="flex items-center justify-between px-4 py-2"
                >
                  <span>
                    {med?.name}
                    {med?.strength ? ` ${med.strength}` : ''}
                  </span>
                  <span className="text-muted-foreground">
                    {Number(item.qty)} {med?.unit} ·{' '}
                    {new Date(sale.sale_date).toLocaleDateString()}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="font-semibold">Details</h2>
        <CustomerForm slug={slug} customer={customer} />
      </section>
    </main>
  );
}
