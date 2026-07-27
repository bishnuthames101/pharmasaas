import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { tenantHref } from '@/lib/tenant/urls';
import { CustomerForm } from './customer-form';

export const metadata = { title: 'Customers' };

export default async function CustomersPage(
  props: PageProps<'/t/[tenant]/customers'>,
) {
  const { tenant: slug } = await props.params;
  const search = await props.searchParams;
  const access = await getTenantAccess(slug);
  if (!access.ok) notFound();

  const query = typeof search.q === 'string' ? search.q.trim() : '';
  const supabase = await createClient();

  let builder = supabase
    .from('customers')
    .select('id, name, phone, allergies, credit_balance, created_at')
    .order('name')
    .limit(100);

  if (query) {
    builder = builder.or(`name.ilike.%${query}%,phone.ilike.%${query}%`);
  }

  const { data } = await builder;
  const rows = data ?? [];
  const owed = rows.reduce((sum, c) => sum + Number(c.credit_balance), 0);
  const base = await tenantHref(slug, '/customers');

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
      <div>
        <h1 className="text-2xl font-semibold">Customers</h1>
        <p className="text-muted-foreground text-sm">
          {rows.length} shown · outstanding credit{' '}
          <span className="tabular-nums">{owed.toFixed(2)}</span>
        </p>
      </div>

      <form action={base} method="get" className="flex items-end gap-3">
        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
          <label htmlFor="q" className="text-sm font-medium">
            Search
          </label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={query}
            placeholder="Name or phone"
            className="border-border bg-background rounded-md border px-3 py-2 text-sm"
          />
        </div>
        <button
          type="submit"
          className="border-border rounded-md border px-4 py-2 text-sm font-medium"
        >
          Search
        </button>
      </form>

      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full min-w-2xl text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Name</th>
              <th className="px-4 py-2 text-left font-medium">Phone</th>
              <th className="px-4 py-2 text-left font-medium">Allergies</th>
              <th className="px-4 py-2 text-right font-medium">Owes</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="text-muted-foreground px-4 py-8 text-center"
                >
                  No customers found.
                </td>
              </tr>
            )}
            {rows.map((c) => (
              <tr key={c.id} className="border-border border-t">
                <td className="px-4 py-2">
                  <Link
                    href={`${base}/${c.id}`}
                    className="font-medium hover:underline"
                  >
                    {c.name}
                  </Link>
                </td>
                <td className="text-muted-foreground px-4 py-2">
                  {c.phone ?? '—'}
                </td>
                <td className="px-4 py-2">
                  {/* Surfaced in the list, not buried in the record: it is the
                      one field that changes what may safely be dispensed. */}
                  {c.allergies ? (
                    <span className="bg-danger/10 text-danger rounded-full px-2 py-0.5 text-xs">
                      {c.allergies}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  <span
                    className={
                      Number(c.credit_balance) > 0 ? 'text-warning' : ''
                    }
                  >
                    {Number(c.credit_balance).toFixed(2)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="border-border flex flex-col gap-4 rounded-lg border p-5">
        <h2 className="font-semibold">Add a customer</h2>
        <CustomerForm slug={slug} />
      </section>
    </main>
  );
}
