'use server';

import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';

/** A row the POS can add to the cart. */
export interface PosResult {
  medicine_id: string;
  name: string;
  generic_name: string | null;
  strength: string | null;
  unit: string;
  is_prescription_required: boolean;
  is_controlled: boolean;
  saleable_on_hand: number;
  batch_id: string | null;
  batch_no: string | null;
  expiry_date: string | null;
  selling_price: number | null;
  exact_barcode: boolean;
}

/**
 * Counter search. Runs under the caller's session, so RLS confines it to their
 * own pharmacy — there is no tenant parameter to get wrong.
 */
export async function searchForSale(
  slug: string,
  query: string,
): Promise<PosResult[]> {
  const access = await getTenantAccess(slug);
  if (!access.ok) return [];

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('pos_search', {
    p_query: query,
    p_limit: 12,
  });

  if (error) return [];

  // Without generated database types, RPC results come back untyped. The shape
  // is pinned to the function's RETURNS TABLE signature in
  // 20260727000900_pos_search.sql; changing one without the other is a runtime
  // bug, so they are kept side by side deliberately.
  const rows = (data ?? []) as {
    medicine_id: string;
    name: string;
    generic_name: string | null;
    strength: string | null;
    unit: string;
    is_prescription_required: boolean;
    is_controlled: boolean;
    saleable_on_hand: number | string;
    batch_id: string | null;
    batch_no: string | null;
    expiry_date: string | null;
    selling_price: number | string | null;
    exact_barcode: boolean;
  }[];

  return rows.map((row) => ({
    medicine_id: row.medicine_id,
    name: row.name,
    generic_name: row.generic_name,
    strength: row.strength,
    unit: row.unit,
    is_prescription_required: row.is_prescription_required,
    is_controlled: row.is_controlled,
    saleable_on_hand: Number(row.saleable_on_hand),
    batch_id: row.batch_id,
    batch_no: row.batch_no,
    expiry_date: row.expiry_date,
    selling_price:
      row.selling_price === null ? null : Number(row.selling_price),
    exact_barcode: row.exact_barcode,
  }));
}

const cartLineSchema = z.object({
  medicineId: z.uuid(),
  qty: z.number().positive(),
  discount: z.number().min(0).default(0),
});

const checkoutSchema = z.object({
  slug: z.string().min(1),
  customerId: z.uuid().nullable().default(null),
  prescriptionId: z.uuid().nullable().default(null),
  paymentMethod: z.enum(['cash', 'card', 'wallet', 'credit']),
  paid: z.number().min(0),
  lines: z.array(cartLineSchema).min(1, 'The cart is empty'),
});

export type CheckoutInput = z.input<typeof checkoutSchema>;

export interface CheckoutResult {
  ok: boolean;
  error?: string;
  saleId?: string;
  invoiceNo?: string;
  total?: number;
}

/**
 * Complete the sale.
 *
 * Note what is *not* sent: prices. `complete_sale` reads them from the batch,
 * so a tampered client cannot set its own. The cart only says what and how
 * many.
 */
export async function checkout(input: CheckoutInput): Promise<CheckoutResult> {
  const parsed = checkoutSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'Check the cart and try again.' };
  }

  const access = await getTenantAccess(parsed.data.slug);
  if (!access.ok) return { ok: false, error: 'You are not signed in.' };

  const supabase = await createClient();

  const { data, error } = await supabase.rpc('complete_sale', {
    p_payload: {
      customer_id: parsed.data.customerId,
      prescription_id: parsed.data.prescriptionId,
      payment_method: parsed.data.paymentMethod,
      paid: parsed.data.paid,
      items: parsed.data.lines.map((line) => ({
        medicine_id: line.medicineId,
        qty: line.qty,
        discount: line.discount,
      })),
    },
  });

  if (error) return { ok: false, error: humanise(error.message) };

  const result = data as {
    sale_id: string;
    invoice_no: string;
    total: number;
  };

  return {
    ok: true,
    saleId: result.sale_id,
    invoiceNo: result.invoice_no,
    total: Number(result.total),
  };
}

/** Create a walk-in customer from the counter. Cashiers may do this. */
export async function quickCreateCustomer(
  slug: string,
  name: string,
  phone: string,
): Promise<{ id: string; name: string } | { error: string }> {
  const access = await getTenantAccess(slug);
  if (!access.ok) return { error: 'You are not signed in.' };

  const trimmed = name.trim();
  if (!trimmed) return { error: 'Enter a name.' };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('customers')
    .insert({ name: trimmed, phone: phone.trim() || null })
    .select('id, name')
    .single();

  if (error) return { error: error.message };
  return { id: data!.id as string, name: data!.name as string };
}

/** Look up recent customers for the counter picker. */
export async function searchCustomers(slug: string, query: string) {
  const access = await getTenantAccess(slug);
  if (!access.ok) return [];

  const supabase = await createClient();
  let builder = supabase
    .from('customers')
    .select('id, name, phone, credit_balance')
    .order('name')
    .limit(8);

  if (query.trim()) {
    builder = builder.or(`name.ilike.%${query}%,phone.ilike.%${query}%`);
  }

  const { data } = await builder;
  return (data ?? []).map((c) => ({
    id: c.id as string,
    name: c.name as string,
    phone: (c.phone as string | null) ?? null,
    creditBalance: Number(c.credit_balance),
  }));
}

function humanise(message: string): string {
  if (/insufficient stock/i.test(message)) {
    return message.replace(/^.*?(Insufficient stock)/i, '$1');
  }
  if (/requires a prescription/i.test(message)) {
    return 'That item needs a prescription. Attach one to continue.';
  }
  if (/settings are missing/i.test(message)) {
    return 'Pharmacy settings are missing. Contact the owner.';
  }
  if (/may not perform/i.test(message)) {
    return 'Your role does not allow this.';
  }
  return message;
}
