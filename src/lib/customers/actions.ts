'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { toFieldErrors, type ActionResult } from '@/lib/auth/validation';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

export const customerSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(200),
  phone: optionalText(40),
  address: optionalText(300),
  dob: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : null)),
  gender: optionalText(24),
  // Clinically important, so it sits on the record rather than in notes.
  allergies: optionalText(500),
  notes: optionalText(1000),
});

export async function saveCustomer(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const slug = String(formData.get('slug') ?? '');
  const customerId = String(formData.get('customerId') ?? '');

  const access = await getTenantAccess(slug);
  if (!access.ok) return { error: 'You are not signed in.' };

  const parsed = customerSchema.safeParse(
    Object.fromEntries(formData.entries()),
  );
  if (!parsed.success) return { fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createClient();
  const { error } = customerId
    ? await supabase.from('customers').update(parsed.data).eq('id', customerId)
    : await supabase.from('customers').insert(parsed.data);

  if (error) return { error: error.message };

  revalidatePath(`/t/${slug}/customers`);
  return { success: customerId ? 'Customer updated.' : 'Customer added.' };
}

const settleSchema = z.object({
  customerId: z.uuid(),
  amount: z.coerce.number().positive('Enter an amount above zero'),
});

/**
 * Settle part or all of a customer's credit balance.
 *
 * Owner/pharmacist only: taking money against a debt is not a counter action.
 * Written directly rather than through an RPC because it is a single-row update
 * that RLS already gates — there is no second table to keep in step.
 */
export async function settleCredit(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const slug = String(formData.get('slug') ?? '');
  const access = await getTenantAccess(slug);

  if (!access.ok) return { error: 'You are not signed in.' };
  if (access.role === 'cashier') {
    return { error: 'Only an owner or pharmacist can settle balances.' };
  }

  const parsed = settleSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return { fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createClient();

  const { data: customer } = await supabase
    .from('customers')
    .select('credit_balance')
    .eq('id', parsed.data.customerId)
    .maybeSingle();

  if (!customer) return { error: 'Unknown customer.' };

  const next = Number(customer.credit_balance) - parsed.data.amount;

  const { error } = await supabase
    .from('customers')
    .update({ credit_balance: next })
    .eq('id', parsed.data.customerId);

  if (error) return { error: error.message };

  await supabase.rpc('log_audit', {
    p_action: 'customer.settle',
    p_entity: 'customers',
    p_entity_id: parsed.data.customerId,
    p_before: { credit_balance: Number(customer.credit_balance) },
    p_after: { credit_balance: next, settled: parsed.data.amount },
  });

  revalidatePath(`/t/${slug}/customers`);
  return { success: `Settled ${parsed.data.amount.toFixed(2)}.` };
}

const prescriptionSchema = z.object({
  customerId: z
    .string()
    .optional()
    .transform((v) => (v ? v : null)),
  prescriberName: optionalText(200),
  prescriberRegNo: optionalText(80),
  issuedDate: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : null)),
  refillsAllowed: z.coerce.number().int().min(0).max(24).default(0),
  notes: optionalText(1000),
  imagePath: z
    .string()
    .optional()
    .transform((v) => (v ? v : null)),
});

export async function savePrescription(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const slug = String(formData.get('slug') ?? '');
  const access = await getTenantAccess(slug);
  if (!access.ok) return { error: 'You are not signed in.' };

  const parsed = prescriptionSchema.safeParse(
    Object.fromEntries(formData.entries()),
  );
  if (!parsed.success) return { fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('prescriptions')
    .insert({
      customer_id: parsed.data.customerId,
      prescriber_name: parsed.data.prescriberName,
      prescriber_reg_no: parsed.data.prescriberRegNo,
      issued_date: parsed.data.issuedDate,
      refills_allowed: parsed.data.refillsAllowed,
      notes: parsed.data.notes,
      image_path: parsed.data.imagePath,
    })
    .select('id')
    .single();

  if (error) return { error: error.message };

  revalidatePath(`/t/${slug}/prescriptions`);
  // The ID is surfaced because the POS asks for it when dispensing an Rx item.
  return { success: `Prescription recorded. ID: ${data!.id}` };
}

/**
 * Mint a short-lived signed URL for a prescription image.
 *
 * The bucket is private and its policies are keyed on the tenant path prefix,
 * so this can only ever sign a file belonging to the caller's own pharmacy —
 * attempting another tenant's path returns an error rather than a URL.
 */
export async function getPrescriptionImageUrl(
  slug: string,
  imagePath: string,
): Promise<string | null> {
  const access = await getTenantAccess(slug);
  if (!access.ok) return null;

  const supabase = await createClient();
  const { data } = await supabase.storage
    .from('tenant-files')
    .createSignedUrl(imagePath, 300);

  return data?.signedUrl ?? null;
}
