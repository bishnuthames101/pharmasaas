'use server';

import { createAdminClient } from '@/lib/supabase/admin';
import { slugSchema } from '@/lib/auth/validation';

/**
 * Live availability check for the signup form.
 *
 * Advisory only — it makes the form pleasant to use, and nothing more. The
 * authoritative check happens inside `provision_tenant`, which re-tests
 * availability in the same transaction as the insert; between a keystroke here
 * and a submission a moment later, someone else can always take the name.
 */
export async function checkSlug(slug: string): Promise<boolean> {
  const parsed = slugSchema.safeParse(slug);
  if (!parsed.success) return false;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc('slug_available', {
    p_slug: parsed.data,
  });

  if (error) return false;
  return data === true;
}
