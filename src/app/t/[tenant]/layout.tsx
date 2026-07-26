import { notFound } from 'next/navigation';
import { isValidSlug } from '@/lib/tenant/subdomain';
import { getTenantBySlug } from '@/lib/tenant/lookup';

/**
 * Tenant route boundary.
 *
 * The proxy declines to *resolve* reserved and malformed slugs, but Next still
 * matches `/t/{anything}` directly, so the same rule is re-applied here where
 * the route is actually served. An unknown pharmacy 404s; a suspended one gets
 * an explanation rather than a dead end.
 *
 * Authentication is deliberately not enforced at this level — the login page
 * lives underneath this layout and has to stay reachable. Pages that require a
 * session call `getTenantAccess()` themselves (Phase 2).
 */
export default async function TenantLayout(props: LayoutProps<'/t/[tenant]'>) {
  const { tenant: slug } = await props.params;

  if (!isValidSlug(slug)) {
    notFound();
  }

  const tenant = await getTenantBySlug(slug);

  if (!tenant) {
    notFound();
  }

  if (tenant.status === 'suspended') {
    return (
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-start justify-center gap-4 px-6 py-24">
        <h1 className="text-2xl font-semibold">{tenant.name} is suspended</h1>
        <p className="text-muted-foreground">
          This workspace has been suspended and is temporarily unavailable.
          Contact support to restore access.
        </p>
      </main>
    );
  }

  return props.children;
}
