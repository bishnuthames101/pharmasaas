import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { tenantHref } from '@/lib/tenant/urls';
import { InventoryFilters } from './filters';

export const metadata = { title: 'Inventory' };

const PAGE_SIZE = 25;

export default async function InventoryPage(
  props: PageProps<'/t/[tenant]/inventory'>,
) {
  const { tenant: slug } = await props.params;
  const search = await props.searchParams;

  const access = await getTenantAccess(slug);
  if (!access.ok) notFound();

  const query = typeof search.q === 'string' ? search.q.trim() : '';
  const filter = typeof search.filter === 'string' ? search.filter : 'all';
  const page = Math.max(1, Number(search.page) || 1);
  const from = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();

  // Columns are listed explicitly rather than `*`: the view also carries
  // `search_vector`, a tsvector that is filtered on but never displayed, and
  // shipping one per row would be pure waste.
  //
  // Kept as a single literal because supabase-js derives the row type from the
  // select string; concatenation widens it to `string` and the result type
  // degrades to an error object.
  let builder = supabase
    .from('medicine_stock')
    .select(
      'id, name, generic_name, strength, category, unit, is_active, is_controlled, is_prescription_required, saleable_on_hand, expired_on_hand, batch_count, nearest_expiry, is_low_stock',
      { count: 'exact' },
    )
    .order('name');

  if (query) {
    // Full-text over brand, generic, composition, barcode and manufacturer.
    // `websearch` lets staff type naturally rather than learn tsquery syntax.
    builder = builder.textSearch('search_vector', query, {
      type: 'websearch',
      config: 'simple',
    });
  }

  if (filter === 'low') builder = builder.eq('is_low_stock', true);
  if (filter === 'out') builder = builder.eq('saleable_on_hand', 0);
  if (filter === 'controlled') builder = builder.eq('is_controlled', true);
  if (filter === 'inactive') builder = builder.eq('is_active', false);
  else if (filter !== 'all') builder = builder.eq('is_active', true);

  const { data, count, error } = await builder.range(
    from,
    from + PAGE_SIZE - 1,
  );

  const rows = data ?? [];
  const total = count ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const canEdit = access.role !== 'cashier';

  const inventoryHref = await tenantHref(slug, '/inventory');

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Inventory</h1>
          <p className="text-muted-foreground text-sm">
            {total} {total === 1 ? 'medicine' : 'medicines'}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={await tenantHref(slug, '/inventory/expiry')}
            className="border-border rounded-md border px-3 py-2 text-sm"
          >
            Expiry board
          </Link>
          {canEdit && (
            <Link
              href={await tenantHref(slug, '/inventory/new')}
              className="bg-primary text-primary-foreground rounded-md px-3 py-2 text-sm font-medium"
            >
              Add medicine
            </Link>
          )}
        </div>
      </div>

      <InventoryFilters action={inventoryHref} query={query} filter={filter} />

      {error && (
        <p className="border-danger/30 bg-danger/10 text-danger rounded-md border px-3 py-2 text-sm">
          {error.message}
        </p>
      )}

      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full min-w-3xl text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Medicine</th>
              <th className="px-4 py-2 text-left font-medium">Category</th>
              <th className="px-4 py-2 text-right font-medium">In stock</th>
              <th className="px-4 py-2 text-right font-medium">Batches</th>
              <th className="px-4 py-2 text-left font-medium">
                Nearest expiry
              </th>
              <th className="px-4 py-2 text-left font-medium">Flags</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="text-muted-foreground px-4 py-8 text-center"
                >
                  {query ? `Nothing matches “${query}”.` : 'No medicines yet.'}
                </td>
              </tr>
            )}

            {rows.map((row) => (
              <tr key={row.id} className="border-border border-t">
                <td className="px-4 py-2">
                  <Link
                    href={`${inventoryHref}/${row.id}`}
                    className="font-medium hover:underline"
                  >
                    {row.name}
                  </Link>
                  {row.generic_name && (
                    <span className="text-muted-foreground block text-xs">
                      {row.generic_name}
                      {row.strength ? ` · ${row.strength}` : ''}
                    </span>
                  )}
                </td>
                <td className="text-muted-foreground px-4 py-2">
                  {row.category ?? '—'}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  <span className={row.is_low_stock ? 'text-warning' : ''}>
                    {Number(row.saleable_on_hand)}
                  </span>
                  <span className="text-muted-foreground"> {row.unit}</span>
                  {Number(row.expired_on_hand) > 0 && (
                    <span className="text-danger block text-xs">
                      {Number(row.expired_on_hand)} expired
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {Number(row.batch_count)}
                </td>
                <td className="px-4 py-2">{row.nearest_expiry ?? '—'}</td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap gap-1">
                    {row.is_prescription_required && <Tag>Rx</Tag>}
                    {row.is_controlled && <Tag tone="danger">Controlled</Tag>}
                    {!row.is_active && <Tag>Inactive</Tag>}
                    {row.is_low_stock && <Tag tone="warning">Low</Tag>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {lastPage > 1 && (
        <nav className="flex items-center justify-between text-sm">
          <PageLink
            href={buildHref(inventoryHref, query, filter, page - 1)}
            disabled={page <= 1}
          >
            Previous
          </PageLink>
          <span className="text-muted-foreground">
            Page {page} of {lastPage}
          </span>
          <PageLink
            href={buildHref(inventoryHref, query, filter, page + 1)}
            disabled={page >= lastPage}
          >
            Next
          </PageLink>
        </nav>
      )}
    </main>
  );
}

function buildHref(base: string, q: string, filter: string, page: number) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (filter && filter !== 'all') params.set('filter', filter);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function PageLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return <span className="text-muted-foreground">{children}</span>;
  }
  return (
    <Link href={href} className="text-primary hover:underline">
      {children}
    </Link>
  );
}

function Tag({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'warning' | 'danger';
}) {
  const tones = {
    neutral: 'bg-muted text-muted-foreground',
    warning: 'bg-warning/10 text-warning',
    danger: 'bg-danger/10 text-danger',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${tones[tone]}`}>
      {children}
    </span>
  );
}
