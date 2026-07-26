import { notFound } from 'next/navigation';
import { isValidSlug } from '@/lib/tenant/subdomain';

/**
 * Tenant route boundary.
 *
 * The proxy declines to *resolve* reserved and malformed slugs, but Next still
 * matches `/t/{anything}` directly, so the same rule has to be re-applied here
 * where the route is actually served.
 *
 * Phase 1 extends this with the cached `tenants` lookup (404 on unknown or
 * suspended pharmacies) and the membership guard that checks the caller's JWT
 * tenant against this slug.
 */
export default async function TenantLayout(props: LayoutProps<'/t/[tenant]'>) {
  const { tenant } = await props.params;

  if (!isValidSlug(tenant)) {
    notFound();
  }

  return props.children;
}
