/**
 * In-memory Server Cache for computed Report Bundles.
 * Serves report data instantly (< 5ms) for repeated queries, tab switches,
 * and user dashboard re-loads until a new Trial Balance is uploaded.
 *
 * The cache is per server instance, so invalidateReportCache() only clears
 * the instance that handled the write. Every key therefore also carries a
 * data version (see buildReportCacheKey / loadReportDataVersion): when the
 * underlying data changes anywhere, the key changes everywhere, and a stale
 * bundle can no longer be served for up to 15 minutes by another instance.
 */
import { createHash } from 'crypto';
import type { PeriodParams } from '@/lib/financial/tb-engine';
import { getSharedCached } from './shared-cache';

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes TTL

/** Everything a report bundle is computed from, besides the request itself. */
export interface ReportDataVersion {
  /** Current batch ids + data_changed_at for every year of the company (CY views and comparatives read other years). */
  batches: string | null;
  /** Year ids, dates, labels and lock flags — adding a year changes CY merges and comparatives. */
  years: string | null;
  /** companies.updated_at — source/presentation currency. */
  company: string | null;
  /** Custom metric definitions: latest updated_at + count (a delete lowers the count). */
  metrics: string | null;
  /** Latest Zoho contact sync — contact details are joined into vendor/customer tables. */
  contacts: string | null;
}

export function hashReportDataVersion(v: ReportDataVersion): string {
  return createHash('sha256')
    .update(JSON.stringify([v.batches, v.years, v.company, v.metrics, v.contacts]))
    .digest('hex')
    .slice(0, 16);
}

/** `${companyId}:` stays the prefix, so invalidateReportCache(companyId) still clears every version. */
export function buildReportCacheKey(companyId: string, fyId: string, params: PeriodParams, dataVersion: string): string {
  return `${companyId}:${fyId}:${params.periodType || 'annual'}:${params.period || 'all'}:${params.yearType || 'FY'}:${dataVersion}`;
}

/** Same idea for /reports/threeyear. The response order never depends on the input order (always start_date), so the ids are sorted for the key: two requests naming the same years differently ordered share one cache entry. */
export function buildThreeYearCacheKey(companyId: string, fyIds: string[], yearType: string, dataVersion: string): string {
  return `${companyId}:three:${[...fyIds].sort().join(',')}:${yearType}:${dataVersion}`;
}

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
  // Keys for an old data version are never looked up again, so expired
  // entries are swept here rather than only on a lookup of the same key.
  const now = Date.now();
  for (const [k, entry] of cache) {
    if (now > entry.expiresAt) cache.delete(k);
  }
  cache.set(key, { data, expiresAt: now + ttlMs });
}

/**
 * Two levels for report bundles: this instance's memory, then the shared Redis cache (shared-cache.ts, off unless
 * configured), so a second or freshly started server instance is served without recomputing. The key carries the
 * data version, so neither level can serve a bundle older than the data; invalidateReportCache() clears memory only.
 */
export async function getCachedReportShared<T>(key: string): Promise<T | null> {
  const local = getCachedReport<T>(key);
  if (local) return local;
  const shared = await getSharedCached<T>(key);
  if (shared) setCachedReport(key, shared); // keep it in this instance's memory as well
  return shared;
}

/**
 * The database reads a report bundle is computed from (ledgers, customers,
 * contacts, …), kept under the same data version as the bundles so that
 * switching the PERIOD view of a year (Annual → Q1 → H2 …) doesn't read the
 * same rows from the database again — none of them depend on the period.
 * Same version, same TTL, same invalidation as the bundle cache above.
 *
 * A private copy is stored and a fresh copy handed out on every read, so
 * nothing that computes from the inputs can ever alter what the next request
 * sees. At most MAX_INPUT_ENTRIES are kept (oldest dropped first) to bound
 * memory: one entry is roughly 1–2 MB for a year of ~250 ledgers.
 */
const inputs = new Map<string, CacheEntry>();
const MAX_INPUT_ENTRIES = 12;

export function buildReportInputsKey(companyId: string, fyId: string, isCY: boolean, dataVersion: string): string {
  return `${companyId}:inputs:${fyId}:${isCY ? 'CY' : 'FY'}:${dataVersion}`;
}

export function getCachedReportInputs<T>(key: string): T | null {
  if (process.env.NODE_ENV === 'development') return null; // dev always reads fresh, like the bundle cache
  const entry = inputs.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    inputs.delete(key);
    return null;
  }
  return structuredClone(entry.data) as T;
}

export function setCachedReportInputs(key: string, data: unknown, ttlMs = DEFAULT_TTL_MS): void {
  if (process.env.NODE_ENV === 'development') return;
  try {
    const copy = structuredClone(data);
    const now = Date.now();
    for (const [k, entry] of inputs) {
      if (now > entry.expiresAt) inputs.delete(k);
    }
    inputs.delete(key); // re-insert last, so eviction below drops the oldest
    inputs.set(key, { data: copy, expiresAt: now + ttlMs });
    while (inputs.size > MAX_INPUT_ENTRIES) inputs.delete(inputs.keys().next().value as string);
  } catch (err) {
    // A cache that can't store must never break the request that filled it.
    console.error('[report-cache] inputs not cached:', (err as Error).message);
  }
}

export function invalidateReportCache(companyId?: string): void {
  if (!companyId) {
    cache.clear();
    inputs.clear();
    return;
  }
  const prefix = `${companyId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
  for (const key of inputs.keys()) {
    if (key.startsWith(prefix)) {
      inputs.delete(key);
    }
  }
}
