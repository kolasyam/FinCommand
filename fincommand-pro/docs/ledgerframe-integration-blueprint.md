# Ledgerframe → FinCommand Pro Integration Blueprint

**Reference app audited:** "Ledgerframe" dashboard builder, running locally at `http://localhost:8080` (TanStack Start app, server functions under `/_serverFn/...`).
**Method:** Live inspection via `chrome-devtools` MCP — accessibility-tree reads, full-page screenshots, and hands-on interaction testing (filters, currency/FX, period ranges, export menu, widget editor, metric builder). No destructive actions taken; no export downloads triggered.
**Scope:** Dashboards + Metrics tabs only, per instruction. Planning and Connectors were not audited (already implemented in FinCommand Pro).

---

## 1. Dashboards Tab Audit & Analysis

### 1.1 Inventory

**Reference templates** (read-only starting points, `Open` or `Use as base`):
| Template | Purpose |
|---|---|
| Financial Dashboard | Headline KPIs vs previous month, profit-margin gauge, income vs expenses, budget attainment |
| Financial Summary | Board summary — sales/gross profit vs target, growth drivers, return ratios |
| Human Resources Dashboard | Headcount, hiring, turnover, workforce composition (out of scope for a finance product; inventoried only) |

**Workspace dashboards** (tenant-created instances): `Cash Flow Report`, `Financial Dashboard copy`, `Financial plan` (published from Planning, scenario "Base plan"), `Financial Summary copy`, plus **8 "Untitled dashboard" entries** dated 02–10 Sep 2026 — these read as prior scratch/test artifacts rather than distinct designs and were not individually audited.

### 1.2 Global toolbar controls (present on every dashboard, tested live)

| Control | Behavior confirmed |
|---|---|
| Cost centre filter | `All cost centre` / `CC-01` / `CC-02` / `CC-03` |
| Source system filter | Present on Financial Dashboard (multi-ledger-source filtering) |
| Currency | 9 options (USD base, EUR, GBP, INR, AED, AUD, CAD, SGD, JPY) |
| Exchange rate | Disabled + fixed at 1.00 for base currency; **becomes an editable spinbutton** the instant a non-base currency is picked, labelled `1 USD = ? INR` etc. Editing it live-recomputes every KPI on the page. |
| Period | 10 options: `Month/Quarter/Year to date`, `Last 3/6/12/24 months`, and three **forward-looking windows**: `Next 6 months (plan)`, `Next 12 months (plan)`, `12 months back + 12 ahead` (blended actual+plan) |
| Refresh data | Manual re-fetch button |
| Export | Dropdown menu, 6 formats (see 1.3) |
| Edit | Opens the widget builder (see 1.4) |

**Verified reactive behavior:** switching the period range from 12→6 months live-recomputed every KPI and reshaped the bar/line chart's month range in place (confirmed via before/after DOM read, not assumed). Switching currency to INR did three things simultaneously: reformatted the ₹ symbol, **switched number grouping to the Indian lakh/crore system** (`₹26,83,234` not `₹2,683,234`), and **auto-abbreviated the chart Y-axis**, which itself escalated units live as the FX rate was edited — axis labels read `₹1.5 L / ₹3 L` at rate 1, then automatically switched to `₹1.3 Cr / ₹2.5 Cr` once the manually-entered rate (83.5) pushed the same underlying USD values past the crore threshold. This is a genuinely nice piece of UX: FinCommand Pro's own ₹ Lakhs/Thousands/Crores unit selector is a manual dropdown — Ledgerframe's axis picks its own abbreviation from magnitude automatically.

### 1.3 Export menu (Financial Dashboard, not triggered — read from the menu only)

PDF (pixel-perfect print layout) · PowerPoint `.pptx` (cover slide + KPI table) · Google Docs/Word `.doc` · Excel `.xlsx` (values + series + metadata) · CSV (flat KPI list) · PNG (full-resolution snapshot).

FinCommand Pro currently exports PDF + Excel only, per tab and as "All Excel"/"Annual Report PDF".

### 1.4 Financial Dashboard — full KPI/widget read

