# HANDOVER.md — Project Continuity & Current State

> [!NOTE]
> This is a living document. Update it in place when the platform's state materially changes — don't let it go stale. See `fincommand-readme.md` (project root) for the deeper architecture/behavior reference this file summarizes from.

## 1. Stack & Server

- **Framework**: Next.js 15 (App Router + TypeScript), single deployable app.
- **Dev server**: `npm run dev` → `next dev -p 4000` → `http://localhost:4000`.
- **Database**: PostgreSQL, Neon-ready, via `lib/db/neon.ts`.
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

- **Zoho Books sync performance work** (`lib/services/zoho.ts`), verified in code:
  - Full-year Vendor Bills and Expenses are fetched once, paginated, **in parallel** with the monthly P&L/Balance Sheet report batch (not sequentially, not per-month) — see the `fullYearBillsPromise` / `fullYearExpensesPromise` pair around line 689.
  - Monthly report requests are batched with **`BATCH_SIZE = 5`** concurrent `callZoho()` calls per wave (line 754), staying under Zoho's rate limits.
  - The Zoho config row (`zoho_config`) is fetched **once** per sync and threaded through every subsequent `callZoho()` call via a `configOverride` parameter, instead of each call independently re-querying it.
  - Customer and vendor contact directories are fetched with `Promise.allSettled()` (line ~1573) so one failing directory fetch doesn't abort the other.
  - Token refresh uses a single-flight `Map`-based dedup (`refreshZohoTokenSingleFlight`) — a documented, production-observed race fix (concurrent batch calls previously triggered duplicate `refresh_token` grants against Zoho's OAuth endpoint, which does not support that cleanly).
  - > [!NOTE]
    > A specific speedup figure (~4.8 min → ~15–25s, >10x) was reported for this optimization but was **not independently re-measured** during this documentation pass — doing so requires a live Zoho sync run against real OAuth credentials, which wasn't performed here. Treat the mechanism (parallel full-year fetch, batch size 5, config caching, `allSettled` contacts) as code-verified; treat the exact timing number as reported, not measured in this session.
  - Inline comments elsewhere in `zoho.ts` (e.g. the doc-comment above `refreshZohoTokenSingleFlight`, and the report-batching comment near line 651) still say "batched in groups of **3**" — this is a **stale comment**, not current behavior; the actual constant is `BATCH_SIZE = 5`. Worth a follow-up comment fix so the docstring doesn't mislead the next reader.
- **Foreign-currency safety fix**: Sales by Customer and Vendor Bills concentration figures now explicitly skip rows whose `currency_code` differs from the company's base currency, logging which customers/vendors were skipped (`lib/services/zoho.ts` ~lines 858–926) — prevents silently summing foreign-currency amounts into an INR total.
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

## 4. Current Test & Build State (verified 2026-09-17)

```
Test Suites: 12 passed, 12 total
Tests:       387 passed, 387 total      (re-verified 2026-09-19)
```
Run via `npm test` (Jest). Suites: `note-catalog`, `report-builder-engine`, `custom-metric-engine`, `custom-metrics-v2`, `ledger-metric`, `dashboard-builder-engine`, `dashboard-templates`, `dashboard-layout-export`, `tab-access`, `tab-customization-audit`, `tb-engine`, `format`. `npm run typecheck` and `npm run build` also verified clean the same session — see `CUSTOM-METRICS-UPGRADE.md` §4 and `QA-AUDIT-LATENCY-FIX.md` §7.

## 5. What's explicitly deferred / out of scope

- Anything not derivable from a Trial Balance: PPE gross block/asset register, IND AS 19 actuarial DBO, ECL invoice-level ageing, IND AS 102 ESOP register, IND AS 116 lease schedules (flagged in the Upload tab's own UI).
