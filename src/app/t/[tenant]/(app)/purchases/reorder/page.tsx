import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { tenantHref } from '@/lib/tenant/urls';

export const metadata = { title: 'Reorder report' };

export default async function ReorderPage(
  props: PageProps<'/t/[tenant]/purchases/reorder'>,
) {
  const { tenant: slug } = await props.params;
  const access = await getTenantAccess(slug);
  if (!access.ok || access.role === 'cashier') notFound();

  const supabase = await createClient();

  const { data } = await supabase
    .from('reorder_report')
    .select('*')
    .order('name');

  const rows = data ?? [];
  const estimated = rows.reduce(
    (sum, r) => sum + Number(r.suggested_qty) * Number(r.last_unit_cost ?? 0),
    0,
  );

  // Resolved once, outside the render loop: tenantHref reads request headers,
  // so it cannot be awaited inside a synchronous map callback.
  const inventoryHref = await tenantHref(slug, '/inventory');

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
      <div>
        <Link
          href={await tenantHref(slug, '/purchases')}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Purchases
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Reorder report</h1>
        <p className="text-muted-foreground text-sm">
          Active medicines below their minimum level. Suggested quantity tops
          stock back up to the maximum, so an item does not reappear here the
          moment it arrives.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="border-border text-muted-foreground rounded-lg border p-8 text-center text-sm">
          Nothing below its minimum level.
        </p>
      ) : (
        <>
          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="w-full min-w-3xl text-sm">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Medicine</th>
                  <th className="px-4 py-2 text-right font-medium">In stock</th>
                  <th className="px-4 py-2 text-right font-medium">Minimum</th>
                  <th className="px-4 py-2 text-right font-medium">
                    Suggested
                  </th>
                  <th className="px-4 py-2 text-left font-medium">
                    Last supplier
                  </th>
                  <th className="px-4 py-2 text-right font-medium">
                    Last cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.medicine_id} className="border-border border-t">
                    <td className="px-4 py-2">
                      <Link
                        href={`${inventoryHref}/${r.medicine_id}`}
                        className="font-medium hover:underline"
                      >
                        {r.name}
                      </Link>
                      {r.generic_name && (
                        <span className="text-muted-foreground block text-xs">
                          {r.generic_name}
                        </span>
                      )}
                    </td>
                    <td className="text-warning px-4 py-2 text-right tabular-nums">
                      {Number(r.saleable_on_hand)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {Number(r.min_stock)}
                    </td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums">
                      {Number(r.suggested_qty)} {r.unit}
                      {Number(r.units_per_pack) > 1 && (
                        <span className="text-muted-foreground block text-xs">
                          ≈{' '}
                          {Math.ceil(
                            Number(r.suggested_qty) / Number(r.units_per_pack),
                          )}{' '}
                          packs
                        </span>
                      )}
                    </td>
                    <td className="text-muted-foreground px-4 py-2">
                      {r.last_supplier_name ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {r.last_unit_cost === null
                        ? '—'
                        : Number(r.last_unit_cost).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-muted-foreground text-sm">
            Estimated cost at last known prices:{' '}
            <span className="tabular-nums">{estimated.toFixed(2)}</span>
          </p>
        </>
      )}
    </main>
  );
}
