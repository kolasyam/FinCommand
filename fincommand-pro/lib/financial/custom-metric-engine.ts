/**
 * FinCommand Pro — custom-metric engine (v2).
 *
 * A company-defined metric is one of two KINDS, both plain structured data —
 * never a free-text formula string, never parsed as code (CONSTRAINTS.md:
 * "No string-eval'd financial formulas"):
 *
 *  - 'formula' — a small expression tree (FormulaExpr) over built-in
 *    METRIC_CATALOG keys, constants, AND (since v2) this company's other
 *    custom metrics. References between custom metrics form a graph, so
 *    cycles are rejected at save time (findDependencyCycle) and evaluation
 *    additionally carries a `visiting` set so even a cycle that somehow
 *    reached the database resolves to an honest `null`, never a stack
 *    overflow. Evaluated client-side against the loaded ReportBundle.
 *
 *  - 'ledger' — a structured filter over the company's real Trial Balance
 *    ledgers (LedgerMetricSpec: "ledger name contains Salary AND Note = 23",
 *    movement vs closing balance, natural vs inverted sign). Computed
 *    SERVER-side by tb-engine.ts::computeLedgerMetric() — raw ledgers never
 *    leave the server — and delivered in ReportBundle.custom_metric_values.
 *
 * Both kinds resolve into the exact ResolvedMetric shape built-in metrics
 * use, including a real monthly `trend` whenever every input genuinely has
 * one (so custom metrics now work in line/bar charts, sparklines and metric
 * tables) and a real per-ledger `breakdown` for ledger metrics (donuts, data
 * tables). Nothing is ever fabricated: a trend is only produced when every
 * leaf has real per-column data, otherwise it's honestly absent and the
 * widget picker doesn't offer the metric to chart widgets at all
 * (customMetricCapabilities()).
 *
 * Pure and DB-free (same convention as dashboard-builder-engine.ts) — safe in
 * a client component, a route handler, or a unit test.
 */
import {
  resolveMetric, findMetricCatalogEntry, isKnownMetricKey,
  type ResolvedMetric, type ValueType, type MetricThresholds, type SeriesPoint,
} from './dashboard-builder-engine';
import {
  resolvePeriod, LEDGER_FILTER_FIELDS, LEDGER_FILTER_OPERATORS, LEDGER_AGGREGATIONS,
  NUMERIC_LEDGER_FIELDS, NUMERIC_ONLY_OPERATORS, TEXT_ONLY_OPERATORS, VALUELESS_OPERATORS,
  type LedgerMetricSpec, type LedgerFilterCondition, type LedgerAggregation,
} from './tb-engine';
import type { ReportBundle } from '@/lib/dashboard/types';

// ── Expression tree ──────────────────────────────────────────────────────

export type FormulaOp =
  | 'add' | 'subtract' | 'multiply' | 'divide' | 'safe_divide' | 'percent_of' | 'min' | 'max'
  | 'coalesce' | 'round' | 'abs' | 'percent_change' | 'avg_per_month';

export type FormulaExpr =
  | { type: 'metric'; key: string }
  | { type: 'const'; value: number }
  | { type: 'op'; op: FormulaOp; args: FormulaExpr[] };

/** Reduce over any number (>= 2) of args. `coalesce` = first arg that has a real value. */
const N_ARY_OPS = new Set<FormulaOp>(['add', 'multiply', 'min', 'max', 'coalesce']);
/** Order-sensitive, exactly 2 args. `round`'s second arg must be a whole-number const 0-6 (decimal places). */
const BINARY_OPS = new Set<FormulaOp>(['subtract', 'divide', 'safe_divide', 'percent_of', 'round']);
/** Exactly 1 arg. */
const UNARY_OPS = new Set<FormulaOp>(['abs', 'percent_change', 'avg_per_month']);
export const FORMULA_OPS: FormulaOp[] = [
  'add', 'subtract', 'multiply', 'divide', 'safe_divide', 'percent_of', 'min', 'max',
  'coalesce', 'round', 'abs', 'percent_change', 'avg_per_month',
];
export function isUnaryOp(op: FormulaOp): boolean { return UNARY_OPS.has(op); }

const MAX_DEPTH = 8;
const MAX_NODES = 40;
/** How many custom metrics deep a formula may reach through other custom metrics (A uses B uses C ...). Bounds evaluation cost and keeps definitions explainable. */
export const MAX_CUSTOM_NESTING = 5;

// ── Definitions ──────────────────────────────────────────────────────────

export type CustomMetricKind = 'formula' | 'ledger';

export interface CustomMetricDefinition {
  /** Database id — present on anything loaded from the server; absent on a draft. */
  id?: string;
  key: string;
  label: string;
  description?: string | null;
  /** Absent only on legacy/test fixtures — treated as 'formula'. */
  kind?: CustomMetricKind;
  valueType: ValueType;
  decimals: number;
  /** Required for kind 'formula', null for 'ledger'. */
  expression: FormulaExpr | null;
  /** Required for kind 'ledger', null/absent for 'formula'. */
  ledgerSpec?: LedgerMetricSpec | null;
  thresholds: MetricThresholds | null;
  /**
   * What the metric's change figure compares against: 'prior_year' (same
   * period last year — the default, and what every built-in metric uses),
   * 'prior_period' (the period immediately before, e.g. Q2 vs Q1 — from
   * ReportBundle.prior_period), or 'none' (no change figure; cards show the
   * target instead).
   */
  comparison?: MetricComparison;
  version?: number;
}

export type MetricComparison = 'prior_year' | 'prior_period' | 'none';
export const METRIC_COMPARISONS: MetricComparison[] = ['prior_year', 'prior_period', 'none'];
export const COMPARISON_LABEL: Record<MetricComparison, string | undefined> = {
  prior_year: 'YoY', prior_period: 'vs prior period', none: undefined,
};

