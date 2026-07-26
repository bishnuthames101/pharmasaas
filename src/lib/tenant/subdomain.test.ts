import { describe, expect, it } from 'vitest';
import {
  internalPath,
  isValidSlug,
  resolveTenant,
  tenantFromHost,
  tenantFromPath,
} from './subdomain';

describe('isValidSlug', () => {
  it('accepts DNS-safe slugs', () => {
    expect(isValidSlug('sunrise')).toBe(true);
    expect(isValidSlug('sunrise-pharmacy')).toBe(true);
    expect(isValidSlug('a1')).toBe(true);
  });

  it('rejects malformed slugs', () => {
    expect(isValidSlug('a')).toBe(false);
    expect(isValidSlug('-lead')).toBe(false);
    expect(isValidSlug('trail-')).toBe(false);
    expect(isValidSlug('Upper')).toBe(false);
    expect(isValidSlug('has_underscore')).toBe(false);
    expect(isValidSlug('has.dot')).toBe(false);
    expect(isValidSlug('x'.repeat(33))).toBe(false);
  });

  it('rejects reserved slugs', () => {
    expect(isValidSlug('www')).toBe(false);
    expect(isValidSlug('admin')).toBe(false);
    expect(isValidSlug('api')).toBe(false);
    expect(isValidSlug('app')).toBe(false);
  });
});

describe('tenantFromHost', () => {
  it('extracts a tenant from a production subdomain', () => {
    expect(tenantFromHost('sunrise.pharmasaas.com', 'pharmasaas.com')).toBe(
      'sunrise',
    );
  });

  it('extracts a tenant from a localhost subdomain, ignoring the port', () => {
    expect(tenantFromHost('sunrise.localhost:3000', 'localhost:3000')).toBe(
      'sunrise',
    );
  });

  it('returns null for the bare root domain', () => {
    expect(tenantFromHost('pharmasaas.com', 'pharmasaas.com')).toBeNull();
    expect(tenantFromHost('localhost:3000', 'localhost:3000')).toBeNull();
  });

  it('returns null for reserved subdomains', () => {
    expect(tenantFromHost('www.pharmasaas.com', 'pharmasaas.com')).toBeNull();
    expect(tenantFromHost('admin.pharmasaas.com', 'pharmasaas.com')).toBeNull();
  });

  it('returns null for nested subdomains', () => {
    expect(
      tenantFromHost('a.sunrise.pharmasaas.com', 'pharmasaas.com'),
    ).toBeNull();
  });

  it('returns null for Vercel preview hosts', () => {
    expect(
      tenantFromHost('pharmasaas-git-main-me.vercel.app', 'pharmasaas.com'),
    ).toBeNull();
  });

  it('returns null for an unrelated host', () => {
    expect(tenantFromHost('evil.com', 'pharmasaas.com')).toBeNull();
    expect(tenantFromHost(null, 'pharmasaas.com')).toBeNull();
  });

  it('is case insensitive', () => {
    expect(tenantFromHost('SunRise.PharmaSaaS.com', 'pharmasaas.com')).toBe(
      'sunrise',
    );
  });
});

describe('tenantFromPath', () => {
  it('extracts a tenant from a /t/ path', () => {
    expect(tenantFromPath('/t/sunrise')).toBe('sunrise');
    expect(tenantFromPath('/t/sunrise/pos')).toBe('sunrise');
  });

  it('returns null when the prefix is absent or incomplete', () => {
    expect(tenantFromPath('/')).toBeNull();
    expect(tenantFromPath('/t')).toBeNull();
    expect(tenantFromPath('/t/')).toBeNull();
    expect(tenantFromPath('/pos')).toBeNull();
  });

  it('returns null for a reserved slug in the path', () => {
    expect(tenantFromPath('/t/admin')).toBeNull();
  });
});

describe('resolveTenant', () => {
  it('prefers the subdomain over the path', () => {
    expect(
      resolveTenant('sunrise.pharmasaas.com', '/t/moon/pos', 'pharmasaas.com'),
    ).toEqual({ slug: 'sunrise', source: 'subdomain' });
  });

  it('falls back to the path on the root domain', () => {
    expect(
      resolveTenant('localhost:3000', '/t/moon/pos', 'localhost:3000'),
    ).toEqual({ slug: 'moon', source: 'path' });
  });

  it('returns null when neither addresses a tenant', () => {
    expect(
      resolveTenant('pharmasaas.com', '/pricing', 'pharmasaas.com'),
    ).toBeNull();
  });
});

describe('internalPath', () => {
  it('prefixes subdomain-addressed paths', () => {
    const tenant = { slug: 'sunrise', source: 'subdomain' } as const;
    expect(internalPath(tenant, '/')).toBe('/t/sunrise');
    expect(internalPath(tenant, '/pos')).toBe('/t/sunrise/pos');
  });

  it('leaves path-addressed requests unchanged', () => {
    const tenant = { slug: 'sunrise', source: 'path' } as const;
    expect(internalPath(tenant, '/t/sunrise/pos')).toBe('/t/sunrise/pos');
  });

  it('does not double-prefix an already-prefixed subdomain request', () => {
    const tenant = { slug: 'sunrise', source: 'subdomain' } as const;
    expect(internalPath(tenant, '/t/sunrise')).toBe('/t/sunrise');
    expect(internalPath(tenant, '/t/sunrise/pos')).toBe('/t/sunrise/pos');
  });

  it('still prefixes a path that merely starts with the slug', () => {
    const tenant = { slug: 'sunrise', source: 'subdomain' } as const;
    // `/t/sunrise-annex` is a different tenant, not a sub-path of `sunrise`.
    expect(internalPath(tenant, '/t/sunrise-annex')).toBe(
      '/t/sunrise/t/sunrise-annex',
    );
  });
});
