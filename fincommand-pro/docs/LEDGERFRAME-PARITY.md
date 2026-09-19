# LEDGERFRAME-PARITY.md — Implementation Log

Closing every custom-dashboard / custom-metric capability the reference app "Ledgerframe" (`localhost:8080`, see `ledgerframe-integration-blueprint.md`) had and FinCommand did not. Two rounds:

- **Round 1 (2026-09-18)**: metrics built from ledgers, metrics built from other custom metrics plus functions, custom metrics in charts and tables, version history with restore, a template gallery, role-based sharing, and exporting the on-screen layout.
- **Round 2 (2026-09-19)**: mixed bar + line charts on a second axis, number-based filter conditions and aggregations, a warn level and a comparison choice, PowerPoint / CSV / PNG exports, and horizontal bar, ratio card and KPI group widgets.

A side-by-side parity test of both apps (functionality, formulas, structure) was run between the rounds. Ledgerframe bugs found there: its `avg_per_month` divides by 18 instead of 6, and it keeps showing a stale preview when a formula becomes invalid. FinCommand results matched hand-calculated figures in every case.

---

## 1. Round 1 — what was built

### 1.1 Ledger metrics (`definition_kind = 'ledger'`)
A metric can be defined straight from Trial Balance ledgers ("ledger name contains Salary AND Note = 23") instead of a formula.
- **Model**: `LedgerMetricSpec` in `lib/financial/tb-engine.ts` — `match` (all/any), `conditions`, `measure` (movement / closing balance), `sign` (natural / inverted), `aggregation` (round 2).
- **Computed server-side only** (`computeLedgerMetric()`), so raw ledgers never leave the server. Values are delivered in `ReportBundle.custom_metric_values` from `/api/v1/reports/all`, using the same CY-merged ledger array every statement uses, so a ledger metric can never disagree with the statements about which months "the period" covers.
- A spec with no conditions matches **nothing**. Summing every ledger across mixed Dr/Cr normal balances is meaningless. Zoho parent/group rows (`is_child_present`) never match, so a group and its children are never double-counted.
- **Live preview**: `POST /api/v1/custom-metrics/preview` returns the value, its comparative, the trend and exactly which ledgers matched (top 25), so an accountant can see that "contains Salary" did not also pick up "Salary Payable".

### 1.2 Custom metrics built on other custom metrics, plus functions
- New functions: `abs`, `round`, `coalesce`, `percent_change`, `avg_per_month` (plus the existing arithmetic, `percent_of`, `min`, `max`).
- **Reference graph**: `findDependencyCycle()` rejects cycles at save time and names the path. Nesting is capped at `MAX_CUSTOM_NESTING = 5`. Evaluation depth (`MAX_DEPTH = 8`) is bounded separately per metric. A cycle that somehow reached storage evaluates to null rather than recursing.
- `DECISIONS.md` §5 is updated accordingly: the "never another custom metric" constraint is replaced by validated, bounded references.

### 1.3 Custom metrics in charts and tables
`customMetricCapabilities()` decides where a custom metric can appear:
- **Line/bar charts, sparklines and monthly tables**: when every input has a real monthly trend.
- **Donuts, ranked tables and horizontal bars**: ledger metrics only, one row per matched ledger.

The picker and inspector offer a metric only where it can really fill the widget.

### 1.4 Version history with restore
- New table `custom_metric_versions`. Every save writes a snapshot in the same transaction as the definition, so the two can never disagree.
- Optimistic concurrency via `expectedVersion`: a stale edit returns 409 instead of silently overwriting someone else's save. Creating a metric with a key that already exists also returns 409.
- A restore is recorded as a new version, never a rewrite of history.
- `diffSnapshots()` names exactly which fields changed.

### 1.5 Template gallery, copy a tab, role-based sharing
- **Templates**: `lib/dashboard-builder/templates.ts` holds six starters (CFO snapshot, profitability, liquidity, cash & treasury, board summary, cost control). A new custom tab can also copy another tab's layout.
- **Sharing**: `custom_tabs.visibility` = company / roles / private, plus `shared_roles`. It is enforced server-side in `resolveTabKey()` / `loadCustomTabs()` / `getCustomTab()` (`lib/dashboard-builder/tab-access.ts`). Admin and the creator always see the tab.