/** loadCustomMetrics()'s DTO — a definition plus how many dashboard widgets currently bind to it and which other custom metrics' formulas depend on it. Defined here (not in the query file) so client components can import it without server-only code. */
export interface CustomMetricListItem extends CustomMetricDefinition {
  usageCount: number;
  usedByMetrics: string[];
  updatedAt?: string | null;
}

export function metricKind(def: Pick<CustomMetricDefinition, 'kind'>): CustomMetricKind {
  return def.kind === 'ledger' ? 'ledger' : 'formula';
}

export const CUSTOM_METRIC_KEY_RE = /^[a-z][a-z0-9_]{2,49}$/;

// ── Evaluation ───────────────────────────────────────────────────────────

type Which = 'value' | 'previous';

interface EvalCtx {
  bundle: ReportBundle;
  customByKey: Map<string, CustomMetricDefinition>;
  /** Custom metric keys currently being evaluated up the call stack — a repeat means a cycle, which resolves to null rather than recursing forever. */
  visiting: Set<string>;
}

function makeCtx(bundle: ReportBundle, customMetrics: CustomMetricDefinition[]): EvalCtx {
  return { bundle, customByKey: new Map(customMetrics.map((m) => [m.key, m])), visiting: new Set() };
}

function finite(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

/** Months covered by the bundle's own selected period (12 annual, 6 half, 3 quarter) — what avg_per_month divides a period total by. */
function periodMonthCount(bundle: ReportBundle): number {
  try {
    return resolvePeriod(bundle.period_params ?? {}).plIndices.length || 1;
  } catch {
    return 12;
  }
}

function applyOp(op: FormulaOp, args: number[]): number | null {
  switch (op) {
    case 'add': return args.reduce((s, v) => s + v, 0);
    case 'multiply': return args.reduce((s, v) => s * v, 1);
    case 'subtract': return args[0] - args[1];
    case 'divide':
    case 'safe_divide': return args[1] === 0 ? null : args[0] / args[1];
    // percent_of(a, b) = a / b * 100 — the one op with an implicit x100, so
    // "Salary as % of Revenue" needs no separate x100 constant node.
    case 'percent_of': return args[1] === 0 ? null : (args[0] / args[1]) * 100;
    case 'min': return Math.min(...args);
    case 'max': return Math.max(...args);
    case 'abs': return Math.abs(args[0]);
    case 'round': {
      const f = 10 ** Math.max(0, Math.min(6, Math.round(args[1])));
      return Math.round(args[0] * f) / f;
    }
    default: return null;
  }
}

/**
 * Two independent bounds keep evaluation cheap and finite: `depth` counts
 * nodes within ONE expression (reset to 0 when stepping into another custom
 * metric's own expression — each expression was already validated to
 * MAX_DEPTH on save), and `ctx.visiting.size` counts how many custom metrics
 * deep the evaluation currently is (MAX_CUSTOM_NESTING).
 */
function customPoint(def: CustomMetricDefinition, ctx: EvalCtx, which: Which): number | null {
  if (ctx.visiting.has(def.key)) return null; // cycle — see EvalCtx.visiting
  if (metricKind(def) === 'ledger') {
    const v = ctx.bundle.custom_metric_values?.[def.key];
    if (!v) return null;
    return which === 'value' ? v.value : v.previous;
  }
  if (!def.expression || ctx.visiting.size >= MAX_CUSTOM_NESTING) return null;
  ctx.visiting.add(def.key);
  try {
    return evalNode(def.expression, ctx, which, 0);
  } finally {
    ctx.visiting.delete(def.key);
  }
}

function evalNode(expr: FormulaExpr, ctx: EvalCtx, which: Which, depth: number): number | null {
  if (depth > MAX_DEPTH) return null;
  if (expr.type === 'const') return expr.value;
  if (expr.type === 'metric') {
    const builtIn = resolveMetric(expr.key, ctx.bundle);
    if (builtIn) return which === 'value' ? builtIn.value : builtIn.previous;
    const custom = ctx.customByKey.get(expr.key);
    return custom ? customPoint(custom, ctx, which) : null;
  }

  if (expr.op === 'percent_change') {
    // Growth vs the same period last year: needs this year's AND last year's
    // real value of the argument. There is no "prior of the prior" in a
    // bundle, so the metric's own previous value is honestly null.
    if (which === 'previous') return null;
    const now = evalNode(expr.args[0], ctx, 'value', depth + 1);
    const before = evalNode(expr.args[0], ctx, 'previous', depth + 1);
    if (!finite(now) || !finite(before) || before === 0) return null;
    return ((now - before) / Math.abs(before)) * 100;
  }
  if (expr.op === 'avg_per_month') {
    const total = evalNode(expr.args[0], ctx, which, depth + 1);
    return finite(total) ? total / periodMonthCount(ctx.bundle) : null;
  }
  if (expr.op === 'coalesce') {
    for (const a of expr.args) {
      const v = evalNode(a, ctx, which, depth + 1);
      if (finite(v)) return v;
    }
    return null;
  }

  const values = expr.args.map((a) => evalNode(a, ctx, which, depth + 1));
  if (values.some((v) => !finite(v))) return null;
  const out = applyOp(expr.op, values as number[]);
  return finite(out) ? out : null;
}

/**
 * Evaluates one expression tree against a real bundle. `which` selects the
 * current value or the (also real, never derived-from-current) prior-year
 * value for every leaf, so a custom metric's own YoY delta is built from
 * genuine prior-year figures. `customMetrics` lets 'metric' leaves reference
 * this company's other custom metrics. Any unresolvable/non-finite input
 * (outside `coalesce`) makes the whole result honestly `null` — never a
 * fabricated 0, NaN, or Infinity.
 */
export function evaluateExpr(
  expr: FormulaExpr,
  bundle: ReportBundle,
  which: Which = 'value',
  depth = 0,
  customMetrics: CustomMetricDefinition[] = [],
): number | null {
  if (depth > MAX_DEPTH) return null;
  return evalNode(expr, makeCtx(bundle, customMetrics), which, depth);
}

// ── Monthly trend evaluation ─────────────────────────────────────────────

const NO_TREND = Symbol('no-trend');
type PointOrNone = number | null | typeof NO_TREND;

function customPointAt(def: CustomMetricDefinition, ctx: EvalCtx, i: number): PointOrNone {
  if (ctx.visiting.has(def.key)) return NO_TREND;
  if (metricKind(def) === 'ledger') {
    const t = ctx.bundle.custom_metric_values?.[def.key]?.trend;
    return t && t[i] ? t[i].value : NO_TREND;
  }
  if (!def.expression || ctx.visiting.size >= MAX_CUSTOM_NESTING) return NO_TREND;
  ctx.visiting.add(def.key);
  try {
    return evalAt(def.expression, ctx, i, 0);
  } finally {
    ctx.visiting.delete(def.key);
  }
}

/** One reporting column's value — NO_TREND the moment any leaf has no real per-column data (the whole trend is then omitted, never partially guessed). Same two bounds as evalNode/customPoint. */
function evalAt(expr: FormulaExpr, ctx: EvalCtx, i: number, depth: number): PointOrNone {
  if (depth > MAX_DEPTH) return NO_TREND;
  if (expr.type === 'const') return expr.value;
  if (expr.type === 'metric') {
    const builtIn = resolveMetric(expr.key, ctx.bundle);
    if (builtIn) return builtIn.trend && builtIn.trend[i] ? builtIn.trend[i].value : NO_TREND;
    const custom = ctx.customByKey.get(expr.key);
    return custom ? customPointAt(custom, ctx, i) : NO_TREND;
  }
  // A YoY growth rate has no honest monthly equivalent here (no per-month
  // prior-year series) — so a formula using it simply has no trend.
  if (expr.op === 'percent_change') return NO_TREND;
  if (expr.op === 'avg_per_month') {
    const v = evalAt(expr.args[0], ctx, i, depth + 1);
    if (v === NO_TREND || !finite(v)) return v;
    const months = columnMonthCount(ctx.bundle, i);
    return v / months;
  }
  const values: (number | null)[] = [];
  for (const a of expr.args) {
    const v = evalAt(a, ctx, i, depth + 1);
    if (v === NO_TREND) return NO_TREND;
    values.push(v);
  }
  if (expr.op === 'coalesce') return values.find(finite) ?? null;
  if (values.some((v) => !finite(v))) return null;
  const out = applyOp(expr.op, values as number[]);
  return finite(out) ? out : null;
}

function columnMonthCount(bundle: ReportBundle, i: number): number {
  try {
    return resolvePeriod(bundle.period_params ?? {}).colIndices[i]?.length || 1;
  } catch {
    return 1;
  }
}

/** Real per-column series for a formula, aligned to bundle.mis.columns (the same columns every built-in monthly metric uses) — or undefined when any input lacks one. A column whose inputs can't be combined (e.g. ÷ 0) is 0 in the series, matching how every built-in trend renders a gap. */
function evaluateTrend(expr: FormulaExpr, ctx: EvalCtx): SeriesPoint[] | undefined {
  const labels = ctx.bundle.mis?.columns ?? [];
  if (!labels.length) return undefined;
  const points: SeriesPoint[] = [];
  for (let i = 0; i < labels.length; i++) {
    const v = evalAt(expr, ctx, i, 0);
    if (v === NO_TREND) return undefined;
    points.push({ label: labels[i], value: finite(v) ? v : 0 });
  }
  return points;
}

// ── Resolution into the shared ResolvedMetric shape ─────────────────────

/**
 * Wraps a custom metric into the exact ResolvedMetric shape resolveMetric()
 * returns, so every widget renderer works on it unchanged. `customMetrics`
 * (the company's full list) is needed whenever this metric's formula
 * references other custom metrics.
 */
export function resolveCustomMetric(
  def: CustomMetricDefinition,
  bundle: ReportBundle,
  customMetrics: CustomMetricDefinition[] = [],
): ResolvedMetric {
  let value: number | null = null;
  let previous: number | null = null;
  let trend: SeriesPoint[] | undefined;
  let breakdown: SeriesPoint[] | undefined;

  const comparison: MetricComparison = def.comparison ?? 'prior_year';
  const all = customMetrics.some((m) => m.key === def.key) ? customMetrics : [...customMetrics, def];

  if (metricKind(def) === 'ledger') {
    const v = bundle.custom_metric_values?.[def.key];
    value = v?.value ?? null;
    previous = v?.previous ?? null;
    trend = v?.trend?.length ? v.trend : undefined;
    breakdown = v?.breakdown ?? undefined;
  } else if (def.expression) {
    const ctx = makeCtx(bundle, all);
    ctx.visiting.add(def.key);
    value = evalNode(def.expression, ctx, 'value', 0);
    previous = evalNode(def.expression, ctx, 'previous', 0);
    trend = evaluateTrend(def.expression, ctx);
  }

  if (comparison === 'none') {
    previous = null;
  } else if (comparison === 'prior_period') {
    previous = priorPeriodValue(def, bundle, all);
  }

  const deltaPct = value != null && previous != null && previous !== 0
    ? ((value - previous) / Math.abs(previous)) * 100
    : null;
  return {
    key: def.key,
    label: def.label,
    value,
    previous,
    deltaPct,
    valueType: def.valueType,
    rawUnit: 'rupee',
    decimals: def.decimals,
    thresholds: def.thresholds,
    comparisonLabel: COMPARISON_LABEL[comparison],
    trend,
    breakdown,
  };
}

/**
 * The bundle as it would read for the PREVIOUS period (ReportBundle.
 * prior_period swapped into the main statement fields). prev_* are cleared:
 * a year-on-year function evaluated inside a previous-period value has no
 * honest answer here, so it resolves to null rather than to the wrong year.
 */
export function priorPeriodView(bundle: ReportBundle): ReportBundle | null {
  const pp = bundle.prior_period;
  if (!pp) return null;
  return {
    ...bundle,
    mis: pp.mis, bs: pp.bs, pl: pp.pl, cashflow: pp.cashflow, treasury: pp.treasury, ratios: pp.ratios, notes: pp.notes,
    custom_metric_values: pp.custom_metric_values,
    prev_mis: null, prev_bs: null, prev_pl: null, prev_cashflow: null, prev_treasury: null, prev_ratios: null, prev_notes: null,
    top_customers: [], vendor_expense: [], customer_margin: undefined,
    prior_period: null,
  };
}

/** A custom metric's value for the previous period, or null when that period isn't available. */
function priorPeriodValue(def: CustomMetricDefinition, bundle: ReportBundle, customMetrics: CustomMetricDefinition[]): number | null {
  const shifted = priorPeriodView(bundle);
  if (!shifted) return null;
  if (metricKind(def) === 'ledger') return shifted.custom_metric_values?.[def.key]?.value ?? null;
  if (!def.expression) return null;
  const ctx = makeCtx(shifted, customMetrics);
  ctx.visiting.add(def.key);
  return evalNode(def.expression, ctx, 'value', 0);
}

/**
 * The one place a WIDGET's series binding may resolve either a built-in
 * catalog key or a company custom metric key — built-in first (the common
 * case), then the company's list. `null` only when the key is neither — the
 * same "unrecognized key, not an error" contract as resolveMetric().
 */
export function resolveAnyMetric(key: string, bundle: ReportBundle, customMetrics: CustomMetricDefinition[]): ResolvedMetric | null {
  const builtIn = resolveMetric(key, bundle);
  if (builtIn) return builtIn;
  const custom = customMetrics.find((m) => m.key === key);
  return custom ? resolveCustomMetric(custom, bundle, customMetrics) : null;
}

// ── Capabilities (which widget types a custom metric can feed) ──────────

export interface MetricCapabilities { supportsSeries: boolean; supportsBreakdown: boolean }

function exprSupportsSeries(expr: FormulaExpr, byKey: Map<string, CustomMetricDefinition>, visiting: Set<string>): boolean {
  if (expr.type === 'const') return true;
  if (expr.type === 'metric') {
    const entry = findMetricCatalogEntry(expr.key);
    if (entry) return entry.supportsSeries;
    const custom = byKey.get(expr.key);
    if (!custom || visiting.has(custom.key)) return false;
    if (metricKind(custom) === 'ledger') return true;
    if (!custom.expression) return false;
    visiting.add(custom.key);
    try { return exprSupportsSeries(custom.expression, byKey, visiting); } finally { visiting.delete(custom.key); }
  }
  if (expr.op === 'percent_change') return false;
  return expr.args.every((a) => exprSupportsSeries(a, byKey, visiting));
}

/**
 * Whether a custom metric genuinely has a monthly series (every leaf does)
 * and/or a real composition breakdown (ledger metrics: one slice per
 * matched ledger) — the same flags METRIC_CATALOG entries declare, used by
 * WidgetPicker/WidgetInspector to only offer a custom metric to widget types
 * it can really fill.
 */
export function customMetricCapabilities(def: CustomMetricDefinition, customMetrics: CustomMetricDefinition[] = []): MetricCapabilities {
  if (metricKind(def) === 'ledger') return { supportsSeries: true, supportsBreakdown: true };
  if (!def.expression) return { supportsSeries: false, supportsBreakdown: false };
  const byKey = new Map(customMetrics.map((m) => [m.key, m]));
  return { supportsSeries: exprSupportsSeries(def.expression, byKey, new Set([def.key])), supportsBreakdown: false };
}

// ── Validation (server-side before anything is stored) ──────────────────

export type ValidateExprResult = { ok: true } | { ok: false; error: string };

/**
 * Structural validation of a formula tree. `isKnownMetricKey` decides which
 * metric keys a leaf may reference — the save route passes "a built-in
 * METRIC_CATALOG key OR one of this company's existing custom metric keys";
 * cycles through custom metrics are checked separately, over the whole
 * company graph, by findDependencyCycle().
 */
export function validateExpr(
  expr: unknown,
  isKnownMetricKey: (key: string) => boolean,
  depth = 0,
  nodeCounter: { count: number } = { count: 0 },
): ValidateExprResult {
  nodeCounter.count += 1;
  if (nodeCounter.count > MAX_NODES) return { ok: false, error: `Formula has more than ${MAX_NODES} nodes` };
  if (depth > MAX_DEPTH) return { ok: false, error: `Formula nesting exceeds ${MAX_DEPTH} levels` };
  if (!expr || typeof expr !== 'object') return { ok: false, error: 'Each formula node must be an object' };
  const node = expr as Record<string, unknown>;

  if (node.type === 'const') {
    return typeof node.value === 'number' && Number.isFinite(node.value)
      ? { ok: true }
      : { ok: false, error: 'A const node needs a finite numeric value' };
  }
  if (node.type === 'metric') {
    if (typeof node.key !== 'string' || !isKnownMetricKey(node.key)) {
      return { ok: false, error: `Unknown metric key in formula: ${String(node.key)}` };
    }
    return { ok: true };
  }
  if (node.type === 'op') {
    const op = node.op as FormulaOp;
    if (!FORMULA_OPS.includes(op)) return { ok: false, error: `Unknown operator: ${String(node.op)}` };
    if (!Array.isArray(node.args)) return { ok: false, error: `"${op}" needs an args array` };
    const n = node.args.length;
    if (UNARY_OPS.has(op) && n !== 1) return { ok: false, error: `"${op}" takes exactly 1 argument` };
    if (BINARY_OPS.has(op) && n !== 2) return { ok: false, error: `"${op}" takes exactly 2 arguments` };
    if (N_ARY_OPS.has(op) && n < 2) return { ok: false, error: `"${op}" needs at least 2 arguments` };
    if (op === 'round') {
      const places = node.args[1] as Record<string, unknown> | null;
      if (!places || places.type !== 'const' || !Number.isInteger(places.value) || (places.value as number) < 0 || (places.value as number) > 6) {
        return { ok: false, error: '"round" needs a whole number of decimal places between 0 and 6' };
      }
    }
    for (const arg of node.args) {
      const res = validateExpr(arg, isKnownMetricKey, depth + 1, nodeCounter);
      if (!res.ok) return res;
    }
    return { ok: true };
  }
  return { ok: false, error: `Unknown formula node type: ${String(node.type)}` };
}

const MAX_LEDGER_CONDITIONS = 10;
const MAX_LIST_VALUES = 50;
const MAX_VALUE_LEN = 120;

/** Validates and normalizes a client-supplied ledger filter spec — never trusted as-is. Returns a clean copy on success. */
export function validateLedgerSpec(raw: unknown): { ok: true; spec: LedgerMetricSpec } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'ledgerSpec must be an object' };
  const s = raw as Record<string, unknown>;
  const match = s.match === 'any' ? 'any' : s.match === 'all' ? 'all' : null;
  if (!match) return { ok: false, error: 'ledgerSpec.match must be "all" or "any"' };
  const measure = s.measure === 'movement' || s.measure === 'closing' ? s.measure : null;
  if (!measure) return { ok: false, error: 'ledgerSpec.measure must be "movement" or "closing"' };
  const sign = s.sign === 'invert' ? 'invert' : s.sign === 'natural' || s.sign == null ? 'natural' : null;
  if (!sign) return { ok: false, error: 'ledgerSpec.sign must be "natural" or "invert"' };
  const aggregation = s.aggregation == null ? 'sum' : (LEDGER_AGGREGATIONS as readonly string[]).includes(String(s.aggregation)) ? (s.aggregation as LedgerAggregation) : null;
  if (!aggregation) return { ok: false, error: `ledgerSpec.aggregation must be one of: ${LEDGER_AGGREGATIONS.join(', ')}` };
  if (!Array.isArray(s.conditions) || s.conditions.length === 0) {
    return { ok: false, error: 'Add at least one ledger filter condition' };
  }
  if (s.conditions.length > MAX_LEDGER_CONDITIONS) {
    return { ok: false, error: `A ledger metric may have at most ${MAX_LEDGER_CONDITIONS} conditions` };
  }
  const conditions: LedgerFilterCondition[] = [];
  for (let i = 0; i < s.conditions.length; i++) {
    const c = s.conditions[i] as Record<string, unknown> | null;
    if (!c || typeof c !== 'object') return { ok: false, error: `Condition ${i + 1} is malformed` };
    if (!(LEDGER_FILTER_FIELDS as readonly string[]).includes(String(c.field))) return { ok: false, error: `Condition ${i + 1}: unknown field` };
    if (!(LEDGER_FILTER_OPERATORS as readonly string[]).includes(String(c.operator))) return { ok: false, error: `Condition ${i + 1}: unknown operator` };
    const operator = c.operator as LedgerFilterCondition['operator'];
    const field = c.field as LedgerFilterCondition['field'];
    const numericField = NUMERIC_LEDGER_FIELDS.includes(field);
    if (!numericField && NUMERIC_ONLY_OPERATORS.includes(operator)) return { ok: false, error: `Condition ${i + 1}: "${operator}" only applies to a number field (Note no. or Amount)` };
    if (numericField && TEXT_ONLY_OPERATORS.includes(operator)) return { ok: false, error: `Condition ${i + 1}: "${operator}" only applies to a text field` };
    const isList = operator === 'in' || operator === 'not_in';
    const needsNumber = numericField && operator !== 'is_empty' && operator !== 'is_not_empty';
    const isNum = (v: string) => v.trim() !== '' && Number.isFinite(Number(v.replace(/,/g, '')));
    let value: string | string[];
    if (VALUELESS_OPERATORS.includes(operator)) {
      value = '';
    } else if (operator === 'between') {
      const pair = (Array.isArray(c.value) ? c.value : typeof c.value === 'string' ? c.value.split(',') : []).map((v) => String(v).trim());
      if (pair.length !== 2 || !pair.every(isNum)) return { ok: false, error: `Condition ${i + 1}: "between" needs a lower and an upper number` };
      if (Number(pair[0].replace(/,/g, '')) > Number(pair[1].replace(/,/g, ''))) return { ok: false, error: `Condition ${i + 1}: the lower bound is above the upper bound` };
      value = pair;
    } else if (isList) {
      const list = (Array.isArray(c.value) ? c.value : typeof c.value === 'string' ? c.value.split(',') : [])
        .map((v) => String(v).trim()).filter(Boolean);
      if (!list.length) return { ok: false, error: `Condition ${i + 1}: enter at least one value` };
      if (list.length > MAX_LIST_VALUES) return { ok: false, error: `Condition ${i + 1}: at most ${MAX_LIST_VALUES} values` };
      if (list.some((v) => v.length > MAX_VALUE_LEN)) return { ok: false, error: `Condition ${i + 1}: a value is too long` };
      if (needsNumber && !list.every(isNum)) return { ok: false, error: `Condition ${i + 1}: every value must be a number` };
      value = list;
    } else {
      const v = typeof c.value === 'string' || typeof c.value === 'number' ? String(c.value).trim() : '';
      if (!v) return { ok: false, error: `Condition ${i + 1}: enter a value` };
      if (v.length > MAX_VALUE_LEN) return { ok: false, error: `Condition ${i + 1}: value is too long` };
      if (needsNumber && !isNum(v)) return { ok: false, error: `Condition ${i + 1}: enter a number` };
      value = v;
    }
    conditions.push({ field, operator, value });
  }
  return { ok: true, spec: { match, measure, sign, aggregation, conditions } };
}

