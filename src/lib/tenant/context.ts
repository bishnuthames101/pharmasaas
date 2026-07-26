import 'server-only';

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import { getTenantBySlug, type TenantRecord } from '@/lib/tenant/lookup';

export type TenantRole = 'owner' | 'pharmacist' | 'cashier';

export const ROLE_RANK: Record<TenantRole, number> = {
  cashier: 1,
  pharmacist: 2,
  owner: 3,
};

/** Why a caller was refused, so the UI can offer the right next step. */
export type AccessDenial =
  | { reason: 'unauthenticated' }
  | { reason: 'tenant_not_found' }
  | { reason: 'tenant_suspended'; tenant: TenantRecord }
  /** Signed in, but with no active membership in this pharmacy at all. */
  | { reason: 'not_a_member'; tenant: TenantRecord }
  /**
   * A member here, but their JWT's active tenant points elsewhere. The fix is
   * to switch tenants (which restamps the claim), not to sign in again.
   */
  | {
      reason: 'wrong_active_tenant';
      tenant: TenantRecord;
      activeTenantId: string | null;
    };

export interface TenantSession {
  tenant: TenantRecord;
  userId: string;
  email: string | null;
  role: TenantRole;
}

export type TenantAccess =
  ({ ok: true } & TenantSession) | ({ ok: false } & AccessDenial);

/**
 * Resolve and authorize the caller against a tenant slug.
 *
 * Three separate things are checked, and conflating them is the classic
 * multi-tenant bug:
 *   1. the pharmacy exists and is active;
 *   2. the caller holds an active membership in it (read from `tenant_users`,
 *      not from the token, so a revoked membership takes effect immediately);
 *   3. the caller's JWT `app_metadata.tenant_id` actually points at this
 *      pharmacy. Without check 3, a user belonging to two pharmacies could open
 *      the other one's URL and have every RLS policy silently evaluate against
 *      their *other* tenant — returning the wrong pharmacy's data under the
 *      right pharmacy's branding.
 *
 * This is a usability and correctness layer. It is not what keeps tenants
 * apart: that is RLS in Postgres, which holds even if this function is never
 * called.
 *
 * Wrapped in React `cache` so several Server Components in one render share a
 * single set of lookups.
 */
export const getTenantAccess = cache(
  async (slug: string): Promise<TenantAccess> => {
    const tenant = await getTenantBySlug(slug);
    if (!tenant) return { ok: false, reason: 'tenant_not_found' };

    const supabase = await createClient();

    // getUser() revalidates the token with the auth server rather than trusting
    // the cookie, which is what makes the claim below safe to read.
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return { ok: false, reason: 'unauthenticated' };

    if (tenant.status === 'suspended') {
      return { ok: false, reason: 'tenant_suspended', tenant };
    }

    const { data: membership } = await supabase
      .from('tenant_users')
      .select('role, is_active')
      .eq('tenant_id', tenant.id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!membership || !membership.is_active) {
      return { ok: false, reason: 'not_a_member', tenant };
    }

    const activeTenantId =
      (user.app_metadata?.tenant_id as string | undefined) ?? null;

    if (activeTenantId !== tenant.id) {
      return {
        ok: false,
        reason: 'wrong_active_tenant',
        tenant,
        activeTenantId,
      };
    }

    return {
      ok: true,
      tenant,
      userId: user.id,
      email: user.email ?? null,
      role: membership.role as TenantRole,
    };
  },
);

/** True when `role` is at least as privileged as `minimum`. */
export function hasRole(role: TenantRole, minimum: TenantRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}
