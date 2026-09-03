/**
 * In-memory sliding-window rate limiter, applied from middleware.ts.
 *
 * This has the same scaling characteristic as the original app's
 * express-rate-limit setup (also in-memory, per server instance) — so
 * behavior is preserved exactly for local/single-instance hosting. On
 * Vercel's multi-instance serverless, neither the original nor this
 * implementation enforces a truly global limit; a shared store (e.g.
 * Upstash Redis) would be needed for that, noted in the README.
 */

interface Bucket { count: number; resetAt: number }

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export function checkRateLimit(key: string, windowMs: number, max: number): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1, resetAt: now + windowMs };
  }

  existing.count += 1;
  const allowed = existing.count <= max;
  return { allowed, remaining: Math.max(0, max - existing.count), resetAt: existing.resetAt };
}

// Periodically sweep expired buckets so the Map doesn't grow unbounded on a long-lived dev server.
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, 5 * 60 * 1000).unref?.();
}