// ── Dependency graph between custom metrics ─────────────────────────────

/** Every metric key a formula references (built-in and custom alike). */
export function collectMetricRefs(expr: FormulaExpr | null | undefined, out: Set<string> = new Set()): Set<string> {
  if (!expr) return out;
  if (expr.type === 'metric') out.add(expr.key);
  else if (expr.type === 'op') expr.args.forEach((a) => collectMetricRefs(a, out));
  return out;
}

function customDeps(def: CustomMetricDefinition, customKeys: Set<string>): string[] {
  if (metricKind(def) !== 'formula') return [];
  return [...collectMetricRefs(def.expression)].filter((k) => customKeys.has(k));
}

/**
 * Returns a cycle among custom metrics as the key path (e.g. ['a','b','a']),
 * or null if the graph is acyclic. Run over the company's FULL metric list
 * with the candidate definition swapped in, before any save/restore.
 */
export function findDependencyCycle(defs: CustomMetricDefinition[]): string[] | null {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const keys = new Set(byKey.keys());
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (key: string): string[] | null => {
    if (state.get(key) === 'done') return null;
    if (state.get(key) === 'visiting') return [...stack.slice(stack.indexOf(key)), key];
    state.set(key, 'visiting');
    stack.push(key);
    for (const dep of customDeps(byKey.get(key)!, keys)) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(key, 'done');
    return null;
  };
  for (const key of keys) {
    const cycle = visit(key);
    if (cycle) return cycle;
  }
  return null;
}

