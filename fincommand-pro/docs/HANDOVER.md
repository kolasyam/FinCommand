# HANDOVER.md — Project Continuity & Current State

> [!NOTE]
> This is a living document. Update it in place when the platform's state materially changes — don't let it go stale. See `fincommand-readme.md` (project root) for the deeper architecture/behavior reference this file summarizes from.

## 1. Stack & Server

- **Framework**: Next.js 15 (App Router + TypeScript), single deployable app.
- **Dev server**: `npm run dev` → `next dev -p 4000` → `http://localhost:4000`.
- **Database**: PostgreSQL, Neon-ready, via `lib/db/neon.ts`. Schema changes are versioned migrations in `db/migrations/`: `npm run db:migrate:branch` (Neon test branch, `BRANCH_DATABASE_URL`) first, then `npm run db:migrate:main`, with `db:migrate:status` / `db:migrate:status:branch` for status. There is no default target. `db/schema.sql` is a frozen baseline. Migrations 0000–0005 are live on main (2026-09-19). See `VERIFICATION.md` Step 3, `DB-PHASE-0.md` and `DB-PHASE-1.md`.
- **Required secrets** besides the DB/JWT/Zoho ones: `TOKEN_ENCRYPTION_KEY` (Zoho tokens are encrypted at rest; use the same value locally and in Vercel), and `CRON_SECRET` (the cron route refuses to run in production without it).
- **Auth**: JWT (`jsonwebtoken` + `bcryptjs`) with RBAC. Seeded roles (`db/seed.ts`): `admin`, `cfo` (`cfo@acmetech.in`), `ceo`, `auditor`. Role gating is enforced per-route via `requireRole()` / `ROLE_SETS` (e.g. `app/api/v1/zoho/auth-url/route.ts` requires `ROLE_SETS.isCFO` to initiate a Zoho connection).
- **Exports**: `jspdf` + `jspdf-autotable` for PDF, `xlsx` for Excel.

## 2. Dual Operating Modes

| Mode | Trigger | Data source |
|---|---|---|
| **Sample Data** | Default, no login | Synthetic but internally-balanced ledger set (`lib/financial/sample-data.ts`), run through the same `tb-engine.ts` as real data |
| **Live — API** | Sign in as a seeded/real user | Uploaded Trial Balance Excel, or Zoho Books OAuth sync |

> [!IMPORTANT]
> In Sample mode, `401` responses from `/api/v1/auth/me`, `/api/v1/dashboard-layout/all`, `/api/v1/custom-metrics`, `/api/v1/auth/refresh` are **expected and correct** — there is no session to authorize. Don't treat these as bugs unless actively testing the signed-in path.

## 3. Recent Accomplishments