### 1.6 Exporting the on-screen layout
`lib/exports/dashboard-layout-export.ts`:
- `buildLayoutExportModel()` is a pure function: widgets plus the exact resolved metrics the grid rendered go in, typed blocks come out. An export can therefore never show a different number than the screen.
- The PDF renderer keeps the grid's side-by-side placement and embeds each chart's own canvas as a JPEG capped at 1400 px (a raw PNG per chart made a one-page export about 3 MB).
- The Excel renderer writes real numbers with native number formats.

---

## 2. Round 2 — what was built

### 2.1 Mixed bar + line charts with a second axis
- `WidgetSeriesBinding.renderAs` (bar/line) and `.axis` (left/right) are parsed and stored. `renderAs` was already in the schema but unused.
- `MultiSeriesWidget` now renders through react-chartjs-2's generic `<Chart>`. Each series is drawn as bars or a line against `y` or `y1`. Each axis is formatted by the first series plotted on it, and the right axis draws no gridlines.
- `BarController` and `LineController` are registered explicitly in `lib/charts/register.ts`.
- Lines are drawn over bars. The legend and tooltip keep series order, not draw order.
- When "Stack series" is on, only bars on the same axis stack; a line is never added on top of the bars it is read against.
- A lone right-axis series falls back to the left axis.
- Inspector: per-series "Bars / Line" and "Left axis / Right axis" selects on line and bar charts.

### 2.2 Number-based conditions and aggregations
- **New field**: `amount`, which is each ledger's own figure for the selected period (after measure and sign). Matching is decided once, on the whole period.
- **New operators**: `gt`, `gte`, `lt`, `lte`, `between` [lo, hi], `is_empty`, `is_not_empty`.
- `validateLedgerSpec()` rejects number-only operators on text fields (and the reverse), non-numeric values, and `between` bounds given the wrong way round. The builder offers only the operators the server accepts for the chosen field.
- **Aggregations**: `sum` (default, over all matched ledgers), plus `avg`, `count`, `min` and `max` over ledgers **with non-zero activity**, so a dormant ledger never drags an average down. With nothing active, avg/min/max are `null`, never a fabricated 0. The trend is aggregated the same way, month by month.
- Choosing "Number of ledgers" switches the display format to a plain number, unless the user has already chosen a format.

### 2.3 Warn level and comparison choice
- **Warn level**: `custom_metric_definitions.warn_value`, carried as `MetricThresholds.warn`. `thresholdStatus()` in `dashboard-builder-engine.ts` is the single judgement used by every widget, the builder preview and every export:
  - **good**: target met.
  - **warn**: between the warn level and the target.
  - **bad**: past the warn level.

  The warn level must sit on the bad side of the target (validated in both the engine and the UI).
  - **Widgets**: amber `.wn` tone.
  - **Gauge**: green / amber / red. Gauges without a warn level keep their previous two-colour behaviour.
- **Comparison**: `custom_metric_definitions.comparison` = `prior_year` (default, what every metric did before) / `prior_period` / `none`.
  - `priorPeriodOf()`: Q2–Q4 and H2 compare against the previous quarter or half of the same year. Q1, H1 and whole years compare against the previous FY. In CY mode only within-year steps exist; otherwise the result is null.
  - `reports/all` builds a `prior_period` bundle (statements plus ledger-metric values; notes carry totals only) **only when some metric asks for it**. This is about 180 KB on a 950 KB report for this company.
  - `priorPeriodView()` evaluates formula metrics against that bundle, with year-on-year functions nulled rather than answered for the wrong year.
  - Labels read "YoY" or "vs prior period" everywhere. A missing comparative shows no change figure, never a guess.
- Old version snapshots without these fields read as "no warn, prior_year" and diff as unchanged.

### 2.4 New widgets
| Type | Series | What it shows |
|---|---|---|
| `hbar_chart` | exactly 1 (breakdown metrics only) | A metric's breakdown as ranked horizontal bars (default top 8, configurable 1–25); negative rows in red |
| `ratio_card` | exactly 2 (numerator, denominator) | a ÷ b as a % or a multiple, with the change in points / x against the comparative, only when both sides compare against the same kind of period (`ratioOf()`) |
| `kpi_group` | 2–6 | Headline figures side by side, each with its own tone and change line |

