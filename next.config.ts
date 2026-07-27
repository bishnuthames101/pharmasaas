import type { NextConfig } from 'next';

/**
 * Security headers.
 *
 * A pharmacy system holds patient records and money and is used on shared
 * counter machines, so the defaults are worth tightening.
 *
 * No Content-Security-Policy is set here on purpose: Next injects inline
 * scripts for hydration, so a useful CSP needs a per-request nonce threaded
 * through the proxy. A permissive `unsafe-inline` policy would look like
 * protection while providing none, which is worse than being explicit that it
 * is outstanding. Tracked in docs/DEPLOY.md.
 */
const securityHeaders = [
  // The app is same-origin only; framing it is never legitimate, so this also
  // closes off clickjacking against the POS.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Nothing here needs a camera beyond the prescription scanner, which uses a
  // file input rather than getUserMedia.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      {
        // Receipts, exports and anything under a tenant carry business data;
        // keep them out of shared caches entirely.
        source: '/t/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }],
      },
    ];
  },
};

export default nextConfig;
