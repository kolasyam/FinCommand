# LATENCY.md — Where report-load time goes, and what was changed (2026-09-20)

> [!NOTE]
> Measured, not guessed. Everything below was timed against the production database (read-only) from a developer machine in India, with Neon in `us-east-1`. Report numbers are unchanged: all 84 responses of the real `/reports/all` handler (6 company-years × 14 period views) hash identically before and after.
>
> **What this does not tell you:** how fast the *deployed* app is — that was never measured. The function region is now pinned in `vercel.json` (§5.3), but the Vercel plan and the deployed timings are not visible from here.

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
5. **Switching the period view no longer re-reads the database** (`lib/cache/report-cache.ts`, `loadReportInputs()` in `app/api/v1/reports/all/route.ts`). Annual → Q1 → H2 is a report-cache miss every time (the key includes the period), yet none of what it reads depends on the period. The reads (ledgers, customers, vendors, contacts, metric definitions, neighbouring years, company facts) are now kept per **data version** — the same version, TTL (15 min) and invalidation that already guard the report cache — so the second and later period views of a year cost the user + version check plus about 40 ms of compute.
   - **Never shared by reference.** A private copy is stored and a fresh clone handed out on every read, so nothing that computes from the inputs can alter what the next request sees.
   - **Bounded:** at most 12 entries (roughly 1–2 MB each), oldest dropped first. Off in development, like the bundle cache. A failure to store is logged and never breaks the request. `refresh=true` / `nocache=true` read the database and re-store.
   - **Not cached when the custom-metric definitions failed to load**, so a transient error can't be remembered as "no metrics".
   - **The contract** (same as the bundle cache): a change is picked up when the data version changes. Every application write path does that — ingestion creates a new batch, reclassify bumps `data_changed_at` and clears the company's caches. The exceptions are hand-run SQL and `db/init.ts`'s `note_no` updates, which change ledger rows without a version bump and would not show until the entry expires (15 min) or someone refreshes.
6. **The 3-Year view (`/reports/threeyear`) reads everything in one wave.** It was strictly sequential: user → years → company → audit → then each year's ledgers one after another (about 7 round trips, and it has no cache). Now, after the user lookup, the years, company, audit summary and every requested year's ledgers go out together (2 round trips). Ledgers are preloaded only for canonical UUIDs; any other id format still takes the original per-year path, so behaviour is unchanged. Proved on 28 responses (both companies, FY and CY, one/three/duplicate/foreign/missing years, and invalid ids): 0 differ.

7. **The user lookup is remembered for 30 s** (`lib/auth/permissions.ts`, `AUTH_CACHE_TTL_MS`) — one round trip less on every API call except `/reports/all`. A security trade-off the owner accepted; details and the invalidation proof in §5.2.
8. **The database is kept awake** — an in-process ping on long-lived servers and a Vercel cron (`/api/v1/internal/keepalive`) — so the first request after a quiet spell doesn't wait for Neon to wake. Costs compute hours; §5.1.
9. **Vercel functions are pinned to `iad1`**, next to Neon `us-east-1` (`vercel.json`); §5.3.
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

**Switching period views of a year (item 5), the whole 84-response run with the inputs cache on:**

| | Original | After the one-wave change | + inputs cache |
|---|---|---|---|
| A new period of a year already viewed, median over all views | 1,540 ms | 770 ms | **269 ms** |
| The first view of a year (reads the database) | same as above | same as above | same as before: 1.3–1.7 s for the larger company, ≈ 0.5–0.8 s for the small one |
| **Content of the 84 responses vs the original baseline** | | 0 differ | **0 differ** |

