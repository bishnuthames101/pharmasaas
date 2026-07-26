/**
 * Tenant resolution from an incoming request's hostname and path.
 *
 * Two addressing modes are supported so the same code runs everywhere:
 *   - subdomain  `sunrise.pharmasaas.com/pos`  → production, needs wildcard DNS
 *   - path       `localhost:3000/t/sunrise/pos` → local dev and preview URLs
 *
 * Both resolve to the internal route `/t/{slug}/...`. This module is pure so it
 * can be unit tested without a request.
 */

/**
 * Subdomains that can never be a tenant slug, because they are either taken by
 * platform surfaces or conventionally reserved by infrastructure.
 */
export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'blog',
  'cdn',
  'dashboard',
  'demo',
  'dev',
  'docs',
  'ftp',
  'help',
  'localhost',
  'mail',
  'signup',
  'staging',
  'static',
  'status',
  'support',
  'test',
  'www',
]);

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** A slug is valid if it is DNS-safe, 2–32 chars, and not reserved. */
export function isValidSlug(slug: string): boolean {
  return (
    slug.length >= 2 &&
    slug.length <= 32 &&
    SLUG_PATTERN.test(slug) &&
    !RESERVED_SLUGS.has(slug)
  );
}

/** Lowercase a host and drop any `:port` suffix. */
function normalizeHost(host: string): string {
  return host.toLowerCase().trim().split(':')[0];
}

export type TenantSource = 'subdomain' | 'path';

export interface ResolvedTenant {
  slug: string;
  source: TenantSource;
}

/**
 * Extract a tenant slug from the host, if the host is `{slug}.{rootDomain}`.
 *
 * Returns null for the bare root domain, reserved subdomains, multi-level
 * subdomains, and Vercel preview hosts (`*.vercel.app`), which cannot carry
 * per-tenant wildcards.
 */
export function tenantFromHost(
  host: string | null | undefined,
  rootDomain: string,
): string | null {
  if (!host) return null;

  const normalizedHost = normalizeHost(host);
  const normalizedRoot = normalizeHost(rootDomain);

  if (normalizedHost === normalizedRoot) return null;
  if (normalizedHost.endsWith('.vercel.app')) return null;

  const suffix = `.${normalizedRoot}`;
  if (!normalizedHost.endsWith(suffix)) return null;

  const candidate = normalizedHost.slice(0, -suffix.length);

  // Only a single label is a tenant; `a.b.root` is not.
  if (candidate.includes('.')) return null;

  return isValidSlug(candidate) ? candidate : null;
}

/** Extract a tenant slug from a `/t/{slug}/...` path. */
export function tenantFromPath(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 't' || segments.length < 2) return null;

  const candidate = segments[1].toLowerCase();
  return isValidSlug(candidate) ? candidate : null;
}

/**
 * Resolve the tenant for a request. The subdomain wins over the path so a
 * tenant's own domain can never be used to address a different tenant.
 */
export function resolveTenant(
  host: string | null | undefined,
  pathname: string,
  rootDomain: string,
): ResolvedTenant | null {
  const fromHost = tenantFromHost(host, rootDomain);
  if (fromHost) return { slug: fromHost, source: 'subdomain' };

  const fromPath = tenantFromPath(pathname);
  if (fromPath) return { slug: fromPath, source: 'path' };

  return null;
}

/**
 * Map a public path to the internal `/t/{slug}` route.
 *
 * Path-addressed requests already carry the prefix and are returned unchanged;
 * subdomain-addressed requests get it added.
 */
export function internalPath(tenant: ResolvedTenant, pathname: string): string {
  const prefix = `/t/${tenant.slug}`;

  // Already prefixed — either a path-addressed request, or a subdomain request
  // that followed a redirect written in path form. Prefixing again would
  // produce `/t/sunrise/t/sunrise/...`, which matches nothing.
  if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
    return pathname;
  }

  if (tenant.source === 'path') return pathname;

  const suffix = pathname === '/' ? '' : pathname;
  return `${prefix}${suffix}`;
}
