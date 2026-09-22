# SHARED-CACHE.md — one report cache shared by every server instance

> Added 2026-09-22 (plan phase C; `lib/cache/shared-cache.ts`). Until now each report bundle was cached only in the
> memory of the server instance that computed it (`lib/cache/report-cache.ts`), so a second, cold, or freshly started
> instance always recomputed. This adds a **second, shared level**: Upstash Redis, over its REST API.

## What it does

- **Two levels.** `getCachedReportShared()` checks this instance's memory first, then Redis; a Redis hit is also kept
  in memory. `setCachedReport()` still writes memory before the response is sent (unchanged); the Redis write runs
  **after** the response (`lib/cache/after-response.ts`, Next's `after()`), so it never adds latency to a request.
- **Not configured = exactly today's behaviour.** `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` and
  `REPORT_CACHE_KEY` must all be set, or the shared cache does nothing — the code can be deployed before Redis exists.
- **Freshness needs no invalidation.** The cache key already carries the data version (`hashReportDataVersion`), so
  the moment the underlying data changes, every instance's key changes with it and a stale bundle can never be served
  — the same guarantee the in-memory cache already had. `invalidateReportCache()` clears memory only; a shared entry
  for an old version simply becomes unreachable and expires with its TTL (15 minutes, same as memory).
- **Encrypted before it leaves the database.** Financial data goes to a third party here, so every value is
  gzip-compressed then AES-256-GCM encrypted with `REPORT_CACHE_KEY` (32 random bytes, base64, never sent to Upstash),
  with the Redis key itself as authenticated data — a value that somehow ended up under the wrong key fails to
  decrypt rather than being served to the wrong company. Format `v1.<iv>.<tag>.<ciphertext>`.
- **Can never hurt a request.** A 300 ms timeout, any HTTP/network error, a value that fails to decrypt (wrong or
  rotated key, tampered, from an old code version) — all simply mean "not cached", never an error or wrong data. A
  value too large for Upstash's ~1 MB request limit is skipped, not truncated. After 3 failures in a row, Redis is
  left alone for a minute (a circuit breaker) instead of adding a timeout to every request while it's down.
- **Routes:** `/reports/all` and `/reports/threeyear`. `threeyear` had no cache at all before this (not even
  in-memory) — the light metadata queries (years, currency, audit summary, the data version) run first, in one wave
  as before, and are what the cache key is built from; only a **miss** goes on to the expensive per-year ledger loads
  and statement computes. A `nocache`/`refresh` query param skips the read on both routes, exactly like `/reports/all`
  already did.

## What is stored

`fcp:report:v1:<company>:...:<data version>` → the sealed bundle. Never a name, an amount, or anything else readable
— checked in `tests/unit/shared-cache.test.ts` (a 3,000-row synthetic bundle's encrypted form contains none of its
source text and is under a third of its plain JSON size). Keys are namespaced and start with the company id, matching
the in-memory cache's key shape, so nothing needs a migration or a new lookup pattern.

## Proof (branch, 2026-09-22)

- **Unit** (fake Upstash REST server): a value round-trips unchanged; nothing readable is sent; a wrong key, an
  altered value, or garbage is a miss, never wrong data or a throw; one company's value cannot be read under
  another's key even if copied there; a too-large value is skipped; Redis down/erroring/hanging all fail open within
  the timeout; 3 failures open the breaker for a minute, a success resets the count; a fresh instance is served from
  Redis and keeps it in memory; not configured behaves exactly like memory-only.
- **End-to-end on the Neon test branch**, real report route, a fake Upstash server, separate Node processes standing
  in for separate server instances: cold compute-then-store, a fresh instance served from Redis (2 database
  statements vs. 12 — the ledger loads and computes were skipped), Redis down (fails open, computes), the encryption
  key rotated (old entry unreadable, recomputes and re-stores under the new key rather than erroring), a real data
  change on the branch (new version, old bundle unusable, recomputes) and reverting it (old version again). **All 7
  responses byte-identical** after `generated_at` is excluded (the same field the in-memory cache already lets go
  stale on a hit — pre-existing, not new here). Nothing readable at the fake third party; sealed size a fraction of
  the plain JSON.
- **Report parity**: the branch's full 287-response route-parity harness (`docs/ROW-LEVEL-SECURITY.md`'s tool),
  owner login, before vs. after this change: **0 of 287 report/route responses changed.** (Two unrelated routes —
  `companies/me` and `zoho/modules/status` — differ only because of state my own testing left on the disposable test
  branch: `companies.updated_at` has an auto-touch trigger that stamps `NOW()` on any `UPDATE`, so an earlier
  diagnostic's restore could not put it back exactly, and a later live Zoho re-read moved `zoho_module_state`
  forward. Neither route reads the shared cache; this is branch drift, not a change in behaviour.)

## Owner steps to turn it on

1. Create a Redis database at [Upstash](https://upstash.com) (region: next to where the functions run — `iad1` on
   Vercel is US East / N. Virginia). The Vercel Upstash integration, if used, sets `KV_REST_API_URL` /
   `KV_REST_API_TOKEN`, which are read under those exact names too — no renaming needed.
2. Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
3. In Vercel → Settings → Environment Variables, add the REST URL, REST token and `REPORT_CACHE_KEY`, then redeploy.
4. **Off again:** delete `REPORT_CACHE_KEY` (or either REST variable) and redeploy — the app is back to memory-only,
   instantly, nothing else to undo.

## What it does not do

No new npm dependency (`fetch` to Upstash's REST API). No migration — Redis holds no data of record, only a cache
of data that already lives in Postgres; losing it changes nothing but speed. Rotating `REPORT_CACHE_KEY` never
serves wrong data (see "can never hurt a request" above) — it only costs one recompute per report.