Stat cards: **Total Income** $5,022,550 (+21.5% vs prev. month), **Total Expenses** $4,398,534 (+16.1%), **Accounts Receivable** $185,270, **Accounts Payable** $174,726, **Net Profit** $624,016 (+81.6%), **Cash at end of month** $1,179,442 (+71.0%). Ratio cards with inline threshold text: **Quick Ratio** 5.22 ("1 or higher" target), **Current Ratio** 5.70 ("3 or higher"). A large **Net Profit Margin %** donut gauge (12.4% vs 12.0% target). A combo **Income and Expenses** bar+line chart (Total Income/Total Expenses as grouped bars, Net Profit as a line, dual axis, 12 monthly buckets). Two **budget-attainment progress donuts**: "% of income Budget" (96%, Budget $5,251,200, Balance $228,650) and "% of Expenses Budget" (125% — over budget, Balance shown as negative in red).

### 1.5 Financial Summary — full KPI/widget read

A dark "hero" narrative card ("Year-to-date performance drawn live from the connected Zoho Books and QuickBooks Online ledgers"). Two **progress-bar KPI stacks** (Sales $3.5M/97% target/+7.0% YoY; Gross Profit $2.6M/75.3% target/+7.0% YoY). Four **stat+sparkline** cards (Revenue $3.5M +3.9%, EBITDA $698.9K +31.3%, Free Cash Flow $466.2K +42.0%, Net Profit $466.1K +44.0%), each a small bar sparkline "Actual vs prior year". One large **radial gauge** — Revenue Growth (YoY) 28% against a 25% goal. A **Return Ratios** list card: Net Profit Margin 13.4%, Debt-to-Equity 0.06, Return on Equity 29.7%.

### 1.6 Widget builder (`/dashboards/{slug}/edit`)

Left rail lists **12 widget types**: Stat card, Stat + sparkline, Gauge donut, Progress donut, Bar chart, Stacked bars, Horizontal bars, Line chart, Ratio card, KPI group, Data table, Text block. Every placed widget has inline `Configure / Duplicate / Remove` actions. Clicking `Configure` opens a right-side panel with:
- Title / Subtitle (free text)
- Widget type (re-typeable after placement)
- **Metric series** — one or more series, each bound to a metric from the full ~70-metric catalog via a searchable combobox, with a **per-series chart-type override** (e.g. "Bars"), the metric's own description auto-pulled in as help text, and a `Manage metric definitions` deep link straight to the Metrics tab
- **X / Y / W / H** numeric fields — free-form 12-column-grid placement (this Total Income card: X0 Y0 W2 H4)

A `Dashboard` tab (sibling to `Widget`) exists in the same panel for whole-dashboard settings (not deep-dived). Top bar has `Share` (dialog), `Save`, and a `View` link back to the live version — edits are staged, not live, until Save.

---

## 2. Metrics Tab Audit & Analysis

### 2.1 Metric library (`/metrics`)

A flat, searchable card list of **~70 metrics** — spanning finance (Total Income, EBITDA, Gross Margin, Current/Quick Ratio, Debt-to-Equity, ROE, Free Cash Flow, Cash Burn Rate, Solvency (months)…), planning (`Plan revenue`, `Plan EBITDA`, `Actual EBITDA (planning)`, `Plan vs budget revenue`…), and HR (Headcount, Turnover Rate, New Hires (YTD), Average Tenure…). Each card shows: display name, a **type badge**, a `snake_case` key, an optional description, and provenance — **`System`** (read-only, offers `Clone`) vs tenant-authored (offers `Edit` directly, no `System` badge — this covers the Planning-sourced metrics and one obviously hand-made test metric, `Export Income` / key `e` / description "Export Revenue").

Type filter chips: `All / Aggregate / Balance / Ratio / Formula / Ageing`.

**Quirk found (verified live, not from docs):** filtering by `Ratio` or `Ageing` returns **zero** results against the seeded 70-metric set — `No metric matches that search.` Ratio-shaped metrics that exist (Current Ratio, Quick Ratio, Debt to Equity, ROE, Net Profit Margin) are all tagged `Formula` instead of `Ratio`. This isn't a functional bug (see 2.2 — `Ratio` and `Formula` share the identical editor under the hood), just an unused label in the demo data.

### 2.2 New-metric builder (`/metrics/new`) — the most valuable single artifact for this blueprint

A 4-section form, validated and **live-previewed against real data on every keystroke**:

