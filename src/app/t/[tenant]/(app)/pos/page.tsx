import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { PosTerminal } from './pos-terminal';

export const metadata = { title: 'Point of sale' };

export default async function PosPage(props: PageProps<'/t/[tenant]/pos'>) {
  const { tenant: slug } = await props.params;
  const access = await getTenantAccess(slug);
  if (!access.ok) notFound();

  const supabase = await createClient();
  const { data: settings } = await supabase
    .from('settings')
    .select('default_tax_rate, tax_mode, currency')
    .single();

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 px-6 py-6">
      <h1 className="sr-only">Point of sale</h1>
      <PosTerminal
        slug={slug}
        taxRate={Number(settings?.default_tax_rate ?? 0)}
        taxMode={(settings?.tax_mode as string) ?? 'exclusive'}
        currency={(settings?.currency as string) ?? 'NPR'}
        canSeeReturns={access.role !== 'cashier'}
      />
    </main>
  );
}
