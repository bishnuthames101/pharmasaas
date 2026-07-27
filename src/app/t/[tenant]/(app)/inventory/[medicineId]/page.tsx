import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { tenantHref } from '@/lib/tenant/urls';
import { MedicineForm } from '../medicine-form';
import { AddBatchForm } from './add-batch-form';
import { BatchRow } from './batch-row';

export default async function MedicineDetailPage(
  props: PageProps<'/t/[tenant]/inventory/[medicineId]'>,
) {
  const { tenant: slug, medicineId } = await props.params;
  const access = await getTenantAccess(slug);
  if (!access.ok) notFound();

  const supabase = await createClient();

  // `search_vector` is deliberately excluded — it is only there to be filtered
  // on, and it would otherwise be handed to the edit form as a phantom field.
  //
  // Written as one literal, not a concatenation: supabase-js derives the row
  // type from the select string, and `'a' + 'b'` widens to `string`, which
  // collapses the result type to an error object.
  const { data: medicine } = await supabase
    .from('medicine_stock')
    .select(
      'id, name, generic_name, composition, strength, form, manufacturer, category, rack_location, barcode, unit, units_per_pack, packs_per_box, is_prescription_required, is_controlled, tax_rate, min_stock, max_stock, is_active, saleable_on_hand, expired_on_hand, batch_count',
    )
    .eq('id', medicineId)
    .maybeSingle();

  // RLS makes another pharmacy's medicine indistinguishable from a nonexistent
  // one, which is exactly the behaviour we want.
  if (!medicine) notFound();

  const { data: batches } = await supabase
    .from('batches')
    .select(
      'id, batch_no, expiry_date, qty_available, selling_price, mrp, received_at',
    )
    .eq('medicine_id', medicineId)
    .order('expiry_date');

  // Cost is a separate, role-gated table — a cashier simply gets nothing back,
  // and the column never appears on screen.
  const { data: costs } = await supabase
    .from('batch_costs')
    .select('batch_id, cost_price');

  const costByBatch = new Map(
    (costs ?? []).map((c) => [c.batch_id as string, Number(c.cost_price)]),
  );

  const canEdit = access.role !== 'cashier';

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href={await tenantHref(slug, '/inventory')}
            className="text-muted-foreground text-sm hover:underline"
          >
            ← Inventory
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{medicine.name}</h1>
          <p className="text-muted-foreground text-sm">
            {[medicine.generic_name, medicine.strength, medicine.form]
              .filter(Boolean)
              .join(' · ') || 'No generic details recorded'}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold tabular-nums">
            {Number(medicine.saleable_on_hand)}{' '}
            <span className="text-muted-foreground text-base">
              {medicine.unit}
            </span>
          </p>
          <p className="text-muted-foreground text-xs">
            saleable across {Number(medicine.batch_count)} batch
            {Number(medicine.batch_count) === 1 ? '' : 'es'}
          </p>
          {Number(medicine.expired_on_hand) > 0 && (
            <p className="text-danger text-xs">
              {Number(medicine.expired_on_hand)} expired, needs write-off
            </p>
          )}
        </div>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Batches</h2>
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-full min-w-2xl text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Batch</th>
                <th className="px-4 py-2 text-left font-medium">Expiry</th>
                <th className="px-4 py-2 text-right font-medium">Qty</th>
                <th className="px-4 py-2 text-right font-medium">Price</th>
                {canEdit && (
                  <th className="px-4 py-2 text-right font-medium">Cost</th>
                )}
                {canEdit && <th className="px-4 py-2" />}
              </tr>
            </thead>
            <tbody>
              {(batches ?? []).length === 0 && (
                <tr>
                  <td
                    colSpan={canEdit ? 6 : 4}
                    className="text-muted-foreground px-4 py-8 text-center"
                  >
                    No stock recorded yet.
                  </td>
                </tr>
              )}
              {(batches ?? []).map((batch) => (
                <BatchRow
                  key={batch.id}
                  slug={slug}
                  batch={{
                    id: batch.id as string,
                    batch_no: batch.batch_no as string,
                    expiry_date: batch.expiry_date as string,
                    qty_available: Number(batch.qty_available),
                    selling_price: Number(batch.selling_price),
                    cost_price: costByBatch.get(batch.id as string) ?? null,
                  }}
                  unit={medicine.unit as string}
                  canEdit={canEdit}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {canEdit && (
        <section className="border-border flex flex-col gap-4 rounded-lg border p-5">
          <div>
            <h2 className="font-semibold">Add stock</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Recorded as a goods receipt, so pack sizes are converted and cost
              is stored against the batch.
            </p>
          </div>
          <AddBatchForm
            slug={slug}
            medicineId={medicineId}
            unit={medicine.unit as string}
            unitsPerPack={Number(medicine.units_per_pack)}
          />
        </section>
      )}

      {canEdit && (
        <section className="flex flex-col gap-4">
          <h2 className="font-semibold">Details</h2>
          <MedicineForm slug={slug} medicine={medicine} />
        </section>
      )}
    </main>
  );
}
