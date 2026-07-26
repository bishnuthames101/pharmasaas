import 'server-only';

import { headers } from 'next/headers';
import { env } from '@/env';
import { tenantFromHost } from '@/lib/tenant/subdomain';

/**
 * Builds links and redirect targets that work under both addressing modes.
 *
 * On a tenant subdomain the app is already rooted at that pharmacy, so paths
 * stay bare (`/dashboard`). Addressed by path, everything needs the
 * `/t/{slug}` prefix. Getting this wrong produces either a 404 or, worse, a
 * redirect into a different tenant's namespace, so it lives in one place.
 */

/** True when the current request arrived on a tenant subdomain. */
export async function isSubdomainRequest(slug: string): Promise<boolean> {
  const host = (await headers()).get('host');
  return tenantFromHost(host, env.NEXT_PUBLIC_ROOT_DOMAIN) === slug;
}

/**
 * A path within the given tenant, correct for however this request arrived.
 *
 * @param slug tenant slug
 * @param path app-relative path, e.g. `/dashboard`
 */
export async function tenantHref(slug: string, path = '/'): Promise<string> {
  const normalized = path.startsWith('/') ? path : `/${path}`;

  if (await isSubdomainRequest(slug)) {
    return normalized;
  }

  return normalized === '/' ? `/t/${slug}` : `/t/${slug}${normalized}`;
}

/**
 * An absolute URL for a tenant, used when moving *between* pharmacies — the
 * tenant switcher has to leave the current subdomain entirely.
 */
export async function tenantAbsoluteUrl(
  slug: string,
  path = '/',
): Promise<string> {
  const headerList = await headers();
  const host = headerList.get('host') ?? env.NEXT_PUBLIC_ROOT_DOMAIN;
  const root = env.NEXT_PUBLIC_ROOT_DOMAIN;
  const normalized = path.startsWith('/') ? path : `/${path}`;

  // Local and preview hosts have no wildcard DNS, so they stay path-addressed.
  const canUseSubdomain =
    !root.startsWith('localhost') && !host.endsWith('.vercel.app');

  const protocol =
    headerList.get('x-forwarded-proto') ??
    (host.startsWith('localhost') ? 'http' : 'https');

  if (canUseSubdomain) {
    return `${protocol}://${slug}.${root}${normalized === '/' ? '' : normalized}`;
  }

  return `${protocol}://${host}${normalized === '/' ? `/t/${slug}` : `/t/${slug}${normalized}`}`;
}
