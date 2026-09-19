/**
 * FinCommand Pro — "My Dashboard" custom widget builder engine.
 *
 * This is deliberately NOT a generic metric-formula/filter-DSL engine (the
 * shape a from-scratch "dashboard builder" project would normally reach
 * for). tb-engine.ts already computes a complete, correct ReportBundle for
 * the selected company/FY/period — a second, generic computation path
 * reading raw ledgers directly would risk disagreeing with it, which is
 * exactly the "every report must agree with every other report" failure
 * mode this whole app is built to avoid. Instead, a widget binds to one of
 * a small, curated, explicit METRIC_CATALOG of keys, each just a thin
 * accessor into the already-computed ReportBundle — no formula injection
 * surface, no duplicate computation, fully type-safe.
 *
 * Pure and DB-free, same convention as report-builder-engine.ts: every
 * function here is a plain function of its inputs, safe to call from a
 * client component, a route handler, or a unit test with no setup.
 *
 * A ResolvedMetric's `value`/`previous`/`trend`/`breakdown` are `null`/
 * `undefined` — never a guessed 0 — whenever the bundle genuinely has no
 * answer (e.g. `previous` when there's no prior-year bundle, `trend` for a
 * point-in-time Balance Sheet figure with no monthly grain, `breakdown` for
 * a metric that isn't composition-shaped) — same "honestly undetermined,
 * never fabricated" convention as tb-engine.ts's OCI/EPS/tax_paid.
 */
import type {
  BSResult, CashFlowResult, RatiosResult, TreasuryResult, MISColumn, PLResult, AggregatedNote,
} from './tb-engine';
import type { ReportBundle } from '@/lib/dashboard/types';
import { isBSSection } from './note-catalog';

// ── Widget shape ────────────────────────────────────────────────────────

export type WidgetKind =
  | 'stat_card'
  | 'stat_card_sparkline'
  | 'line_chart'
  | 'bar_chart'
  | 'donut_chart'
  | 'gauge'
  | 'data_table'
  | 'text_block'
  | 'metric_table'
  | 'period_summary'
  | 'yoy_variance'
  | 'financial_health'
  | 'top_customers'
  | 'profit_bridge'
  | 'cash_bridge'
  | 'note_index'
  // 2026-09-18 (Ledgerframe parity): ranked horizontal bars over a
  // breakdown, two figures + their ratio, and a stack of 2-6 related KPIs.
  | 'hbar_chart'
  | 'ratio_card'
  | 'kpi_group';

export const WIDGET_KINDS: WidgetKind[] = [
  'stat_card', 'stat_card_sparkline', 'line_chart', 'bar_chart',
  'donut_chart', 'gauge', 'data_table', 'text_block', 'metric_table',
  'period_summary', 'yoy_variance', 'financial_health', 'top_customers',
  'profit_bridge', 'cash_bridge', 'note_index', 'hbar_chart', 'ratio_card', 'kpi_group',
];

export function isWidgetKind(v: unknown): v is WidgetKind {
  return typeof v === 'string' && (WIDGET_KINDS as string[]).includes(v);
}

/**
 * Every widget kind but `text_block`/`period_summary`/`financial_health`/
 * `top_customers` needs at least one real metric bound to it — mirrors the
 * reference catalog's own `minSeries`. The latter three are fixed-content
 * summaries: `period_summary` always shows the real revenue waterfall,
 * `financial_health` always shows the real 4-indicator solvency strip, and
 * `top_customers` always shows the real Top-5-by-Revenue table (including
 * its %-of-Revenue/GM%/Status columns — the generic `data_table` widget's
 * plain Name/Value shape can't represent that, see TopCustomersWidget's own
 * doc comment) — none of them read `widget.series` at all, so 0 is the
 * correct, honest minimum rather than an arbitrary "any metric will do".
 * `WidgetPicker`/`WidgetInspector` both derive their own "this type has
 * nothing to configure" branch from this same table (`=== 0`, `text_block`
 * excepted) rather than hardcoding the list of fixed-content kinds a second
 * time. `profit_bridge` (added for the P&L customizable zone) joins this
 * same fixed-content group: it always shows the real, already-computed
 * Revenue→PAT waterfall straight from `bundle.pl`, nothing user-pickable.
 * `cash_bridge` (added for the Cash Flow customizable zone) is the same
 * pattern again: the real Opening→Operating→Investing→Financing→(Reconciling
 * Diff, when material)→Closing waterfall straight from `bundle.cashflow`.
 * `note_index` (added for the Notes to Accounts customizable zone) joins for
 * the same reason `top_customers` did: a real multi-column table (Note/
 * Description/Section/Value[/Prior/YoY]) with click-to-jump-to-note behavior
 * that the generic `data_table` widget's plain Name/Value breakdown shape
 * can't represent — reads `bundle.notes`/`bundle.prev_notes` directly,
 * nothing user-pickable. The 4 individual Notes KPIs (total count, Equity &
 * Liabilities/Assets/Income & Expense totals) are deliberately NOT bundled
 * into this same fixed-content widget — unlike the Note Index table, each is
 * a genuinely reconfigurable single scalar (bindable to stat_card, gauge,
 * yoy_variance, ...) with a real METRIC_CATALOG entry of its own (see the
 * "Notes to Accounts" catalog section below), keeping the customizable zone
 * actually reconfigurable rather than one indivisible block.
 */
export const WIDGET_MIN_SERIES: Record<WidgetKind, number> = {
  stat_card: 1, stat_card_sparkline: 1, line_chart: 1, bar_chart: 1,
  donut_chart: 1, gauge: 1, data_table: 1, text_block: 0, metric_table: 1,
  period_summary: 0, yoy_variance: 1, financial_health: 0, top_customers: 0,
  profit_bridge: 0, cash_bridge: 0, note_index: 0,
  hbar_chart: 1, ratio_card: 2, kpi_group: 2,
};