- `WIDGET_MAX_SERIES` is enforced server-side for these three types (400 with a clear message). The inspector trims series when the widget type changes.
- A new ratio card takes its title from both metrics ("A ÷ B").
- The DB `widget_type` CHECK was updated in **both** `db/schema.sql` and `lib/db/neon.ts` at the time. *(Since DB Phase 0, `neon.ts` no longer re-applies it at pool start — a new widget type now needs a migration in `db/migrations/`.)*

### 2.5 PowerPoint, CSV and PNG exports
A single **Export ▾** menu replaces the separate PDF/Excel buttons: PDF, PowerPoint, Excel, CSV, Image.
- **PowerPoint** (`pptxgenjs`, loaded on demand):
  - A cover slide.
  - KPI tiles: single cards grouped 8 per slide in reading order; a KPI group gets its own slide.
  - **Native, editable charts**: a mixed chart becomes a PowerPoint combo chart with the right-axis series on a secondary axis.
  - Tables that page automatically.
  - pptxgenjs gotcha, documented in code: for a combo chart the second argument must be `null`, because `data || options` treats `[]` as truthy.
- **CSV**: one flat table (`Widget, Widget type, Metric, Row, Label, Value, Unit, Formatted`).
  - `Value` is a plain number in the view's unit; `Formatted` is the screen text.
  - UTF-8 BOM and CRLF line endings.
  - User-authored text starting with `= + - @` is neutralised against formula injection; the app's own signed numbers are left alone.
- **PNG** (`html-to-image`, loaded on demand): the grid exactly as on screen, under a header band naming the company, view and period, at 2× (1× for very long views).
- **Excel/PDF updates**: "Comparative / Change / Compared with" columns, "Warning" status, ratio rows with their two parts, and horizontal bar breakdowns.

---

## 3. Migration

`db/schema.sql` is idempotent and was applied to the live database on 2026-09-19. It adds:
- `custom_metric_definitions.comparison VARCHAR(20) NOT NULL DEFAULT 'prior_year'` plus a CHECK constraint.
- `custom_metric_definitions.warn_value NUMERIC(18,4)`.
- The widened `dashboard_widgets_widget_type_check`.

Existing metrics defaulted to `prior_year`, so there is no behaviour change for them. Round 1's migration added `definition_kind`, `ledger_spec`, `description`, `version`, `updated_by`, the `custom_metric_versions` table (with a backfill), and `custom_tabs.visibility` / `shared_roles` / `started_from`.

## 4. Verification (2026-09-19)

- `npm run typecheck` clean. `npm test`: **12 suites, 387 tests passed** (343 before round 2). New tests cover:
  - Numeric operators, the amount field, aggregations and `priorPeriodOf`.
  - Warn and comparison validation, resolution and snapshots.
  - `thresholdStatus`, `ratioOf`, and series limits.
  - The export model for the new widgets, Excel warn/comparison columns and CSV escaping.
  - A real PowerPoint deck built in Node and unzipped, asserting a bar+line combo chart with 2 value axes.
- `npm run build` clean (lint included).
- **Live, on the QA tab** (never on a real tab):
  - A metric "expense ledgers with annual movement > ₹1,00,000, counted" previewed 23 against 28 last year. Raw SQL gave FY 2025-26 = 23 and FY 2024-25 = 28, an exact match.
  - Warn level: a warn of 15 with a lower-is-better target of 20 was blocked in the UI. With a warn of 25, 23 renders amber.
  - Ratio card: 51.4%, −5.7 pts YoY. From the raw bundle: 16,676,282 ÷ 32,475,586.58 = 51.35%; last year 57.09%.
  - The mixed chart shows revenue bars on the left axis in ₹ Lakhs and EBITDA margin % on the right axis.
  - All five exports were captured in the page and inspected:
    - CSV: BOM present, rows match the screen.
    - PowerPoint: 12 slides, 7 native charts, a combo chart with 2 value axes, and a horizontal bar with `barDir=bar`.
    - PNG: 2242 × 4912.
    - PDF: 2 pages.
    - Excel: written.

## 5. Known limits
- `amount` means the ledger's figure for the whole selected period. A monthly trend point re-aggregates the same matched ledgers; it does not re-filter per month.
- A previous-period comparison for a *formula* metric appears in the builder preview only after the first save, because the bundle builds previous-period statements only once some saved metric asks for them. The builder says so.
- PowerPoint charts are native (editable) rather than screenshots, so fonts and spacing follow PowerPoint's own chart styling rather than the app's.
