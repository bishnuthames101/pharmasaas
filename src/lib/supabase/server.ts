import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { env } from '@/env';

/**
 * The client used for essentially all data access.
 *
 * It carries the anon key plus the caller's session, which means every query
 * runs as that user and Postgres RLS decides what comes back. Application code
 * therefore does not need `.eq('tenant_id', ...)` for correctness — though
 * adding it is still worthwhile, both as defence in depth and to help the
 * planner pick the `(tenant_id, ...)` composite indexes.
 *
 * Must be constructed per request: it reads and writes the session cookies.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot set cookies. Session refresh is handled
            // in the proxy and in Server Actions, so ignoring this is safe.
          }
        },
      },
    },
  );
}