/**
 * Most series a widget type can use. Enforced server-side (parseWidgetsInput)
 * only for the three newer types, whose renderers depend on an exact shape
 * (a ratio card is exactly two figures); older types keep their long-standing
 * UI-only caps so no previously-saved layout starts failing validation.
 */
export const WIDGET_MAX_SERIES: Record<WidgetKind, number> = {
  stat_card: 1, stat_card_sparkline: 1, line_chart: 4, bar_chart: 4,
  donut_chart: 1, gauge: 1, data_table: 1, text_block: 0, metric_table: 4,
  period_summary: 0, yoy_variance: 4, financial_health: 0, top_customers: 0,
  profit_bridge: 0, cash_bridge: 0, note_index: 0,
  hbar_chart: 1, ratio_card: 2, kpi_group: 6,
};
const STRICT_MAX_SERIES = new Set<WidgetKind>(['hbar_chart', 'ratio_card', 'kpi_group']);

/** The fixed, real metric keys `period_summary` always shows, in display order — every one already a real METRIC_CATALOG entry (see below). */
export const PERIOD_SUMMARY_METRIC_KEYS = ['revenue', 'gross_profit', 'ebitda', 'pbt', 'pat', 'employee_cost'] as const;

// ── Customizable tabs (platform-wide tab customization, phase 2) ──────────

/**
 * The tabs a user may customize — deliberately the SAME id strings already
 * used as `activeTab` in app/dashboard/page.tsx / SidebarNav.tsx, not a
 * parallel naming scheme. `'my-dashboard'` is the original single
 * customizable surface; the other 9 are real, load-bearing tabs whose fixed
 * view stays the default (see CustomizableTabPanel's own doc comment) —
 * customizing is always opt-in.
 *
 * `'bs'` (Balance Sheet) is customizable in EXACTLY the same opt-in,
 * additive-only sense as the other 8: CustomizableTabPanel adds a
 * supplementary widget grid *alongside* BalanceSheetTab.tsx's fixedView —
 * the mandated Schedule III statutory table inside that fixedView (every
 * line, every Note reference, its order) is never itself a widget, never
 * draggable, resizable, or removable, and stays rendered exactly as before
 * regardless of what a user adds to the grid below it. What moved here is
 * only real, already-computed BS *summary* figures (Total Assets, Total
 * Equity, composition breakdowns, ...) being made available as optional
 * KPI/chart widgets, the same "pin a real metric onto a card" model as every
 * other customizable tab — nothing about the statutory statement itself.
 *
 * `'pl'` (P&L Account) follows exactly the same split as `'bs'`: the
 * mandated Schedule III Statement of Profit & Loss (Revenue → Other Income →
 * Total Income → every expense line → EBITDA → PBT → Tax → PAT → OCI → EPS,
 * every Note reference) lives in PLTab.tsx's own fixed zone, rendered
 * unconditionally, never passed to CustomizableTabPanel — only the real
 * supplementary content (the 4-KPI strip and the Profit Bridge waterfall)
 * moved into the customizable zone. See PLTab.tsx's own doc comment for the
 * exact same architecture BalanceSheetTab.tsx already established (mirrored
 * deliberately, not reinvented).
 *
 * `'cashflow'` (Cash Flow) follows the identical split again: the mandated
 * IND AS 7 Statement of Cash Flows — Operating/Investing/Financing
 * activities and their line-item breakdowns, Net Change in Cash, and the
 * Opening/Closing Cash reconciliation (plus the Operating/Investing/
 * Financing/Net-Change KPI strip that restates those same A/B/C totals) —
 * lives in CashFlowTab.tsx's own fixed zone, rendered unconditionally, never
 * passed to CustomizableTabPanel. Only the real supplementary content already
 * added to this tab this engagement — the 3-KPI strip (Free Cash Flow,
 * Opening Cash & Bank, Closing Cash & Bank) and the Cash Bridge waterfall —
 * moved into the customizable zone. See CashFlowTab.tsx's own doc comment.
 *
 * `'notes'` (Notes to Accounts) follows the identical split once more: every
 * individual Note card — Share Capital, Borrowings, PPE, every Schedule III
 * note in its mandated order, each with its real figures and Sparkline —
 * lives in NotesTab.tsx's own fixed zone, rendered unconditionally, never
 * passed to CustomizableTabPanel. Only the real supplementary/navigation
 * content already added to this tab this engagement — the 4-KPI strip and
 * the Note Index (a contents-page table, not the notes themselves) — moved
 * into the customizable zone. See NotesTab.tsx's own doc comment.
 *
 * Compliance (a pass/fail checklist) and Scenario Planner (interactive
 * sliders + live projection, not static resolved values) remain excluded for
 * an unrelated reason — neither fits the "pin a real metric onto a card"
 * model this engine is built for, regardless of statutory status.
 */
/**
 * Widened from a closed union of the 13 fixed tabs below to `string` so a
 * user-created custom tab (see lib/db/queries/custom-tabs.ts, `custom_tabs`
 * table) can share this same type everywhere it's used — every function
 * signature typed `TabKey` continues to compile unchanged, since `string`
 * satisfies all existing usage. `TAB_KEYS`/`isTabKey` deliberately keep their
 * exact runtime values (still exactly these 13 strings, still a pure/DB-free
 * check) — that's still a real, useful question ("is this one of the fixed
 * tabs"), just no longer the same thing as "is this any tab a user can
 * open." Validating a *custom* tab_key requires knowing which company is
 * asking and hitting the DB, so that's a separate function:
 * resolveTabKey() in lib/db/queries/custom-tabs.ts.
 */
export type TabKey = string;