**Invalidation, proved end to end on the Neon test branch** through the real handler (`NODE_ENV=production`): filling the cache, then a silent edit (no version bump) is still served from the cache — by design and as a control that the cache is really in use — `refresh=true` reads the new value, and once the data version changes both Annual and Q1 (served from the new version's cached inputs) show the edit. The edited value was restored afterwards.

**3-Year view, real handler, steady state on a warm pool (median of repeats):**

| | Before | After |
|---|---|---|
| Acme (3 years with data) | ≈ 1,565 ms | **≈ 500 ms** |
| Real Variable (2 years of larger ledgers) | ≈ 1,400 ms | **≈ 1,000 ms** |

Real Variable gains less: a wave of several large result sets in parallel over this link is not always one round trip (jitter, extra connections, transfer time), and its steady-state runs varied between about 0.9 and 2.6 s. Phase timing of that route: user lookup ≈ 250 ms, engine for 3 years 40–80 ms, the read wave the rest.

**Browser startup (live, Acme CFO, dev server on the Neon test branch, warm routes):** `/auth/me` and `/fy` now start 1 ms apart (they took 701 ms and 1,066 ms, so the old chain would have cost about their sum, ~1.8 s; now ~1.1 s). The dashboard loads with its years and figures, with no console errors or warnings and no `undefined`/`NaN` in the rendered text. `/reports/all` still starts after `/fy` (§5.7).

**Side by side in Chrome on the real Real Variable data (2026-09-20):** the pre-Phase-0 build the owner had running on `:4000` versus a production build of the current code on `:4001`, both on the same database, same browser session type, measured with `fetch` timings (first call / repeat), the report content compared section by section by hash.

| View | Old build | New build |
|---|---|---|
| FY 2025-26, a new period (Q1) | 4,793 / 293 ms | **395** / 311 ms |
| FY 2025-26, a new period (H1) | 5,406 / 311 ms | **420** / 304 ms |
| FY 2025-26, calendar-year view | 4,428 / 284 ms | **1,816** / 290 ms |
| FY 2024-25, Q3 | 1,631 / 284 ms | **355** / 292 ms |
| 3-Year view | 4,320 / 2,837 ms | **1,089** / 1,116 ms |
| Page load: data on screen | ≈ 1,075 ms (`/fy` waits for `/auth/me`; tab-setup calls ≈ 2.3 s while reconnecting) | **≈ 615 ms** (`/auth/me` and `/fy` start 1 ms apart) |
| **Report content, 7 views** | | **identical, every section** |

The old build's first-call figures include reconnecting to the database after a short pause (its 30 s idle timeout). The first view of a year or of the calendar-year mode still reads the database, hence 1.4–1.8 s on the new build. Also on the new build with the real data: all 21 tabs render, the browser console stays clean, the keep-alive and Zoho cron endpoints refuse a caller without the secret (401), and the batch list is 25 kB with no raw-data column. Steady-state cost per API call from the browser: `/auth/me` ≈ 15 ms (user cache), single-query endpoints ≈ 272 ms (one round trip), `/custom-tabs`, `/dashboard-layout/all` and `/audit` ≈ 530 ms (two sequential queries), `/report-builder/templates` ≈ 800 ms (three) — the last four are not on the page-load critical path and are the next candidates.

**Verification:** `npx tsc --noEmit` 0 errors · `npx jest --runInBand` 26 suites / 500 tests (added `auth-claims`, `report-inputs-cache`, `auth-cache`, `cron-auth` and `neon-keepalive`) · 84/84 `/reports/all` responses and 28/28 `/reports/threeyear` responses identical before/after · pool test after a 130 s pause with 0 errors · cache invalidation proved on the test branch · user-cache invalidation through the real user-update route proved on the test branch.

**Final regression after every change above (real handlers, against the original baselines):** `/reports/all` — all 84 responses identical in every section except Real Variable's `audit_summary` (172 → 173 events, latest event 2026-09-20 12:24:55): that is the one audit row written by the approved raw-column clear, made after the baseline was taken; Acme (no new audit rows) is identical in full. `/reports/threeyear` — the original route and the new route, both in production mode, 28/28 identical (`audit_summary` excluded for the same reason; an earlier mismatch on the error cases was only the app masking 500 messages in production mode, not a code change).

## 4. How to re-measure

Throwaway scripts (repo convention `_diag_*.ts`, deleted after use; copies in the session scratchpad):
- Route timing and content hashes: call the real `GET` handler in-process for every company × year × 14 views, with a token minted by `signAccessToken()`; run with `NODE_ENV=production` so the cache is on; compare two runs' hashes.
- Round-trip baseline: `SELECT 1` × 15 on a warm pool. Anything above ~5 ms means the app and database are far apart.
- Plans: `EXPLAIN (ANALYZE, BUFFERS)` inside `BEGIN READ ONLY … ROLLBACK`.

## 5. The owner's decisions (2026-09-20), and what was done

The owner approved all four open points. Each is a trade-off, so each is spelled out.

### 5.1 Keep the Neon compute awake — done (costs compute hours)
- **What it costs:** the database no longer suspends, so it bills for every hour. At Neon's smallest size (0.25 CU) that is roughly 180 compute-hours a month. Check that against your plan's allowance and price; this is the price of the first request after a quiet spell no longer waiting seconds for the database to wake.
- **How it works:**
  - **Long-lived servers** (a local `next start`, any container or VM) ping from `lib/db/neon.ts` every 4 minutes (`DB_KEEPALIVE_MS`, default 240000, under Neon's 5-minute window). The timer is unref'd, so it can't keep a script or a shutting-down server alive; a hot reload replaces it instead of stacking a second one. Off in tests and on Vercel; `DB_KEEPALIVE_MS=0` turns it off.
  - **Vercel** has no long-lived process, so `vercel.json` now runs `/api/v1/internal/keepalive` every 4 minutes. It does a `SELECT 1` and returns how long the database took to answer (a wake-up shows as seconds). Same `CRON_SECRET` guard as the Zoho cron, now one shared, constant-time check (`lib/auth/cron-auth.ts`); production without the secret refuses (503).
- **Needs a Vercel plan that allows it.** Vercel Hobby limits cron jobs to once a day and rejects a more frequent schedule when deploying. The existing Zoho cron (every 6 hours) already needs Pro, so this is probably fine; if the project is on Hobby, remove the keep-alive line from `vercel.json`.
- **A simpler alternative, if the plan allows it:** in the Neon console, turn off "suspend compute after inactivity" for the production compute. Then the cron and the in-process ping are redundant (delete the cron line and set `DB_KEEPALIVE_MS=0`). It could not be done from here: the Neon tools available to the assistant can't see this project, so nothing was changed in the Neon console.
- **Verified:** the route's guard and its `SELECT 1` against production; the ping starting, reaching the database (3 pings in 3.6 s, 0 failures) and not holding the process open; the timer logic in unit tests.

### 5.2 A short cache of the user lookup — done (a security trade-off, accepted)
- Every route starts with `authenticate()`, which read the user from the database on every request. Now the record is remembered for **30 s** (`AUTH_CACHE_TTL_MS`; 0 turns it off; always off in development). Measured on the real `/fy` route from here: **≈ 510–610 ms → ≈ 230–300 ms** after the first call, one round trip saved.
- **The accepted cost:** a user who is deactivated or given another role on a *different server instance* keeps the old access for up to 30 s.
- **What does not change:** the token's signature and expiry are checked on every request; a failed lookup (unknown or inactive user) is never cached, so a refusal always reaches the database and a reactivated user works at once; every caller gets its own copy.
- **On the instance that makes the change it takes effect immediately:** `PATCH /companies/users/:id`, the only route that changes a user's role, name or active flag, clears that user (`invalidateAuthCache`). Proved on the test branch through the real routes: after an admin deactivated a user through the route, the user's very next request was refused although they had just been cached; reactivating worked at once. A control showed a direct-SQL deactivation is still served inside the window, as documented.
- **Where it helps:** every API call except `/reports/all`, which already looks the user up in the same round trip as its data-version check, so it gains nothing there.

### 5.3 Where the functions run — pinned to `iad1` (done); moving further is a separate project
- `vercel.json` now pins `"regions": ["iad1"]` (Washington D.C.), next to Neon `us-east-1`, so the choice no longer depends on a dashboard default. If the project already ran there, this changes nothing; if it ran elsewhere, deploying moves it next to the database.
- **Why `iad1` and not Mumbai:** after the round-trip reductions above, a request needs one or two database round trips. With the database in `us-east-1`, functions in Mumbai would pay ~250 ms on each of those, whereas functions in `iad1` pay a few milliseconds and the browser pays one ~250–300 ms trip from India. For a hit or a cached period switch that is the same total, and for anything that reads the database it is better.
- **Still open, not done:** if most users are in India, the fastest arrangement is **both** the database and the functions in Mumbai (Neon `aws-ap-south-1`, Vercel `bom1`): browser ↔ server ~30 ms and database in milliseconds. A Neon project's region can't be changed in place; it means a new project, a migration of the data, and a cutover. That is a project of its own and needs its own plan and approval.

### 5.4 Emptying the old raw-data column on production — done
- Approved list `426d3108cea5` was re-checked before applying (the dry run still produced exactly that id) and applied on 2026-09-20: 31 batches, 1,158 entries, each verified field by field against the new store first. `tb_uploads` went from 4.7 MB to 232 kB.
- **Proved after:** all 37 batches read back exactly the same raw responses as before; all 1,024 stored responses remain, none orphaned; every integrity check clean; recorded in the audit trail (`TB_RAW_JSON_CLEARED`). Nothing was lost: every response is still in `raw_payloads`, and the column itself remains (only emptied).
- No Neon restore point was created (the Neon tools can't see the project); the copy in the new store is the safety net.

## 6. Considered and not done
1. **`SELECT l.*` returns 43 columns**; the engine uses about 34. Measured (interleaved, three parallel queries like a real wave, Real Variable FY 2025-26): engine columns only sends **36% fewer bytes** (228 → 145 kB) but saves only **≈ 41 ms** (the minimums are equal, 248 vs 247 ms). Not worth the risk of dropping a column another consumer reads.
2. **Other routes** each make their own sequential queries. Only `/reports/all`, `/reports/threeyear` and the page-load pair were reworked; the user-lookup cache (§5.2) helps all the rest by one round trip.
3. **Browser-side:** report loading still waits for `/fy` to learn the current year. Starting `/reports/all` with the stored year id in parallel would save another browser round trip (~250–300 ms from India), at the cost of restructuring the loading effect and handling a stale stored year.
## 7. End-to-end test with the real Real Variable account (2026-09-20)

A 27-check suite, run through Chrome DevTools against real HTTP servers with the owner's real account, on a production build of the final code (`:4001`) and, earlier, on the owner's running `:4000` (the old build). It covers sign-in and refresh, tenant isolation (another company's ids with this company's token), all 28 report views against the **original pre-work baseline**, the 3-Year view, the raw ledger API with an independent recomputation, the custom-metric preview, the Report Builder, and the Zoho, user and audit endpoints for leaked secrets.

- **New build: 27 / 27.** All 28 report views identical to the original baseline in every section except the audit counter; the custom-metric preview equals the income total recomputed from the raw ledger rows (33,061,830.35); the Report Builder run's numbers equal the old build's; another company's year, batch or 3-year request is refused with 404; no endpoint returns a token, client secret or password; the cron endpoints refuse a caller without the secret.
- **Old build (`:4000`): every report, ledger, metric, builder and tenancy check passes and matches.** The differences are the known old-build behaviour: its batch list hides the 4 scheduled-sync batches (27 shown, 31 exist) and still sends internal fields (`file_sha256`); it has no keep-alive route.
- **Found and fixed by the test:** the order in which a Report Builder line's ledgers come back had changed as a side effect of the account-id join (the links table has no sequence column, so the order was always plan-dependent). It is now defined — by the ledger's current name, then id — with the same links and unchanged numbers (`DB-PHASE-1.md` §3.4).
- **Not a bug, but worth knowing:** the Report Builder template "Test Management P&L" (created 5 Sep, before this work) links the same ledger name three times to one line, and links TDS-payable ledgers to a line named "Operating Revenue". That is the template's own data, identical on the old build. Real Variable also has two custom tabs named "QA temp …" from earlier testing.
- **The app's rate limiter is easy to hit.** `RATE_LIMIT_MAX=100` requests per 15 minutes per IP, in memory per server, and everything on one machine shares one IP. The test suites used it up, and `:4000` answered 429 until the window ended (at most 15 minutes; nothing is stored, it clears by itself). A normal page load costs about 7 requests, so a heavy session or several people behind one office IP could reach 100. The middleware default is 200; consider raising the limit or exempting authenticated reads. Not changed.
- **Not tested, on purpose:** anything that changes production data (Excel upload, Zoho sync — Zoho is disconnected —, reclassify, user changes). Those paths were proved on the Neon test branch.