/** Longest chain of custom-metric references starting at `key` (1 = references no other custom metric). Assumes an acyclic graph (check findDependencyCycle first). */
export function customNestingDepth(key: string, defs: CustomMetricDefinition[]): number {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const keys = new Set(byKey.keys());
  const memo = new Map<string, number>();
  const depthOf = (k: string, guard: Set<string>): number => {
    if (memo.has(k)) return memo.get(k)!;
    if (guard.has(k)) return Infinity;
    guard.add(k);
    const def = byKey.get(k);
    const deps = def ? customDeps(def, keys) : [];
    const d = 1 + (deps.length ? Math.max(...deps.map((x) => depthOf(x, guard))) : 0);
    guard.delete(k);
    memo.set(k, d);
    return d;
  };
  return depthOf(key, new Set());
}

/** Keys of the custom metrics whose formulas reference `key` directly — a metric with dependents can't be deleted until they stop referencing it. */
export function findDependents(key: string, defs: CustomMetricDefinition[]): string[] {
  return defs.filter((d) => d.key !== key && metricKind(d) === 'formula' && collectMetricRefs(d.expression).has(key)).map((d) => d.key);
}

// ── Whole-definition validation (shared by save and restore) ─────────────

const VALUE_TYPES: ValueType[] = ['currency', 'percent', 'ratio', 'days', 'number'];
/** Keys that would collide with a static API route segment (/api/v1/custom-metrics/preview). */
const RESERVED_KEYS = new Set(['preview', 'versions']);

