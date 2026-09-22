import { randomBytes } from 'crypto';
import {
  getSharedCached, setSharedCached, sealPayload, openPayload, sharedCacheConfig, resetSharedCacheBreaker, SHARED_TTL_SECONDS,
  type SharedCacheDeps,
} from '@/lib/cache/shared-cache';
import { buildReportCacheKey, getCachedReportShared, setCachedReport, invalidateReportCache } from '@/lib/cache/report-cache';

const KEY = randomBytes(32).toString('base64');
const ENV = { UPSTASH_REDIS_REST_URL: 'https://example.upstash.io/', UPSTASH_REDIS_REST_TOKEN: 'tok', REPORT_CACHE_KEY: KEY } as unknown as NodeJS.ProcessEnv;
const cacheKey = (company: string, version = 'v1') => buildReportCacheKey(company, 'fy1', { periodType: 'annual', yearType: 'FY' } as never, version);

/** A stand-in for Upstash's REST API: POST a JSON command array, get { result }. */
function fakeRedis() {
  const store = new Map<string, string>();
  const calls: Array<Array<string | number>> = [];
  const impl = (async (_url: string, init: { body: string }) => {
    const args = JSON.parse(init.body) as Array<string | number>;
    calls.push(args);
    if (args[0] === 'GET') return { ok: true, status: 200, json: async () => ({ result: store.get(String(args[1])) ?? null }) };
    if (args[0] === 'SET') { store.set(String(args[1]), String(args[2])); return { ok: true, status: 200, json: async () => ({ result: 'OK' }) }; }
    return { ok: false, status: 400, json: async () => ({ error: 'unknown' }) };
  }) as unknown as typeof fetch;
  return { store, calls, impl, deps: { fetch: impl, env: ENV } as SharedCacheDeps };
}

beforeEach(() => resetSharedCacheBreaker());

describe('configuration', () => {
  test('not configured = off: nothing is called, nothing is stored', async () => {
    const r = fakeRedis();
    const deps = { fetch: r.impl, env: {} as NodeJS.ProcessEnv };
    expect(await getSharedCached('c1:x', deps)).toBeNull();
    expect(await setSharedCached('c1:x', { a: 1 }, deps)).toBe(false);
    expect(r.calls).toHaveLength(0);
  });

  test('all three settings are needed; the Vercel/Upstash integration names are accepted; a bad key size is refused', () => {
    expect(sharedCacheConfig({ UPSTASH_REDIS_REST_URL: 'u', UPSTASH_REDIS_REST_TOKEN: 't' } as never)).toBeNull();
    expect(sharedCacheConfig({ KV_REST_API_URL: 'https://a.io///', KV_REST_API_TOKEN: 't', REPORT_CACHE_KEY: KEY } as never)?.url).toBe('https://a.io');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(sharedCacheConfig({ UPSTASH_REDIS_REST_URL: 'u', UPSTASH_REDIS_REST_TOKEN: 't', REPORT_CACHE_KEY: Buffer.from('short').toString('base64') } as never)).toBeNull();
    spy.mockRestore();
  });

  test('development always computes fresh, like the in-memory cache', async () => {
    const env = process.env as Record<string, string | undefined>;
    const was = env.NODE_ENV;
    env.NODE_ENV = 'development';
    try {
      const r = fakeRedis();
      expect(await setSharedCached('c1:x', { a: 1 }, r.deps)).toBe(false);
      expect(await getSharedCached('c1:x', r.deps)).toBeNull();
      expect(r.calls).toHaveLength(0);
    } finally { env.NODE_ENV = was; }
  });
});