export type FixedTabKey =
  | 'my-dashboard' | 'overview' | 'mis' | 'ratios' | 'funds' | 'wc'
  | 'customer-margin' | 'vendor-expense' | 'boardpack' | 'bs' | 'pl' | 'cashflow' | 'notes';

export const TAB_KEYS: FixedTabKey[] = [
  'my-dashboard', 'overview', 'mis', 'ratios', 'funds', 'wc',
  'customer-margin', 'vendor-expense', 'boardpack', 'bs', 'pl', 'cashflow', 'notes',
];

/** True only for one of the 13 fixed tabs — NOT "is this a valid tab a user can open" now that custom tabs exist. See resolveTabKey() for the DB-backed, company-scoped check that also accepts a custom tab. */
export function isTabKey(v: unknown): v is FixedTabKey {
  return typeof v === 'string' && (TAB_KEYS as string[]).includes(v);
}

export interface WidgetSeriesBinding {
  metricKey: string;
  /** Overrides the catalog's own label for this series (e.g. distinguishing "Revenue" vs "Revenue (this widget)" when two series share an axis). */
  label?: string;
  /** CSS color (hex or `var(--...)`) — falls back to a palette rotation when unset. */
  color?: string;
  /** line_chart/bar_chart only — draw this series as bars or as a line, so one chart can mix both (e.g. a margin-% line over revenue/cost bars). Unset = the widget type's own default. */
  renderAs?: 'bar' | 'line';
  /** line_chart/bar_chart only — plot this series against the right-hand axis (its own scale), e.g. a % line over currency bars. Unset = left. */
  axis?: 'left' | 'right';
}

export interface DashboardWidget {
  id: string;
  widgetType: WidgetKind;
  title: string | null;
  subtitle: string | null;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
  series: WidgetSeriesBinding[];
  vizConfig: Record<string, unknown>;
  sequence: number;
}

export interface GridBounds { x: number; y: number; w: number; h: number; }

/** Same clamps the grid canvas itself enforces while dragging — re-checked server-side because client geometry is never trusted as-is (same discipline as the Notes reclassify route validating its drop target). */
export function isValidGridBounds(b: GridBounds, cols = 12): boolean {
  return (
    Number.isInteger(b.x) && Number.isInteger(b.y) && Number.isInteger(b.w) && Number.isInteger(b.h) &&
    b.x >= 0 && b.y >= 0 && b.w >= 2 && b.h >= 3 && b.x + b.w <= cols
  );
}

// ── Metric catalog ──────────────────────────────────────────────────────

export type ValueType = 'currency' | 'percent' | 'ratio' | 'days' | 'number';

/**
 * `'crore'` marks the handful of fields that (like TopCustomer.revenue_cr)
 * are already pre-divided into Crores by tb-engine.ts, as distinct from the
 * raw-rupee convention every other monetary field in this engine follows —
 * same distinction lib/utils/format.ts's fl() vs frRaw() already draws.
 * Renderers must route a `'crore'` value through frRaw(), never fl()/fn().
 */
export type RawUnit = 'rupee' | 'crore';

export interface MetricThresholds {
  direction: 'higher_is_better' | 'lower_is_better';
  /** Real benchmark already shown elsewhere in this app (RatiosTab / GET /reports/ratios's `benchmarks`) — never a made-up number. */
  target: number;
  /**
   * Optional early-warning level on the "bad" side of `target` (below it
   * when higher is better, above it when lower is better). Between warn and
   * target the metric reads amber ("watch"); beyond warn it reads red.
   * Custom metrics only — built-in benchmarks stay single-level.
   */
  warn?: number | null;
}

export type ThresholdStatus = 'good' | 'warn' | 'bad';

/** The one place a value is judged against its target (and optional warn level) — every widget, the builder preview and every export use this, so a metric can't read green in one place and amber in another. */
export function thresholdStatus(value: number | null | undefined, t: MetricThresholds | null | undefined): ThresholdStatus | null {
  if (!t || value == null || !Number.isFinite(value)) return null;
  const higher = t.direction === 'higher_is_better';
  if (higher ? value >= t.target : value <= t.target) return 'good';
  if (t.warn != null && Number.isFinite(t.warn) && (higher ? value >= t.warn : value <= t.warn)) return 'warn';
  return 'bad';
}

/** a ÷ b for a ratio_card (and its exports) — null when either side is missing, the denominator is zero, or the result isn't finite; never a guessed figure. */
export function ratioOf(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null || b === 0) return null;
  const r = a / b;
  return Number.isFinite(r) ? r : null;
}

export interface SeriesPoint { label: string; value: number; }

export interface ResolvedMetric {
  key: string;
  label: string;
  value: number | null;
  previous: number | null;
  deltaPct: number | null;
  valueType: ValueType;
  rawUnit: RawUnit;
  decimals: number;
  thresholds: MetricThresholds | null;
  /** What `previous`/`deltaPct` compare against — 'YoY' (same period last year, the default for every built-in metric), 'vs prior period', or undefined when a custom metric is set to no comparison. */
  comparisonLabel?: string;
  /** Present only for metrics with real monthly grain (MIS-derived). */
  trend?: SeriesPoint[];
  /** Present only for metrics that are a real composition breakdown. */
  breakdown?: SeriesPoint[];
}

interface ResolvedFields {
  value: number | null;
  previous: number | null;
  trend?: SeriesPoint[];
  breakdown?: SeriesPoint[];
}

export interface MetricCatalogEntry {
  key: string;
  label: string;
  group: string;
  valueType: ValueType;
  rawUnit: RawUnit;
  decimals: number;
  supportsSeries: boolean;
  supportsBreakdown: boolean;
  thresholds?: MetricThresholds;
  resolve: (bundle: ReportBundle) => ResolvedFields;
}

