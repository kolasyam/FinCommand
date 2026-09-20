# QA-AUDIT-LATENCY-FIX.md — Platform-Wide Quiz & Latency Fix

> [!NOTE]
> This is an implementation log, not a living reference — it records a QA pass performed on the date below: every tab quizzed for functional/console/network issues, one severe latency bug found and fixed, two smaller issues fixed, and several suspected issues investigated and confirmed **not** to be bugs. For the ongoing architecture reference, see `fincommand-readme.md` and `HANDOVER.md`.

**Date**: 2026-09-17
**Scope**: Full platform sweep at `localhost:4000` — all 17 sidebar tabs, both Live (CFO, Acme Technologies Ltd, real DB data) and Sample Data modes, period/view controls, PDF/Excel exports, and a regression check of the custom-tabs/custom-metrics work from the same session (`CUSTOM-METRICS-UPGRADE.md`). Method: `chrome-devtools` MCP — `evaluate_script` DOM/console/network probes rather than full accessibility-tree snapshots per tab, to keep the sweep fast; full snapshots only where a probe flagged something worth a closer look.

---

## 1. The headline finding: report loads were bypassing their own cache

### 1.1 What was wrong

`lib/dashboard/DashboardContext.tsx` hardcoded `nocache: 'true'` on **every** `/api/v1/reports/all` request, unconditionally — no comment, no justification, no code path that ever set it any other way. `app/api/v1/reports/all/route.ts` respects that flag literally: `if (!nocache) { check the cache }`. With `nocache` always true, the check was permanently dead code from the frontend's side — a 15-minute in-memory server cache (`lib/cache/report-cache.ts`, comment: *"Serves report data instantly (< 5ms) for repeated queries, tab switches, and user dashboard re-loads"*) existed, was correctly wired up, and was invalidated correctly on every data-mutating path (confirmed: `app/api/v1/tb/upload/route.ts`, `app/api/v1/tb/ledgers/[ledgerId]/reclassify/route.ts`, `app/api/v1/zoho/sync/route.ts` all call `invalidateReportCache()`, matching the documented flow in `docs/FLOW.md`) — and was never once consulted by the app's own primary data-loading path.

**Effect measured live**: every FY switch, every Annual/Quarterly/H1-H2 toggle, and every full page reload forced a complete server-side recompute from raw ledger rows — even for data that hadn't changed in the last 15 minutes and had already been computed once in this exact shape.

### 1.2 The fix

Removed the hardcoded `nocache: 'true'` from the query string `DashboardContext.tsx` builds. No other change was needed — the cache, its TTL, and its invalidation were already correct; only the one call site that defeated it needed to change.

> [!IMPORTANT]
> `getCachedReport()` in `report-cache.ts` unconditionally returns `null` in `NODE_ENV=development` — "always compute fresh in dev" is itself a deliberate, pre-existing design choice, not a bug. **This means the fix has zero observable effect in `npm run dev`.** It only matters — and was only meaningfully measurable — in a production build (`npm run build && npm start`).

### 1.3 Measured impact (production build, real seeded data, FY 2024-25)

| Request | Duration |
|---|---|
| First load after server start (cache empty — genuine cold compute) | **9.9s** |
| Same report, page reload immediately after (cache hit) | **1.3s** |
| Same report, one more reload | **0.4s** |

Measured via the browser's own `performance.getEntriesByType('resource')` resource-timing entries for the `/api/v1/reports/all` request, not a stopwatch — see §5 for the exact method. This is roughly an **8–24× improvement** on the common case (a signed-in user switching FY, toggling the period view, or simply reloading the page within the same 15-minute window), which was previously always paying the full 9–10s cold-compute cost.

> [!NOTE]
> **Update (2026-09-20):** the cold figure was later profiled and the inference below was confirmed — it is network round trips to Neon, not compute. See `LATENCY.md` for the measurements and what was changed.
>
> The 9.9s **cold** figure was not separately investigated further in this pass — `app/api/v1/reports/all/route.ts` already parallelizes its DB reads and its seven `compute*()` calls via `Promise.all` (only one, low-risk improvement was made there — see §2). The 9.9s most plausibly reflects real Neon network round-trip time across ~8 sequential-ish query waves rather than JS compute cost (a demo-sized ledger set computes in low tens of milliseconds in Node). This is a reasonable inference from the request shape, not an independently profiled number — flagging it as inferred, not measured, matching this repo's own established discipline (see `HANDOVER.md`'s Zoho-sync-speedup caveat) for not overclaiming a root cause that wasn't directly instrumented.