export type ValidateDefinitionResult = { ok: true; definition: CustomMetricDefinition } | { ok: false; error: string };

/**
 * Everything that must hold before a custom metric definition is stored —
 * by a save OR a restore of an old version (whose referenced metrics may
 * have changed since). `existing` is the company's current full list; the
 * candidate replaces its own key there for the graph checks (cycles and
 * nesting depth are properties of the whole company graph, not of one
 * formula). Returns a normalized copy on success.
 */
export function validateCustomMetricDefinition(
  candidate: CustomMetricDefinition, existing: CustomMetricDefinition[],
): ValidateDefinitionResult {
  const key = candidate.key;
  if (!CUSTOM_METRIC_KEY_RE.test(key)) return { ok: false, error: 'Key must be 3-50 lowercase letters/digits/underscores, starting with a letter' };
  if (RESERVED_KEYS.has(key)) return { ok: false, error: `"${key}" is a reserved word — choose a different key` };
  if (isKnownMetricKey(key)) return { ok: false, error: `"${key}" is already a built-in metric key — choose a different one` };
  const label = candidate.label?.trim() ?? '';
  if (!label) return { ok: false, error: 'Name is required' };
  if (label.length > 150) return { ok: false, error: 'Name must be 150 characters or fewer' };
  const description = candidate.description?.trim() || null;
  if (description && description.length > 300) return { ok: false, error: 'Description must be 300 characters or fewer' };
  if (!VALUE_TYPES.includes(candidate.valueType)) return { ok: false, error: `Display type must be one of: ${VALUE_TYPES.join(', ')}` };
  if (!Number.isInteger(candidate.decimals) || candidate.decimals < 0 || candidate.decimals > 6) {
    return { ok: false, error: 'Decimals must be a whole number between 0 and 6' };
  }
  const t = candidate.thresholds;
  if (t && (!Number.isFinite(t.target) || (t.direction !== 'higher_is_better' && t.direction !== 'lower_is_better'))) {
    return { ok: false, error: 'A target needs a finite value and a direction' };
  }
  const warn = t?.warn ?? null;
  if (warn != null) {
    if (!t) return { ok: false, error: 'A warning level needs a target' };
    if (!Number.isFinite(warn)) return { ok: false, error: 'The warning level must be a number' };
    if (t.direction === 'higher_is_better' ? warn >= t.target : warn <= t.target) {
      return { ok: false, error: t.direction === 'higher_is_better'
        ? 'When higher is better, the warning level must be below the target'
        : 'When lower is better, the warning level must be above the target' };
    }
  }
  const comparison = candidate.comparison ?? 'prior_year';
  if (!METRIC_COMPARISONS.includes(comparison)) return { ok: false, error: 'Comparison must be prior_year, prior_period or none' };

  const kind = metricKind(candidate);
  let expression: FormulaExpr | null = null;
  let ledgerSpec: LedgerMetricSpec | null = null;
  if (kind === 'formula') {
    if (!candidate.expression || candidate.expression.type !== 'op') {
      return { ok: false, error: 'A formula metric must combine or transform at least one figure (add a step)' };
    }
    const customKeys = new Set(existing.filter((m) => m.key !== key).map((m) => m.key));
    const res = validateExpr(candidate.expression, (k) => isKnownMetricKey(k) || customKeys.has(k) || k === key);
    if (!res.ok) return { ok: false, error: res.error };
    if (collectMetricRefs(candidate.expression).has(key)) return { ok: false, error: 'A metric cannot reference itself' };
    expression = candidate.expression;
  } else {
    const res = validateLedgerSpec(candidate.ledgerSpec);
    if (!res.ok) return { ok: false, error: res.error };
    ledgerSpec = res.spec;
  }

  const definition: CustomMetricDefinition = {
    ...candidate, key, label, description, kind, expression, ledgerSpec, comparison,
    thresholds: t ? { target: t.target, direction: t.direction, ...(warn != null ? { warn } : {}) } : null,
  };
  const graph = [...existing.filter((m) => m.key !== key), definition];
  const cycle = findDependencyCycle(graph);
  if (cycle) {
    const names = new Map(graph.map((m) => [m.key, m.label]));
    return { ok: false, error: `Circular reference: ${cycle.map((k) => names.get(k) ?? k).join(' → ')}` };
  }
  for (const m of graph) {
    if (customNestingDepth(m.key, graph) > MAX_CUSTOM_NESTING) {
      return { ok: false, error: `Custom metrics may reference each other at most ${MAX_CUSTOM_NESTING} levels deep ("${m.label}" would exceed that)` };
    }
  }
  return { ok: true, definition };
}