function misTrend(bundle: ReportBundle, field: keyof MISColumn): SeriesPoint[] {
  return bundle.mis.columns.map((label, i) => ({ label, value: (bundle.mis.data[i]?.[field] as number) ?? 0 }));
}

/** A metric read straight off mis.totals, with a real monthly trend from mis.data and a real prior-year value from prev_mis when one exists. */
function misMetric(
  key: string, label: string, group: string, field: keyof MISColumn,
  valueType: ValueType = 'currency', decimals = 2,
): MetricCatalogEntry {
  return {
    key, label, group, valueType, rawUnit: 'rupee', decimals,
    supportsSeries: true, supportsBreakdown: false,
    resolve: (bundle) => ({
      value: bundle.mis.totals[field] as number,
      previous: bundle.prev_mis ? (bundle.prev_mis.totals[field] as number) : null,
      trend: misTrend(bundle, field),
    }),
  };
}

function bsMetric(key: string, label: string, group: string, get: (bs: BSResult) => number): MetricCatalogEntry {
  return {
    key, label, group, valueType: 'currency', rawUnit: 'rupee', decimals: 2,
    supportsSeries: false, supportsBreakdown: false,
    resolve: (bundle) => ({
      value: get(bundle.bs),
      previous: bundle.prev_bs ? get(bundle.prev_bs) : null,
    }),
  };
}

/**
 * A metric read straight off `bundle.pl` (computePL()'s own statutory
 * figures), not `bundle.mis.totals` — deliberately, for the P&L
 * customizable zone specifically. Phase 1 of this build verified by hand
 * (and with a throwaway diagnostic against real Real Variable ledger data,
 * since deleted) that mis.totals.totInc/totExp/pbt agree with
 * pl.total_income/total_expenses/pbt EXACTLY (both are unrounded sums of
 * the same underlying ledger figures) — but mis.totals.pat can differ from
 * pl.pat by a small rounding-methodology residual in a PROFITABLE period
 * (tb-engine.ts's computeMIS() sums 12 independently-rounded monthly tax
 * figures; computePL() rounds once on the whole period — see its own
 * comment, "confirmed: ₹1 on real data" — for the exact prior discrepancy
 * this class of bug already caused once, between MIS's and P&L's own PAT).
 * Sourcing every P&L-zone metric from `bundle.pl` directly — the identical
 * object PLTab.tsx's own fixed statutory table reads — makes that whole
 * class of drift structurally impossible here, by construction, rather than
 * relying on the rate-matching fix elsewhere being enough (it usually is,
 * but "usually" isn't the standard this catalog holds itself to).
 */
function plMetric(
  key: string, label: string, get: (pl: PLResult) => number | null,
  valueType: ValueType = 'currency', decimals = 2,
): MetricCatalogEntry {
  return {
    key, label, group: 'P&L Statement', valueType, rawUnit: 'rupee', decimals,
    supportsSeries: false, supportsBreakdown: false,
    resolve: (bundle) => ({
      value: get(bundle.pl),
      previous: bundle.prev_pl ? get(bundle.prev_pl) : null,
    }),
  };
}

function cfMetric(key: string, label: string, group: string, get: (cf: CashFlowResult) => number | null): MetricCatalogEntry {
  return {
    key, label, group, valueType: 'currency', rawUnit: 'rupee', decimals: 2,
    supportsSeries: false, supportsBreakdown: false,
    resolve: (bundle) => ({
      value: get(bundle.cashflow),
      previous: bundle.prev_cashflow ? get(bundle.prev_cashflow) : null,
    }),
  };
}

function treasuryMetric(key: string, label: string, get: (t: TreasuryResult) => number): MetricCatalogEntry {
  return {
    key, label, group: 'Treasury', valueType: 'currency', rawUnit: 'rupee', decimals: 2,
    supportsSeries: false, supportsBreakdown: false,
    resolve: (bundle) => ({
      value: get(bundle.treasury),
      previous: bundle.prev_treasury ? get(bundle.prev_treasury) : null,
    }),
  };
}

/** Ratios carry no prior-year figure anywhere in ReportBundle — `previous` is always honestly null, never derived by re-running the ratio engine on a prior-year bundle this metric doesn't have access to. */
function ratioMetric(
  key: string, label: string, get: (r: RatiosResult) => number | null,
  valueType: ValueType, decimals: number, thresholds?: MetricThresholds,
): MetricCatalogEntry {
  return {
    key, label, group: 'Key Ratios', valueType, rawUnit: 'rupee', decimals, thresholds,
    supportsSeries: false, supportsBreakdown: false,
    resolve: (bundle) => ({ value: get(bundle.ratios), previous: null }),
  };
}

/**
 * Real per-note-section aggregation shared by the 3 currency "Notes to
 * Accounts" catalog entries below — one pass over a single year's
 * AggregatedNote[] array, matching NotesTab.tsx's own eqLiabTotal/
 * assetsTotal/plTotal computation exactly (same section-group filters, same
 * Math.abs() for the Income & Expense group) so the widget path can never
 * compute these totals a second, differently-formulated way.
 */
function aggregateNoteTotals(notes: AggregatedNote[] | null | undefined): { eqLiab: number; assets: number; plGroup: number } {
  const list = notes ?? [];
  return {
    eqLiab: list.filter((n) => ['eq', 'lnc', 'lc'].includes(n.section || '')).reduce((s, n) => s + n.total, 0),
    assets: list.filter((n) => ['anc', 'ac'].includes(n.section || '')).reduce((s, n) => s + n.total, 0),
    plGroup: list.filter((n) => ['inc', 'exp'].includes(n.section || '')).reduce((s, n) => s + Math.abs(n.total), 0),
  };
}

