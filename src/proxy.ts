import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/env';
import { internalPath, resolveTenant } from '@/lib/tenant/subdomain';

/**
 * Next.js 16 proxy (formerly middleware). Runs on the Node.js runtime.
 *
 * Responsibility is deliberately narrow: work out which tenant a request is
 * addressed to and rewrite it onto the internal `/t/{slug}` route, stamping the
 * slug into a request header for Server Components to read.
 *
 * It is NOT an authorization boundary. `x-tenant-slug` only says which tenant
 * was *addressed*; whether the caller may see that tenant's data is decided by
 * the membership check in the tenant layout and, ultimately, by RLS in
 * Postgres. Nothing here can be trusted to keep data separate.
 *
 * Phase 1 will add the cached `tenants` lookup so unknown and suspended
 * tenants get a clean 404 instead of falling through to the app.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get('host');

  const tenant = resolveTenant(host, pathname, env.NEXT_PUBLIC_ROOT_DOMAIN);

  if (!tenant) {
    return NextResponse.next();
  }

  const headers = new Headers(request.headers);
  headers.set('x-tenant-slug', tenant.slug);

  const target = internalPath(tenant, pathname);

  // Path-addressed requests are already on the internal route; rewriting them
  // to themselves would be a no-op, so only the headers need to be attached.
  if (target === pathname) {
    return NextResponse.next({ request: { headers } });
  }

  const url = request.nextUrl.clone();
  url.pathname = target;
  return NextResponse.rewrite(url, { request: { headers } });
}

export const config = {
  /**
   * Skip Next internals and anything that looks like a static asset, so the
   * proxy only runs for real page and route-handler requests.
   */
  matcher: ['/((?!_next/|.*\\.[\\w]+$).*)'],
};
