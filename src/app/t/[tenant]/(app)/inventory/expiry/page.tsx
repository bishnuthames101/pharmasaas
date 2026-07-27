import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { tenantHref } from '@/lib/tenant/urls';
import { cn } from '@/lib/utils';

export const metadata = { title: 'Expiry board' };

const BUCKETS = [
  {
    key: 'expired',
    title: 'Expired',
    blurb: 'Cannot be sold. Write off with a reason.',
    tone: 'border-danger/40 bg-danger/5',
  },
  {
    key: 'critical',
    title: 'Expiring very soon',
    blurb: 'Push these first, or return to the supplier.',
    tone: 'border-warning/40 bg-warning/5',
  },
  {
    key: 'warning',
    title: 'Expiring soon',
    blurb: 'Worth watching.',
    tone: 'border-border',
  },
  {
    key: 'notice',
    title: 'On the horizon',
    blurb: 'No action needed yet.',
    tone: 'border-border',
  },
] as const;

export default async function ExpiryBoardPage(
  props: PageProps<'/t/[tenant]/inventory/expiry'>,
) {
  const { tenant: slug } = await props.params;
  const access = await getTenantAccess(slug);
  if (!access.ok) notFound();

  const supabase = await createClient();

  // Buckets come from settings.expiry_alert_days inside the view, so a pharmacy
  // that wants 15/45/120 gets that without a code change.
  const { data } = await supabase
    .from('batch_expiry_board')
    .select('*')
    .neq('bucket', 'ok')
    .order('expiry_date');

  const rows = data ?? [];
  const inventoryHref = await tenantHref(slug, '/inventory');

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
      <div>
        <Link
          href={inventoryHref}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Inventory
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Expiry board</h1>
        <p className="text-muted-foreground text-sm">
          Live batches only. Expired stock is excluded from sale automatically,
          but still needs writing off.
        </p>
      </div>

      {rows.length === 0 && (
        <p className="border-border text-muted-foreground rounded-lg border p-8 text-center text-sm">
          Nothing expiring within your alert window.
        </p>
      )}

      {BUCKETS.map((bucket) => {
        const items = rows.filter((r) => r.bucket === bucket.key);
        if (items.length === 0) return null;

        return (
          <section
            key={bucket.key}
            className={cn('rounded-lg border p-5', bucket.tone)}
          >
            <div className="mb-3">
              <h2 className="font-semibold">
                {bucket.title}{' '}
                <span className="text-muted-foreground font-normal">
                  ({items.length})
                </span>
              </h2>
              <p className="text-muted-foreground text-sm">{bucket.blurb}</p>
            </div>

            <table className="w-full text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 text-left font-medium">Medicine</th>
                  <th className="py-1 text-left font-medium">Batch</th>
                  <th className="py-1 text-left font-medium">Expiry</th>
                  <th className="py-1 text-right font-medium">Qty</th>
                  <th className="py-1 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.batch_id} className="border-border border-t">
                    <td className="py-1.5">
                      <Link
                        href={`${inventoryHref}/${item.medicine_id}`}
                        className="hover:underline"
                      >
                        {item.medicine_name}
                      </Link>
                    </td>
                    <td className="py-1.5 font-mono text-xs">
                      {item.batch_no}
                    </td>
                    <td className="py-1.5">
                      {item.expiry_date}
                      <span className="text-muted-foreground text-xs">
                        {' '}
                        (
                        {Number(item.days_to_expiry) < 0
                          ? `${-Number(item.days_to_expiry)}d ago`
                          : `${item.days_to_expiry}d`}
                        )
                      </span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {Number(item.qty_available)} {item.unit}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {(
                        Number(item.qty_available) * Number(item.selling_price)
                      ).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </main>
  );
}
