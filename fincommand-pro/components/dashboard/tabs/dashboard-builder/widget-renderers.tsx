'use client';

/**
 * The 19-widget-type registry — each renderer is a small function of
 * `{widget, resolved}`; `renderWidget()` dispatches by `widget.widgetType`
 * and falls back to a graceful "unknown widget type" card instead of
 * crashing (same convention the reference dashboard builder's own registry
 * uses), so a widget row with a stale/unrecognized type after a future
 * schema change degrades instead of breaking the whole dashboard.
 *
 * Charting reuses this app's existing Chart.js setup (lib/charts/register.ts)
 * via the same `<Bar>`/`<Line>`/`<Doughnut>` wrappers already used by
 * RevenueEbitdaChart/MarginTrendChart/TreasuryCompositionChart — no new
 * charting library. line_chart/bar_chart go through react-chartjs-2's
 * generic `<Chart>` so each series can be drawn as bars or a line
 * (WidgetSeriesBinding.renderAs) and against the left or a second,
 * right-hand axis (WidgetSeriesBinding.axis) — e.g. revenue bars with an
 * EBITDA-margin % line on its own scale.
 */
import { useEffect } from 'react';
import { Bar, Line, Doughnut, Chart } from 'react-chartjs-2';
import type { ChartData, ChartOptions } from 'chart.js';
import { ensureChartsRegistered } from '@/lib/client/chart-register';
import { fn, frRaw, pct, fx, signedPct, numTone, benchmarkTone, formatChg, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { useDashboard } from '@/lib/client/DashboardContext';
import { findMetricCatalogEntry, thresholdStatus, ratioOf, type DashboardWidget, type ResolvedMetric } from '@/lib/financial/dashboard-builder-engine';
import { isBSSection } from '@/lib/financial/note-catalog';
import { jumpToNoteCard } from '@/lib/utils/note-navigation';
import { WidgetFrame } from './WidgetFrame';
import { WaterfallChart, type WaterfallStep } from '@/components/charts/WaterfallChart';

export interface WidgetRenderProps {
  widget: DashboardWidget;
  /** Parallel to widget.series — one resolved metric per binding, or null when that metric key couldn't be resolved (never fatal to the rest of the widget). */
  resolved: (ResolvedMetric | null)[];
  displayUnit: DisplayUnit;
  currency: CurrencyCode;
}

const PALETTE = ['#378ADD', '#1D9E75', '#EF9F27', '#D85A30', '#3C3489', '#0F6E56'];

function useChartsRegistered() {
  useEffect(() => { ensureChartsRegistered(); }, []);
}

function formatValue(m: ResolvedMetric, unit: DisplayUnit, currency: CurrencyCode): string {
  if (m.value == null) return '—';
  switch (m.valueType) {
    case 'currency':
      // TopCustomer.revenue_cr-shaped values are already in Crores — route
      // through frRaw() (no further division), same convention as
      // OverviewTab's own Top Customers table.
      if (m.rawUnit === 'crore') return `${frRaw(m.value, m.decimals)} Cr`;
      // Previously a `compact` flag routed stat_card/stat_card_sparkline
      // through fcRaw() (currency-symbol, adaptive Lakh/Crore, ignores the
      // Unit Selector — see its own doc comment) while every other widget
      // type on this exact grid (gauge, data_table, metric_table,
      // period_summary, yoy_variance) already called this same function and
      // got the correct fn()-below unit-scaled path — a customized "Total
      // Assets" stat_card widget showed "Rs. 9.92 Cr" and stayed frozen
      // there while the fixed view's identical figure, right next to the
      // "Customize" toggle, tracked the Unit Selector correctly. Removed;
      // every caller now gets the same real, unit-scaled figure.
      return fn(m.value, m.decimals, unit);
    case 'percent': return pct(m.value, m.decimals);
    case 'ratio': return fx(m.value, m.decimals);
    case 'days': return `${Math.round(m.value)}d`;
    // A plain count (e.g. notes_total_count) is not a raw-rupee table
    // amount — routing it through fn()/fl() would divide a real integer
    // like 17 by the Lakhs/Crores/Thousands unit divisor and round it to
    // "—" (confirmed live: Notes to Accounts' "Total Notes" widget showed
    // "—" instead of 17 before this case existed, the exact "not a raw-rupee
    // amount" scenario frRaw()'s own doc comment already calls out). 'number'
    // has been a documented ValueType since this file's first widget-type
    // registry but had no dedicated case until notes_total_count became the
    // first catalog entry to actually use it.
    case 'number': return frRaw(m.value, m.decimals);
    default: return fn(m.value, m.decimals, unit);
  }
}

function benchmarkSuffix(m: ResolvedMetric): string {
  return m.valueType === 'percent' ? '%' : m.valueType === 'days' ? 'd' : m.valueType === 'ratio' ? 'x' : '';
}

/** Same per-valueType formatting as formatValue(), for a single trend point rather than m.value — used by metric_table, one cell at a time. Never the compact currency form, so unlike formatValue() this needs no currency code. */
function formatPoint(value: number, m: ResolvedMetric, unit: DisplayUnit): string {
  switch (m.valueType) {
    case 'currency':
      if (m.rawUnit === 'crore') return `${frRaw(value, m.decimals)} Cr`;
      return fn(value, m.decimals, unit);
    case 'percent': return pct(value, m.decimals);
    case 'ratio': return fx(value, m.decimals);
    case 'days': return `${Math.round(value)}d`;
    // See formatValue()'s identical 'number' case above — a plain count
    // (e.g. notes_total_count, bindable to metric_table like any other
    // catalog metric) is not a raw-rupee amount to unit-scale.
    case 'number': return frRaw(value, m.decimals);
    default: return fn(value, m.decimals, unit);
  }
}

/**
 * Sign alone isn't meaningful for a ratio (e.g. a positive Debt/Equity isn't
 * automatically "good") — when this metric carries a real benchmark, tone
 * follows whether it's actually meeting that benchmark (delegates to the one
 * canonical benchmarkTone() in format.ts); only genuinely sign-meaningful
 * figures (revenue, EBITDA, PAT, ...) fall back to plain sign-based
 * numTone().
 */
function toneForMetric(m: ResolvedMetric): 'up' | 'dn' | 'wn' | '' {
  // thresholdStatus() is benchmarkTone()'s rule plus the optional warn level
  // in between (amber) — the same judgement the exports use.
  const status = thresholdStatus(m.value, m.thresholds);
  if (status) return status === 'good' ? 'up' : status === 'warn' ? 'wn' : 'dn';
  return numTone(m.value);
}

/** "Benchmark > 15%", plus " · warn 10–15%" when the metric has a warning level. */
function benchmarkLine(m: ResolvedMetric): string | null {
  const t = m.thresholds;
  if (!t) return null;
  const sfx = benchmarkSuffix(m);
  const base = `Benchmark ${t.direction === 'higher_is_better' ? '>' : '<'} ${t.target}${sfx}`;
  if (t.warn == null || !Number.isFinite(t.warn)) return base;
  return `${base} · warn ${Math.min(t.warn, t.target)}–${Math.max(t.warn, t.target)}${sfx}`;
}

/** What the change figure is measured against — "YoY" for every built-in metric; a custom metric may compare with the prior period instead. */
function comparisonText(m: ResolvedMetric): string {
  return m.comparisonLabel ?? 'YoY';
}

/** A breakdown row is always an amount (a ledger's, a vendor's, a customer's …), whatever the metric's own value type — same formatting DataTableWidget has always used. */
function formatBreakdownValue(value: number, m: ResolvedMetric, unit: DisplayUnit): string {
  return m.rawUnit === 'crore' ? `${frRaw(value)} Cr` : fn(value, 2, unit);
}

function EmptyNotice({ text = 'No data for this metric yet.' }: { text?: string }) {
  return <div style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic', padding: '6px 2px' }}>{text}</div>;
}

// ── 1. stat_card ──────────────────────────────────────────────────────────
function StatCardWidget({ widget, resolved, displayUnit, currency }: WidgetRenderProps) {
  const m = resolved[0];
  if (!m) return <WidgetFrame title={widget.title}><EmptyNotice /></WidgetFrame>;
  const showCompare = widget.vizConfig.compare !== false && m.deltaPct != null;
  return (
    <WidgetFrame title={widget.title ?? m.label} subtitle={widget.subtitle}>
      <div className={`val ${toneForMetric(m)}`} style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2 }}>
        {formatValue(m, displayUnit, currency)}
      </div>
      {showCompare ? (
        <div className={`chg ${numTone(m.deltaPct)}`} style={{ fontSize: 11, marginTop: 4 }}>{signedPct(m.deltaPct)} {comparisonText(m)}</div>
      ) : m.thresholds ? (
        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>{benchmarkLine(m)}</div>
      ) : null}
    </WidgetFrame>
  );
}

