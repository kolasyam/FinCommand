# LATENCY.md — Where report-load time goes, and what was changed (2026-09-20)

> [!NOTE]
> Measured, not guessed. Everything below was timed against the production database (read-only) from a developer machine in India, with Neon in `us-east-1`. Report numbers are unchanged: all 84 responses of the real `/reports/all` handler (6 company-years × 14 period views) hash identically before and after.
>
> **What this does not tell you:** how fast the *deployed* app is. The Vercel project's function region isn't visible from the repo (`vercel.json` sets none). See §5.

## 1. The finding: it's round trips, not compute

| Measured | Result |
|---|---|
| A query, as Neon executes it | **< 1 ms** (data-version query 0.17 ms, ledger loader 0.4 ms, audit count 0.1 ms) |
| Engine CPU: every statement, this year + prior year | **33–44 ms** (`withPeriodSurplus`: 1.3–1.6 ms) |
| One round trip to Neon from India | **≈ 247 ms** |
| Opening a new connection (TCP + TLS + login) | **≈ 1.3–2 s** |
| Raw ledger rows of one year, as JSON | 197–228 kB, ~1 kB per row (43 columns) |

So a request's latency is about **(sequential round trips) × 247 ms**, plus the time to pull hundreds of kB over that link, plus any connections that have to be opened first. The earlier guess in `QA-AUDIT-LATENCY-FIX.md` §1.3 ("Neon network round-trip time across ~8 sequential-ish waves") was right, and is now measured.

Round trips per `/reports/all` request, before:

| Path | Sequential steps | Count |
|---|---|---|
| Cache **hit** | user lookup → data-version check | 2 |
| Cache **miss** (FY view) | user → version → year+ledgers+customers+vendors → previous year → its ledgers → company/audit/contacts/metrics | 6 |
| Cache miss (CY view) | user → version → wave 1 → neighbour years → their data → wave 2 | 6 |

The browser adds its own chain on page load (live mode): `/auth/me` → `/fy` → `/reports/all`, three sequential HTTP round trips, before FX or the tab widgets.

## 2. What changed

1. **The user lookup and the data-version check run together** (`app/api/v1/reports/all/route.ts`).
   - `claimedCompanyId()` (`lib/auth/permissions.ts`) reads the company from the request's *signed* token, with no database access, so the version query can start at once.
   - `authenticate()` still decides whether the request is allowed. The early result is used only if `authenticate()` returns the same company; otherwise it is asked again. Nothing is ever returned on the strength of the token claim.
   - Cache hit: **2 → 1 round trips**.
