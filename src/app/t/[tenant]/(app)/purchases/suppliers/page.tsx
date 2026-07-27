import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { tenantHref } from '@/lib/tenant/urls';
import { SupplierForm } from './supplier-form';
import { PaymentForm } from './payment-form';

export const metadata = { title: 'Suppliers' };

export default async function SuppliersPage(
  props: PageProps<'/t/[tenant]/purchases/suppliers'>,
) {
  const { tenant: slug } = await props.params;
  const access = await getTenantAccess(slug);
  if (!access.ok) notFound();

  if (access.role === 'cashier') {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-semibold">Suppliers</h1>
        <p className="text-muted-foreground mt-2">
          Suppliers are managed by owners and pharmacists.
        </p>
      </main>
    );
  }

  const supabase = await createClient();

  const { data: suppliers } = await supabase
    .from('suppliers')
    .select('id, name, phone, email, pan_vat_no, balance, is_active')
    .order('name');

  const rows = suppliers ?? [];
  const totalOwed = rows.reduce((sum, s) => sum + Number(s.balance), 0);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-8">
      <div>
        <Link
          href={await tenantHref(slug, '/purchases')}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Purchases
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Suppliers</h1>
        <p className="text-muted-foreground text-sm">
          Outstanding across all suppliers:{' '}
          <span className="tabular-nums">{totalOwed.toFixed(2)}</span>
        </p>
      </div>

      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full min-w-2xl text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Supplier</th>
              <th className="px-4 py-2 text-left font-medium">Contact</th>
              <th className="px-4 py-2 text-left font-medium">PAN / VAT</th>
              <th className="px-4 py-2 text-right font-medium">Balance</th>
              <th className="px-4 py-2 text-right font-medium">Pay</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="text-muted-foreground px-4 py-8 text-center"
                >
                  No suppliers yet.
                </td>
              </tr>
            )}
            {rows.map((s) => (
              <tr key={s.id} className="border-border border-t align-top">
                <td className="px-4 py-2 font-medium">{s.name}</td>
                <td className="text-muted-foreground px-4 py-2">
                  {s.phone ?? '—'}
                  {s.email && <span className="block text-xs">{s.email}</span>}
                </td>
                <td className="text-muted-foreground px-4 py-2">
                  {s.pan_vat_no ?? '—'}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {/* Negative means we are in credit with them. */}
                  <span className={Number(s.balance) > 0 ? 'text-warning' : ''}>
                    {Number(s.balance).toFixed(2)}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <PaymentForm slug={slug} supplierId={s.id as string} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="border-border flex flex-col gap-4 rounded-lg border p-5">
        <h2 className="font-semibold">Add a supplier</h2>
        <SupplierForm slug={slug} />
      </section>
    </main>
  );
}