// ── Version snapshots ───────────────────────────────────────────────────

/** Exactly what one row of custom_metric_versions.snapshot holds — keys mirror the SQL backfill in db/schema.sql. */
export interface CustomMetricSnapshot {
  key: string;
  label: string;
  description: string | null;
  kind: CustomMetricKind;
  valueType: ValueType;
  decimals: number;
  expression: FormulaExpr | null;
  ledgerSpec: LedgerMetricSpec | null;
  targetValue: number | null;
  thresholdDirection: 'higher_is_better' | 'lower_is_better' | null;
  /** Absent in snapshots recorded before warn levels existed — read as null. */
  warnValue?: number | null;
  /** Absent in snapshots recorded before comparison choice existed — read as 'prior_year'. */
  comparison?: MetricComparison;
}

export function toSnapshot(def: CustomMetricDefinition): CustomMetricSnapshot {
  return {
    key: def.key,
    label: def.label,
    description: def.description ?? null,
    kind: metricKind(def),
    valueType: def.valueType,
    decimals: def.decimals,
    expression: metricKind(def) === 'formula' ? def.expression : null,
    ledgerSpec: metricKind(def) === 'ledger' ? def.ledgerSpec ?? null : null,
    targetValue: def.thresholds ? def.thresholds.target : null,
    thresholdDirection: def.thresholds ? def.thresholds.direction : null,
    warnValue: def.thresholds?.warn ?? null,
    comparison: def.comparison ?? 'prior_year',
  };
}