describe('what is stored at the third party', () => {
  const payload = { customers: Array.from({ length: 3000 }, (_, i) => ({ name: `SECRET-CUSTOMER-${i % 20}`, amount: 1000 + i, note: 'repeated text '.repeat(5) })) };

  test('a value comes back identical, under a key that starts with the company and lives 15 minutes', async () => {
    const r = fakeRedis();
    const key = cacheKey('company-a');
    expect(await setSharedCached(key, payload, r.deps)).toBe(true);
    expect(r.calls[0]![0]).toBe('SET');
    expect(String(r.calls[0]![1]).startsWith('fcp:report:v1:company-a:')).toBe(true);
    expect(r.calls[0]!.slice(3)).toEqual(['EX', SHARED_TTL_SECONDS]);
    expect(SHARED_TTL_SECONDS).toBe(900);
    expect(await getSharedCached<typeof payload>(key, r.deps)).toEqual(payload);
  });

  test('nothing readable is sent: no name, no amount, and it is compressed', async () => {
    const r = fakeRedis();
    await setSharedCached(cacheKey('company-a'), payload, r.deps);
    const sealed = String(r.calls[0]![2]);
    const plain = JSON.stringify(payload);
    expect(sealed).not.toContain('SECRET-CUSTOMER');
    expect(Buffer.from(sealed, 'base64url').toString('latin1')).not.toContain('SECRET-CUSTOMER');
    expect(sealed.length).toBeLessThan(plain.length / 3);
    expect(sealed.startsWith('v1.')).toBe(true);
  });

  test('the same value sealed twice differs (a fresh nonce each time)', () => {
    const key = Buffer.from(KEY, 'base64');
    expect(sealPayload({ a: 1 }, key, 'k')).not.toBe(sealPayload({ a: 1 }, key, 'k'));
  });

  test('a wrong key, a changed value, or garbage is a miss, never an error or wrong data', () => {
    const key = Buffer.from(KEY, 'base64');
    const sealed = sealPayload({ ok: true }, key, 'k1');
    expect(openPayload(sealed, key, 'k1')).toEqual({ ok: true });
    expect(openPayload(sealed, randomBytes(32), 'k1')).toBeNull(); // key rotated
    const parts = sealed.split('.');
    const flipped = [...parts.slice(0, 3), (parts[3]![0] === 'A' ? 'B' : 'A') + parts[3]!.slice(1)].join('.');
    expect(openPayload(flipped, key, 'k1')).toBeNull();
    for (const junk of ['', 'x', 'v1.a.b', 'v1.a.b.c.d', 'v2.a.b.c', '{"json":true}']) expect(openPayload(junk, key, 'k1')).toBeNull();
  });

  test("one company's value cannot be served as another's, even if it is copied to their key", async () => {
    const r = fakeRedis();
    const a = cacheKey('company-a'); const b = cacheKey('company-b');
    await setSharedCached(a, payload, r.deps);
    const redisKeyA = [...r.store.keys()][0]!;
    r.store.set(redisKeyA.replace('company-a', 'company-b'), r.store.get(redisKeyA)!); // an attacker/bug moves the value
    expect(await getSharedCached(b, r.deps)).toBeNull();
    expect(await getSharedCached(a, r.deps)).toEqual(payload);
  });

  test('a new data version is a different key, so an old bundle can never be served for new data', async () => {
    const r = fakeRedis();
    await setSharedCached(cacheKey('company-a', 'version1'), { total: 100 }, r.deps);
    expect(await getSharedCached(cacheKey('company-a', 'version1'), r.deps)).toEqual({ total: 100 });
    expect(await getSharedCached(cacheKey('company-a', 'version2'), r.deps)).toBeNull();
  });

  test('a value too big for the Redis request limit is skipped without an error', async () => {
    const r = fakeRedis();
    expect(await setSharedCached(cacheKey('company-a'), { blob: randomBytes(800_000).toString('hex') }, r.deps)).toBe(false);
    expect(r.calls).toHaveLength(0);
  });

  test('a value that cannot be serialised is not cached and does not count against Redis', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = fakeRedis();
    const circular: Record<string, unknown> = {}; circular.self = circular;
    for (let i = 0; i < 5; i++) expect(await setSharedCached(cacheKey('company-a'), circular, r.deps)).toBe(false);
    expect(await setSharedCached(cacheKey('company-a'), { fine: 1 }, r.deps)).toBe(true); // breaker untouched
    spy.mockRestore();
  });
});

