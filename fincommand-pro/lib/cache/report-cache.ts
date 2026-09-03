/**
 * In-memory Server Cache for computed Report Bundles.
 * Serves report data instantly (< 5ms) for repeated queries, tab switches,
 * and user dashboard re-loads until a new Trial Balance is uploaded.
 */

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes TTL

export function getCachedReport<T>(key: string): T | null {
  if (process.env.NODE_ENV === 'development') {
    return null; // In development mode, always compute fresh report data directly from Neon DB
  }
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

export function setCachedReport(key: string, data: unknown, ttlMs = DEFAULT_TTL_MS): void {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

export function invalidateReportCache(companyId?: string): void {
  if (!companyId) {
    cache.clear();
    return;
  }
  const prefix = `${companyId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}