// ── 2. stat_card_sparkline ──────────────────────────────────────────────────
function StatCardSparklineWidget({ widget, resolved, displayUnit, currency }: WidgetRenderProps) {
  useChartsRegistered();
  const m = resolved[0];
  if (!m) return <WidgetFrame title={widget.title}><EmptyNotice /></WidgetFrame>;
  const hasTrend = !!m.trend && m.trend.length > 0;
  const sparkType: 'bar' | 'line' = widget.vizConfig.spark_type === 'bar' ? 'bar' : 'line';
  const data = hasTrend ? {
    labels: m.trend!.map((p) => p.label),
    datasets: [{
      data: m.trend!.map((p) => p.value),
      backgroundColor: '#B5D4F4', borderColor: '#378ADD', borderWidth: 2,
      tension: 0.3, pointRadius: 0, fill: sparkType === 'line',
    }],
  } : undefined;
  const options = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { x: { display: false }, y: { display: false } },
  };
  return (
    <WidgetFrame title={widget.title ?? m.label} subtitle={widget.subtitle}>
      <div className={`val ${toneForMetric(m)}`} style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>
        {formatValue(m, displayUnit, currency)}
      </div>
      {hasTrend ? (
        <div style={{ height: 44, position: 'relative' }}>
          {sparkType === 'bar' ? <Bar data={data!} options={options} /> : <Line data={data!} options={options} />}
        </div>
      ) : (
        <EmptyNotice text="No monthly trend available for this metric." />
      )}
    </WidgetFrame>
  );
}

