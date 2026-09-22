import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { gunzipSync, gzipSync } from 'zlib';

/**
 * Second-level report cache shared by every server instance: Upstash Redis over its REST API (plain `fetch`, no
 * dependency). See docs/SHARED-CACHE.md.
 *
 * Financial data leaves the database for a third party here, so every value is gzip-compressed and AES-256-GCM
 * encrypted with REPORT_CACHE_KEY (32 random bytes, base64; never stored at Upstash). The cache key is bound in as
 * authenticated data, so a value copied under another key (another company's) fails to decrypt. Keys start with the
 * company id, like the in-memory cache.
 *
 * It can never hurt a request: not configured = does nothing; a 300 ms timeout, any Redis error, a bad or tampered
 * value, and a value that is too large all simply mean "not cached". After 3 failures in a row Redis is left alone for
 * a minute. Freshness needs no invalidation: the key already carries the data version (report-cache.ts).
 */

const NAMESPACE = 'fcp:report:v1:';
export const SHARED_TTL_SECONDS = 15 * 60;
const DEFAULT_TIMEOUT_MS = 300;
const MAX_SEALED_CHARS = 900_000; // Upstash's request limit is about 1 MB
const BREAKER_FAILURES = 3;
const BREAKER_OPEN_MS = 60_000;

export interface SharedCacheConfig { url: string; token: string; key: Buffer }
export interface SharedCacheDeps {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** null = not configured (or misconfigured), so the cache is simply off. */
export function sharedCacheConfig(env: NodeJS.ProcessEnv = process.env): SharedCacheConfig | null {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  const keyB64 = env.REPORT_CACHE_KEY;
  if (!url || !token || !keyB64) return null;
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    console.error('[shared-cache] REPORT_CACHE_KEY must be 32 bytes, base64-encoded; the shared cache is off.');
    return null;
  }
  return { url: url.replace(/\/+$/, ''), token, key };
}

/** gzip, then AES-256-GCM. Format `v1.<iv>.<tag>.<ciphertext>` (base64url). `aad` ties the value to its cache key. */
export function sealPayload(data: unknown, key: Buffer, aad: string): string {
  const compressed = gzipSync(Buffer.from(JSON.stringify(data), 'utf8'));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

/** null for anything that is not a value sealed with this key for this cache key (wrong key, altered, moved, garbage). */
export function openPayload<T>(sealed: string, key: Buffer, aad: string): T | null {
  try {
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const [iv, tag, ciphertext] = parts.slice(1).map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer];
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(gunzipSync(compressed).toString('utf8')) as T;
  } catch {
    return null;
  }
}

let failures = 0;
let openUntil = 0;
/** For tests. */
export function resetSharedCacheBreaker(): void { failures = 0; openUntil = 0; }

async function command(cfg: SharedCacheConfig, args: Array<string | number>, deps: SharedCacheDeps): Promise<unknown> {
  const doFetch = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(cfg.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Redis answered HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: string };
    if (body.error) throw new Error('Redis reported an error');
    return body.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

function active(deps: SharedCacheDeps): SharedCacheConfig | null {
  if (process.env.NODE_ENV === 'development') return null; // dev always computes fresh, like the in-memory cache
  const cfg = sharedCacheConfig(deps.env);
  if (!cfg) return null;
  if ((deps.now ?? Date.now)() < openUntil) return null;
  return cfg;
}

function recordFailure(err: unknown, deps: SharedCacheDeps): void {
  failures++;
  if (failures >= BREAKER_FAILURES) {
    openUntil = (deps.now ?? Date.now)() + BREAKER_OPEN_MS;
    failures = 0;
    console.error(`[shared-cache] Redis failed ${BREAKER_FAILURES} times in a row (${(err as Error).message}); skipping it for a minute.`);
  }
}

export async function getSharedCached<T>(cacheKey: string, deps: SharedCacheDeps = {}): Promise<T | null> {
  const cfg = active(deps);
  if (!cfg) return null;
  const redisKey = NAMESPACE + cacheKey;
  let result: unknown;
  try {
    result = await command(cfg, ['GET', redisKey], deps);
    failures = 0;
  } catch (err) {
    recordFailure(err, deps);
    return null;
  }
  if (typeof result !== 'string') return null;
  return openPayload<T>(result, cfg.key, redisKey);
}

export async function setSharedCached(cacheKey: string, data: unknown, deps: SharedCacheDeps = {}): Promise<boolean> {
  const cfg = active(deps);
  if (!cfg) return false;
  const redisKey = NAMESPACE + cacheKey;
  let sealed: string;
  try {
    sealed = sealPayload(data, cfg.key, redisKey);
  } catch (err) {
    console.error('[shared-cache] value not cached:', (err as Error).message); // not Redis's fault: the breaker is not touched
    return false;
  }
  if (sealed.length > MAX_SEALED_CHARS) return false; // too big for Redis's request limit: not cached, not an error
  try {
    await command(cfg, ['SET', redisKey, sealed, 'EX', SHARED_TTL_SECONDS], deps);
    failures = 0;
    return true;
  } catch (err) {
    recordFailure(err, deps);
    return false;
  }
}