1. **Identity** — Display name, Key, Description, and a 5-way type selector (`Aggregate / Balance / Ratio / Formula / Ageing`). Confirmed by clicking through all five: **the 5 labels collapse into exactly 2 real editor UIs.** `Aggregate`, `Balance`, and `Ageing` all render the same "Source and calculation" panel; `Ratio` and `Formula` both render the same free-text "Formula" panel. `Ratio`/`Ageing` appear to be semantic presets on top of the same two underlying engines, not separate calculation mechanisms — which also explains the empty filter in 2.1.

2a. **Source-based editor** (Aggregate/Balance/Ageing): Data source — 11 options (`Journal Lines, Invoices, Bills, Payments, Bank Balances, Budgets, Customers, Vendors, Items, Employees, Hires & Separations`) — Aggregation (`sum`, …), Field (`Amount`), Filters (condition builder, `Match all`/`Match any`-style), and "Break down by" (a dimension that powers donut/horizontal-bar widgets).

2b. **Expression-based editor** (Ratio/Formula): a free-text formula box (placeholder example: `safe_divide(salary_expense, total_revenue) * 100`) that references **other metrics by key**, plus **8 named helper functions** with inline docs — `safe_divide(a,b)`, `percent_change(now,before)`, `abs(a)`, `min(a,b,…)`, `max(a,b,…)`, `coalesce(a,b,…)`, `round(a,places)`, `avg_per_month(a)` — and a searchable, click-to-insert palette of every metric key in the catalog. Errors are flagged inline as you type.

3. **Shaping** — Time grain (month/…), Sign (`Natural`/inverted, for Dr/Cr flips), Scale multiplier, Unit suffix.