// ── 3/4. line_chart / bar_chart (multi-series, monthly) ─────────────────────
// Each series may be drawn as bars or a line regardless of the widget's own
// type (binding.renderAs), and against a second, right-hand axis
// (binding.axis) with its own scale and number format — so a currency bar
// series and a % line can share one chart without the % line flattening to
// zero against a crore-scale axis.
type AxisId = 'y' | 'y1';
function MultiSeriesWidget({ widget, resolved, kind, displayUnit }: WidgetRenderProps & { kind: 'line' | 'bar' }) {
  useChartsRegistered();
  const usable = resolved
    .map((m, i) => ({ m, binding: widget.series[i] }))
    .filter((x): x is { m: ResolvedMetric; binding: typeof x.binding } => !!x.m && !!x.m.trend && x.m.trend.length > 0);
  if (!usable.length) {
    return <WidgetFrame title={widget.title}><EmptyNotice text="No monthly trend available for the selected metric(s)." /></WidgetFrame>;
  }
  const labels = usable[0].m.trend!.map((p) => p.label);
  const stacked = kind === 'bar' && widget.vizConfig.stacked === true;
  // Everything on the right and nothing on the left is just one axis.
  const anyLeft = usable.some(({ binding }) => binding?.axis !== 'right');
  const series = usable.map(({ m, binding }, i) => ({
    m,
    label: binding?.label || m.label,
    type: (binding?.renderAs ?? kind) as 'bar' | 'line',
    axisId: (anyLeft && binding?.axis === 'right' ? 'y1' : 'y') as AxisId,
    color: binding?.color || PALETTE[i % PALETTE.length],
  }));
  const datasets = series.map(({ m, label, type, axisId, color }, i) => ({
    type,
    label,
    data: m.trend!.map((p) => p.value),
    backgroundColor: type === 'bar' ? color : `${color}33`,
    borderColor: color, borderWidth: 2, tension: 0.3, pointRadius: 2,
    fill: false,
    yAxisID: axisId,
    // Chart.js draws higher `order` first — lines (0) land on top of bars (1).
    order: type === 'line' ? 0 : 1,
    // Only bars on the same axis stack; a line gets a group of its own so it
    // is never added on top of the bars it's meant to be read against.
    stack: stacked ? (type === 'bar' ? `bars-${axisId}` : `line-${i}`) : undefined,
  }));
  const showLegend = widget.vizConfig.legend !== false;
  // Each axis is formatted by the first series plotted on it — every
  // default multi-series widget binds same-shaped metrics to one axis anyway
  // (Revenue+EBITDA are both currency, Gross/EBITDA/PAT % are all percent),
  // same assumption RevenueEbitdaChart/MarginTrendChart make. Previously the
  // axis had NO unit-aware formatting at all (raw rupee ticks like
  // "4500000" beside the fixed view's "45.00" Lakhs for the same data).
  const leftMetric = series.find((x) => x.axisId === 'y')!.m;
  const rightMetric = series.find((x) => x.axisId === 'y1')?.m ?? null;
  const axisFor = (metric: ResolvedMetric, position: 'left' | 'right') => {
    const isPercent = metric.valueType === 'percent';
    return {
      position,
      stacked,
      // Same fixed ±100%/25-step clamp MarginTrendChart's own comment
      // documents: one extreme low-revenue month (e.g. -600% from dividing
      // near-zero revenue) would otherwise auto-rescale the whole axis and
      // flatten every normal month.
      ...(isPercent ? { min: -100, max: 100 } : {}),
      ticks: {
        font: { size: 10 },
        ...(isPercent ? { stepSize: 25 } : {}),
        callback: (v: number | string) => formatPoint(Number(v), metric, displayUnit),
      },
      // Gridlines follow the left axis only — two sets would not line up.
      grid: position === 'left' ? { color: 'rgba(128,128,128,0.07)' } : { drawOnChartArea: false },
    };
  };
  const options = {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      // `order` (lines over bars) would otherwise also reorder the legend
      // and tooltip — keep both in the order the series were bound.
      legend: {
        display: showLegend,
        labels: { font: { size: 10 }, sort: (a: { datasetIndex?: number }, b: { datasetIndex?: number }) => (a.datasetIndex ?? 0) - (b.datasetIndex ?? 0) },
      },
      tooltip: {
        itemSort: (a: { datasetIndex: number }, b: { datasetIndex: number }) => a.datasetIndex - b.datasetIndex,
        callbacks: {
          label: (ctx: { dataset: { label?: string }; datasetIndex: number; raw: unknown }) =>
            `${ctx.dataset.label}: ${formatPoint(ctx.raw as number, series[ctx.datasetIndex]?.m ?? leftMetric, displayUnit)}`,
        },
      },
    },
    scales: {
      x: { stacked, ticks: { font: { size: 10 }, maxRotation: 40 }, grid: { display: false } },
      y: axisFor(leftMetric, 'left'),
      ...(rightMetric ? { y1: axisFor(rightMetric, 'right') } : {}),
    },
  };
  return (
    <WidgetFrame title={widget.title} subtitle={widget.subtitle}>
      <div style={{ height: '100%', minHeight: 120, position: 'relative' }}>
        <Chart
          type={kind}
          data={{ labels, datasets } as ChartData<'bar' | 'line', number[], string>}
          options={options as ChartOptions<'bar' | 'line'>}
        />
      </div>
    </WidgetFrame>
  );
}

// ── 5. donut_chart (composition breakdown) ──────────────────────────────────
function DonutChartWidget({ widget, resolved }: WidgetRenderProps) {
  useChartsRegistered();
  const m = resolved[0];
  const present = (m?.breakdown ?? []).filter((b) => Math.abs(b.value) > 0.005);
  if (!m || !present.length) {
    return <WidgetFrame title={widget.title}><EmptyNotice text="No breakdown data available for this metric." /></WidgetFrame>;
  }
  const total = present.reduce((s, b) => s + b.value, 0);
  const data = {
    labels: present.map((b) => b.label),
    datasets: [{
      data: present.map((b) => b.value),
      backgroundColor: present.map((_, i) => PALETTE[i % PALETTE.length]),
      borderColor: '#fff', borderWidth: 2,
    }],
  };
  const options = {
    responsive: true, maintainAspectRatio: false, cutout: '62%',
    plugins: {
      legend: { position: 'right' as const, labels: { font: { size: 10 }, boxWidth: 10, padding: 8 } },
      tooltip: {
        callbacks: {
          label: (ctx: { label: string; raw: unknown }) => {
            const v = ctx.raw as number;
            const p = total > 0 ? ((v / total) * 100).toFixed(1) : '0.0';
            return `${ctx.label}: ${p}%`;
          },
        },
      },
    },
  };
  return (
    <WidgetFrame title={widget.title ?? m.label} subtitle={widget.subtitle}>
      <div style={{ height: '100%', minHeight: 120, position: 'relative' }}>
        <Doughnut data={data} options={options} />
      </div>
    </WidgetFrame>
  );
}