- **Zoho Books sync performance work** (then `lib/services/zoho.ts`; since DB Phase 1 the `lib/services/zoho/` folder, mostly `sync.ts`), verified in code:
  - Full-year Vendor Bills and Expenses are fetched once, paginated, **in parallel** with the monthly P&L/Balance Sheet report batch (not sequentially, not per-month) — see the `fullYearBillsPromise` / `fullYearExpensesPromise` pair in `sync.ts`.
  - Monthly report requests are batched with **`BATCH_SIZE = 5`** concurrent `callZoho()` calls per wave (`sync.ts`), staying under Zoho's rate limits.
  - The Zoho config row (`zoho_config`) is fetched **once** per sync and threaded through every subsequent `callZoho()` call via a `configOverride` parameter, instead of each call independently re-querying it.
  - Customer and vendor contact directories are fetched with `Promise.allSettled()` (`contacts.ts`) so one failing directory fetch doesn't abort the other.
  - Token refresh uses a single-flight `Map`-based dedup (`refreshZohoTokenSingleFlight`) — a documented, production-observed race fix (concurrent batch calls previously triggered duplicate `refresh_token` grants against Zoho's OAuth endpoint, which does not support that cleanly).
    - That only covered *concurrent* calls. Until 2026-09-19 each *sequential* batch still refreshed again, because the sync's in-memory config kept the old expiry. That is fixed now; see `DB-PHASE-0.md` §3.6.
  - > [!NOTE]
    > A specific speedup figure (~4.8 min → ~15–25s, >10x) was reported for this optimization but was **not independently re-measured** during this documentation pass — doing so requires a live Zoho sync run against real OAuth credentials, which wasn't performed here. Treat the mechanism (parallel full-year fetch, batch size 5, config caching, `allSettled` contacts) as code-verified; treat the exact timing number as reported, not measured in this session.
  - The stale "batched in groups of **3**" comments in `zoho.ts` now say 5, matching `BATCH_SIZE = 5` (fixed 2026-09-19).
- **Foreign-currency safety fix**: Sales by Customer and Vendor Bills concentration figures now explicitly skip rows whose `currency_code` differs from the company's base currency, logging which customers/vendors were skipped (`lib/services/zoho/sync.ts`) — prevents silently summing foreign-currency amounts into an INR total.
- **9-tab dashboard customization system** live: My Dashboard + 8 generalized tabs (Overview, MIS, Ratios, Treasury, Working Capital, Customer Margin, Vendor Expense, Board Pack), each backed by `dashboard_layouts` with 3-tier resolution — personal layout → company default → system starter — and a `tab_key` column distinguishing which tab a saved layout belongs to.
- **Custom dashboard tabs** (2026-09-17, see `CUSTOM-DASHBOARD-TABS.md` for the full implementation log): a company (`admin`/`cfo`) can now create an entirely new, freely-named dashboard tab — not just customize one of the 9 fixed ones — via "Manage custom tabs" in the sidebar, add widgets to it, and attach built-in or brand-new custom-metric formulas, using the exact same `CustomizableTabPanel`/`WidgetPicker`/`CustomMetricBuilder` machinery as every fixed tab (zero changes needed there). New `custom_tabs` table, `TabKey` widened from a closed union to `string` (`TAB_KEYS`/`isTabKey` unchanged — still exactly the 13 fixed tabs), app-code cascade delete on tab removal. Closes the gap identified in `ledgerframe-integration-blueprint.md` against the reference app "Ledgerframe."
- **Custom metric builder — chaining + manage UI** (2026-09-17, see `CUSTOM-METRICS-UPGRADE.md`): the custom-metric formula builder now chains any number of operands (previously hard-capped at exactly two) via a left-associative expression tree — no engine change needed, since `custom-metric-engine.ts` already validated arbitrarily nested trees. New "Manage custom metrics" sidebar surface (browse/edit/delete every company metric, with a real "used by N widgets" count before delete) closes the other gap the blueprint identified — there was previously no way to see or manage a custom metric once created, only to create one inline while placing a widget. Also: `min`/`max` operators, and a lightweight audit-trail-backed edit history (`audit_trail.old_values`/`new_values`, columns that existed but were never populated before this).
- **Ledgerframe parity** (2026-09-18/19, see `LEDGERFRAME-PARITY.md`):
  - Metrics built straight from ledgers, with text and number filters (amount, between, is empty) and sum/average/count/min/max.
  - Metrics built on other custom metrics, plus functions.
  - Custom metrics in charts and tables.
  - Version history with restore; template gallery; role-based tab sharing.
  - Warn levels (amber) and a comparison choice (prior year / prior period / none).
  - Mixed bar + line charts on a second axis; horizontal bar, ratio card and KPI group widgets.
  - "Export ▾" for any customized view: PDF, PowerPoint (native editable charts), Excel, CSV, PNG.
- **Platform-wide QA pass + a real latency fix** (2026-09-17, see `QA-AUDIT-LATENCY-FIX.md`): found and fixed a bug where every report load unconditionally bypassed the existing 15-minute server-side cache (`nocache=true` hardcoded on every request in `DashboardContext.tsx`, with no justification) — measured **8–24× faster** report loads in a production build as a result (9.9s cold → 0.4–1.3s cached). Also fixed a Chart.js `Filler`-plugin registration gap (sparkline area charts were silently not filling + spamming console warnings) and folded an unnecessary sequential Zoho-contacts fetch into the main parallel batch in `reports/all`. Full 17-tab sweep (Live + Sample mode) otherwise came back clean — see that doc for what was investigated and confirmed *not* a bug (including a stale claim in `CONSTRAINTS.md`, now corrected).

- **DB Phase 0 — database safety fixes** (2026-09-19, see `DB-PHASE-0.md`): no redesign and no number changes, with before/after parity as the proof.
  - Versioned migrations. `0001` adds integrity rules and records debit/credit totals on every batch. `0002` removes `ledger_master` duplicates; the removed copies stay in a backup table.
  - One writer per company + year, and the year lock is enforced on every trial-balance write.
  - Whichever of Excel or Zoho loads a year first owns it; switching needs confirmation.
  - Zoho tokens are encrypted and no longer sent to the browser. The OAuth state is signed. The cron fails closed.
  - The report cache key includes a data version.
  - **Zoho sync fixes** (`DB-PHASE-0.md` §3.6):
    - The opening snapshot was one day early in India's timezone.
    - The earnings brought forward were missing.
    - 29 February was lost in leap years.
    - A stale token config made scheduled syncs refresh about 10 times per run, and they failed.
    - Proven by replaying the stored Zoho responses: FY 2025-26 now balances to the paisa.
  - The Balance Sheet's missing profit was resolved in Phase 1 (below).

- **DB Phase 1 — backend & database redesign** (2026-09-19, see `DB-PHASE-1.md`). Report numbers are unchanged on today's data (parity 84/84).
  - **One ingestion pipeline** (`lib/ingestion/trial-balance.ts`) for Excel and Zoho. `lib/services/zoho.ts` is now the `lib/services/zoho/` folder.
  - A Zoho sync with a failed monthly report no longer overwrites good data.
  - **Unchanged syncs write nothing** (content hash, migration `0003`).
  - **Raw Zoho responses are stored once** (`raw_payloads`, migration `0004`).
  - **Stable account ids** (`ledger_accounts`, migration `0005`). Report Builder links survive a Zoho rename, and reclassify works by account.
  - **The Balance Sheet carries the period's profit**, as "Surplus — profit for the period (as booked)" in Other Equity. It shows only for a trial balance that balances, so it takes effect for Zoho years once Zoho is reconnected and re-syncs.
  - **Retention and old-column clean-up scripts** sit behind a dry-run list the owner approves. On main, retention has nothing due (the first deletions become possible around late November 2026). The old raw column was emptied on main on 2026-09-20 with the owner's approval (list `426d3108cea5`; nothing lost — every response is in `raw_payloads`).

- **Latency pass** (2026-09-20, see `LATENCY.md`): a report load is dominated by database round trips (~247 ms each from India to Neon `us-east-1`; the queries themselves take < 1 ms). `/reports/all` now makes 1 round trip on a cache hit (was 2) and 2–3 on a miss (was 6); idle database connections are kept for 5 minutes (`DB_IDLE_TIMEOUT_MS`), which removed a ~3 s penalty on the first click after a short pause; the browser asks `/auth/me` and `/fy` together; the 3-Year view reads everything in one wave; and the database reads behind a bundle are kept per data version, so switching Annual → Q1 → H2 no longer re-reads them (a new period of an already-viewed year: ~1.5 s → ~0.27 s from India). Report content unchanged (84/84 `/reports/all` and 28/28 `/reports/threeyear` responses identical).
  - **The cache contract:** a change shows once the data version changes (every app write path does that). Hand-run SQL and `db/init.ts`'s `note_no` updates don't, and would show after up to 15 min or on `refresh=true`.
  - **Owner decisions carried out 2026-09-20** (`LATENCY.md` §5), each a trade-off:
    - **Neon kept awake** (costs compute hours): a 4-minute ping in long-lived servers (`DB_KEEPALIVE_MS`) and a Vercel cron (`/api/v1/internal/keepalive`, needs a plan that allows it). `DB_KEEPALIVE_MS=0` / removing the cron line undoes it.
    - **The user lookup is remembered for 30 s** (`AUTH_CACHE_TTL_MS`): a user deactivated or re-roled on another server instance keeps the old access for up to 30 s. Cleared at once on the instance that changes it.
    - **Functions pinned to `iad1`** (next to Neon `us-east-1`). Moving both the database and the functions to Mumbai would be faster for Indian users but is a migration project of its own — not started.
  - **Still to check on the Vercel side:** that the plan allows a 4-minute cron (Hobby limits crons to daily), or turn off "suspend compute after inactivity" in the Neon console instead.
  - **End-to-end test with the real Real Variable account** (`LATENCY.md` §7): 27/27 on the final build; every report view identical to the original baseline. Two things surfaced: the rate limiter (100 requests per 15 minutes per IP — easy to hit while testing, and possibly for several people behind one office IP; not changed) and leftover test data in Real Variable (two "QA temp …" custom tabs and a template "Test Management P&L" with odd links) that the owner may want to tidy.
  - **`:4000` still runs the old build** — restarting it with the current code needs the owner to stop the old process (`npm run start`, its `cmd` and `node` children), then `npm run build` and `npm run start`.
  - `npm run dev` never uses the report cache (`NODE_ENV=development`), so it always feels slower than a production build.

- **Zoho data audit** (2026-09-21, see `ZOHO-DATA-AUDIT.md`): the platform reads Zoho's **financial statements plus customer/vendor summaries**, not every record (invoices, bills, journals, bank transactions, GST, fixed assets … are not read). The statements reconcile exactly to Zoho's own totals (24 P&L months, 26 Balance Sheet snapshots). Three defects found and fixed in code: **(1)** customers invoiced in another currency were skipped, hiding the dominant USD customer (84–94% of revenue) from Top Customers and Customer Margin — Zoho's report amounts are already in the base currency, proved against 10/10 invoices; **(2)** vendor spend was empty in every batch because the old build sent Zoho a timestamp it rejects (HTTP 400), silently — fixed in Phase 0, live test 187 bills → 32 vendors; **(3)** the chart of accounts was read one page only (200 of 299+). Non-fatal sync problems are now recorded on the sync log and returned as `warning`; the year's bills and expenses are stored with each batch.
  - **Urgent, 2026-09-21:** Zoho was reconnected at 06:37 UTC and the Upload tab auto-synced FY 2025-26 on the **old build still running on `:4000`**, so the current FY 2025-26 batch carries the old defects. Restart `:4000` on the current code, then run "Sync Trial Balance" for each year (`ZOHO-DATA-AUDIT.md` §6).

- **Every kind of Zoho record is now read** (2026-09-21, see `ZOHO-RECORDS.md`; owner request: "read all data from Zoho whatever it will give"). A **read-only mirror** in new tables (migrations `0006`, `0007`): invoices, bills, credit notes, vendor credits, customer and vendor payments, expenses, journals, purchase and sales orders, estimates, retainer invoices, sales receipts, delivery challans, **bank accounts and bank transactions**, the chart of accounts, items, taxes, currencies, users, locations, reporting tags, **fixed assets**, projects, recurring documents, budgets, plus **GST fields on every document** (GST treatment, GSTIN, place of supply, HSN/SAC, tax per line, ITC) and Zoho's own tax-summary, ageing, cash-flow and sales-by-item reports as dated snapshots. Zoho has no GSTR endpoints (measured), so GSTR-style output would be computed later from the stored lines. **No report, statement or `tb-engine.ts` code was touched** — using the data (drill-downs, ageing, GST summary, bank register, reconciliation) is a separate plan.
  - **How to use it:** Upload tab → "Zoho data coverage" panel → set the Zoho plan (Professional = 5,000 calls a day) → "Read all Zoho data". About 1,000 calls for the reference org, in 40-second steps. A cron (`/internal/zoho-records-cron`, every 30 min) then keeps it fresh, but only for companies whose admin has started a first read.
  - **Budget:** record reads may use up to 80% of the day's Zoho allowance (owner decision); Zoho's own daily-limit answer stops everything for an hour. A failing sync now backs off (15 min → 1 h → 6 h → 24 h) — before, it retried on every tick at ~40 calls each, up to ~3,800 of a 5,000 allowance a day. The 15-minute frequency costs ~4,300 calls a day; the panel warns.
  - **Access:** admin, CFO, CEO and auditor can read the records; admin and CFO start a read.
  - **Deploy:** `0006` and `0007` were applied to main on 2026-09-21 (dry run first; additive; proven on the Neon branch), so the new code can deploy. Still to do: set the Zoho plan in the panel, run the first read, restart `:4000` on the new build, and run `next build` to completion with free memory.
  - **The verified Real Variable data is on main** (copied from the Neon test branch on 2026-09-21 in one transaction, insert-only into the empty tables, content fingerprints identical on both sides, list id `d843ed3499fe`, audit row `ZOHO_RECORDS_COPIED`): 6,721 records in 18 modules, 2,935 lines, 12 report snapshots, the module cursors (so the first read after reconnecting is incremental) and today's API-call count (1,213). Nothing that existed was changed. Main's plan limit is still the default 1,000, so set the Zoho plan (Professional) in the panel, or it shows over quota.
  - **Real Variable's Zoho connection on main is inactive** (2026-09-21 07:45 UTC): the old build refreshed the expired token, was refused, and deactivated it, though Zoho still accepts the refresh token. `refreshZohoToken` no longer deactivates on a rate-limit refusal (`ZOHO-RECORDS.md`, "A false disconnect"). Reconnect from the Upload tab (or reactivate the row) once `:4000` runs the new build.

- **Database at scale, Phase A — row-level security** (2026-09-21, `ROW-LEVEL-SECURITY.md`; owner asked to "build my database at high level", plan phases A→D). The database can now enforce company separation itself: migration `0008` adds a restricted login `fincommand_app` and a policy on every table. **Inert until switched on** (the current owner login bypasses it) and **instantly reversible** (two env vars). Enforced in **production only**; local dev keeps the owner login. Proven on the Neon branch: 310/310 leak checks, 287/287 route responses identical, 28/28 write-path checks as the restricted role. **To switch on:** `npx tsx db/scripts/set-app-role-password.ts --target=main --generate` (password to your clipboard, never printed), then `DB_APP_USER=fincommand_app` + `DB_APP_PASSWORD` in Vercel and redeploy. Every new table now needs its own policy (`rls-coverage.test.ts` enforces it). Next phases: B (below), then C shared Redis report cache, D monthly ledger (own check-in first).

- **Database at scale, Phase B — bank transactions in their own partitioned table** (2026-09-21, `ZOHO-RECORDS.md` "Bank transactions have their own table"). Migrations `0009` (table, 16 hash partitions by company, row-level security) and `0010` (list indexes matching the list order — found by measuring: page 1 went from 135 ms to 0.1 ms at 200,000 rows) are **applied on main** (dry run first). The 3,341 existing rows were **copied** into the new table on main with identical fingerprints; **the old copies in `zoho_records` are NOT removed** — `move-bank-transactions.ts --target=main --retire-old` needs your approval of its own dry-run list (currently id `81f9ba64d254`, 3,341 rows, both sets identical). The new code (local branch `db-phase-0`, never pushed) reads the new table; until it is deployed, production keeps reading the old copies, so nothing breaks in between. Proven on the branch: listing identical to the old one field by field and in order (two defects found and fixed on the way: unstable page order, missing base amount), a live re-read changed only what genuinely changed in Zoho (+40 credit-card items, 4 matched/categorised) and a second one changed 0, 8/8 accounts tie to Zoho's book balances, 320/320 leak checks, report parity unchanged (the only differences were the move script's own audit entry), partition pruning under the restricted login, and a 230,000-row synthetic scale test (deleted afterwards).