describe('it can never hurt a request', () => {
  const failing = (mode: 'reject' | 'http500' | 'redis-error' | 'hang'): SharedCacheDeps & { count: () => number } => {
    let n = 0;
    const impl = (async (_u: string, init: { signal: AbortSignal }) => {
      n++;
      if (mode === 'reject') throw new Error('network down');
      if (mode === 'http500') return { ok: false, status: 500, json: async () => ({}) };
      if (mode === 'redis-error') return { ok: true, status: 200, json: async () => ({ error: 'WRONGPASS' }) };
      return new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    }) as unknown as typeof fetch;
    return { fetch: impl, env: ENV, timeoutMs: 20, count: () => n };
  };

  test.each(['reject', 'http500', 'redis-error', 'hang'] as const)('%s: reading and writing return "not cached", never throw', async (mode) => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const d = failing(mode);
    expect(await getSharedCached(cacheKey('c'), d)).toBeNull();
    expect(await setSharedCached(cacheKey('c'), { a: 1 }, d)).toBe(false);
    spy.mockRestore();
  });

  test('a hanging Redis is given up on after the timeout', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const d = failing('hang'); const t = Date.now();
    await getSharedCached(cacheKey('c'), d);
    expect(Date.now() - t).toBeLessThan(500);
    spy.mockRestore();
  });

  test('after 3 failures in a row Redis is left alone for a minute, then tried again', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let clock = 1_000_000;
    const d = { ...failing('reject'), now: () => clock };
    for (let i = 0; i < 3; i++) await getSharedCached(cacheKey('c'), d);
    expect(d.count()).toBe(3);
    await getSharedCached(cacheKey('c'), d); await setSharedCached(cacheKey('c'), { a: 1 }, d);
    expect(d.count()).toBe(3); // breaker open: no calls
    clock += 61_000;
    await getSharedCached(cacheKey('c'), d);
    expect(d.count()).toBe(4);
    spy.mockRestore();
  });

  test('a success resets the count, so scattered failures never open the breaker', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const bad = failing('reject'); const good = fakeRedis();
    for (let i = 0; i < 5; i++) { await getSharedCached(cacheKey('c'), bad); await getSharedCached(cacheKey('c'), bad); await getSharedCached(cacheKey('c'), good.deps); }
    expect(bad.count()).toBe(10);
    spy.mockRestore();
  });
});

describe('the two-level lookup', () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { ...env };
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'REPORT_CACHE_KEY']) { if (saved[k] === undefined) delete env[k]; else env[k] = saved[k]; } jest.restoreAllMocks(); invalidateReportCache(); });

  test("a second instance (empty memory) is served from Redis, keeps it in memory, and Redis is not asked again", async () => {
    Object.assign(env, ENV);
    const r = fakeRedis();
    global.fetch = r.impl;
    const key = cacheKey('company-a');
    await setSharedCached(key, { total: 42 }); // instance A computed and stored it
    invalidateReportCache();                     // instance B starts with an empty memory
    r.calls.length = 0;
    expect(await getCachedReportShared(key)).toEqual({ total: 42 });
    expect(r.calls.map((c) => c[0])).toEqual(['GET']);
    expect(await getCachedReportShared(key)).toEqual({ total: 42 });
    expect(r.calls).toHaveLength(1); // now from memory
  });

  test('memory answers first: Redis is not touched when this instance already has it', async () => {
    Object.assign(env, ENV);
    const r = fakeRedis(); global.fetch = r.impl;
    const key = cacheKey('company-a');
    setCachedReport(key, { local: true });
    expect(await getCachedReportShared(key)).toEqual({ local: true });
    expect(r.calls).toHaveLength(0);
  });

  test('invalidateReportCache clears memory only; the shared value stays but is unreachable once the data version changes', async () => {
    Object.assign(env, ENV);
    const r = fakeRedis(); global.fetch = r.impl;
    await setSharedCached(cacheKey('company-a', 'old'), { v: 'old' });
    invalidateReportCache('company-a');
    expect(r.store.size).toBe(1);
    expect(await getCachedReportShared(cacheKey('company-a', 'new'))).toBeNull();
  });

  test('with nothing configured it behaves exactly like the memory-only cache', async () => {
    for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'REPORT_CACHE_KEY', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) delete env[k];
    const spy = jest.fn(); global.fetch = spy as never;
    expect(await getCachedReportShared(cacheKey('company-a'))).toBeNull();
    setCachedReport(cacheKey('company-a'), { m: 1 });
    expect(await getCachedReportShared(cacheKey('company-a'))).toEqual({ m: 1 });
    expect(spy).not.toHaveBeenCalled();
  });
});