/** `bs_${note_no}` / `pl_${note_no}` — the same combined-note identity NotesTab.tsx's own getNoteKey() establishes (via note-catalog.ts's isBSSection()), reused here so notes_total_count's union count can never drift from the real Note Index/note-card list it's counting. */
function noteUnionKey(n: AggregatedNote): string {
  return `${isBSSection(n.section) ? 'bs' : 'pl'}_${n.note_no}`;
}

export const METRIC_CATALOG: MetricCatalogEntry[] = [
  // ── Revenue & Profitability (real monthly trend from MIS) ──
  misMetric('revenue', 'Revenue from Operations', 'Revenue & Profitability', 'rev'),
  misMetric('other_income', 'Other Income', 'Revenue & Profitability', 'oth'),
  misMetric('total_income', 'Total Income', 'Revenue & Profitability', 'totInc'),
  {
    key: 'gross_profit', label: 'Gross Profit', group: 'Revenue & Profitability',
    valueType: 'currency', rawUnit: 'rupee', decimals: 2, supportsSeries: true, supportsBreakdown: false,
    resolve: (bundle) => ({
      value: bundle.mis.totals.rev - bundle.mis.totals.cos,
      previous: bundle.prev_mis ? bundle.prev_mis.totals.rev - bundle.prev_mis.totals.cos : null,
      trend: bundle.mis.columns.map((label, i) => ({ label, value: (bundle.mis.data[i]?.rev ?? 0) - (bundle.mis.data[i]?.cos ?? 0) })),
    }),
  },
  misMetric('ebitda', 'EBITDA (Operating)', 'Revenue & Profitability', 'ebitda'),
  misMetric('pbt', 'Profit Before Tax', 'Revenue & Profitability', 'pbt'),
  misMetric('pat', 'Profit After Tax', 'Revenue & Profitability', 'pat'),
  misMetric('gross_margin_pct', 'Gross Margin %', 'Revenue & Profitability', 'gm', 'percent', 1),
  misMetric('ebitda_margin_pct', 'EBITDA Margin %', 'Revenue & Profitability', 'em', 'percent', 1),
  misMetric('pat_margin_pct', 'PAT Margin %', 'Revenue & Profitability', 'pm', 'percent', 1),
  misMetric('cost_of_services', 'Cost of Services', 'Revenue & Profitability', 'cos'),
  misMetric('employee_cost', 'Employee Benefits', 'Revenue & Profitability', 'emp'),
  misMetric('other_expenses', 'Other Expenses', 'Revenue & Profitability', 'oex'),
  misMetric('finance_costs', 'Finance Costs', 'Revenue & Profitability', 'fin'),
  misMetric('depreciation', 'Depreciation & Amortisation', 'Revenue & Profitability', 'dep'),

  // ── Balance Sheet (point-in-time — no monthly trend to show, honestly) ──
  bsMetric('total_assets', 'Total Assets', 'Balance Sheet', (bs) => bs.assets.total),
  bsMetric('non_current_assets', 'Non-Current Assets', 'Balance Sheet', (bs) => bs.assets.total_nca),
  bsMetric('current_assets', 'Current Assets', 'Balance Sheet', (bs) => bs.assets.total_ca),
  bsMetric('total_equity', 'Total Equity', 'Balance Sheet', (bs) => bs.equity_liabilities.total_equity),
  bsMetric('non_current_liabilities', 'Non-Current Liabilities', 'Balance Sheet', (bs) => bs.equity_liabilities.total_ncl),
  bsMetric('current_liabilities', 'Current Liabilities', 'Balance Sheet', (bs) => bs.equity_liabilities.total_cl),
  bsMetric('total_liabilities', 'Total Liabilities', 'Balance Sheet', (bs) => bs.equity_liabilities.total_ncl + bs.equity_liabilities.total_cl),
  bsMetric('net_working_capital', 'Net Working Capital (CA - CL)', 'Balance Sheet', (bs) => bs.assets.total_ca - bs.equity_liabilities.total_cl),
  // Two real breakdowns, not one fused "Assets vs Equity & Liabilities" donut
  // — a balanced Balance Sheet has Assets == Equity & Liabilities by
  // definition (bs.balanced), so a single 2-slice donut of those two totals
  // would always render as a trivial ~50/50 split and tell a reader nothing
  // real. Mirrors BalanceSheetTab.tsx's own two CompositionBar charts (its
  // fixedView, unaffected by this) instead — same real segments, same
  // convention as treasury_composition just above: honest breakdown values,
  // '' entries filtered by the donut renderer itself when a segment is 0.
  {
    key: 'bs_equity_liab_composition', label: 'Equity & Liabilities Composition', group: 'Balance Sheet',
    valueType: 'currency', rawUnit: 'rupee', decimals: 2, supportsSeries: false, supportsBreakdown: true,
    resolve: (bundle) => ({
      value: bundle.bs.equity_liabilities.total,
      previous: bundle.prev_bs ? bundle.prev_bs.equity_liabilities.total : null,
      breakdown: [
        { label: 'Equity', value: bundle.bs.equity_liabilities.total_equity },
        { label: 'Non-Current Liabilities', value: bundle.bs.equity_liabilities.total_ncl },
        { label: 'Current Liabilities', value: bundle.bs.equity_liabilities.total_cl },
      ],
    }),
  },
  {
    key: 'bs_assets_composition', label: 'Assets Composition', group: 'Balance Sheet',
    valueType: 'currency', rawUnit: 'rupee', decimals: 2, supportsSeries: false, supportsBreakdown: true,
    resolve: (bundle) => ({
      value: bundle.bs.assets.total,
      previous: bundle.prev_bs ? bundle.prev_bs.assets.total : null,
      breakdown: [
        { label: 'Non-Current Assets', value: bundle.bs.assets.total_nca },
        { label: 'Current Assets', value: bundle.bs.assets.total_ca },
      ],
    }),
  },

  // ── P&L Statement (sourced from bundle.pl directly, not MIS — see
  //    plMetric()'s own doc comment for why the P&L customizable zone
  //    specifically needs this instead of reusing the misMetric() entries
  //    above) ──
  plMetric('pl_total_income', 'Total Income', (pl) => pl.total_income),
  plMetric('pl_total_expenses', 'Total Expenses', (pl) => pl.total_expenses),
  // pl_pbt / pl_pat (raw currency) — PL_DEFAULT_WIDGETS binds these, NOT the
  // *_margin_pct entries below, specifically so the customizable zone's
  // starter KPI cards show the exact same KIND of number (a currency amount)
  // under the exact same label ("Profit Before Tax"/"Profit After Tax") as
  // PLTab.tsx's own fixed-view KPI strip. Found during a live bug report:
  // clicking "Customize" swapped "Profit Before Tax: (17.69)" for "PBT
  // Margin: (5.4%)" — same real figure, reconciled and correct, but a
  // different-looking number under a different-looking name is exactly what
  // reads as "a different widget with a different number" to a real user,
  // even with the statutory-table-disappearing bug (the original Balance
  // Sheet-class defect) long since fixed. The margin-% entries stay in the
  // catalog — still real, still reconciled, still selectable by anyone who
  // wants a %-based card instead — only the STARTER default changed.
  plMetric('pl_pbt', 'Profit Before Tax', (pl) => pl.pbt),
  plMetric('pl_pat', 'Profit After Tax', (pl) => pl.pat),
  plMetric('pl_pbt_margin_pct', 'PBT Margin %', (pl) => (pl.revenue > 0 ? (pl.pbt / pl.revenue) * 100 : null), 'percent', 1),
  plMetric('pl_pat_margin_pct', 'PAT Margin %', (pl) => (pl.revenue > 0 ? (pl.pat / pl.revenue) * 100 : null), 'percent', 1),

  // ── Cash Flow ──
  cfMetric('operating_cash_flow', 'Operating Cash Flow', 'Cash Flow', (cf) => (cf.operating as Record<string, unknown>).total as number),
  cfMetric('investing_cash_flow', 'Investing Cash Flow', 'Cash Flow', (cf) => (cf.investing as Record<string, unknown>).total as number),
  cfMetric('financing_cash_flow', 'Financing Cash Flow', 'Cash Flow', (cf) => (cf.financing as Record<string, unknown>).total as number),
  cfMetric('net_change_in_cash', 'Net Change in Cash', 'Cash Flow', (cf) => cf.net_change),
  cfMetric('opening_cash', 'Opening Cash & Bank', 'Cash Flow', (cf) => cf.opening_cash),
  cfMetric('closing_cash', 'Closing Cash & Bank', 'Cash Flow', (cf) => cf.closing_cash),
  cfMetric('free_cash_flow', 'Free Cash Flow', 'Cash Flow', (cf) => cf.free_cash_flow),
  {
    key: 'ocf_to_pat', label: 'OCF / PAT', group: 'Cash Flow',
    valueType: 'ratio', rawUnit: 'rupee', decimals: 2, supportsSeries: false, supportsBreakdown: false,
    resolve: (bundle) => ({ value: bundle.cashflow.ocf_to_pat, previous: bundle.prev_cashflow ? bundle.prev_cashflow.ocf_to_pat : null }),
  },

  // ── Treasury ──
  treasuryMetric('treasury_total', 'Total Treasury', (t) => t.total),
  treasuryMetric('cash_and_bank', 'Cash & Bank', (t) => t.total_cash_and_bank),
  treasuryMetric('fixed_deposits', 'Fixed Deposits', (t) => t.total_fd),
  treasuryMetric('mutual_funds', 'Mutual Funds', (t) => t.total_mf),
  {
    key: 'treasury_composition', label: 'Treasury Composition', group: 'Treasury',
    valueType: 'currency', rawUnit: 'rupee', decimals: 2, supportsSeries: false, supportsBreakdown: true,
    resolve: (bundle) => {
      const t = bundle.treasury;
      const sum = (arr: { closing: number }[]) => arr.reduce((s, e) => s + e.closing, 0);
      return {
        value: t.total,
        previous: bundle.prev_treasury ? bundle.prev_treasury.total : null,
        breakdown: [
          { label: 'Cash in Hand', value: sum(t.cash) },
          { label: 'Bank — Current', value: sum(t.bank_ca) },
          { label: 'Bank — Savings', value: sum(t.bank_sb) },
          { label: 'Fixed Deposits', value: t.total_fd },
          { label: 'Mutual Funds', value: t.total_mf },
        ],
      };
    },
  },

  // ── Notes to Accounts (sourced from bundle.notes/prev_notes directly —
  //    the same real AggregatedNote[] arrays NotesTab.tsx's own fixed-zone
  //    KPI strip reads) ──
  {
    key: 'notes_total_count', label: 'Total Notes', group: 'Notes to Accounts',
    valueType: 'number', rawUnit: 'rupee', decimals: 0, supportsSeries: false, supportsBreakdown: false,
    resolve: (bundle) => ({
      value: new Set([...bundle.notes.map(noteUnionKey), ...(bundle.prev_notes ?? []).map(noteUnionKey)]).size,
      // Honestly NOT the same union quantity computed a year earlier (that's
      // not a well-defined "prior" for a two-year union count) — this is the
      // real, standalone prior-year note count instead: a genuinely
      // different-shaped figure, never fabricated to look like a matching
      // YoY comparison for `value` above.
      previous: bundle.prev_notes ? bundle.prev_notes.length : null,
    }),
  },
  {
    key: 'notes_eq_liab_total', label: 'Equity & Liabilities Notes', group: 'Notes to Accounts',
    valueType: 'currency', rawUnit: 'rupee', decimals: 2, supportsSeries: false, supportsBreakdown: false,
    resolve: (bundle) => ({
      value: aggregateNoteTotals(bundle.notes).eqLiab,
      previous: bundle.prev_notes ? aggregateNoteTotals(bundle.prev_notes).eqLiab : null,
    }),
  },
  {
    key: 'notes_assets_total', label: 'Assets Notes', group: 'Notes to Accounts',
    valueType: 'currency', rawUnit: 'rupee', decimals: 2, supportsSeries: false, supportsBreakdown: false,
    resolve: (bundle) => ({
      value: aggregateNoteTotals(bundle.notes).assets,
      previous: bundle.prev_notes ? aggregateNoteTotals(bundle.prev_notes).assets : null,
    }),
  },
  {
    key: 'notes_pl_total', label: 'Income & Expense Notes', group: 'Notes to Accounts',
    valueType: 'currency', rawUnit: 'rupee', decimals: 2, supportsSeries: false, supportsBreakdown: false,
    resolve: (bundle) => ({
      value: aggregateNoteTotals(bundle.notes).plGroup,
      previous: bundle.prev_notes ? aggregateNoteTotals(bundle.prev_notes).plGroup : null,
    }),
  },

  // ── Key Ratios — thresholds reuse the exact benchmarks already shown on
  //    RatiosTab / GET /api/v1/reports/ratios, never a separately-invented number. ──
  ratioMetric('current_ratio', 'Current Ratio', (r) => r.liquidity.current_ratio, 'ratio', 2, { direction: 'higher_is_better', target: 1.5 }),
  ratioMetric('quick_ratio', 'Quick Ratio', (r) => r.liquidity.quick_ratio, 'ratio', 2, { direction: 'higher_is_better', target: 1.0 }),
  ratioMetric('cash_ratio', 'Cash Ratio', (r) => r.liquidity.cash_ratio, 'ratio', 2),
  ratioMetric('gross_margin_ratio_pct', 'Gross Margin % (Ratio)', (r) => r.profitability.gross_margin, 'percent', 1, { direction: 'higher_is_better', target: 45 }),
  ratioMetric('ebitda_margin_ratio_pct', 'EBITDA Margin % (Ratio)', (r) => r.profitability.ebitda_margin, 'percent', 1, { direction: 'higher_is_better', target: 10 }),
  ratioMetric('net_margin_pct', 'Net Margin %', (r) => r.profitability.net_margin, 'percent', 1, { direction: 'higher_is_better', target: 8 }),
  ratioMetric('roe_pct', 'Return on Equity (ROE)', (r) => r.profitability.roe, 'percent', 1, { direction: 'higher_is_better', target: 15 }),
  ratioMetric('roce_pct', 'Return on Capital Employed (ROCE)', (r) => r.profitability.roce, 'percent', 1, { direction: 'higher_is_better', target: 15 }),
  ratioMetric('debt_equity', 'Debt / Equity', (r) => r.leverage.debt_equity, 'ratio', 2, { direction: 'lower_is_better', target: 1.0 }),
  ratioMetric('interest_cover', 'Interest Coverage', (r) => r.leverage.interest_cover, 'ratio', 1, { direction: 'higher_is_better', target: 3.0 }),
  ratioMetric('dscr', 'Debt Service Coverage (DSCR)', (r) => r.leverage.dscr, 'ratio', 2),
  ratioMetric('asset_turnover', 'Asset Turnover', (r) => r.efficiency.asset_turnover, 'ratio', 2),
  ratioMetric('dso_days', 'Days Sales Outstanding (DSO)', (r) => r.efficiency.dso, 'days', 0, { direction: 'lower_is_better', target: 60 }),
  ratioMetric('dpo_days', 'Days Payable Outstanding (DPO)', (r) => r.efficiency.dpo, 'days', 0),
  ratioMetric('ccc_days', 'Cash Conversion Cycle (CCC)', (r) => r.efficiency.ccc, 'days', 0),

  // ── Customers & Vendors (real Zoho-sourced breakdowns — [] when unavailable, never fabricated) ──
  {
    key: 'top_customers_revenue', label: 'Top Customers by Revenue', group: 'Customers & Vendors',
    // TopCustomer.revenue_cr is pre-divided into Crores by computeTopCustomers() — render via frRaw(), not fl()/fn().
    valueType: 'currency', rawUnit: 'crore', decimals: 2, supportsSeries: false, supportsBreakdown: true,
    resolve: (bundle) => ({
      value: null, previous: null,
      breakdown: (bundle.top_customers ?? []).map((c) => ({ label: c.customer, value: c.revenue_cr })),
    }),
  },
  {
    key: 'vendor_expense_by_vendor', label: 'Vendor Spend by Vendor', group: 'Customers & Vendors',
    valueType: 'currency', rawUnit: 'rupee', decimals: 2, supportsSeries: false, supportsBreakdown: true,
    resolve: (bundle) => ({
      value: null, previous: null,
      breakdown: (bundle.vendor_expense ?? []).map((v) => ({ label: v.vendor, value: v.amount })),
    }),
  },
  {
    key: 'customer_direct_margin', label: 'Direct Margin by Customer', group: 'Customers & Vendors',
    valueType: 'currency', rawUnit: 'rupee', decimals: 2, supportsSeries: false, supportsBreakdown: true,
    resolve: (bundle) => ({
      value: null, previous: null,
      breakdown: (bundle.customer_margin?.entries ?? []).map((e) => ({ label: e.customer, value: e.direct_margin })),
    }),
  },
];

