import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { SettingsForm } from './settings-form';
import { InvoiceSeqForm } from './invoice-seq-form';

export const metadata = { title: 'Pharmacy settings' };

export default async function SettingsPage(
  props: PageProps<'/t/[tenant]/settings'>,
) {
  const { tenant: slug } = await props.params;
  const access = await getTenantAccess(slug);
  if (!access.ok) notFound();

  const supabase = await createClient();

  // Readable by every staff member — the POS needs currency and tax mode — so
  // this loads for any role; only editing is gated.
  const { data: settings } = await supabase
    .from('settings')
    .select(
      'pharmacy_name, address, phone, currency, tax_mode, default_tax_rate, expiry_alert_days, invoice_prefix, next_invoice_seq, low_stock_threshold_default',
    )
    .single();

  if (!settings) notFound();

  const isOwner = access.role === 'owner';
  const alertDays = (settings.expiry_alert_days as number[] | null) ?? [
    30, 60, 90,
  ];

  return (
    <>
      {!isOwner && (
        <p className="border-border text-muted-foreground rounded-lg border px-4 py-3 text-sm">
          These are shown for reference. Only an owner can change them.
        </p>
      )}

      <SettingsForm
        slug={slug}
        readOnly={!isOwner}
        settings={{
          pharmacy_name: (settings.pharmacy_name as string) ?? '',
          address: (settings.address as string) ?? '',
          phone: (settings.phone as string) ?? '',
          currency: settings.currency as string,
          tax_mode: settings.tax_mode as string,
          default_tax_rate: Number(settings.default_tax_rate),
          invoice_prefix: settings.invoice_prefix as string,
          low_stock_threshold_default: Number(
            settings.low_stock_threshold_default,
          ),
          expiry_critical: alertDays[0] ?? 30,
          expiry_warning: alertDays[1] ?? 60,
          expiry_notice: alertDays[2] ?? 90,
        }}
      />

      {isOwner && (
        <InvoiceSeqForm
          slug={slug}
          prefix={settings.invoice_prefix as string}
          nextSeq={Number(settings.next_invoice_seq)}
        />
      )}
    </>
  );
}
