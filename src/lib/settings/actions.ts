'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { toFieldErrors, type ActionResult } from '@/lib/auth/validation';
import { invoiceSeqSchema, settingsSchema } from '@/lib/settings/validation';

/**
 * Pharmacy settings.
 *
 * Writes run through the caller's own session, so the owner-only update policy
 * on `settings` is what actually enforces this — the role check below only
 * produces a clear message instead of a silent no-op. There is no insert or
 * delete policy at all; the row is created by `provision_tenant` and removed
 * only when the pharmacy is.
 */

export async function saveSettings(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const slug = String(formData.get('slug') ?? '');
  const access = await getTenantAccess(slug);

  if (!access.ok) return { error: 'You are not signed in.' };
  if (access.role !== 'owner') {
    return { error: 'Only an owner can change pharmacy settings.' };
  }

  const parsed = settingsSchema.safeParse(
    Object.fromEntries(formData.entries()),
  );
  if (!parsed.success) return { fieldErrors: toFieldErrors(parsed.error) };

  const { expiry_critical, expiry_warning, expiry_notice, ...rest } =
    parsed.data;

  const supabase = await createClient();

  const { data: before } = await supabase
    .from('settings')
    .select('*')
    .eq('tenant_id', access.tenant.id)
    .maybeSingle();

  const values = {
    ...rest,
    // Stored as an int[] because the expiry board reads the three thresholds
    // positionally in SQL.
    expiry_alert_days: [expiry_critical, expiry_warning, expiry_notice],
  };

  const { error, count } = await supabase
    .from('settings')
    .update(values, { count: 'exact' })
    .eq('tenant_id', access.tenant.id);

  if (error) return { error: error.message };
  // RLS makes a refused update return zero rows rather than an error.
  if (!count) return { error: 'Only an owner can change pharmacy settings.' };

  await supabase.rpc('log_audit', {
    p_action: 'settings.update',
    p_entity: 'settings',
    p_entity_id: access.tenant.id,
    p_before: before ?? null,
    p_after: values,
  });

  revalidatePath(`/t/${slug}/settings`);
  return { success: 'Settings saved.' };
}

/**
 * Move the invoice counter forward.
 *
 * Forward only, and the check is done against a freshly read value rather than
 * one posted from the form. Lowering it would reissue numbers already on
 * printed receipts, and the `unique (tenant_id, invoice_no)` constraint would
 * then fail the next sale at the counter.
 */
export async function setInvoiceSeq(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const slug = String(formData.get('slug') ?? '');
  const access = await getTenantAccess(slug);

  if (!access.ok) return { error: 'You are not signed in.' };
  if (access.role !== 'owner') {
    return { error: 'Only an owner can change the invoice number.' };
  }

  const parsed = invoiceSeqSchema.safeParse(
    Object.fromEntries(formData.entries()),
  );
  if (!parsed.success) return { fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createClient();

  const { data: current } = await supabase
    .from('settings')
    .select('next_invoice_seq, invoice_prefix')
    .eq('tenant_id', access.tenant.id)
    .maybeSingle();

  if (!current) return { error: 'Settings not found.' };

  const currentSeq = Number(current.next_invoice_seq);
  const nextSeq = parsed.data.next_invoice_seq;

  if (nextSeq < currentSeq) {
    return {
      fieldErrors: {
        next_invoice_seq:
          `Cannot go backwards. ${current.invoice_prefix}-${currentSeq - 1} ` +
          'and earlier have already been issued.',
      },
    };
  }

  if (nextSeq === currentSeq) {
    return { success: 'Unchanged.' };
  }

  const { error, count } = await supabase
    .from('settings')
    .update({ next_invoice_seq: nextSeq }, { count: 'exact' })
    .eq('tenant_id', access.tenant.id);

  if (error) return { error: error.message };
  if (!count) return { error: 'Only an owner can change the invoice number.' };

  await supabase.rpc('log_audit', {
    p_action: 'settings.invoice_seq',
    p_entity: 'settings',
    p_entity_id: access.tenant.id,
    p_before: { next_invoice_seq: currentSeq },
    p_after: { next_invoice_seq: nextSeq },
  });

  revalidatePath(`/t/${slug}/settings`);
  return {
    success: `Next invoice will be ${current.invoice_prefix}-${nextSeq}.`,
  };
}