export function findMetricCatalogEntry(key: string): MetricCatalogEntry | undefined {
  return METRIC_CATALOG.find((m) => m.key === key);
}

export function isKnownMetricKey(key: unknown): key is string {
  return typeof key === 'string' && METRIC_CATALOG.some((m) => m.key === key);
}

/**
 * Resolves one metric key against a live ReportBundle. Returns `null` only
 * for an unrecognized key (never for a recognized metric with no data —
 * that case still returns a real ResolvedMetric with `value`/`breakdown`
 * honestly empty/null) so callers can distinguish "this key doesn't exist"
 * from "this key exists but has nothing to show yet".
 */
export function resolveMetric(key: string, bundle: ReportBundle): ResolvedMetric | null {
  const entry = findMetricCatalogEntry(key);
  if (!entry) return null;
  const { value, previous, trend, breakdown } = entry.resolve(bundle);
  const deltaPct = value != null && previous != null && previous !== 0
    ? ((value - previous) / Math.abs(previous)) * 100
    : null;
  return {
    key: entry.key,
    label: entry.label,
    value,
    previous,
    deltaPct,
    valueType: entry.valueType,
    rawUnit: entry.rawUnit,
    decimals: entry.decimals,
    thresholds: entry.thresholds ?? null,
    comparisonLabel: 'YoY',
    trend,
    breakdown,
  };
}

