import 'server-only';

/**
 * In-process rate limiter for the auth surface.
 *
 * Deliberately modest in what it claims: the counters live in one server
 * instance's memory, so on a multi-instance deployment the effective limit is
 * per instance rather than global. That is enough to blunt credential stuffing
 * and signup spam from a single source, and it costs no extra infrastructure.
 *
 * If the platform ever needs a real guarantee — a hard cap across the fleet —
 * this wants Upstash or Supabase-side throttling instead. Noted in
 * docs/DEPLOY.md rather than left as an implied promise.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Drop expired buckets so the map cannot grow without bound. */
function sweep(now: number) {
  if (buckets.size < 5_000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  existing.count += 1;

  if (existing.count > limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000),
    };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Client address from proxy headers.
 *
 * Only the first entry of `x-forwarded-for` is used, and only because Vercel
 * rewrites that header at the edge. Behind a proxy that does not, this is
 * spoofable — which is another reason the limiter above is described as a
 * speed bump rather than a control.
 */
export function clientKey(headers: Headers, scope: string): string {
  const forwarded = headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || 'unknown';
  return `${scope}:${ip}`;
}
