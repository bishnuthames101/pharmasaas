import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { tenantHref } from '@/lib/tenant/urls';
import { ReceiveForm } from './receive-form';

export const metadata = { title: 'Receive goods' };

export default async function ReceivePage(
  props: PageProps<'/t/[tenant]/purchases/receive'>,
) {
  const { tenant: slug } = await props.params;
  const access = await getTenantAccess(slug);
  if (!access.ok) notFound();

  if (access.role === 'cashier') {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-semibold">Receive goods</h1>
        <p className="text-muted-foreground mt-2">
          Only owners and pharmacists can receive goods.
        </p>
      </main>
    );
  }

  const supabase = await createClient();

  const [{ data: medicines }, { data: suppliers }] = await Promise.all([
    supabase
      .from('medicines')
      .select('id, name, unit, units_per_pack')
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('suppliers')
      .select('id, name')
      .eq('is_active', true)
      .order('name'),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
      <div>
        <Link
          href={await tenantHref(slug, '/purchases')}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Purchases
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Receive goods</h1>
        <p className="text-muted-foreground text-sm">
          Quantities may be entered in packs. Conversion to selling units
          happens here, once, and never again.
        </p>
      </div>

      {(medicines ?? []).length === 0 ? (
        <p className="border-border text-muted-foreground rounded-lg border p-8 text-center text-sm">
          Add a medicine to the catalogue first.
        </p>
      ) : (
        <ReceiveForm
          slug={slug}
          medicines={(medicines ?? []).map((m) => ({
            id: m.id as string,
            name: m.name as string,
            unit: m.unit as string,
            units_per_pack: Number(m.units_per_pack),
          }))}
          suppliers={(suppliers ?? []).map((s) => ({
            id: s.id as string,
            name: s.name as string,
          }))}
          today={new Date().toISOString().slice(0, 10)}
        />
      )}
    </main>
  );
}