// ── Server-side input validation (shared by both dashboard-layout API routes) ──

export type ParseWidgetsResult = { widgets: DashboardWidget[] } | { error: string };

/**
 * Validates and normalizes a PUT body's `widgets` array — never trusts
 * client-supplied `widgetType`/`metricKey`/grid geometry as-is (same
 * discipline as the Notes reclassify route validating its drop target
 * against NOTE_CATALOG). Widget `id`s are intentionally ignored/discarded:
 * every save is a full delete-then-reinsert (see
 * lib/db/queries/dashboard-builder.ts::saveLayout), so the database always
 * mints fresh ids and the client is expected to replace its local state
 * from the response rather than track ids across a save — there is no
 * separate child table keyed by widget id the way Report Builder's ledger
 * mappings need line ids to survive a resave.
 */
/**
 * `extraKnownKeys` — a company's own custom metric keys (see
 * lib/financial/custom-metric-engine.ts), so a widget's series MAY bind to
 * a custom metric, not just a built-in METRIC_CATALOG key. This is the one
 * direction custom metrics and widgets are allowed to mix — a custom
 * metric's own formula may never reference another custom metric (see that
 * file's header comment for why), but a widget is just a display binding,
 * not a formula, so there's no cycle risk in letting it point at either
 * kind.
 */