## 4. Current Test & Build State (verified 2026-09-21)

```
Test Suites: 40 passed, 40 total
Tests:       712 passed, 712 total
```
Run via `npm test` (Jest; `npx jest --runInBand` on a low-memory machine). Suites: `note-catalog`, `report-builder-engine`, `custom-metric-engine`, `custom-metrics-v2`, `ledger-metric`, `dashboard-builder-engine`, `dashboard-templates`, `dashboard-layout-export`, `tab-access`, `tab-customization-audit`, `tb-engine`, `format`, `migrate-core`, `tb-validation`, `security`, `report-cache-key`, `zoho-assembly`, `ingestion`, `content-hash`, `period-surplus`, `script-support`, `auth-claims`, `report-inputs-cache`, `auth-cache`, `cron-auth`, `neon-keepalive`, `zoho-people`, `zoho-modules`, `zoho-records-ingest`, `zoho-records-sync`, `zoho-records-state`, `zoho-records-cron`, `zoho-budget`, `zoho-health`, `zoho-usage`, `zoho-client-limits`. **After the Zoho records mirror:** the full-project `tsc` is clean and `next build` compiles successfully, but the build ran out of memory in the final "Generating static pages" step (the machine had < 0.1 GB free), so it has not completed once, and the Upload-tab panel has not been seen in a browser — run `npm run build` and look at the panel before deploying. `npm run typecheck` and `npm run build` also verified clean the same session — see `CUSTOM-METRICS-UPGRADE.md` §4 and `QA-AUDIT-LATENCY-FIX.md` §7.

## 5. What's explicitly deferred / out of scope

- Anything not derivable from a Trial Balance: PPE gross block/asset register, IND AS 19 actuarial DBO, ECL invoice-level ageing, IND AS 102 ESOP register, IND AS 116 lease schedules (flagged in the Upload tab's own UI).