// ── 6. gauge (ratio vs. real benchmark) ─────────────────────────────────────
function GaugeWidget({ widget, resolved, displayUnit, currency }: WidgetRenderProps) {
  const m = resolved[0];
  if (!m) return <WidgetFrame title={widget.title}><EmptyNotice /></WidgetFrame>;
  const target = m.thresholds?.target;
  const status = thresholdStatus(m.value, m.thresholds);
  // Below benchmark has always been amber here; with a warning level set,
  // amber is the warn zone and past it turns red.
  const hasWarn = m.thresholds?.warn != null;
  const fillClass = status == null ? 'g-blue' : status === 'good' ? 'g-green' : status === 'warn' || !hasWarn ? 'g-amber' : 'g-red';
  const fillPct = target && m.value != null
    ? (m.thresholds!.direction === 'higher_is_better' ? (m.value / target) * 100 : (target / Math.max(m.value, 0.01)) * 100)
    : 50;
  return (
    <WidgetFrame title={widget.title ?? m.label} subtitle={widget.subtitle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
        <span style={{ color: 'var(--text2)' }}>{m.label}</span>
        <span style={{ fontWeight: 600 }}>{formatValue(m, displayUnit, currency)}</span>
      </div>
      <div className="gauge-wrap">
        <div className={`gauge-fill ${fillClass}`} style={{ width: `${Math.min(100, Math.max(4, fillPct))}%` }} />
      </div>
      <div style={{ fontSize: 9, color: 'var(--text3)', textAlign: 'right' }}>
        {target != null ? benchmarkLine(m) : 'No fixed benchmark for this metric'}
      </div>
    </WidgetFrame>
  );
}

// ── 7. data_table (breakdown rows) ──────────────────────────────────────────
function DataTableWidget({ widget, resolved, displayUnit }: WidgetRenderProps) {
  const m = resolved[0];
  if (!m) return <WidgetFrame title={widget.title}><EmptyNotice /></WidgetFrame>;
  // Default of 5 must match WidgetInspector's own displayed default for this
  // exact field (`typeof widget.vizConfig.limit === 'number' ? ... : 5`) —
  // a freshly-added widget (vizConfig: {}, see CustomizableTabPanel's
  // addWidget()) previously fell through to `undefined` here, and
  // Array.prototype.slice(0, undefined) applies no cap at all, silently
  // rendering every real row (confirmed: 33 vendors, not 5) while the
  // settings panel sat right next to it showing "5" as if that limit were
  // already active. SYSTEM_DEFAULT_WIDGETS' own 'default-top-customers'
  // entry already relies on 5 being the real default (it sets `limit: 5`
  // explicitly for the identical reason) — this brings every OTHER data_table
  // in line with that same, already-established default instead of a second,
  // silently different one.
  const limit = typeof widget.vizConfig.limit === 'number' ? widget.vizConfig.limit : 5;
  const rows = (m.breakdown ?? []).slice(0, limit);
  if (!rows.length) return <WidgetFrame title={widget.title ?? m.label}><EmptyNotice text="No rows available for this metric." /></WidgetFrame>;
  return (
    <WidgetFrame title={widget.title ?? m.label} subtitle={widget.subtitle} bare>
      <table className="fc-table">
        <thead><tr><th>Name</th><th className="num">Value</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td className={`num ${numTone(r.value)}`}>{formatBreakdownValue(r.value, m, displayUnit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </WidgetFrame>
  );
}

// ── 8. metric_table (rows = up to 4 metrics, columns = the period's months) ─
function MetricTableWidget({ widget, resolved, displayUnit }: WidgetRenderProps) {
  const usable = resolved
    .map((m, i) => ({ m, binding: widget.series[i] }))
    .filter((x): x is { m: ResolvedMetric; binding: typeof x.binding } => !!x.m && !!x.m.trend && x.m.trend.length > 0);
  if (!usable.length) {
    return <WidgetFrame title={widget.title}><EmptyNotice text="No monthly trend available for the selected metric(s)." /></WidgetFrame>;
  }
  const months = usable[0].m.trend!.map((p) => p.label);
  return (
    <WidgetFrame title={widget.title} subtitle={widget.subtitle} bare>
      <div style={{ overflowX: 'auto' }}>
        <table className="fc-table">
          <thead>
            <tr>
              <th>Metric</th>
              {months.map((mo, i) => <th key={i} className="num">{mo}</th>)}
            </tr>
          </thead>
          <tbody>
            {usable.map(({ m, binding }, idx) => (
              <tr key={`${m.key}-${idx}`}>
                <td>{binding?.label || m.label}</td>
                {m.trend!.map((p, i) => (
                  <td key={i} className={`num ${numTone(p.value)}`}>{formatPoint(p.value, m, displayUnit)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </WidgetFrame>
  );
}

// ── 9. period_summary (fixed real P&L waterfall, % of Revenue) ──────────────
// Employee Cost is a cost MAGNITUDE, not a signed profit figure — it's always
// >= 0 by construction, so numTone() on its raw value trivially always
// returned 'up' (green), a meaningless-at-best/misleading-at-worst "this
// expense is favorable" read that OverviewTab.tsx's own fixed-view Period
// Summary table never applied to this exact row (no tone class on either its
// Value or %-of-Revenue cell). `neutral: true` opts a row out of value-cell
// tone the same way, keeping this widget and the fixed view in parity.
const PERIOD_SUMMARY_ROWS: { label: string; bold?: boolean; neutral?: boolean }[] = [
  { label: 'Revenue' }, { label: 'Gross Profit' }, { label: 'EBITDA' }, { label: 'PBT' }, { label: 'PAT', bold: true }, { label: 'Employee Cost', neutral: true },
];
function PeriodSummaryWidget({ widget, resolved, displayUnit, currency }: WidgetRenderProps) {
  // resolved is always exactly [revenue, gross_profit, ebitda, pbt, pat, employee_cost],
  // in that order — see PERIOD_SUMMARY_METRIC_KEYS in dashboard-builder-engine.ts.
  const revenue = resolved[0];
  if (!revenue) return <WidgetFrame title={widget.title}><EmptyNotice /></WidgetFrame>;
  const revenueValue = revenue.value;
  return (
    <WidgetFrame title={widget.title} subtitle={widget.subtitle} bare>
      <table className="fc-table">
        <thead><tr><th>Metric</th><th className="num">Value</th><th className="num">% of Revenue</th></tr></thead>
        <tbody>
          {PERIOD_SUMMARY_ROWS.map((row, i) => {
            const m = resolved[i];
            const pctOfRev = m?.value != null && revenueValue ? (m.value / revenueValue) * 100 : null;
            return (
              <tr key={row.label} className={row.bold ? 'tot-row' : undefined}>
                <td className={row.bold ? 'bold' : undefined}>{row.label}</td>
                <td className={`num ${row.bold ? 'bold' : ''} ${m && !row.neutral ? numTone(m.value) : ''}`}>{m ? formatValue(m, displayUnit, currency) : '—'}</td>
                <td className={`num ${row.bold ? 'bold' : ''}`}>{pctOfRev != null ? pct(pctOfRev) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </WidgetFrame>
  );
}

// ── 10. yoy_variance (up to 4 metrics vs. their real prior-year figure) ─────
// A cost/expense line rising isn't inherently bad (e.g. hiring for growth) —
// same "don't judge a cost line's direction" call the Executive Overview
// fixed view's own Year-on-Year Variance table already makes for Employee
// Cost. Kept as an explicit key set (not a valueType/group check) because
// "is this metric a cost" isn't otherwise represented in METRIC_CATALOG —
// every genuinely revenue/profit-level metric (including custom metrics,
// which fall through to the default colored case) gets a real favorable/
// unfavorable read. 'pl_total_expenses' (the P&L-zone Total Expenses figure)
// is the sum of exactly these same cost lines, so the identical reasoning
// applies to it — added here after an audit found a yoy_variance widget can
// bind ANY METRIC_CATALOG key (this widget type isn't supportsSeries-gated
// in WidgetPicker.tsx), so a user binding Total Expenses would otherwise get
// a profit-line-style red/green read on a rising cost total.
const NEUTRAL_VARIANCE_KEYS = new Set(['employee_cost', 'cost_of_services', 'other_expenses', 'finance_costs', 'depreciation', 'pl_total_expenses']);
function YoyVarianceWidget({ widget, resolved, displayUnit, currency }: WidgetRenderProps) {
  const usable = resolved
    .map((m, i) => ({ m, binding: widget.series[i] }))
    .filter((x): x is { m: ResolvedMetric; binding: typeof x.binding } => !!x.m);
  if (!usable.length) return <WidgetFrame title={widget.title}><EmptyNotice /></WidgetFrame>;
  return (
    <WidgetFrame title={widget.title} subtitle={widget.subtitle} bare>
      <table className="fc-table">
        <thead>
          <tr><th>Head</th><th className="num">Current</th><th className="num" style={{ color: 'var(--text2)' }}>Prior</th><th className="num">Variance</th></tr>
        </thead>
        <tbody>
          {usable.map(({ m, binding }, idx) => {
            const label = binding?.label || m.label;
            // Real prior-year figure or honestly null (never derived from the current value) —
            // same convention resolveMetric()/resolveCustomMetric() already guarantee.
            const chgPct = m.value != null && m.previous != null && m.previous !== 0
              ? ((m.value - m.previous) / Math.abs(m.previous)) * 100
              : null;
            const badgeClass = chgPct == null ? 'pgy' : NEUTRAL_VARIANCE_KEYS.has(m.key) ? 'pgy' : chgPct >= 0 ? 'pg' : 'pr';
            return (
              <tr key={`${m.key}-${idx}`}>
                <td>{label}</td>
                <td className="num">{formatValue(m, displayUnit, currency)}</td>
                <td className="num" style={{ color: 'var(--text2)' }}>{m.previous != null ? formatPoint(m.previous, m, displayUnit) : '—'}</td>
                <td className="num"><span className={`pill ${badgeClass}`}>{chgPct == null ? 'n/a' : signedPct(chgPct)}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </WidgetFrame>
  );
}

// ── 11. text_block (no metric binding) ───────────────────────────────────────
function TextBlockWidget({ widget }: WidgetRenderProps) {
  const text = typeof widget.vizConfig.text === 'string' ? widget.vizConfig.text : '';
  return (
    <WidgetFrame title={widget.title} subtitle={widget.subtitle}>
      <div style={{ fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', color: 'var(--text2)' }}>
        {text || <span style={{ fontStyle: 'italic', color: 'var(--text3)' }}>Empty text block — add text from the widget settings.</span>}
      </div>
    </WidgetFrame>
  );
}

// ── 12. financial_health (4 key solvency & liquidity indicators) ───────────
function FinancialHealthWidget({ widget, displayUnit }: WidgetRenderProps) {
  const { bundle } = useDashboard();
  if (!bundle) return <WidgetFrame title={widget.title || 'Financial Health & Solvency'}><EmptyNotice /></WidgetFrame>;
  const { ratios, bs } = bundle;
  const netWorkingCapital = bs ? bs.assets.total_ca - bs.equity_liabilities.total_cl : 0;
  // fx/pct/numTone below are the SAME real functions (imported at module
  // scope) OverviewTab.tsx's own Financial Health & Solvency card uses —
  // previously this widget hand-rolled its own local fx() that skipped the
  // real fx()'s NaN and near-zero (EPSILON) guards, so a debt-free company
  // (debt_equity === 0) would show "0.00x" here but "—" in the fixed view
  // for the identical real figure.
  //
  // Net Working Capital below used to go through fcRaw() (currency-symbol,
  // adaptive Lakh/Crore, ignores the Unit Selector) — same bug as
  // OverviewTab.tsx's own mirrored card, now fixed identically there too.
  //
  // Current Ratio / ROE / Debt-Equity tone: previously Current Ratio and
  // Debt/Equity carried no tone class at all, and ROE used plain sign-based
  // numTone() — a positive-but-below-15%-target ROE would have shown
  // green/favorable. All three are ratios with a real benchmark (the same
  // ones METRIC_CATALOG's own current_ratio/roe_pct/debt_equity entries
  // define — read from there, not retyped a third time, so this card can
  // never drift from the catalog's real numbers), so all three now go
  // through benchmarkTone() like every other benchmarked ratio in this file
  // (toneForMetric()/GaugeWidget already did this correctly; this hand-coded
  // card, mirrored from OverviewTab.tsx's own fixed-view version, did not).
  const crThresholds = findMetricCatalogEntry('current_ratio')!.thresholds!;
  const roeThresholds = findMetricCatalogEntry('roe_pct')!.thresholds!;
  const deThresholds = findMetricCatalogEntry('debt_equity')!.thresholds!;
  return (
    <WidgetFrame title={widget.title || 'Financial Health & Solvency'} subtitle={widget.subtitle || 'Liquidity · Profitability · Leverage'} bare>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, padding: 14 }}>
        <div className="so-item">
          <div className="so-lbl">Current Ratio</div>
          <div className={`so-val ${benchmarkTone(ratios.liquidity.current_ratio, crThresholds.target, crThresholds.direction)}`}>{fx(ratios.liquidity.current_ratio)}</div>
          <div style={{ fontSize: 10, color: 'var(--text3)' }}>Benchmark &gt; 1.5x</div>
        </div>
        <div className="so-item">
          <div className="so-lbl">Net Working Capital</div>
          <div className={`so-val ${numTone(netWorkingCapital)}`}>{fn(netWorkingCapital, 2, displayUnit)}</div>
          <div style={{ fontSize: 10, color: 'var(--text3)' }}>Current Assets − Current Liabilities</div>
        </div>
        <div className="so-item">
          <div className="so-lbl">Return on Equity</div>
          <div className={`so-val ${benchmarkTone(ratios.profitability.roe, roeThresholds.target, roeThresholds.direction)}`}>{pct(ratios.profitability.roe)}</div>
          <div style={{ fontSize: 10, color: 'var(--text3)' }}>Benchmark &gt; 15%</div>
        </div>
        <div className="so-item">
          <div className="so-lbl">Debt / Equity</div>
          <div className={`so-val ${benchmarkTone(ratios.leverage.debt_equity, deThresholds.target, deThresholds.direction)}`}>{fx(ratios.leverage.debt_equity)}</div>
          <div style={{ fontSize: 10, color: 'var(--text3)' }}>Benchmark &lt; 1.0x</div>
        </div>
      </div>
    </WidgetFrame>
  );
}

// ── 13. top_customers (real 5-column Top-5-by-Revenue table) ────────────────
// A fixed-content widget, like financial_health/period_summary above — reads
// bundle.top_customers/customer_margin directly rather than through
// `resolved`. Deliberately its OWN widget type rather than a data_table bound
// to the 'top_customers_revenue' catalog metric: that generic widget only
// ever renders a plain Name/Value pair from a breakdown array, so the
// customized grid's Top Customers card previously showed only 2 of the fixed
// view's 5 real columns — %-of-Revenue, GM%, and the Healthy/Key Account/
// Concentration Risk status pill were silently dropped. Mirrors
// OverviewTab.tsx's own Top Customers card line for line, including the
// Zoho/estimated-source badge and the "no customer data" notice.
function TopCustomersWidget({ widget, currency }: WidgetRenderProps) {
  const { bundle, dataMode } = useDashboard();
  if (!bundle) return <WidgetFrame title={widget.title || 'Top 5 Customers by Revenue'}><EmptyNotice /></WidgetFrame>;
  const symbol = getCurrencyMeta(currency).symbol;
  const customers = bundle.top_customers ?? [];
  // Same source badge as OverviewTab.tsx's own Top Customers card — this
  // widget's own doc comment above already claimed to mirror it "line for
  // line, including the Zoho/estimated-source badge", but the badge itself
  // was never actually added to this JSX, so the customized grid silently
  // showed real Zoho-sourced and estimated-from-ledgers figures identically,
  // with no way to tell which one a given row's data quality actually was —
  // found auditing Executive Overview's real data-provenance disclosures.
  const sourceBadge = customers[0]?.source === 'zoho' ? (
    <span className="cbadge cb-blue">Zoho — Sales by Customer</span>
  ) : customers[0]?.source === 'ledger_estimate' ? (
    <span className="cbadge cb-amber" title="No Zoho customer data yet — split from the current Trial Balance's own revenue ledgers instead.">
      Estimated — Revenue Ledger Split
    </span>
  ) : null;
  return (
    <WidgetFrame title={widget.title || 'Top 5 Customers by Revenue'} subtitle={widget.subtitle} headerRight={sourceBadge} bare>
      {customers.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="fc-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th className="num">Revenue ({symbol}Cr)</th>
                <th className="num">% of Revenue</th>
                <th className="num">GM %</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c, i) => {
                const marginEntry = bundle.customer_margin?.entries.find((e) => e.customer === c.customer);
                const gm = marginEntry && marginEntry.direct_cost > 0 ? marginEntry.direct_margin_pct : null;
                const gmTone = gm == null ? '' : gm >= 25 ? 'up' : gm < 15 ? 'dn' : '';
                return (
                  <tr key={i}>
                    <td>{c.customer}</td>
                    <td className="num">{frRaw(c.revenue_cr, 2)}</td>
                    <td className="num">{pct(c.pct_of_total)}</td>
                    <td className={`num ${gmTone}`} title={gm == null ? 'No direct cost tagged for this customer in Zoho' : undefined}>
                      {gm != null ? pct(gm) : '—'}
                    </td>
                    <td>
                      <span className={`pill ${c.status === 'Healthy' ? 'pg' : c.status === 'Key Account' ? 'pa' : 'pr'}`}>
                        {c.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyNotice
          text={
            dataMode === 'api'
              ? "Customer-level revenue isn't available for this Trial Balance yet — re-sync from the Upload tab, or split revenue into per-customer ledgers in Zoho Books."
              : 'Excel-uploaded Trial Balances carry ledger totals only, with no per-customer breakdown.'
          }
        />
      )}
    </WidgetFrame>
  );
}

// ── 14. profit_bridge (real Revenue→PAT waterfall, fixed content) ──────────
// A fixed-content widget, like financial_health/period_summary/top_customers
// above — reads bundle.pl directly rather than through `resolved`, and
// reuses WaterfallChart (the exact component PLTab.tsx's own fixed zone
// renders) with the identical step construction, so the customized grid's
// bridge can never numerically or visually diverge from the statutory
// zone's own "Profit Bridge — Revenue to PAT" chart for the same period.
function ProfitBridgeWidget({ widget, displayUnit }: WidgetRenderProps) {
  const { bundle } = useDashboard();
  if (!bundle) return <WidgetFrame title={widget.title || 'Profit Bridge — Revenue to PAT'}><EmptyNotice /></WidgetFrame>;
  const { pl } = bundle;
  const steps: WaterfallStep[] = [
    { label: 'Revenue', value: pl.revenue, isTotal: true },
    { label: '+ Other Income', value: pl.other_income },
    { label: '- Cost of Services', value: -pl.cos },
    { label: '- Employee Costs', value: -pl.employee_benefits },
    { label: '- Other Expenses', value: -pl.other_expenses },
    { label: '- Finance Costs', value: -pl.finance_costs },
    { label: '- Depreciation', value: -pl.depreciation },
    { label: 'PBT', value: pl.pbt, isTotal: true },
    { label: '- Tax', value: -(pl.current_tax + pl.deferred_tax) },
    { label: 'PAT', value: pl.pat, isTotal: true },
  ];
  return (
    <WidgetFrame title={widget.title || 'Profit Bridge — Revenue to PAT'} subtitle={widget.subtitle}>
      <div style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--text2)', marginBottom: 8 }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#1E3A8A', marginRight: 4, verticalAlign: 'middle' }} />Revenue / PBT / PAT</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#1D9E75', marginRight: 4, verticalAlign: 'middle' }} />Increase</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#D85A30', marginRight: 4, verticalAlign: 'middle' }} />Deduction</span>
      </div>
      <div style={{ height: 'calc(100% - 26px)', position: 'relative' }}><WaterfallChart steps={steps} unit={displayUnit} /></div>
    </WidgetFrame>
  );
}

// ── 15. cash_bridge (real Opening→Closing waterfall, fixed content) ────────
// A fixed-content widget, exactly like profit_bridge above — reads
// bundle.cashflow directly rather than through `resolved`, and reuses
// WaterfallChart (the exact component CashFlowTab.tsx's own fixed zone
// renders) with the identical step construction — including the conditional
// Reconciling Diff step, using the same >=1000 materiality threshold — so
// the customized grid's bridge can never numerically or visually diverge
// from the statutory zone's own "Cash Bridge — Opening to Closing" chart for
// the same period.
function CashBridgeWidget({ widget, displayUnit }: WidgetRenderProps) {
  const { bundle } = useDashboard();
  if (!bundle) return <WidgetFrame title={widget.title || 'Cash Bridge — Opening to Closing'}><EmptyNotice /></WidgetFrame>;
  const { cashflow: cf } = bundle;
  const op = cf.operating as Record<string, unknown>;
  const inv = cf.investing as Record<string, unknown>;
  const fin = cf.financing as Record<string, unknown>;
  const ocfTotal = op.total as number;
  const icfTotal = inv.total as number;
  const financingTotal = fin.total as number;
  const hasMaterialGap = Math.abs(cf.reconciling_gap) >= 1000;
  const steps: WaterfallStep[] = [
    { label: 'Opening Cash', value: cf.opening_cash, isTotal: true },
    { label: 'Operating CF', value: ocfTotal },
    { label: 'Investing CF', value: icfTotal },
    { label: 'Financing CF', value: financingTotal },
    ...(hasMaterialGap ? [{ label: 'Reconciling Diff.', value: cf.reconciling_gap }] : []),
    { label: 'Closing Cash', value: cf.closing_cash, isTotal: true },
  ];
  return (
    <WidgetFrame title={widget.title || 'Cash Bridge — Opening to Closing'} subtitle={widget.subtitle}>
      <div style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--text2)', marginBottom: 8 }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#1E3A8A', marginRight: 4, verticalAlign: 'middle' }} />Opening / Closing</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#1D9E75', marginRight: 4, verticalAlign: 'middle' }} />Inflow</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#D85A30', marginRight: 4, verticalAlign: 'middle' }} />Outflow</span>
      </div>
      <div style={{ height: 'calc(100% - 26px)', position: 'relative' }}><WaterfallChart steps={steps} unit={displayUnit} /></div>
    </WidgetFrame>
  );
}

// ── 16. note_index (real Note Index — a contents-page table, fixed content) ─
// A fixed-content widget, like top_customers/profit_bridge/cash_bridge above
// — reads bundle.notes/prev_notes directly rather than through `resolved`,
// and reuses jumpToNoteCard() (the exact function NotesTab.tsx's own Note
// Index and its cross-tab Balance Sheet/P&L "jump to note" both use), so a
// row clicked here scrolls to and highlights the identical note card the
// fixed zone's own SingleNoteCard renders — the note cards themselves are
// never part of this widget or any widget, only navigated to.
const NOTE_SECTION_LABEL: Record<string, string> = { eq: 'Equity', lnc: 'Non-Curr. Liab.', lc: 'Curr. Liab.', anc: 'Non-Curr. Assets', ac: 'Curr. Assets', inc: 'Income', exp: 'Expense' };
function noteIndexKey(section: string | null | undefined, noteNo: number): string {
  return `${isBSSection(section) ? 'bs' : 'pl'}_${noteNo}`;
}
function NoteIndexWidget({ widget, displayUnit }: WidgetRenderProps) {
  const { bundle } = useDashboard();
  if (!bundle) return <WidgetFrame title={widget.title || 'Note Index'}><EmptyNotice /></WidgetFrame>;
  const notes = bundle.notes ?? [];
  const prevNotes = bundle.prev_notes ?? [];
  const hasPrev = prevNotes.length > 0;
  const allKeys = Array.from(new Set([
    ...notes.map((n) => noteIndexKey(n.section, n.note_no)),
    ...prevNotes.map((n) => noteIndexKey(n.section, n.note_no)),
  ]));
  const combined = allKeys
    .map((key) => {
      const curr = notes.find((n) => noteIndexKey(n.section, n.note_no) === key);
      const prev = prevNotes.find((n) => noteIndexKey(n.section, n.note_no) === key);
      return { key, noteNo: curr?.note_no ?? prev?.note_no ?? 0, curr, prev };
    })
    .sort((a, b) => a.noteNo - b.noteNo);

  if (!combined.length) return <WidgetFrame title={widget.title || 'Note Index'} subtitle={widget.subtitle}><EmptyNotice text="No note data for this period." /></WidgetFrame>;

  return (
    <WidgetFrame title={widget.title || 'Note Index'} subtitle={widget.subtitle} bare>
      <div style={{ overflowX: 'auto' }}>
        <table className="fc-table">
          <thead>
            <tr>
              <th>Note</th><th>Description</th><th>Section</th><th className="num">Value</th>
              {hasPrev && <th className="num" style={{ color: 'var(--text2)' }}>Prior</th>}
              {hasPrev && <th className="num">YoY</th>}
            </tr>
          </thead>
          <tbody>
            {combined.map(({ key, noteNo, curr, prev }) => {
              const name = curr?.note_name || prev?.note_name || `Note ${noteNo}`;
              const sec = curr?.section || prev?.section || '';
              const cVal = curr?.total ?? 0;
              const pVal = prev?.total ?? 0;
              const chg = cVal - pVal;
              return (
                <tr key={key} onClick={() => jumpToNoteCard(key)} style={{ cursor: 'pointer' }} title={`Jump to Note ${noteNo}`}>
                  <td>{noteNo}</td>
                  <td>{name}</td>
                  <td style={{ fontSize: 11, color: 'var(--text2)' }}>{NOTE_SECTION_LABEL[sec] || sec}</td>
                  <td className="num">{fn(cVal, 2, displayUnit)}</td>
                  {hasPrev && <td className="num" style={{ color: 'var(--text2)' }}>{fn(pVal, 2, displayUnit)}</td>}
                  {hasPrev && <td className={`num ${numTone(chg)}`}>{formatChg(chg, 2, displayUnit)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </WidgetFrame>
  );
}

// ── 17. hbar_chart (one metric's breakdown as ranked horizontal bars) ───────
// The chart form of data_table — "which ledgers / vendors / customers make up
// this figure". Negative rows (e.g. a credit balance in an expense group)
// are drawn in red, pointing left, rather than hidden.
const HBAR_LABEL_MAX = 28;
function HBarChartWidget({ widget, resolved, displayUnit }: WidgetRenderProps) {
  useChartsRegistered();
  const m = resolved[0];
  const limit = typeof widget.vizConfig.limit === 'number' ? widget.vizConfig.limit : 8;
  const rows = (m?.breakdown ?? []).filter((b) => Math.abs(b.value) > 0.005).slice(0, limit);
  if (!m || !rows.length) {
    return <WidgetFrame title={widget.title ?? m?.label}><EmptyNotice text="No breakdown data available for this metric." /></WidgetFrame>;
  }
  const color = widget.series[0]?.color || PALETTE[0];
  const data = {
    labels: rows.map((r) => (r.label.length > HBAR_LABEL_MAX ? `${r.label.slice(0, HBAR_LABEL_MAX - 1)}…` : r.label)),
    datasets: [{
      label: widget.series[0]?.label || m.label,
      data: rows.map((r) => r.value),
      backgroundColor: rows.map((r) => (r.value < 0 ? '#D85A30' : color)),
      borderRadius: 3,
      maxBarThickness: 18,
    }],
  };
  const options = {
    indexAxis: 'y' as const,
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items: { dataIndex: number }[]) => rows[items[0]?.dataIndex ?? 0]?.label ?? '',
          label: (ctx: { raw: unknown }) => formatBreakdownValue(ctx.raw as number, m, displayUnit),
        },
      },
    },
    scales: {
      x: {
        ticks: { font: { size: 10 }, maxTicksLimit: 5, callback: (v: number | string) => formatBreakdownValue(Number(v), m, displayUnit) },
        grid: { color: 'rgba(128,128,128,0.07)' },
      },
      y: { ticks: { font: { size: 10 } }, grid: { display: false } },
    },
  };
  return (
    <WidgetFrame title={widget.title ?? m.label} subtitle={widget.subtitle}>
      <div style={{ height: '100%', minHeight: 120, position: 'relative' }}>
        <Bar data={data} options={options} />
      </div>
    </WidgetFrame>
  );
}

// ── 18. ratio_card (series[0] ÷ series[1]) ──────────────────────────────────
// e.g. "Employee cost ÷ Revenue" as a % or "Current assets ÷ Current
// liabilities" as a multiple — any two metrics, built-in or custom, without
// having to define a custom formula metric first. The change line is only
// shown when both metrics compare against the same kind of period (a
// prior-period numerator over a prior-year denominator is not a real ratio).
function RatioCardWidget({ widget, resolved, displayUnit, currency }: WidgetRenderProps) {
  const [num, den] = resolved;
  const numLabel = widget.series[0]?.label || num?.label;
  const denLabel = widget.series[1]?.label || den?.label;
  const title = widget.title ?? (numLabel && denLabel ? `${numLabel} ÷ ${denLabel}` : undefined);
  if (!num || !den) {
    return <WidgetFrame title={title}><EmptyNotice text="A ratio card needs a numerator and a denominator metric." /></WidgetFrame>;
  }
  const asPercent = widget.vizConfig.ratio_format !== 'multiple';
  const show = (r: number) => (asPercent ? pct(r * 100, 1) : fx(r, 2));
  const current = ratioOf(num.value, den.value);
  const sameBasis = comparisonText(num) === comparisonText(den);
  const prior = sameBasis ? ratioOf(num.previous, den.previous) : null;
  const change = current != null && prior != null ? (asPercent ? (current - prior) * 100 : current - prior) : null;
  const showCompare = widget.vizConfig.compare !== false && change != null;
  return (
    <WidgetFrame title={title} subtitle={widget.subtitle}>
      <div className="val" style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2 }}>{current == null ? '—' : show(current)}</div>
      {showCompare ? (
        <div style={{ fontSize: 11, marginTop: 4, color: 'var(--text2)' }}>
          {change! >= 0 ? '+' : '−'}{Math.abs(change!).toFixed(asPercent ? 1 : 2)}{asPercent ? ' pts' : 'x'} {comparisonText(num)}
          <span style={{ color: 'var(--text3)' }}> (was {show(prior!)})</span>
        </div>
      ) : null}
      <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 6, lineHeight: 1.5 }}>
        {numLabel} {formatValue(num, displayUnit, currency)} ÷ {denLabel} {formatValue(den, displayUnit, currency)}
      </div>
    </WidgetFrame>
  );
}

// ── 19. kpi_group (2–6 headline figures in one card) ────────────────────────
function KpiGroupWidget({ widget, resolved, displayUnit, currency }: WidgetRenderProps) {
  const items = resolved
    .map((m, i) => ({ m, binding: widget.series[i], i }))
    .filter((x): x is { m: ResolvedMetric; binding: typeof x.binding; i: number } => !!x.m);
  if (!items.length) return <WidgetFrame title={widget.title}><EmptyNotice /></WidgetFrame>;
  const showCompare = widget.vizConfig.compare !== false;
  return (
    <WidgetFrame title={widget.title} subtitle={widget.subtitle}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 12 }}>
        {items.map(({ m, binding, i }) => {
          const label = binding?.label || m.label;
          return (
            <div key={`${m.key}-${i}`} style={{ borderLeft: `3px solid ${binding?.color || PALETTE[i % PALETTE.length]}`, paddingLeft: 8, minWidth: 0 }}>
              <div title={label} style={{ fontSize: 10, color: 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
              <div className={`val ${toneForMetric(m)}`} style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.3 }}>{formatValue(m, displayUnit, currency)}</div>
              {showCompare && m.deltaPct != null ? (
                <div className={`chg ${numTone(m.deltaPct)}`} style={{ fontSize: 10 }}>{signedPct(m.deltaPct)} {comparisonText(m)}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </WidgetFrame>
  );
}

export function renderWidget(props: WidgetRenderProps): React.ReactElement {
  switch (props.widget.widgetType) {
    case 'stat_card': return <StatCardWidget {...props} />;
    case 'stat_card_sparkline': return <StatCardSparklineWidget {...props} />;
    case 'line_chart': return <MultiSeriesWidget {...props} kind="line" />;
    case 'bar_chart': return <MultiSeriesWidget {...props} kind="bar" />;
    case 'donut_chart': return <DonutChartWidget {...props} />;
    case 'gauge': return <GaugeWidget {...props} />;
    case 'data_table': return <DataTableWidget {...props} />;
    case 'metric_table': return <MetricTableWidget {...props} />;
    case 'period_summary': return <PeriodSummaryWidget {...props} />;
    case 'yoy_variance': return <YoyVarianceWidget {...props} />;
    case 'text_block': return <TextBlockWidget {...props} />;
    case 'financial_health': return <FinancialHealthWidget {...props} />;
    case 'top_customers': return <TopCustomersWidget {...props} />;
    case 'profit_bridge': return <ProfitBridgeWidget {...props} />;
    case 'cash_bridge': return <CashBridgeWidget {...props} />;
    case 'note_index': return <NoteIndexWidget {...props} />;
    case 'hbar_chart': return <HBarChartWidget {...props} />;
    case 'ratio_card': return <RatioCardWidget {...props} />;
    case 'kpi_group': return <KpiGroupWidget {...props} />;
    default:
      return <WidgetFrame title={props.widget.title}><EmptyNotice text={`Unknown widget type "${props.widget.widgetType}"`} /></WidgetFrame>;
  }
}
