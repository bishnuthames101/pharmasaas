'use server';

import { createClient } from '@/lib/supabase/server';
import { slugSchema } from '@/lib/auth/validation';

/**
 * Live availability check for the signup form.
 *
 * Uses the ordinary anon client, not the service role: `slug_available()` is a
 * security-definer function granted to `anon` precisely so this check needs no
 * elevated privileges. It answers one boolean about a slug the caller already
 * typed, which is inherently public once that subdomain resolves.
 *
 * Advisory only. The authoritative check is inside `provision_tenant`, which
 * re-tests availability in the same transaction as the insert — between a
 * keystroke here and a submission a moment later, someone else can always take
 * the name.
 */
export async function checkSlug(slug: string): Promise<boolean> {
  const parsed = slugSchema.safeParse(slug);
  if (!parsed.success) return false;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('slug_available', {
    p_slug: parsed.data,
  });

  if (error) return false;
  return data === true;
}
