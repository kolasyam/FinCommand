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
  - **Retention and old-column clean-up scripts** sit behind a dry-run list the owner approves. On main, retention has nothing due. Clearing the old raw column (31 batches, list `426d3108cea5`) awaits approval.

## 4. Current Test & Build State (verified 2026-09-19)

```
Test Suites: 21 passed, 21 total
Tests:       470 passed, 470 total
```
Run via `npm test` (Jest; `npx jest --runInBand` on a low-memory machine). Suites: `note-catalog`, `report-builder-engine`, `custom-metric-engine`, `custom-metrics-v2`, `ledger-metric`, `dashboard-builder-engine`, `dashboard-templates`, `dashboard-layout-export`, `tab-access`, `tab-customization-audit`, `tb-engine`, `format`, `migrate-core`, `tb-validation`, `security`, `report-cache-key`, `zoho-assembly`, `ingestion`, `content-hash`, `period-surplus`, `script-support`. `npm run typecheck` and `npm run build` also verified clean the same session — see `CUSTOM-METRICS-UPGRADE.md` §4 and `QA-AUDIT-LATENCY-FIX.md` §7.

## 5. What's explicitly deferred / out of scope

- Anything not derivable from a Trial Balance: PPE gross block/asset register, IND AS 19 actuarial DBO, ECL invoice-level ageing, IND AS 102 ESOP register, IND AS 116 lease schedules (flagged in the Upload tab's own UI).