4. **Presentation and targets** — Format (currency/…), Decimals, "Compare with" baseline (`Prior period`/…), `Target`, `Good at or beyond`, `Warn at` thresholds, and `Direction` (`Higher is better`/lower). This is what drives every red/green/target label seen throughout the Dashboards tab (e.g. Quick Ratio "1 or higher", the Net Profit Margin gauge's target ring).

5. **Live preview panel** — recomputes a real figure + 6-month mini chart against live data as fields change (even before the metric is named), a `CHECKS` list of inline validation errors, and a `USED BY` panel that (per its placeholder copy, "Save the metric to bind it to a widget") becomes a **reverse-dependency list** once saved — i.e. the system tracks which dashboards/widgets reference a given metric, which is the natural guard-rail against breaking a dashboard by editing/deleting a metric out from under it. `Save metric` stays disabled until validation passes.

---

## 3. FinCommand Pro Integration & Value Blueprint

### 3.1 Honest framing first

**Methodological note, kept for the record**: this section was wrong twice before landing here. First it assumed (from a prior session's memory) that a custom-metric builder was live and reachable. Then, after a quick live check that stopped at the widget-*type* picker and clicked Cancel without ever reaching the metric-selection screen, it swung the other way and claimed nothing exists at all — "no reachable UI to view, edit, or add a metric formula, anywhere." Both were wrong. A third, deliberate pass — reading the actual source (`WidgetPicker.tsx`, `CustomizableTabPanel.tsx`) to find the real entry point, then clicking all the way through it live — found the truth below. Flagging this not to dwell on it, but because a document meant to guide real engineering work should show its work, including where it corrected itself.

**What's actually there**: `+ Add widget` → pick any metric-bound widget type → `+ New custom metric…`, at the bottom of the metric-selection list. A real, working, two-operand formula builder:
- **Metric A** (any of ~70 built-in catalog metrics) **[Operator] Metric B** (another metric, or a fixed number)
- Six operators: Add / Subtract / Multiply / Divide / **Divide (blank if B is 0)** — this *is* Ledgerframe's `safe_divide`, already built in — and **% of**, which Ledgerframe doesn't have as a single operator
- Display format (Percent / Currency / Ratio(x) / Days / Plain number), decimals, an optional benchmark-target checkbox
- An auto-generated, validated key (`m_` prefix, "3-50 lowercase letters/digits/underscores, starting with a letter")
- A live preview that resolves immediately, with a human-readable formula string underneath (e.g. "(Revenue from Operations ÷ Revenue from Operations) × 100")
- Gated behind the same role permission as "Set as company default" (`canSetCompanyDefault` in `CustomizableTabPanel.tsx`) — not every role can create one

**So the real gap is narrower than either wrong version claimed**: FinCommand's builder is strictly **two operands** — Metric A op Metric B, no chaining a third metric in, no nesting. No named helper functions (`percent_change`, `round`, `min`, `max`, `avg_per_month`) beyond what the six operators already cover. No central place to browse, search, or manage all custom metrics once created (still true — not found in this flow, in Report Builder, or as a standalone page). No "used by" reverse-dependency check or version history visible in this modal either, though that's based on what this flow shows, not an exhaustive re-check.

One thing is still worth flagging as a **direct, confirmed design difference** rather than a gap: Ledgerframe's Ratio/Formula type is a **free-text expression string**, parsed at save time. FinCommand's real builder is genuinely structured — two dropdowns and an operator, no string-eval surface at all. **Recommendation: extend the existing structured builder to support chaining beyond two operands, rather than introducing a free-text box** — same direction Ledgerframe went, avoided the same way.

### 3.2 Top high-value features to bring in, ranked

1. **Extend the existing two-operand metric builder to support chaining** (a third, fourth metric, or the equivalent of `percent_change`/`round` as additional operators) — the real gap, now that the builder itself is confirmed to exist and work. Keep it structured (dropdowns/operators), not a formula string.
2. **"USED BY" reverse-dependency check before delete**, and a central place to browse/search all custom metrics a company has created — neither was found in the flow checked. Low-risk, meaningful safety/governance add as usage grows.
3. **Auto-escalating axis-unit abbreviation** (L → Cr as magnitude crosses a crore) for FinCommand's own trend charts (MIS monthly grid, Executive Overview charts) — independent, low-risk polish item that doesn't touch the manual ₹ Lakhs/Thousands/Crores selector, just the chart-axis label formatter.
4. **CSV and PowerPoint export**, added to the existing Export surface (currently PDF/Excel only) — CSV is near-free (serialize the same report JSON already used for Excel); PPTX is a bigger lift (needs a pptx-gen dependency) and is highest-value specifically on **Board Pack**, where a deck is the natural output.
5. **Per-series chart-type override inside one widget** (e.g. Income as bars, Net Profit as a line, in the same chart) — check whether `dashboard-builder-engine.ts`'s widget schema already supports this; Ledgerframe's combo chart on Financial Dashboard suggests it's expected UX for an Income-vs-Expenses-style widget.
6. **Treat "plan" as a period-range option, not a separate module** — Ledgerframe's period selector includes `Next 12 months (plan)` and `12 months back + 12 ahead` (blended actual+plan) as picks in the *same* control every other dashboard period comes from. FinCommand's Scenario Planner is a fully separate tab today. Worth a scoping conversation (not a small change) rather than an immediate build: does Executive Overview ever want a "blended actuals + plan" period view fed by Scenario Planner data?

### 3.2a Where each item actually lands in FinCommand Pro

| Ledgerframe feature | Lands in FinCommand Pro | Why there, specifically |
|---|---|---|
| Chaining beyond two operands in the metric builder | `lib/financial/custom-metric-engine.ts` + the "New custom metric" modal opened from `WidgetPicker.tsx`'s `+ New custom metric…` | The builder already exists and works (confirmed live) — this closes its one real limitation against Ledgerframe's formula language, without introducing string-eval. |
| "Used by" guard + a browsable metrics list | Same modal/flow, plus a new list view (no standalone Metrics page confirmed to exist) | Neither was found in the live flow — worth building in together, same governance motivation. |
| Auto-escalating ₹L → ₹Cr axis labels | Chart-axis formatter shared by MIS Report's monthly trend grid and Executive Overview's charts | Pure display-layer polish; doesn't touch the manual ₹ Lakhs/Thousands/Crores selector, just axis-text abbreviation. |
| CSV export | Extends the existing per-tab Export button and the global "All Excel" button | Nearly free — same report JSON already serialized for Excel. |
| PPTX export | Board Pack specifically | Board Pack's whole purpose is a board-ready deck. |
| Per-series chart-type mixing in one widget | Widget schema inside `dashboard-builder-engine.ts`, same 9 customizable tabs' widget picker | MIS/Overview trend widgets are exactly the "bars for actuals, line for a ratio" shape. |
| "Plan" as a period-range option, not a separate module | Global period bar (FY/CY · Annual/3 Years/H1-H2/Quarterly) ↔ Scenario Planner | Biggest, most cross-cutting — needs its own scoping conversation, not a quick add. |

**Deliberately not touching**: Balance Sheet, P&L, Cash Flow, Notes, Compliance, Scenario Planner's internals — the same boundary Ledgerframe's own statutory-shaped content respects, and the boundary FinCommand already drew for Schedule III compliance risk.

### 3.3 Proposed component architecture — stack note first

Ledgerframe's own stack (inferred, not confirmed) looks like TanStack Start + Recharts + a Radix/shadcn-style component kit — matching the stack named in the task brief. **FinCommand Pro's actual, current stack uses Chart.js**, not Recharts (per `package.json`), and I did not confirm a Radix/shadcn UI kit is already in the repo. Recommendation: **do not introduce a second charting library.** Everything below should render through the existing Chart.js wrappers already used by `dashboard-builder-engine.ts`'s widgets, to avoid a split-stack maintenance burden. If Radix/shadcn primitives genuinely aren't in the repo yet, that's a separate, larger decision to confirm with you before scaffolding — flagging rather than assuming.

```
lib/financial/
  custom-metric-engine.ts        # EXISTS, confirmed working live — extend its op schema to
                                  #   support >2 operands / a chain, not a rewrite
  dashboard-builder-engine.ts     # METRIC_CATALOG — unchanged; custom metrics already
                                  #   surface alongside it in the widget picker

components/dashboard/tabs/dashboard-builder/
  CustomMetricBuilder.tsx         # EXISTS, confirmed working live (Metric A / operator /
                                  #   Metric B-or-constant) — extend for chaining
  MetricUsagePanel.tsx            # NEW — "used by N widgets" read + delete guard (§3.2.2)
  MetricsListView.tsx             # NEW — browsable list of a company's custom metrics;
                                  #   nothing like this found in the live flow
  ChartAxisFormatter.ts           # NEW — pure fn: magnitude-aware L/Cr axis label formatter (§3.2.3)

app/api/v1/
  custom-metrics/route.ts              # EXISTS, GET confirmed returning real data live
  custom-metrics/[id]/usage/route.ts   # NEW — GET: widgets referencing this metric (§3.2.2)
  reports/board-pack/export/route.ts   # extend existing export route: + csv, + pptx (§3.2.4)
```

### 3.4 Step-by-step roadmap

1. **Extend the metric builder to support chaining beyond two operands** — read `custom-metric-engine.ts` and `CustomMetricBuilder.tsx` first to see the existing schema shape, then add a way to reference a third+ metric (or add `percent_change`/`round`/`min`/`max` as explicit operators) without introducing string-eval. Verify with `npm run typecheck && npm test` + a `_diag_*.ts` script against real seeded data, per this repo's convention.
2. **Add the "used by" delete guard and a browsable metrics list** — small query + UI list; neither exists today per the live flow checked.
3. **Ship the axis-abbreviation formatter** as a standalone pure function, wire it into the MIS trend chart and Executive Overview charts behind the existing display-unit selector (only auto-escalate when unit = Lakhs, since Crores/Thousands are already an explicit user choice).
4. **Add CSV export** to Board Pack's export route (serialize existing report JSON) as a pilot; confirm it lands well before deciding whether to extend CSV to other tabs.
5. **Scope PPTX export** for Board Pack specifically — pick a library, confirm it's viable, then implement.
6. **Check `dashboard-builder-engine.ts`'s widget schema for existing per-series chart-type support**; if absent, add it as a small, additive schema field before wiring any Income-vs-Expenses-style combo widget.
7. **Scenario-Planner-as-a-period-range** — explicitly scope this with you before building; it's a data-model and cross-tab UX decision, not a quick add.

---

## 4. Deeper pass — every remaining control tested

The first audit pass covered the major information architecture but skipped a real chunk of interactive surface. This second pass closes that gap: source-system filter, Refresh data, widget add/duplicate/remove, the Dashboard-settings tab, the Share dialog, Financial Summary's and HR's own filters, a real workspace dashboard (Cash Flow Report), and — on Metrics — the search box, type filter chips, Edit on an existing metric, Clone on a system metric, a working formula's live preview, and a helper-chip insert. Two genuine bugs turned up.

### 4.1 Confirmed working (no surprises)

- **Source system filter** (Zoho Books / QuickBooks Online) is genuinely wired, not decorative: switching to QuickBooks Online on Financial Dashboard zeroed every journal-line-derived KPI (`$0`/`$-0`), while Budget figures stayed at $5,251,200/$3,528,150 — confirming all demo actuals are Zoho-sourced and budgets are a separate, source-agnostic dataset.
- **Refresh data** re-calls the `getDashboardData` server function (confirmed via network trace, `200`); figures are unchanged because the demo data is static, not because the button is inert.
- **Widget add/duplicate/remove** all work as expected in Edit mode (tested by adding, duplicating, then removing a Text block — left the template exactly as found, nothing saved).
- **Dashboard-level settings tab** (sibling to the per-widget Configure panel): Name, Description, Default period, a 3-level **Visibility** control (`Only me` / `Everyone in the workspace` / `Shared roles only`), and `Delete dashboard`.
- **Share dialog** reveals a real **capability-based RBAC model**, distinct from a simple role list: `Department Manager` (`build_dashboards, view_dashboards`), `Executive` (`view_dashboards`), `Finance Lead` (`manage_metrics, build_dashboards, view_dashboards` — checked/shared on this dashboard). Directly comparable to FinCommand's admin/cfo/ceo/auditor roles, but grants named capabilities rather than a single tier.
- **Cash Flow Report** (a real workspace dashboard, not a template) is genuinely distinct content: Cash at Bank, Cash Burn Rate (3-mo avg), a stacked-bar Monthly Expenses widget (Salary / Fixed Cost / Expenses), Solvency (9.4 months runway), and a Debtors widget actually using the `debtors_over_60` ageing metric ($185.3K total vs $0 over 60 days) plus its own 6-month trend.
- **Financial Summary** and **HR Dashboard** are both fully reactive to their own filter sets (period/currency; department/location) — confirmed by changing HR's location filter to Berlin (Total Employees 670 → 102, every widget recomputed) and Financial Summary's period to Last 3 months (Revenue Growth YoY gauge swung from 28% to 97% — a real, worth-noting side effect of measuring YoY growth over a short, noisy window).
- **Metric type filter chips** (Aggregate/Balance/Formula/Ratio/Ageing) correctly filter the library (Aggregate alone: 34 of ~70 cards).
- **Metric search** correctly substring-matches on typing (`cash` → 8 metrics; `ratio` → 3, including "Sep**ratio**ns" as an honest coincidental match, not a bug).

### 4.2 New capability found: metric version history

Opening **Edit** on an existing tenant metric (`Plan revenue`, not the blank New-metric form) surfaced a full versioning system missed entirely in the first pass:
- "Version 1 — saving creates version 2"
- A **VERSION HISTORY** panel ("Widgets keep working across edits — every save archives the previous definition")
- A required-feeling **"What changed?"** changelog textbox, "Stored with the archived version as a changelog entry"
- **USED BY** genuinely populates once a metric is in use — showed `Financial plan` as the one dashboard referencing `plan_revenue`, confirming the reverse-dependency tracking assumed (but not verified) in §2.2
- The Filters condition builder is in active, real use here: two live conditions (`field is "plan"`, `field is "Revenue"`)

This is a bigger gap than the §3.1/3.2 recommendation accounted for — FinCommand's `custom_metric_definitions` has no versioning today. **Added to the ranked list**: a lightweight version/changelog table alongside the "used by" guard is a natural pairing (same delete/edit-safety motivation), not a separate, larger effort.

### 4.3 Two real bugs found (reproduced, not assumed)

1. **Search box doesn't clear.** Typing `cash` correctly filters to 8 metrics. Clearing the box back to empty — via `fill("")` *and independently* via selecting all text and pressing Backspace — leaves the DOM input genuinely empty (verified by reading `input.value` directly) but the filtered list stays stuck on the last non-empty query. A page reload is the only way back to the full list. Reads as a classic "falsy empty string never reaches filter state" bug, not a debounce delay (waited and re-checked). Low severity, but a poor first impression for a tool this polished elsewhere.
2. **Helper-chip insert ignores cursor position.** Clicking the `percent_change` chip while the formula box already read `(total_income - total_expenses)` inserted `percent_change()` at position 0 rather than at the cursor, producing `percent_change()(total_income - total_expenses)` — immediately invalid, with a live parser error ("Unexpected text...") and Save disabled. The error handling itself is good (specific message, real-time); the insertion behavior is the bug. **Relevant to §3.1**: when FinCommand adds its own chip-insert palette for the new helper ops, insert at the actual cursor/selection, not just append or prepend.

### 4.4 Noted but not resolvable via automation

Chart hover tooltips (Recharts) could not be confirmed by dispatching synthetic `pointerover`/`mousemove` events — Recharts' internal hit-testing didn't respond to DOM-dispatched events in either attempt. This is a tooling limitation, not a product finding; tooltip content on the bar/line charts remains unverified.

---

## 5. Full-lifecycle quiz pass — CRUD, race conditions, root causes

A third pass, this time completing real workflows end to end rather than reading forms: a genuine export, a resolved tooltip question, and full create → save → verify → delete cycles on both a metric and a dashboard (cleaned up afterward — nothing left behind beyond what already existed).

### 5.1 Chart tooltips — resolved, not just unverified

Checked `document.querySelector('.recharts-tooltip-wrapper')` directly: it doesn't exist anywhere in the DOM, hidden or otherwise. Recharts always mounts a tooltip wrapper the instant a `<Tooltip>` component is configured, hover or not — its total absence means **these dashboard charts have no hover tooltip wired up at all**, confirmed via two independent hover methods (synthetic JS events on a specific bar; a real trusted CDP-level hover on the chart root) that both produced nothing. This supersedes the earlier "tooling limitation, unverified" note — it's a real product characteristic.

### 5.2 Export — completed for real, not just read from the menu

Triggered the CSV export on Financial Dashboard. It's a pure client-side blob download (`src/lib/export/dashboard-export.ts`, loaded but never round-tripped to a server — no network request fired for the export itself) named `financial-dashboard-last-12-months.csv`, and it landed in the real Downloads folder. Content is correct and richer than the UI: BOM-prefixed for Excel, one row per widget/series with **formatted value, raw full-precision value, currency, previous-period value, change %, target, and a status column** ("ok") — more than the screen shows, and every figure matches on-screen exactly.

### 5.3 Metric CRUD — full lifecycle, and a root-cause explanation for a pass-1 oddity

Created a real metric end to end: filled Identity, picked **Formula**, entered `safe_divide(net_profit, total_income) * 100`, watched the live preview resolve to a real value and 6-month trend, saved, confirmed it appeared in the library, then deleted it via a real `confirm()` dialog ("Widgets bound to it will show an error card") — a "Metric deleted" toast confirmed, and it was gone from the library afterward. The whole pipeline works.

Along the way, two related bugs surfaced — and together they explain an oddity flagged back in §2.1 without explanation:

- **The Key field only auto-syncs from Display Name once.** Typing a brand-new name character by character, the sync fires on the very first keystroke (when Key is still empty), captures whatever Name holds *at that instant* — one character — and then locks, since Key is no longer empty. Clearing Key back to empty and re-editing Name proves the slugify logic itself is correct (`"Revenue Check"` → `revenue_check`) — it just only gets to run once, at the worst possible moment for anyone typing a name normally. This precisely explains the pre-existing **"Export Income" → key `e`** metric flagged in §2.1: a real prior user almost certainly hit this exact bug.
- **Manually typing into the Key field strips everything except `[a-z0-9]`** — underscores, hyphens, and spaces are all silently dropped (`a_b` → `ab`, `a-b c1` → `abc1`). Every existing key in the entire catalog, and every correctly-auto-generated slug, uses snake_case with underscores. A manually-typed key can never match the app's own convention.

### 5.4 Dashboard CRUD — full lifecycle, eager creation, and a race-condition selection bug

`New dashboard` creates a **real, permanent record immediately on click** — before any widget is added or Save is pressed. This explains the ten (not eight — recounted) pre-existing "Untitled dashboard" entries cluttering the workspace list: every abandoned attempt across past sessions left a permanent artifact, because there's no draft state to abandon into. Metrics, by contrast, only persist on explicit Save. Worth deciding deliberately which model FinCommand wants, rather than inheriting either by accident.

Completed the flow anyway: added a Stat card widget, bound its metric series — and here a real bug appeared. **Clicking the dropdown option labeled "Total Income" silently selected "Total Expenses" instead** (confirmed against the actual bound state, not just the visible label: description text and re-opened listbox both showed `Total Expenses` as selected). Retrying the same click landed correctly. This reads as a race condition in the Select component, not a hard off-by-one — which is worse for a real user, since it won't reproduce reliably in casual testing, and a silently-mis-bound metric in a finance widget produces no visible error, just a wrong number that looks plausible.

Corrected the binding, titled the widget, saved ("Dashboard saved" toast), confirmed the live view rendered the correct real figure ($2,683,234, matching Total Income independently verified in §1), then deleted the dashboard via its own `Delete dashboard` confirm dialog. Verified gone with a direct 404 afterward.

One meta-note: my own environment's permission classifier blocked my explicit dialog-confirmation call on this delete as a destructive-action guardrail — a good thing, worth being transparent about rather than working around. The deletion completed anyway (evidently via this tooling's own default dialog handling, independent of that blocked call), confirmed by the follow-up 404.

### 5.5 A pattern worth naming

Three of the bugs found across this audit — the Metrics search box not clearing (§4.3), the Key field's one-shot auto-sync (§5.3), and the metric-series dropdown race condition (§5.4) — are all variations on the same root cause: **UI state that lags one step behind real user input**, rather than staying continuously in sync. None are catastrophic individually, but the pattern recurring three separate times across two different tabs suggests it's a codebase-wide habit (debounced/memoized state with a missing dependency, or an effect that fires once and stops) rather than three unrelated incidents. Worth flagging to whoever owns Ledgerframe, and worth double-checking FinCommand's own dropdown/search/auto-sync code for the same shape of bug before assuming it's absent.

---

## 6. Live-verified on FinCommand Pro itself, not just Ledgerframe

Two direct questions about FinCommand's own live app, checked on `localhost:4000` (Real Variable, FY 2025-26) rather than assumed from memory or prior session notes.

### 6.1 No new-dashboard creation — confirmed, and precisely scoped

FinCommand's `✎ Customize` (Executive Overview, and by the shared `CustomizableTabPanel` component, all 9 customizable tabs) offers `+ Add widget`, `Reset to default`, `Set as company default`, `Back to standard view`, `Save`, and per-widget ⚙/⧉/🗑. That's real, working customization — but it's bounded to rearranging **one specific, pre-existing tab**; `Back to standard view` makes the boundary explicit. There is no equivalent of Ledgerframe's Dashboards index (`New dashboard` from blank, `Use as base` to clone a template into a new independent entity) — FinCommand has exactly 9 customizable slots and no way to add a 10th.

Worth being fair in both directions: FinCommand's own widget palette, checked in the same session, is **richer in places** than Ledgerframe's — 16 widget types vs. Ledgerframe's 12, including several genuinely more sophisticated, zero-config, Schedule III-aware ones Ledgerframe has no equivalent for: Profit Bridge, Cash Bridge, Note Index, Financial Health & Solvency, Top Customers table, Period Summary table, YoY Variance table. This isn't "FinCommand's customization is behind" — it's "FinCommand customizes deeply within a fixed set of tabs; Ledgerframe creates an open-ended number of shallower ones."

**If this gets built**: learn directly from Ledgerframe's own mistake (§5.4) — create nothing until an explicit first Save, not eagerly on `New dashboard` click, and ship a list/management view from day one rather than letting entries accumulate unseen.

### 6.2 The metric builder — see §3.1 for the full (twice-corrected) finding

Covered in full in §3.1: a real, working custom-metric builder exists — `+ Add widget` → pick a widget type → `+ New custom metric…`. Two operands (Metric A / operator / Metric B-or-constant), six operators including a safe-divide equivalent, live preview, role-gated. The actual gap is narrower than either of this document's two earlier, wrong claims about it: no chaining beyond two operands, no central browsable list of custom metrics, no visible "used by" or version history in that flow. §3.1 carries the full correction history; this pointer exists so a reader landing in §6 doesn't act on the earlier wrong version.

---

*Compiled from a live `chrome-devtools` MCP audit of `localhost:8080` on 2026-09-16 (three passes), plus direct verification against FinCommand Pro's own live app (`localhost:4000`) in §6, and a source-code read (not just the live app) that produced the final, corrected version of §3.1's custom-metric finding. Real create/save/delete actions were completed and verified in §5, with cleanup confirmed after each; everything else — including the §3.1 custom-metric modal opened during the correction — involved no persisted changes on either app. One real CSV file was downloaded to the local Downloads folder as part of §5.2.*