2. **One wave of reads instead of three or four.** Everything that doesn't depend on another read now goes out together: the year, its ledgers, customers, vendors, cost, the company facts, contacts, custom-metric definitions, and the previous/next year and the previous year's ledgers, found from the year's id in SQL (`loadPreviousFYOf`, `loadNextFYOf`, `loadPreviousStatementLedgers` in `lib/db/queries/reports.ts`).
   - The company currency, audit-trail summary and batch currency (three queries) became one (`loadReportContext`).
   - Cache miss: **6 → 2 round trips** (FY view), **6 → 3** (CY view; the neighbour year's data still needs its id first).
   - The calendar-year merge logic itself is untouched.
3. **Idle connections are kept for 5 minutes, not 30 s** (`lib/db/neon.ts`, `DB_IDLE_TIMEOUT_MS`), with TCP keep-alive. A page load asks for ~10 connections at once. With the old timeout, the first load after a 35 s pause opened all the ones the pool had dropped.
4. **The browser asks `/auth/me` and `/fy` together** (`lib/dashboard/DashboardContext.tsx`), saving one browser round trip on every page load. Safe with expiring tokens: refresh doesn't rotate the refresh token, so two refreshes racing both succeed.

## 3. Results

**Whole route, real handler, 84 views, cache on (`NODE_ENV=production`), same machine and database:**

| | Before | After |
|---|---|---|
| Cache **hit**, median | ≈ 540 ms | **≈ 260 ms** |
| Cache **miss**, all views, median | 1,540 ms | **770 ms** |
| Miss, Acme (small ledgers), FY views | 1,275–1,560 ms | **≈ 520 ms** |
| Miss, Acme, CY views | ≈ 1,530 ms | **≈ 770 ms** |
| Miss, Real Variable (200–230 ledgers/year), FY views | 1,890–2,070 ms | **1,280–1,440 ms** |
| Miss, Real Variable, CY views | 2,350–2,360 ms | **860–1,570 ms** |
| **Content of the 84 responses** | | **0 differ** |

- The heavier company gains less because its queries are limited by *volume*: two years of ledger rows are 400+ kB, and pulling that over a 247 ms link takes several round trips of TCP window growth.
- The first request on a brand-new pool is slower than before (5.5 s vs 3.4 s in the worst case), because the wave opens up to 10 connections instead of 5. That is a one-off per process; item 3 above keeps it from recurring after short pauses.

**First page load after a pause (8–10 queries at once, the app's real pool settings):**

| Idle timeout | After a 35 s pause |
|---|---|
| 30 s (before) | **3,358 ms** |
| 300 s (now) | **335 ms** |
| 300 s + keep-alive, the app's real pool, after a **130 s** pause | **800 ms**, 0 pool errors |

The 130 s result is not quite the warm 250 ms: a few of the idle connections had evidently been closed by the network or Neon's pooler by then, and were replaced. Still a large saving over reopening all of them.

> [!IMPORTANT]
> `getCachedReport()` returns nothing when `NODE_ENV=development`, and the local `.env` sets `NODE_ENV=development`. So `npm run dev` (and any script that loads `.env`) **never uses the report cache** and pays the full miss cost on every request. That is deliberate (see `report-cache.ts`), but it makes a dev server feel 2–5× slower than a production build. Measure latency with `npm run build && npm start`.

**Browser startup (live, Acme CFO, dev server on the Neon test branch, warm routes):** `/auth/me` and `/fy` now start 1 ms apart (they took 701 ms and 1,066 ms, so the old chain would have cost about their sum, ~1.8 s; now ~1.1 s). The dashboard loads with its years and figures, with no console errors or warnings and no `undefined`/`NaN` in the rendered text. `/reports/all` still starts after `/fy` (§5.7).

**Verification:** `npx tsc --noEmit` 0 errors · `npx jest --runInBand` 22 suites / 473 tests (added `auth-claims`) · 84/84 route responses identical before/after · pool test after a 130 s pause with 0 errors.

## 4. How to re-measure

Throwaway scripts (repo convention `_diag_*.ts`, deleted after use; copies in the session scratchpad):
- Route timing and content hashes: call the real `GET` handler in-process for every company × year × 14 views, with a token minted by `signAccessToken()`; run with `NODE_ENV=production` so the cache is on; compare two runs' hashes.
- Round-trip baseline: `SELECT 1` × 15 on a warm pool. Anything above ~5 ms means the app and database are far apart.
- Plans: `EXPLAIN (ANALYZE, BUFFERS)` inside `BEGIN READ ONLY … ROLLBACK`.

## 5. Not changed — decisions and unknowns for the owner

1. **Where the app runs versus where Neon is.** This is the biggest lever and can't be decided from the repo.
   - Neon is in `us-east-1`. `vercel.json` sets no `regions`, so unless the Vercel dashboard says otherwise, functions run in Vercel's default region (`iad1`, Washington D.C.), which is next to `us-east-1`. If so, each round trip in production is a few ms, and the changes above matter mainly for cold starts and for local work.
   - If the Vercel project was set to another region, or the app is run locally, every round trip is what was measured here (~247 ms from India).
   - Users in India → US servers still pay the browser↔server round trip (~250–300 ms) on each of the sequential calls a page load makes.
   - A Neon project's region can't be changed in place; moving means a new project and a migration. Not done, and not recommended without knowing where the users and the deployment are.
2. **Neon scale-to-zero.** Phase 0 removed the 3-minute keep-alive ping so Neon can suspend when idle (a cost decision). The first request after a suspension waits for the database to wake (the pool allows up to 30 s). Bringing the ping back trades compute cost for that first-request latency.
3. **A short in-memory cache of the user lookup** would remove one round trip from *every* API call (each route starts with `authenticate()`). The cost is that a deactivated user or changed role would still work for the cache's lifetime (say 30 s). A security trade-off; not done.
4. **Caching the loaded ledgers per data version.** Toggling Annual → Q1 → Q2 is a report-cache miss each time (different period), and each one re-reads the same 200 kB of ledgers. Keyed by the same data version that already guards the report cache, those rows could be served from memory. Not done: it adds a second cache to keep correct, and it only helps where the database is far away.
5. **`SELECT l.*` returns 43 columns**; the engine uses about 34. Trimming would save perhaps a quarter of the bytes. Not done: modest gain, and several other consumers read the same rows.
6. **Other routes** each start with their own `authenticate()` and some make sequential queries. Only `/reports/all`, the dominant call, was reworked.
7. **Browser-side:** report loading still waits for `/fy` to learn the current year. Starting `/reports/all` with the stored year id in parallel would save another round trip, at the cost of restructuring the loading effect.
