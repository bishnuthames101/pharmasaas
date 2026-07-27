'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { tenantHref } from '@/lib/tenant/urls';
import { toFieldErrors, type ActionResult } from '@/lib/auth/validation';
import {
  adjustmentSchema,
  batchSchema,
  medicineSchema,
} from '@/lib/inventory/validation';

/**
 * Inventory mutations.
 *
 * Every one runs through the caller's own session, so the role gates in
 * docs/ROLES.md are applied by Postgres rather than re-implemented here. The
 * `access.role` checks below exist to produce a clear message instead of a
 * confusing empty result — they are not the security boundary.
 *
 * `tenant_id` is never sent from here: the column default is
 * `public.tenant_id()`, and the WITH CHECK policy rejects anything else.
 */

async function requireAccess(slug: string) {
  const access = await getTenantAccess(slug);
  if (!access.ok) {
    throw new Error('You do not have access to this pharmacy.');
  }
  return access;
}

export async function saveMedicine(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const slug = String(formData.get('slug') ?? '');
  const medicineId = String(formData.get('medicineId') ?? '');

  const access = await requireAccess(slug);
  if (access.role === 'cashier') {
    return { error: 'Only an owner or pharmacist can edit the catalogue.' };
  }

  const parsed = medicineSchema.safeParse(
    Object.fromEntries(formData.entries()),
  );
  if (!parsed.success) return { fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createClient();
  const values = parsed.data;

  if (medicineId) {
    const { data: before } = await supabase
      .from('medicines')
      .select('*')
      .eq('id', medicineId)
      .maybeSingle();

    const { error } = await supabase
      .from('medicines')
      .update(values)
      .eq('id', medicineId);

    if (error) return { error: describe(error.message) };

    await supabase.rpc('log_audit', {
      p_action: 'medicine.update',
      p_entity: 'medicines',
      p_entity_id: medicineId,
      p_before: before ?? null,
      p_after: values,
    });
  } else {
    const { data, error } = await supabase
      .from('medicines')
      .insert(values)
      .select('id')
      .single();

    if (error) return { error: describe(error.message) };

    await supabase.rpc('log_audit', {
      p_action: 'medicine.create',
      p_entity: 'medicines',
      p_entity_id: data!.id,
      p_after: values,
    });
  }

  revalidatePath(`/t/${slug}/inventory`);
  redirect(await tenantHref(slug, '/inventory'));
}

/** Add stock by recording a receipt against a (possibly new) batch. */
export async function addBatch(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const slug = String(formData.get('slug') ?? '');
  const access = await requireAccess(slug);

  if (access.role === 'cashier') {
    return { error: 'Only an owner or pharmacist can add stock.' };
  }

  const parsed = batchSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return { fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createClient();
  const v = parsed.data;

  // Goes through receive_purchase rather than inserting a batch directly, so
  // pack conversion, cost recording, and the purchase trail all happen the one
  // way they are meant to.
  const { error } = await supabase.rpc('receive_purchase', {
    p_payload: {
      items: [
        {
          medicine_id: v.medicineId,
          batch_no: v.batch_no,
          expiry_date: v.expiry_date,
          qty: v.qty,
          pack_mode: v.pack_mode,
          unit_cost: v.unit_cost,
          selling_price: v.selling_price,
          mrp: v.mrp,
        },
      ],
    },
  });

  if (error) return { error: describe(error.message) };

  revalidatePath(`/t/${slug}/inventory/${v.medicineId}`);
  return { success: 'Stock added.' };
}

export async function adjustStock(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const slug = String(formData.get('slug') ?? '');
  const access = await requireAccess(slug);

  if (access.role === 'cashier') {
    return { error: 'Only an owner or pharmacist can adjust stock.' };
  }

  const parsed = adjustmentSchema.safeParse(
    Object.fromEntries(formData.entries()),
  );
  if (!parsed.success) return { fieldErrors: toFieldErrors(parsed.error) };

  const { batchId, direction, qty, reason, notes } = parsed.data;
  const supabase = await createClient();

  // The form asks for a positive quantity and a direction, because a signed
  // number in a text box is an easy way to write off stock by accident.
  const { error } = await supabase.rpc('adjust_stock', {
    p_batch_id: batchId,
    p_qty_change: direction === 'decrease' ? -qty : qty,
    p_reason: reason,
    p_notes: notes,
  });

  if (error) return { error: describe(error.message) };

  revalidatePath(`/t/${slug}/inventory`);
  return { success: 'Stock adjusted.' };
}

/** Turn Postgres error text into something a pharmacist can act on. */
function describe(message: string): string {
  if (/medicines_barcode_unique/.test(message)) {
    return 'Another medicine already uses that barcode.';
  }
  if (/below zero/i.test(message)) {
    return message.replace(/^.*?ERROR:\s*/, '');
  }
  if (/row-level security|violates row-level/i.test(message)) {
    return 'Your role does not allow this change.';
  }
  return message;
}
