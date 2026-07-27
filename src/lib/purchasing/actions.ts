'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { tenantHref } from '@/lib/tenant/urls';
import { toFieldErrors, type ActionResult } from '@/lib/auth/validation';
import {
  paymentSchema,
  purchaseSchema,
  supplierSchema,
} from '@/lib/purchasing/validation';

async function requireBuyer(slug: string) {
  const access = await getTenantAccess(slug);
  if (!access.ok) throw new Error('You do not have access to this pharmacy.');
  if (access.role === 'cashier') return null;
  return access;
}

export async function saveSupplier(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const slug = String(formData.get('slug') ?? '');
  const supplierId = String(formData.get('supplierId') ?? '');

  if (!(await requireBuyer(slug))) {
    return { error: 'Only an owner or pharmacist can manage suppliers.' };
  }

  const parsed = supplierSchema.safeParse(
    Object.fromEntries(formData.entries()),
  );
  if (!parsed.success) return { fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createClient();

  const { error } = supplierId
    ? await supabase.from('suppliers').update(parsed.data).eq('id', supplierId)
    : await supabase.from('suppliers').insert(parsed.data);

  if (error) return { error: error.message };

  revalidatePath(`/t/${slug}/purchases/suppliers`);
  redirect(await tenantHref(slug, '/purchases/suppliers'));
}

export async function recordPayment(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const slug = String(formData.get('slug') ?? '');
  if (!(await requireBuyer(slug))) {
    return { error: 'Only an owner or pharmacist can record payments.' };
  }

  const parsed = paymentSchema.safeParse(
    Object.fromEntries(formData.entries()),
  );
  if (!parsed.success) return { fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createClient();

  // The payment row and the balance movement are written together inside the
  // RPC, so the ledger cannot end up half-updated.
  const { error } = await supabase.rpc('pay_supplier', {
    p_supplier_id: parsed.data.supplierId,
    p_amount: parsed.data.amount,
    p_method: parsed.data.method,
    p_reference: parsed.data.reference,
    p_purchase_id: parsed.data.purchaseId,
    p_notes: parsed.data.notes,
  });

  if (error) return { error: error.message };

  revalidatePath(`/t/${slug}/purchases/suppliers`);
  return { success: 'Payment recorded.' };
}

/**
 * Goods receipt.
 *
 * The form posts repeated `line.*` fields rather than JSON, so it degrades
 * gracefully and so each field can carry its own validation error.
 */
export async function receiveGoods(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const slug = String(formData.get('slug') ?? '');
  if (!(await requireBuyer(slug))) {
    return { error: 'Only an owner or pharmacist can receive goods.' };
  }

  const medicineIds = formData.getAll('line.medicine_id').map(String);
  const lines = medicineIds
    .map((medicineId, i) => ({
      medicine_id: medicineId,
      batch_no: String(formData.getAll('line.batch_no')[i] ?? ''),
      expiry_date: String(formData.getAll('line.expiry_date')[i] ?? ''),
      qty: String(formData.getAll('line.qty')[i] ?? ''),
      pack_mode: formData.getAll('line.pack_mode')[i] === 'on',
      unit_cost: String(formData.getAll('line.unit_cost')[i] ?? ''),
      selling_price: String(formData.getAll('line.selling_price')[i] ?? ''),
      mrp: String(formData.getAll('line.mrp')[i] ?? ''),
    }))
    // Blank rows are the natural result of a form that offers spare lines.
    .filter((line) => line.medicine_id && line.qty);

  const parsed = purchaseSchema.safeParse({
    supplierId: formData.get('supplierId') ?? '',
    invoiceNo: formData.get('invoiceNo') ?? '',
    purchaseDate: formData.get('purchaseDate'),
    paid: formData.get('paid') ?? 0,
    lines,
  });

  if (!parsed.success) {
    const errors = toFieldErrors(parsed.error);
    return {
      error: errors.lines ?? 'Check the highlighted fields.',
      fieldErrors: errors,
    };
  }

  const supabase = await createClient();

  const { data, error } = await supabase.rpc('receive_purchase', {
    p_payload: {
      supplier_id: parsed.data.supplierId,
      invoice_no: parsed.data.invoiceNo,
      purchase_date: parsed.data.purchaseDate,
      paid: parsed.data.paid,
      items: parsed.data.lines,
    },
  });

  if (error) return { error: error.message };

  revalidatePath(`/t/${slug}/purchases`);
  redirect(
    await tenantHref(
      slug,
      `/purchases/${(data as { purchase_id: string }).purchase_id}`,
    ),
  );
}