---

## 2. A second, smaller latency fix in the same route

`app/api/v1/reports/all/route.ts` fetched the Zoho contact directory (`loadZohoContacts()`) as a separate `await` **after** the main `Promise.all([bs, pl, notes, treasury, cashflow, ratios, companyRows, auditRows])` block finished — even though it has zero dependency on any of those seven results (it's only joined onto `vendor_expense`/`customer_margin` afterward, by name). That's one full unnecessary sequential network round trip on every single report load. Folded `loadZohoContacts()` into the same `Promise.all` batch.

**Deliberately not touched**: the CY (calendar-year) branch's `getPreviousFY()` → `loadLedgers(prevFy.id)` chain, which is genuinely sequential (needs the resolved `fy` object first) and sits inside the same function block as a large, carefully-commented, previously-debugged block of logic about `cyLabelFy` fallback behavior (see the route's own inline comment: *"a confusing, confirmed mismatch"* from an earlier bug). A further parallelization there is plausible but was judged not worth the correctness risk in compliance-sensitive period logic for a speculative, modest gain — noted here as a candidate for a future, separately-scoped pass rather than folded in opportunistically.

---

## 3. Two more fixes

### 3.1 Chart.js `Filler` plugin was never registered

`lib/charts/register.ts` registered `CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Tooltip, Legend` but not `Filler`. `components/charts/Sparkline.tsx` (used by `stat_card_sparkline` widgets, including in default tab layouts) sets `fill: true` on its dataset. Chart.js doesn't error on a missing plugin for an option it doesn't recognize — it silently skips the fill and logs a console warning on **every single chart render**: *"Tried to use the 'fill' option without the 'Filler' plugin enabled"* (observed 6× in one page load). Fixed by registering `Filler`. This was a real, if minor, visual defect (sparkline area charts rendering as bare lines instead of filled areas) plus ongoing console noise on every render.

### 3.2 Orphaned dev-server process corrupting production builds

`npm run build` failed twice in a row with `unhandledRejection [Error [PageNotFoundError]: Cannot find module for page: /_document]` during "Collecting page data" — a Pages-Router-shaped error in a pure App Router project with no `pages/` directory. Traced to an **orphaned `next dev -p 4000` process** (PID found via `Get-CimInstance Win32_Process | Select ProcessId, CommandLine`, port-mapped via `netstat -ano`) left running from earlier in this session — it silently reclaimed port 4000 the moment the intended dev server was stopped, and was writing to the same `.next/` directory the build was trying to write to concurrently.

This is the **same class of incident** `CUSTOM-DASHBOARD-TABS.md` §4 already documented once this session (`next build` and `next dev` must never run concurrently against the same `.next` folder on this Windows/OneDrive path) — it recurred because a background dev-server process wasn't fully accounted for before starting a second one, not because of anything new. **Not a codebase bug** — recorded here as an operational lesson: before any `npm run build` on this project, confirm with `netstat -ano | grep :4000` (or the PowerShell equivalent) that nothing is already bound to the port, not just that the command used to stop one is believed to have worked.

---

## 4. Investigated, confirmed *not* bugs

### 4.1 "Customize this view" appears on the Balance Sheet tab

At first glance this looks like a violation of `CONSTRAINTS.md`'s "statutory report layout preservation" rule. Reading `BalanceSheetTab.tsx` (and its own detailed inline comment describing an **earlier, already-fixed** version of this exact bug) shows the real current design: the tab is split into a `supplementaryView` (KPI strip + composition visual — passed to `CustomizableTabPanel`'s `fixedView`, genuinely customizable) and the mandated Schedule III statutory table, which renders unconditionally, directly in `BalanceSheetTab.tsx`, **never** passed to `CustomizableTabPanel` at all. Verified live: entered customize mode on Balance Sheet and confirmed the full statutory table (`EQUITY AND LIABILITIES`, the balance-check row) remained on screen throughout, alongside the customizable KPI strip.