export function parseWidgetsInput(raw: unknown, cols = 12, extraKnownKeys: ReadonlySet<string> = new Set()): ParseWidgetsResult {
  if (!Array.isArray(raw)) return { error: 'widgets must be an array' };
  if (raw.length > 60) return { error: 'A dashboard may have at most 60 widgets' };

  const widgets: DashboardWidget[] = [];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i] as Record<string, unknown> | null;
    if (!w || typeof w !== 'object') return { error: `widgets[${i}] must be an object` };
    if (!isWidgetKind(w.widgetType)) return { error: `widgets[${i}].widgetType is not a recognized widget type` };

    const gridX = Number(w.gridX), gridY = Number(w.gridY), gridW = Number(w.gridW), gridH = Number(w.gridH);
    if (!isValidGridBounds({ x: gridX, y: gridY, w: gridW, h: gridH }, cols)) {
      return { error: `widgets[${i}] has an invalid grid position or size` };
    }

    const seriesRaw = Array.isArray(w.series) ? w.series : [];
    const series: WidgetSeriesBinding[] = [];
    for (const sRaw of seriesRaw) {
      const s = sRaw as Record<string, unknown> | null;
      const metricKey = s?.metricKey;
      if (typeof metricKey !== 'string' || !(isKnownMetricKey(metricKey) || extraKnownKeys.has(metricKey))) {
        return { error: `widgets[${i}] references an unknown metric key` };
      }
      series.push({
        metricKey,
        label: typeof s?.label === 'string' ? s.label.slice(0, 100) : undefined,
        color: typeof s?.color === 'string' ? s.color.slice(0, 30) : undefined,
        renderAs: s?.renderAs === 'bar' || s?.renderAs === 'line' ? s.renderAs : undefined,
        axis: s?.axis === 'right' ? 'right' : s?.axis === 'left' ? 'left' : undefined,
      });
    }
    if (series.length < WIDGET_MIN_SERIES[w.widgetType]) {
      return { error: `widgets[${i}] (${w.widgetType}) needs at least ${WIDGET_MIN_SERIES[w.widgetType]} metric${WIDGET_MIN_SERIES[w.widgetType] === 1 ? '' : 's'} bound to it` };
    }
    if (STRICT_MAX_SERIES.has(w.widgetType) && series.length > WIDGET_MAX_SERIES[w.widgetType]) {
      return { error: `widgets[${i}] (${w.widgetType}) can show at most ${WIDGET_MAX_SERIES[w.widgetType]} metric${WIDGET_MAX_SERIES[w.widgetType] === 1 ? '' : 's'}` };
    }

    const vizConfig = w.vizConfig && typeof w.vizConfig === 'object' && !Array.isArray(w.vizConfig)
      ? (w.vizConfig as Record<string, unknown>)
      : {};

    widgets.push({
      id: '', // discarded — see this function's doc comment
      widgetType: w.widgetType,
      title: typeof w.title === 'string' ? w.title.slice(0, 200) : null,
      subtitle: typeof w.subtitle === 'string' ? w.subtitle.slice(0, 200) : null,
      gridX, gridY, gridW, gridH,
      series,
      vizConfig,
      sequence: i,
    });
  }
  return { widgets };
}
