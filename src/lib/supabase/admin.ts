import 'server-only';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { env, serverEnv } from '@/env';

/**
 * Service-role client. **This bypasses Row Level Security entirely.**
 *
 * The service role holds the BYPASSRLS attribute, which `force row level
 * security` does not override. Every query made through this client sees every
 * tenant's data, so it is the one place in the codebase where a missing
 * `.eq('tenant_id', ...)` is a cross-tenant leak rather than a harmless
 * omission.
 *
 * Legitimate uses are narrow:
 *   - Auth admin operations: invites, stamping `app_metadata`, revoking
 *     sessions — things the anon client is not permitted to do.
 *   - Signup, which must create a tenant before any membership exists.
 *   - Platform-admin features, behind an explicit allowlist guard.
 *   - The RLS coverage check, which reads catalog metadata.
 *
 * Prefer {@link scopedAdmin} whenever the operation concerns exactly one
 * tenant, so the tenant filter is applied structurally rather than remembered.
 *
 * The `server-only` import makes importing this from a Client Component a build
 * error rather than a runtime key leak.
 */
export function createAdminClient() {
  return createSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    serverEnv().SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

/**
 * A service-role client whose table operations are pinned to one tenant.
 *
 * Each helper applies the tenant filter (or stamps `tenant_id` on inserts)
 * before handing back the builder, so the filter cannot be forgotten. This is a
 * guard rail, not a security boundary: `raw` and `auth` are unscoped by
 * necessity, and callers reaching for them carry the full responsibility.
 */
export function scopedAdmin(tenantId: string) {
  const admin = createAdminClient();

  return {
    tenantId,

    /** Tenant-filtered read. Chain further filters as normal. */
    select(table: string, columns = '*') {
      return admin.from(table).select(columns).eq('tenant_id', tenantId);
    },

    /** Insert with `tenant_id` stamped onto every row, overriding any input. */
    insert(table: string, rows: Record<string, unknown>[]) {
      const stamped = rows.map((row) => ({ ...row, tenant_id: tenantId }));
      return admin.from(table).insert(stamped);
    },

    /** Tenant-filtered update. Add further `.eq()` filters to narrow it. */
    update(table: string, values: Record<string, unknown>) {
      return admin.from(table).update(values).eq('tenant_id', tenantId);
    },

    /** Tenant-filtered delete. Add further `.eq()` filters to narrow it. */
    delete(table: string) {
      return admin.from(table).delete().eq('tenant_id', tenantId);
    },

    /**
     * Auth admin API — inherently cross-tenant (it operates on `auth.users`).
     * Callers must check membership themselves before acting on a user.
     */
    auth: admin.auth,

    /** Unscoped escape hatch. Filter by tenant manually. */
    raw: admin,
  };
}