**Documentation gap found in the process**: `docs/CONSTRAINTS.md` §1 currently states *"verified: no `tab_key` wiring exists for `bs`, `pl`, `cashflow`, or `notes`"* — this is now **stale**; `bs` (and presumably `pl`/`cashflow`/`notes`, not independently re-checked in this pass) does have `tab_key` wiring, scoped to a supplementary zone only. Corrected in `CONSTRAINTS.md` as part of this pass (see below) rather than left for a future reader to trip over.

### 4.2 Working Capital / Balance Sheet showing near-zero figures for FY 2025-26

`Trade Receivables —`, `DSO 0d`, `Net Working Capital ₹(0.02)L` initially looked like a broken computation. Switching to FY 2024-25 (which has a full year of real uploaded data) showed the same component rendering correctly with populated figures — FY 2025-26 in this dev database is simply a near-empty financial year (minimal or no Trial Balance data uploaded for it yet), not a code defect. Confirmed by checking real numbers, not assumed.

### 4.3 Smart Alerts flags a real balance-sheet imbalance

Smart Alerts (FY 2024-25, real data) reads: *"Balance Sheet is out of balance by ₹0.84L — review ledger mappings for FY 2024-25."* This ties directly to a gap already documented in `CONSTRAINTS.md` §2: there is no upload-time Σ Dr = Σ Cr validation, so an out-of-balance Trial Balance is accepted and stored as-is. This demo company's real uploaded data genuinely has a small imbalance. **Not touched** — this is real financial data, not something to silently edit or "fix" via a code change in this pass, and the alert system correctly surfacing it is the feature working as designed, not a bug in it.

### 4.4 Report Builder fetches its template list twice on mount

`MyReports.tsx` and `TemplateList.tsx` (both mounted simultaneously on the Report Builder tab — a sidebar list and a main panel) each independently call `fetchTemplates()`. Confirmed via network log (two `GET /api/v1/report-builder/templates`, both 200, ~265 B each). A genuine minor duplicate-fetch inefficiency, but the response is trivially small and the effect imperceptible; **not fixed** in this pass — sharing state between the two components would touch report-builder internals outside this pass's scope for a benefit too small to justify the risk.

---

## 5. Method note — measuring real request latency from the browser

`list_network_requests` (chrome-devtools MCP) reports request/response status but not timing. Latency numbers in this doc were measured with the browser's own Resource Timing API, run via `evaluate_script`:

```js
performance.getEntriesByType('resource')
  .filter(e => e.name.includes('/api/v1/reports/all'))[0].duration
```

This is the real, browser-measured wall-clock duration of the fetch (DNS/connect/TTFB/download), not a proxy or an estimate. `performance.clearResourceTimings()` was called between measurements to avoid picking up a stale entry from a previous request to the same URL.

---

## 6. Full sweep results

All 17 sidebar tabs (Executive Overview, Balance Sheet, P&L Account, Cash Flow, Notes to Accounts, MIS Report, Ratio Analysis, Working Capital, Treasury, Customer Margin, Vendor Expense, Scenario Planner, Smart Alerts, Compliance, Board Pack, Report Builder, Upload/Architecture), checked in both **Live — API** (CFO, Acme Technologies Ltd) and **Sample Data** (unauthenticated) modes, plus Annual/Quarterly/H1-H2/3-Year period views and PDF/Excel export triggers:

- **Zero** console errors.
- **Zero** unexpected network failures (every request `200`/`304`, other than the documented-as-expected `401`s that only occur in Sample mode on auth-gated endpoints, none of which fired in this pass since none of the tabs quizzed touch those endpoints).
- **Zero** suspicious-content matches (`undefined`, `NaN`, `[object Object]`, `TypeError`, error-boundary text) in any tab's rendered output.
- Custom tabs and custom metrics (`CUSTOM-METRICS-UPGRADE.md`) regression-checked clean in this same production build.

---

## 7. Verification

```
npx tsc --noEmit   → 0 errors
npm test           → Test Suites: 7 passed, 7 total / Tests: 249 passed, 249 total
npm run build      → ✓ Compiled successfully, ✓ Generating static pages (46/46)
```

All three fixes (§1, §2, §3.1) are included in the production build these numbers and the §1.3 latency table were measured against — `npm start` after `npm run build`, port 4000, dev server confirmed stopped first (see §3.2).
