import { notFound } from 'next/navigation';
import { getTenantAccess } from '@/lib/tenant/context';
import { createClient } from '@/lib/supabase/server';
import { listMyMemberships } from '@/lib/auth/actions';
import { TenantSwitcher } from './tenant-switcher';

export async function generateMetadata() {
  return { title: 'Dashboard' };
}

/**
 * Placeholder dashboard. The real one — today's takings, dues, expiring stock,
 * low stock — arrives in Phase 7, once there is domain data to summarise.
 * For now it confirms the session, role, and settings are all wired up.
 */
export default async function DashboardPage(
  props: PageProps<'/t/[tenant]/dashboard'>,
) {
  const { tenant: slug } = await props.params;
  const access = await getTenantAccess(slug);

  // The layout guard has already run; this narrows the type and covers the
  // impossible case rather than asserting it away.
  if (!access.ok) notFound();

  const supabase = await createClient();

  // No `.eq('tenant_id', ...)` needed — RLS restricts this to the caller's
  // pharmacy. That it returns exactly one row is itself a check that the JWT
  // claim and the policies agree.
  const { data: settings } = await supabase
    .from('settings')
    .select(
      'pharmacy_name, currency, tax_mode, default_tax_rate, invoice_prefix, next_invoice_seq',
    )
    .single();

  const memberships = await listMyMemberships();

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {settings?.pharmacy_name ?? access.tenant.name}
          </h1>
          <p className="text-muted-foreground text-sm">
            Signed in as {access.email} ({access.role})
          </p>
        </div>

        {memberships.length > 1 && (
          <TenantSwitcher
            memberships={memberships}
            currentTenantId={access.tenant.id}
          />
        )}
      </div>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Currency', value: settings?.currency ?? '—' },
          {
            label: 'Default tax',
            value: settings ? `${settings.default_tax_rate}%` : '—',
          },
          { label: 'Tax mode', value: settings?.tax_mode ?? '—' },
          {
            label: 'Next invoice',
            value: settings
              ? `${settings.invoice_prefix}-${settings.next_invoice_seq}`
              : '—',
          },
        ].map((stat) => (
          <div key={stat.label} className="border-border rounded-lg border p-4">
            <p className="text-muted-foreground text-xs tracking-wide uppercase">
              {stat.label}
            </p>
            <p className="mt-1 text-lg font-medium">{stat.value}</p>
          </div>
        ))}
      </section>

      <section className="border-border rounded-lg border p-5">
        <h2 className="font-semibold">What&apos;s next</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Inventory, purchasing, and the point of sale are built in the phases
          that follow. Staff can be added now under Staff.
        </p>
      </section>
    </main>
  );
}
