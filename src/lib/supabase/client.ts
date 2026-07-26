'use client';

import { createBrowserClient } from '@supabase/ssr';
import { env } from '@/env';

/**
 * Browser client, for the few things that must happen client-side: sign-in
 * forms, password reset, and subscribing to auth state changes.
 *
 * Carries the anon key and the user's session, so RLS applies exactly as it
 * does on the server. Data reads should still prefer Server Components.
 */
export function createClient() {
  return createBrowserClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