export function fromSnapshot(s: CustomMetricSnapshot): CustomMetricDefinition {
  const target = s.targetValue != null ? Number(s.targetValue) : null;
  const warn = s.warnValue != null ? Number(s.warnValue) : null;
  return {
    key: s.key,
    label: s.label,
    description: s.description ?? null,
    kind: s.kind === 'ledger' ? 'ledger' : 'formula',
    valueType: s.valueType,
    decimals: s.decimals,
    expression: s.kind === 'ledger' ? null : s.expression,
    ledgerSpec: s.kind === 'ledger' ? s.ledgerSpec : null,
    thresholds: target != null && Number.isFinite(target) && s.thresholdDirection
      ? { target, direction: s.thresholdDirection, ...(warn != null && Number.isFinite(warn) ? { warn } : {}) }
      : null,
    comparison: s.comparison && METRIC_COMPARISONS.includes(s.comparison) ? s.comparison : 'prior_year',
  };
}

const SNAPSHOT_FIELDS: (keyof CustomMetricSnapshot)[] = [
  'label', 'description', 'kind', 'valueType', 'decimals', 'expression', 'ledgerSpec', 'targetValue', 'thresholdDirection',
  'warnValue', 'comparison',
];

/** Which definition fields differ between two snapshots — stored with each version so the history reads "changed: formula, target" at a glance. */
export function diffSnapshots(before: CustomMetricSnapshot | null, after: CustomMetricSnapshot): string[] {
  if (!before) return ['created'];
  const norm = (snap: CustomMetricSnapshot, f: keyof CustomMetricSnapshot) =>
    JSON.stringify(f === 'comparison' ? snap.comparison ?? 'prior_year' : snap[f] ?? null);
  return SNAPSHOT_FIELDS.filter((f) => norm(before, f) !== norm(after, f));
}

// ── Chain building for CustomMetricBuilder.tsx ──────────────────────────
//
// The builder never exposes an arbitrary tree: it builds a left-associative
// CHAIN — start from one operand, then fold each step onto the running
// result. A step is either a two-operand operator with its operand
// (`acc op operand`) or a function applied to the running result
// (`abs(acc)`, `percent_change(acc)`, `avg_per_month(acc)`); `round` is a
// two-operand step whose operand is its decimal places.

export type Operand = { type: 'metric'; key: string } | { type: 'const'; value: number };
export interface ChainStep { op: FormulaOp; operand?: Operand }

/** Builds a left-associative FormulaExpr from a first operand and an ordered list of steps. */
export function buildChainExpr(first: Operand, steps: ChainStep[]): FormulaExpr {
  return steps.reduce<FormulaExpr>((acc, step) => (
    UNARY_OPS.has(step.op)
      ? { type: 'op', op: step.op, args: [acc] }
      : { type: 'op', op: step.op, args: [acc, step.operand ?? { type: 'const', value: 0 }] }
  ), first);
}

