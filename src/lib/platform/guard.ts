import 'server-only';

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * The platform-admin gate.
 *
 * Everything behind this runs with the service role, which bypasses RLS
 * entirely — so this is the only check standing between an authenticated user
 * and every pharmacy's data. It is written to fail closed at each step.
 *
 * Two properties matter:
 *   - The identity comes from `supabase.auth.getUser()`, which revalidates the
 *     token with the auth server rather than trusting a cookie.
 *   - Membership is read from `platform_admins`, a table with no RLS policies
 *     at all. It is unreachable from the application under any role, so nobody
 *     can grant themselves entry; adding a row takes a migration or the
 *     Supabase dashboard.
 *
 * Being a platform admin conveys nothing inside a tenant — it is a separate
 * axis from `tenant_users.role`.
 */

export interface PlatformAdmin {
  userId: string;
  email: string;
}

export const getPlatformAdmin = cache(
  async (): Promise<PlatformAdmin | null> => {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return null;

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('platform_admins')
      .select('user_id, email')
      .eq('user_id', user.id)
      .maybeSingle();

    // Any error is treated as "not an admin". Failing open here would expose
    // every tenant on the platform.
    if (error || !data) return null;

    return {
      userId: data.user_id as string,
      email: data.email as string,
    };
  },
);

/**
 * Assert platform-admin status, throwing otherwise.
 *
 * Every server action and page under `(platform-admin)` must call this before
 * touching the admin client — there is no layout-level shortcut, because a
 * layout guard does not protect a server action.
 */
export async function requirePlatformAdmin(): Promise<PlatformAdmin> {
  const admin = await getPlatformAdmin();
  if (!admin) {
    throw new Error('Not authorised');
  }
  return admin;
}
