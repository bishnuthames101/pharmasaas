import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Slug → tenant resolution.
 *
 * This runs on every tenant request, so it is cached in process with a short
 * TTL. The cache is per server instance and deliberately small: a suspended or
 * renamed pharmacy becomes visible within one TTL window, which is an
 * acceptable lag for a status flag that also gates nothing security-critical
 * on its own (RLS still governs the data itself).
 *
 * The lookup uses the service-role client because it necessarily runs before
 * the caller is known to belong to anything — an anonymous visitor hitting
 * `sunrise.pharmasaas.com/login` has no membership yet. Only non-sensitive
 * registry fields are read, and the result is never returned to the client
 * beyond the tenant's own name.
 */

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
}

const TTL_MS = 60_000;

interface CacheEntry {
  value: TenantRecord | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Drop a slug from the cache — call after renaming or suspending a tenant. */
export function invalidateTenant(slug: string) {
  cache.delete(slug);
}

export async function getTenantBySlug(
  slug: string,
): Promise<TenantRecord | null> {
  const cached = cache.get(slug);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('tenants')
    .select('id, slug, name, status')
    .eq('slug', slug)
    .maybeSingle();

  if (error) {
    // Don't cache failures — a transient outage would otherwise 404 the tenant
    // for a full TTL window.
    throw new Error(`Tenant lookup failed for "${slug}": ${error.message}`);
  }

  const value = (data as TenantRecord | null) ?? null;
  cache.set(slug, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}