/**
 * Reverses buildChainExpr() for editing. Only recognizes the exact
 * left-associative shape the builder produces (the only writer of formula
 * expressions in this codebase) — null for anything else rather than
 * guessing at a shape nothing ever writes.
 */
export function flattenChain(expr: FormulaExpr): { first: Operand; steps: ChainStep[] } | null {
  const steps: ChainStep[] = [];
  let node = expr;
  while (node.type === 'op') {
    if (UNARY_OPS.has(node.op)) {
      if (node.args.length !== 1) return null;
      steps.unshift({ op: node.op });
      node = node.args[0];
      continue;
    }
    if (node.args.length !== 2) return null;
    const [left, right] = node.args;
    if (right.type !== 'metric' && right.type !== 'const') return null;
    steps.unshift({ op: node.op, operand: right });
    node = left;
  }
  if (node.type !== 'metric' && node.type !== 'const') return null;
  if (steps.length === 0) return null;
  return { first: node, steps };
}

const OP_SYMBOL: Partial<Record<FormulaOp, string>> = {
  add: '+', subtract: '−', multiply: '×', divide: '÷', safe_divide: '÷', percent_of: '÷',
};

export interface DescribeOptions {
  /** Label lookup for custom metric keys (built-in keys are always looked up in METRIC_CATALOG). */
  labelFor?: (key: string) => string | undefined;
  depth?: number;
}

/**
 * Human-readable formula for previews and lists, e.g.
 * "((Employee Benefits + Other Expenses) ÷ Revenue from Operations) × 100".
 * Recursive over any FormulaExpr shape.
 */
export function describeExpr(expr: FormulaExpr, opts: DescribeOptions = {}): string {
  const depth = opts.depth ?? 0;
  const child = (e: FormulaExpr) => describeExpr(e, { ...opts, depth: depth + 1 });
  if (expr.type === 'const') return String(expr.value);
  if (expr.type === 'metric') return findMetricCatalogEntry(expr.key)?.label ?? opts.labelFor?.(expr.key) ?? expr.key;

  let text: string;
  switch (expr.op) {
    case 'min': case 'max':
      text = `${expr.op}(${expr.args.map((a) => describeExpr(a, { ...opts, depth: 0 })).join(', ')})`;
      return text;
    case 'coalesce':
      return `first available of (${expr.args.map((a) => describeExpr(a, { ...opts, depth: 0 })).join(', ')})`;
    case 'abs':
      return `|${describeExpr(expr.args[0], { ...opts, depth: 0 })}|`;
    case 'round':
      return `round(${describeExpr(expr.args[0], { ...opts, depth: 0 })}, ${expr.args[1]?.type === 'const' ? expr.args[1].value : '?'})`;
    case 'percent_change':
      return `% change vs prior year of (${describeExpr(expr.args[0], { ...opts, depth: 0 })})`;
    case 'avg_per_month':
      return `monthly average of (${describeExpr(expr.args[0], { ...opts, depth: 0 })})`;
    default: {
      const inner = expr.args.map(child).join(` ${OP_SYMBOL[expr.op] ?? expr.op} `);
      text = expr.op === 'percent_of' ? `(${inner}) × 100` : inner;
      return depth === 0 ? text : `(${text})`;
    }
  }
}

const FIELD_LABEL: Record<string, string> = {
  ledger_name: 'Ledger name', ledger_code: 'Ledger code', note_no: 'Note no.', note_name: 'Note name',
  section: 'Section', zoho_account_type: 'Account type', amount: 'Amount',
};
const OPERATOR_LABEL: Record<string, string> = {
  equals: 'is', not_equals: 'is not', contains: 'contains', not_contains: 'does not contain',
  starts_with: 'starts with', in: 'is any of', not_in: 'is none of',
  gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'is between', is_empty: 'is empty', is_not_empty: 'is not empty',
};
const AGGREGATION_LABEL: Record<LedgerAggregation, string> = {
  sum: '', avg: 'Average per ledger of', count: 'Number of ledgers with', min: 'Smallest ledger', max: 'Largest ledger',
};

/** Plain-English summary of a ledger metric, e.g. "Movement of ledgers where Ledger name contains "salary" and Note no. is "23"". */
export function describeLedgerSpec(spec: LedgerMetricSpec): string {
  const conds = spec.conditions.map((c) => {
    const label = `${FIELD_LABEL[c.field] ?? c.field} ${OPERATOR_LABEL[c.operator] ?? c.operator}`;
    if (c.operator === 'is_empty' || c.operator === 'is_not_empty') return label;
    if (c.operator === 'between' && Array.isArray(c.value)) return `${label} ${c.value[0]} and ${c.value[1]}`;
    const v = Array.isArray(c.value) ? c.value.map((x) => `"${x}"`).join(', ') : `"${c.value}"`;
    return `${label} ${v}`;
  }).join(spec.match === 'any' ? ' or ' : ' and ');
  const measure = spec.measure === 'closing' ? 'closing balance' : 'movement';
  const agg = spec.aggregation ?? 'sum';
  const lead = agg === 'sum'
    ? `${measure === 'movement' ? 'Movement' : 'Closing balance'} of ledgers`
    : agg === 'count' ? `Number of ledgers with ${measure} (non-zero)` : `${AGGREGATION_LABEL[agg]} ${measure}`;
  return `${lead} where ${conds}${spec.sign === 'invert' ? ' (sign inverted)' : ''}`;
}

/** describeExpr() or describeLedgerSpec(), whichever fits the definition's kind. */
export function describeCustomMetric(def: CustomMetricDefinition, customMetrics: CustomMetricDefinition[] = []): string {
  if (metricKind(def) === 'ledger') return def.ledgerSpec ? describeLedgerSpec(def.ledgerSpec) : 'Ledger metric';
  if (!def.expression) return '—';
  const labels = new Map(customMetrics.map((m) => [m.key, m.label]));
  return describeExpr(def.expression, { labelFor: (k) => labels.get(k) });
}
