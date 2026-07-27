'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import type { ActionResult } from '@/lib/auth/validation';

const returnSchema = z.object({
  slug: z.string().min(1),
  saleId: z.uuid(),
  items: z
    .array(z.object({ sale_item_id: z.uuid(), qty: z.number().positive() }))
    .min(1, 'Enter a quantity to return'),
});

/**
 * Process a sales return.
 *
 * Stock goes back to the batch it came from, which `sales_return` handles —
 * restocking to "the newest batch" would quietly launder an old batch's expiry
 * date onto returned goods.
 */
export async function processReturn(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const slug = String(formData.get('slug') ?? '');
  const saleId = String(formData.get('saleId') ?? '');

  const access = await getTenantAccess(slug);
  if (!access.ok) return { error: 'You are not signed in.' };
  if (access.role === 'cashier') {
    return { error: 'Refunds must be handled by an owner or pharmacist.' };
  }

  // Only lines with a positive quantity are returned; the rest of the form is
  // left blank because most returns cover one item out of several.
  const ids = formData.getAll('line.id').map(String);
  const items = ids
    .map((id, i) => ({
      sale_item_id: id,
      qty: Number(formData.getAll('line.qty')[i] ?? 0),
    }))
    .filter((line) => line.qty > 0);

  const parsed = returnSchema.safeParse({ slug, saleId, items });
  if (!parsed.success) {
    return { error: 'Enter a quantity against at least one line.' };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('sales_return', {
    p_sale_id: parsed.data.saleId,
    p_items: parsed.data.items,
  });

  if (error) {
    return {
      error: /more than was sold/i.test(error.message)
        ? 'Cannot return more than was sold.'
        : error.message,
    };
  }

  revalidatePath(`/t/${slug}/sales/${saleId}`);
  const refund = (data as { refund: number }).refund;
  return { success: `Refunded ${Number(refund).toFixed(2)}.` };
}
