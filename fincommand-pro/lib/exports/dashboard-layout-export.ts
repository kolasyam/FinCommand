'use client';

/**
 * Export a CUSTOMIZED view — a custom tab, My Dashboard, or a fixed tab's
 * saved widget layout — exactly as arranged on screen, to PDF, Excel,
 * PowerPoint, CSV or PNG. (Each tab's existing statutory/fixed-format export
 * is untouched; this is the "Export this view" path for the widget grid.)
 *
 * Two stages:
 *  1. buildLayoutExportModel() — PURE: turns the widgets + their resolved
 *     metrics (the same resolveAnyMetric() values the grid renders) + the
 *     bundle into typed blocks with raw numbers. No DOM, unit-tested.
 *  2. Renderers:
 *     - PDF (jsPDF + autotable, real selectable text, charts embedded from
 *       the widgets' own rendered Chart.js canvases, KPI cards and charts
 *       placed side by side in their on-screen grid proportions)
 *     - Excel (real numbers with native number formats)
 *     - PowerPoint (pptxgenjs, loaded on demand: KPI tiles, NATIVE editable
 *       charts — including bar+line combos on two axes — and tables)
 *     - CSV (one flat, tidy table of every figure, for other tools)
 *     - PNG (a picture of the grid exactly as on screen, via html-to-image,
 *       loaded on demand, under a company/period header band)
 *
 * Nothing here computes a figure — every value was already resolved for the
 * screen; exports only format and lay it out.
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as ExcelJS from 'exceljs';
import type PptxGenJS from 'pptxgenjs';
import type { ReportBundle } from '@/lib/dashboard/types';
import {
  resolveMetric, thresholdStatus, ratioOf, PERIOD_SUMMARY_METRIC_KEYS,
  type DashboardWidget, type ResolvedMetric, type ValueType, type RawUnit, type SeriesPoint,
} from '@/lib/financial/dashboard-builder-engine';
import { fn, frRaw, pct, fx, signedPct, getUnitHeader, getUnitHeaderPdf, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import {
  NAVY, SLATE, BORDER, MARGIN, CONTENT_W, PAGE_W, PDF_TABLE_STYLES, GREEN, GREEN_TINT, RED, RED_TINT, AMBER, AMBER_TINT,
  addPdfHeader, addPdfFooter, toneColor, toneTint, pdfTableBottom,
} from './pdf-kit';
import { ACC_FMT, toUnit, buildSheet, downloadWorkbook, type SheetRow, type CellVal } from './xlsx-kit';

// ── Model ────────────────────────────────────────────────────────────────

export interface ExportMetric {
  label: string;
  m: ResolvedMetric;
  /** line_chart/bar_chart only — how this series is drawn and against which axis (the widget's own settings). */
  renderAs?: 'bar' | 'line';
  axis?: 'left' | 'right';
  /** The series colour picked for this binding, if any. */
  color?: string;
}
export type NumCell = { num: number | null; type: ValueType; rawUnit?: RawUnit; decimals: number };
export type Cell = string | NumCell;

/** A ratio_card: series[0] ÷ series[1], as a % or a multiple — the same figures RatioCardWidget shows. */
export interface ExportRatio {
  label: string;
  format: 'percent' | 'multiple';
  /** In display terms: ×100 for a percentage, as-is for a multiple. */
  value: number | null;
  prior: number | null;
  /** Percentage points (percent) or x (multiple); null when there's no like-for-like comparative. */
  change: number | null;
  comparisonLabel: string;
  parts: ExportMetric[];
}

export type ExportBlock =
  | { kind: 'kpis'; widget: DashboardWidget; title: string; metrics: ExportMetric[] }
  | { kind: 'series'; widget: DashboardWidget; title: string; visual: 'line' | 'bar' | 'table'; columns: string[]; metrics: ExportMetric[] }
  | { kind: 'breakdown'; widget: DashboardWidget; title: string; visual: 'donut' | 'hbar' | 'table'; metric: ExportMetric; items: SeriesPoint[] }
  | { kind: 'ratio'; widget: DashboardWidget; title: string; ratio: ExportRatio }
  | { kind: 'yoy'; widget: DashboardWidget; title: string; metrics: ExportMetric[] }
  | { kind: 'table'; widget: DashboardWidget; title: string; head: string[]; rows: Cell[][] }
  | { kind: 'text'; widget: DashboardWidget; title: string; text: string }
  | { kind: 'empty'; widget: DashboardWidget; title: string; reason: string };

/** Visual order: top-to-bottom, then left-to-right — the order a reader scans the grid. */
export function orderWidgets(widgets: DashboardWidget[]): DashboardWidget[] {
  return [...widgets].sort((a, b) => a.gridY - b.gridY || a.gridX - b.gridX);
}

function named(binding: DashboardWidget['series'][number] | undefined, m: ResolvedMetric | null): ExportMetric | null {
  if (!m) return null;
  return {
    label: binding?.label || m.label, m,
    ...(binding?.renderAs ? { renderAs: binding.renderAs } : {}),
    ...(binding?.axis ? { axis: binding.axis } : {}),
    ...(binding?.color ? { color: binding.color } : {}),
  };
}
const cur = (num: number | null | undefined, rawUnit: RawUnit = 'rupee'): NumCell => ({ num: num ?? null, type: 'currency', rawUnit, decimals: 2 });
const pctCell = (num: number | null | undefined): NumCell => ({ num: num ?? null, type: 'percent', decimals: 1 });

/** What a metric's change figure is measured against — every built-in metric is year-on-year; a custom metric may use the previous period. */
export function comparisonOf(m: ResolvedMetric): string {
  return m.comparisonLabel ?? 'YoY';
}
function comparedWith(label: string): string {
  return label === 'vs prior period' ? 'Previous period' : 'Same period last year';
}

function buildRatio(w: DashboardWidget, num: ExportMetric, den: ExportMetric): ExportRatio {
  const format = w.vizConfig.ratio_format === 'multiple' ? 'multiple' : 'percent';
  const scale = format === 'percent' ? 100 : 1;
  const current = ratioOf(num.m.value, den.m.value);
  // Same rule as RatioCardWidget: a change only when both sides compare
  // against the same kind of period.
  const sameBasis = comparisonOf(num.m) === comparisonOf(den.m);
  const prior = sameBasis ? ratioOf(num.m.previous, den.m.previous) : null;
  return {
    label: `${num.label} ÷ ${den.label}`,
    format,
    value: current == null ? null : current * scale,
    prior: prior == null ? null : prior * scale,
    change: current != null && prior != null ? (current - prior) * scale : null,
    comparisonLabel: comparisonOf(num.m),
    parts: [num, den],
  };
}

/**
 * One export block per widget, in visual order. `resolveWidget` must return
 * the same resolved metrics the grid rendered (CustomizableTabPanel passes
 * its own resolveAnyMetric()-based resolver), so an export can never show a
 * different number than the screen.
 */
export function buildLayoutExportModel(
  widgets: DashboardWidget[],
  resolveWidget: (w: DashboardWidget) => (ResolvedMetric | null)[],
  bundle: ReportBundle,
): ExportBlock[] {
  return orderWidgets(widgets).map((w): ExportBlock => {
    const title = w.title ?? '';
    const resolved = resolveWidget(w);
    const metrics = resolved
      .map((m, i) => named(w.series[i], m))
      .filter((x): x is ExportMetric => !!x);
    const firstTitle = title || metrics[0]?.m.label || 'Widget';

    switch (w.widgetType) {
      case 'stat_card':
      case 'gauge':
        return metrics.length ? { kind: 'kpis', widget: w, title: firstTitle, metrics } : { kind: 'empty', widget: w, title: firstTitle, reason: 'Metric unavailable' };
      case 'kpi_group':
        return metrics.length
          ? { kind: 'kpis', widget: w, title: title || 'Key figures', metrics }
          : { kind: 'empty', widget: w, title: title || 'Key figures', reason: 'Metrics unavailable' };
      case 'ratio_card': {
        const num = named(w.series[0], resolved[0] ?? null);
        const den = named(w.series[1], resolved[1] ?? null);
        if (!num || !den) return { kind: 'empty', widget: w, title: title || 'Ratio', reason: 'A ratio card needs both its numerator and denominator metric' };
        const ratio = buildRatio(w, num, den);
        return { kind: 'ratio', widget: w, title: title || ratio.label, ratio };
      }
      case 'stat_card_sparkline':
      case 'line_chart':
      case 'bar_chart':
      case 'metric_table': {
        const withTrend = metrics.filter((x) => x.m.trend && x.m.trend.length);
        if (!withTrend.length) {
          return metrics.length && w.widgetType === 'stat_card_sparkline'
            ? { kind: 'kpis', widget: w, title: firstTitle, metrics }
            : { kind: 'empty', widget: w, title: firstTitle, reason: 'No monthly trend available' };
        }
        const visual = w.widgetType === 'metric_table' ? 'table' : w.widgetType === 'bar_chart' ? 'bar' : 'line';
        // Everything on the right and nothing on the left is just one axis (same as the renderer).
        const anyLeft = withTrend.some((x) => x.axis !== 'right');
        const series = visual === 'table' ? withTrend : withTrend.map((x) => ({
          ...x,
          renderAs: x.renderAs ?? visual,
          axis: anyLeft && x.axis === 'right' ? 'right' as const : 'left' as const,
        }));
        return { kind: 'series', widget: w, title: firstTitle, visual, columns: withTrend[0].m.trend!.map((p) => p.label), metrics: series };
      }
      case 'donut_chart':
      case 'hbar_chart':
      case 'data_table': {
        const x = metrics[0];
        const items = x?.m.breakdown ?? [];
        if (!x || !items.length) return { kind: 'empty', widget: w, title: firstTitle, reason: 'No breakdown data available' };
        const nonZero = items.filter((b) => Math.abs(b.value) > 0.005);
        const present = w.widgetType === 'donut_chart' ? nonZero
          : w.widgetType === 'hbar_chart' ? nonZero.slice(0, typeof w.vizConfig.limit === 'number' ? w.vizConfig.limit : 8)
          : items.slice(0, typeof w.vizConfig.limit === 'number' ? w.vizConfig.limit : 5);
        if (!present.length) return { kind: 'empty', widget: w, title: firstTitle, reason: 'No breakdown data available' };
        const visual = w.widgetType === 'donut_chart' ? 'donut' : w.widgetType === 'hbar_chart' ? 'hbar' : 'table';
        return { kind: 'breakdown', widget: w, title: firstTitle, visual, metric: x, items: present };
      }
      case 'yoy_variance':
        return metrics.length ? { kind: 'yoy', widget: w, title: title || 'Year-on-Year Variance', metrics } : { kind: 'empty', widget: w, title: title || 'Year-on-Year Variance', reason: 'Metrics unavailable' };
      case 'text_block':
        return { kind: 'text', widget: w, title: title || 'Note', text: typeof w.vizConfig.text === 'string' ? w.vizConfig.text : '' };
      case 'period_summary': {
        const rev = bundle.mis.totals.rev;
        const rows: Cell[][] = PERIOD_SUMMARY_METRIC_KEYS.map((k) => {
          const m = resolveMetric(k, bundle);
          return [m?.label ?? k, cur(m?.value), pctCell(m?.value != null && rev ? (m.value / rev) * 100 : null)];
        });
        return { kind: 'table', widget: w, title: title || 'Period Summary', head: ['Metric', 'Value', '% of Revenue'], rows };
      }
      case 'financial_health': {
        const ms = ['current_ratio', 'net_working_capital', 'roe_pct', 'debt_equity']
          .map((k) => named(undefined, resolveMetric(k, bundle))).filter((x): x is ExportMetric => !!x);
        return { kind: 'kpis', widget: w, title: title || 'Financial Health & Solvency', metrics: ms };
      }
      case 'top_customers': {
        const list = bundle.top_customers ?? [];
        if (!list.length) return { kind: 'empty', widget: w, title: title || 'Top Customers', reason: 'No customer-level revenue for this company (Zoho sync required)' };
        return {
          kind: 'table', widget: w, title: title || 'Top Customers', head: ['Customer', 'Revenue', '% of Revenue', 'Status'],
          rows: list.slice(0, 5).map((c) => [c.customer, cur(c.revenue_cr, 'crore'), pctCell(c.pct_of_total), c.status]),
        };
      }
      case 'profit_bridge': {
        const pl = bundle.pl;
        const tax = (pl.current_tax ?? 0) + (pl.deferred_tax ?? 0);
        const rows: Cell[][] = [
          ['Revenue from Operations', cur(pl.revenue)], ['Other Income', cur(pl.other_income)],
          ['Cost of Services', cur(-pl.cos)], ['Employee Benefits', cur(-pl.employee_benefits)],
          ['Other Expenses', cur(-pl.other_expenses)], ['Finance Costs', cur(-pl.finance_costs)],
          ['Depreciation & Amortisation', cur(-pl.depreciation)], ['Profit Before Tax', cur(pl.pbt)],
          ['Tax', cur(-tax)], ['Profit After Tax', cur(pl.pat)],
        ];
        return { kind: 'table', widget: w, title: title || 'Profit Bridge', head: ['Step', 'Amount'], rows };
      }
      case 'cash_bridge': {
        const cf = bundle.cashflow;
        const total = (part: Record<string, unknown>) => (typeof part.total === 'number' ? part.total : null);
        const rows: Cell[][] = [
          ['Opening Cash & Bank', cur(cf.opening_cash)], ['Operating Activities', cur(total(cf.operating))],
          ['Investing Activities', cur(total(cf.investing))], ['Financing Activities', cur(total(cf.financing))],
          ['Closing Cash & Bank', cur(cf.closing_cash)],
        ];
        return { kind: 'table', widget: w, title: title || 'Cash Bridge', head: ['Step', 'Amount'], rows };
      }
      case 'note_index': {
        const rows: Cell[][] = [...(bundle.notes ?? [])]
          .sort((a, b) => a.note_no - b.note_no)
          .map((n) => [String(n.note_no), n.note_name ?? '', cur(n.total)]);
        return { kind: 'table', widget: w, title: title || 'Note Index', head: ['Note', 'Name', 'Total'], rows };
      }
      default:
        return { kind: 'empty', widget: w, title: firstTitle, reason: 'This widget type has no export representation' };
    }
  });
}

// ── Formatting shared by every renderer ─────────────────────────────────

/** Screen-identical text for one value (same rules as the widget renderers). */
export function formatNum(num: number | null, type: ValueType, decimals: number, unit: DisplayUnit, rawUnit: RawUnit = 'rupee'): string {
  if (num == null || !Number.isFinite(num)) return '—';
  switch (type) {
    case 'currency': return rawUnit === 'crore' ? `${frRaw(num, decimals)} Cr` : fn(num, decimals, unit);
    case 'percent': return pct(num, decimals);
    case 'ratio': return fx(num, decimals);
    case 'days': return `${Math.round(num)}d`;
    case 'number': return frRaw(num, decimals);
    default: return fn(num, decimals, unit);
  }
}

function formatCell(c: Cell, unit: DisplayUnit): string {
  return typeof c === 'string' ? c : formatNum(c.num, c.type, c.decimals, unit, c.rawUnit);
}

/** A breakdown row is always an amount (a ledger's, a vendor's …), whatever the metric's own value type — same as the widgets. */
function formatItem(value: number, metric: ExportMetric, unit: DisplayUnit): string {
  return formatNum(value, 'currency', 2, unit, metric.m.rawUnit);
}

function ratioValueText(r: ExportRatio, v: number | null): string {
  return formatNum(v, r.format === 'percent' ? 'percent' : 'ratio', r.format === 'percent' ? 1 : 2, 'Lakhs');
}
/** "+1.2 pts" / "-0.05x" — ASCII signs so the PDF's base-14 fonts can draw it. */
function ratioChangeAmount(r: ExportRatio): string {
  if (r.change == null) return '';
  const d = r.format === 'percent' ? 1 : 2;
  return `${r.change >= 0 ? '+' : '-'}${Math.abs(r.change).toFixed(d)}${r.format === 'percent' ? ' pts' : 'x'}`;
}
/** "+1.2 pts YoY" / "-0.05x vs prior period". */
export function ratioChangeText(r: ExportRatio): string {
  return r.change == null ? '' : `${ratioChangeAmount(r)} ${r.comparisonLabel}`;
}

function valueSuffix(m: ResolvedMetric): string {
  return m.valueType === 'percent' ? '%' : m.valueType === 'days' ? 'd' : m.valueType === 'ratio' ? 'x' : '';
}
export function targetText(m: ResolvedMetric, pdfSafe = false): string {
  const t = m.thresholds;
  if (!t) return '';
  const sfx = valueSuffix(m);
  const higher = t.direction === 'higher_is_better';
  // jsPDF's base-14 fonts can't draw ≥/≤ — the PDF says it in words instead.
  const cmp = pdfSafe ? (higher ? 'at least' : 'at most') : (higher ? '≥' : '≤');
  const base = `${cmp} ${t.target}${sfx}`;
  if (t.warn == null || !Number.isFinite(t.warn)) return base;
  return `${base}, warn ${pdfSafe ? (higher ? 'from' : 'up to') : cmp} ${t.warn}${sfx}`;
}
export function targetStatus(m: ResolvedMetric): 'Meets target' | 'Warning' | 'Off target' | '' {
  const s = thresholdStatus(m.value, m.thresholds);
  return s === 'good' ? 'Meets target' : s === 'warn' ? 'Warning' : s === 'bad' ? 'Off target' : '';
}
function changeLine(m: ResolvedMetric): string {
  return m.deltaPct != null ? `${signedPct(m.deltaPct)} ${comparisonOf(m)}` : '';
}

// ── Excel ────────────────────────────────────────────────────────────────

export interface LayoutExportMeta {
  title: string;
  companyName: string;
  fyLabel: string;
  fyShort: string;
  periodLabel: string;
  unit: DisplayUnit;
  currency: CurrencyCode;
}

/** A real number in the export's unit — currency scaled like the screen (Crore-denominated fields converted back to rupees first); everything else as-is. */
function excelNumber(num: number | null, type: ValueType, rawUnit: RawUnit | undefined, unit: DisplayUnit): number | null {
  if (num == null || !Number.isFinite(num)) return null;
  if (type !== 'currency') return num;
  return toUnit(rawUnit === 'crore' ? num * 1e7 : num, unit);
}
function excelFormat(type: ValueType, decimals: number): string {
  const d = decimals > 0 ? `.${'0'.repeat(decimals)}` : '';
  switch (type) {
    case 'currency': return ACC_FMT;
    case 'percent': return `0${d}"%";[Red](0${d}"%")`;
    case 'ratio': return `0${d}"x";[Red](0${d}"x")`;
    case 'days': return '0"d"';
    default: return `#,##0${d}`;
  }
}
const CHANGE_PCT_FMT = '0.0"%";[Red](0.0"%")';

/** Builds the workbook without downloading it (testable in Node). Sheets: Info, Widgets (one row per value), Trends (month-by-month), Breakdowns, Tables. */
export function buildDashboardLayoutXlsx(model: ExportBlock[], meta: LayoutExportMeta): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const unitHeader = getUnitHeader(meta.unit, meta.currency);

  buildSheet(wb, 'Info', [
    { cells: ['FinCommand Pro — Dashboard Export'], bold: true },
    { cells: [] },
    { cells: ['Company', meta.companyName] },
    { cells: ['View', meta.title] },
    { cells: ['Reporting Year', meta.fyLabel] },
    { cells: ['Reporting Period', meta.periodLabel] },
    { cells: ['Amounts', `${unitHeader} (percentages, ratios and days as shown)`] },
    { cells: ['Widgets', model.length] },
    { cells: ['Generated At', new Date().toLocaleString('en-IN')] },
  ], [22, 60]);

  const widgetRows: SheetRow[] = [{ cells: ['Widget', 'Type', 'Metric', 'Value', 'Comparative', 'Change', 'Compared with', 'Target', 'Status'], bold: true }];
  const pushMetric = (block: string, type: string, x: ExportMetric) => {
    const fmt = excelFormat(x.m.valueType, x.m.decimals);
    const hasComparative = x.m.previous != null || x.m.deltaPct != null;
    widgetRows.push({
      cells: [
        block, type, x.label,
        excelNumber(x.m.value, x.m.valueType, x.m.rawUnit, meta.unit),
        excelNumber(x.m.previous, x.m.valueType, x.m.rawUnit, meta.unit),
        x.m.deltaPct, hasComparative ? comparedWith(comparisonOf(x.m)) : '', targetText(x.m), targetStatus(x.m),
      ],
      formats: [null, null, null, fmt, fmt, CHANGE_PCT_FMT, null, null, null],
    });
  };
  const trendRows: SheetRow[] = [];
  const breakdownRows: SheetRow[] = [];
  const tableRows: SheetRow[] = [];

  model.forEach((b) => {
    switch (b.kind) {
      case 'kpis': b.metrics.forEach((x) => pushMetric(b.title, b.widget.widgetType, x)); break;
      case 'yoy': b.metrics.forEach((x) => pushMetric(b.title, 'yoy_variance', x)); break;
      case 'text': widgetRows.push({ cells: [b.title, 'text_block', b.text] }); break;
      case 'empty': widgetRows.push({ cells: [b.title, b.widget.widgetType, b.reason] }); break;
      case 'ratio': {
        const r = b.ratio;
        const pctFmt = r.format === 'percent';
        widgetRows.push({
          cells: [b.title, 'ratio_card', r.label, r.value, r.prior, r.change, r.change != null ? comparedWith(r.comparisonLabel) : '', '', ''],
          formats: [
            null, null, null,
            pctFmt ? '0.0"%";[Red](0.0"%")' : '0.00"x";[Red](0.00"x")',
            pctFmt ? '0.0"%";[Red](0.0"%")' : '0.00"x";[Red](0.00"x")',
            pctFmt ? '+0.0" pts";[Red]-0.0" pts"' : '+0.00"x";[Red]-0.00"x"',
            null, null, null,
          ],
        });
        r.parts.forEach((x, i) => pushMetric(b.title, i === 0 ? 'ratio_card (numerator)' : 'ratio_card (denominator)', x));
        break;
      }
      case 'series': {
        b.metrics.forEach((x) => pushMetric(b.title, b.widget.widgetType, x));
        trendRows.push({ cells: [b.title], bold: true });
        trendRows.push({ cells: ['Metric', ...b.columns], bold: true });
        b.metrics.forEach((x) => {
          const fmt = excelFormat(x.m.valueType, x.m.decimals);
          trendRows.push({
            cells: [x.label, ...x.m.trend!.map((p) => excelNumber(p.value, x.m.valueType, x.m.rawUnit, meta.unit))],
            formats: [null, ...x.m.trend!.map(() => fmt)],
          });
        });
        trendRows.push({ cells: [] });
        break;
      }
      case 'breakdown': {
        const total = b.items.reduce((s, i) => s + i.value, 0);
        const fmt = excelFormat('currency', 2);
        breakdownRows.push({ cells: [b.title === b.metric.label ? b.title : `${b.title} — ${b.metric.label}`], bold: true });
        breakdownRows.push({ cells: ['Item', 'Value', 'Share'], bold: true });
        b.items.forEach((i) => breakdownRows.push({
          cells: [i.label, excelNumber(i.value, 'currency', b.metric.m.rawUnit, meta.unit), total ? i.value / total : null],
          formats: [null, fmt, '0.0%'],
        }));
        breakdownRows.push({ cells: [] });
        break;
      }
      case 'table': {
        tableRows.push({ cells: [b.title], bold: true });
        tableRows.push({ cells: b.head, bold: true });
        b.rows.forEach((r) => tableRows.push({
          cells: r.map((c): CellVal => (typeof c === 'string' ? c : excelNumber(c.num, c.type, c.rawUnit, meta.unit))),
          formats: r.map((c) => (typeof c === 'string' ? null : excelFormat(c.type, c.decimals))),
        }));
        tableRows.push({ cells: [] });
        break;
      }
    }
  });

  widgetRows[0].cells[3] = `Value (${unitHeader})`;
  buildSheet(wb, 'Widgets', widgetRows, [30, 22, 34, 16, 16, 12, 22, 22, 14]);
  if (trendRows.length) buildSheet(wb, 'Trends', trendRows, [30, ...Array(12).fill(12)]);
  if (breakdownRows.length) buildSheet(wb, 'Breakdowns', breakdownRows, [40, 16, 10]);
  if (tableRows.length) buildSheet(wb, 'Tables', tableRows, [34, 30, 16, 16]);
  return wb;
}

function fileBase(meta: LayoutExportMeta): string {
  const slug = meta.title.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'Dashboard';
  return `FinCommandPro_${slug}_${meta.fyShort || 'FY'}`;
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick — some browsers start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function exportDashboardLayoutXlsx(model: ExportBlock[], meta: LayoutExportMeta): Promise<void> {
  await downloadWorkbook(buildDashboardLayoutXlsx(model, meta), `${fileBase(meta)}.xlsx`);
}

// ── CSV ──────────────────────────────────────────────────────────────────

export const CSV_HEADER = ['Widget', 'Widget type', 'Metric', 'Row', 'Label', 'Value', 'Unit', 'Formatted'] as const;
type CsvRow = [string, string, string, string, string, number | null, string, string];

/** Our own formatted numbers ("-5.0%", "(1.50x)", "+2.1 pts") are safe as-is; any OTHER text starting with = + - @ is neutralised so a spreadsheet never runs it as a formula. */
const SAFE_NUMERIC_TEXT = /^[+\-(]?[\d.,]+%?\)?(\s?(%|x|d|pts|Cr|L|K))?\)?$/;
function csvCell(v: string | number | null): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Number(v.toFixed(6))) : '';
  let s = v;
  if (/^[=+\-@\t\r]/.test(s) && !SAFE_NUMERIC_TEXT.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * One flat, tidy table of every figure in the view — one row per value, so
 * it loads straight into another tool (a BI import, a pivot table, a
 * script). `Value` is a plain number in the view's unit (currency scaled to
 * Lakhs/Crores/Thousands exactly like the Excel export); `Formatted` is the
 * text the screen shows. No preamble rows — the file name carries the view
 * and year.
 */
export function buildDashboardLayoutCsv(model: ExportBlock[], meta: LayoutExportMeta): string {
  const unitHeader = getUnitHeader(meta.unit, meta.currency);
  const unitOf = (type: ValueType): string =>
    type === 'currency' ? unitHeader : type === 'percent' ? '%' : type === 'ratio' ? 'x' : type === 'days' ? 'days' : '';
  const rows: CsvRow[] = [];

  const metricRows = (b: ExportBlock, x: ExportMetric, type: string = b.widget.widgetType) => {
    const m = x.m;
    const num = (v: number | null) => excelNumber(v, m.valueType, m.rawUnit, meta.unit);
    const text = (v: number | null) => formatNum(v, m.valueType, m.decimals, meta.unit, m.rawUnit);
    rows.push([b.title, type, x.label, 'value', 'Current period', num(m.value), unitOf(m.valueType), text(m.value)]);
    if (m.previous != null) rows.push([b.title, type, x.label, 'comparative', comparedWith(comparisonOf(m)), num(m.previous), unitOf(m.valueType), text(m.previous)]);
    if (m.deltaPct != null) rows.push([b.title, type, x.label, 'change', `Change % (${comparisonOf(m)})`, m.deltaPct, '%', signedPct(m.deltaPct)]);
    if (m.thresholds) rows.push([b.title, type, x.label, 'target', 'Target', null, '', `${targetText(m)}${targetStatus(m) ? ` — ${targetStatus(m)}` : ''}`]);
  };

  for (const b of model) {
    const type = b.widget.widgetType;
    switch (b.kind) {
      case 'kpis':
      case 'yoy':
        b.metrics.forEach((x) => metricRows(b, x));
        break;
      case 'series':
        b.metrics.forEach((x) => {
          metricRows(b, x);
          x.m.trend!.forEach((p) => rows.push([
            b.title, type, x.label, 'month', p.label,
            excelNumber(p.value, x.m.valueType, x.m.rawUnit, meta.unit), unitOf(x.m.valueType),
            formatNum(p.value, x.m.valueType, x.m.decimals, meta.unit, x.m.rawUnit),
          ]));
        });
        break;
      case 'breakdown':
        b.items.forEach((i) => rows.push([
          b.title, type, b.metric.label, 'item', i.label,
          excelNumber(i.value, 'currency', b.metric.m.rawUnit, meta.unit), unitHeader, formatItem(i.value, b.metric, meta.unit),
        ]));
        break;
      case 'ratio': {
        const r = b.ratio;
        const u = r.format === 'percent' ? '%' : 'x';
        rows.push([b.title, type, r.label, 'value', 'Current period', r.value, u, ratioValueText(r, r.value)]);
        if (r.prior != null) rows.push([b.title, type, r.label, 'comparative', comparedWith(r.comparisonLabel), r.prior, u, ratioValueText(r, r.prior)]);
        if (r.change != null) rows.push([b.title, type, r.label, 'change', `Change (${r.comparisonLabel})`, r.change, r.format === 'percent' ? 'pts' : 'x', ratioChangeAmount(r)]);
        r.parts.forEach((x) => metricRows(b, x));
        break;
      }
      case 'table':
        b.rows.forEach((r) => {
          const rowLabel = typeof r[0] === 'string' ? r[0] : '';
          r.forEach((c, j) => {
            if (j === 0) return;
            if (typeof c === 'string') rows.push([b.title, type, rowLabel, 'table', b.head[j] ?? '', null, '', c]);
            else rows.push([b.title, type, rowLabel, 'table', b.head[j] ?? '', excelNumber(c.num, c.type, c.rawUnit, meta.unit), unitOf(c.type), formatCell(c, meta.unit)]);
          });
        });
        break;
      case 'text':
        rows.push([b.title, type, '', 'text', '', null, '', b.text]);
        break;
      case 'empty':
        rows.push([b.title, type, '', 'unavailable', '', null, '', b.reason]);
        break;
    }
  }
  return [CSV_HEADER as readonly string[], ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function exportDashboardLayoutCsv(model: ExportBlock[], meta: LayoutExportMeta): void {
  // BOM so Excel opens it as UTF-8 (₹, ÷ and accented names intact).
  downloadBlob(new Blob(['﻿', buildDashboardLayoutCsv(model, meta)], { type: 'text/csv;charset=utf-8' }), `${fileBase(meta)}.csv`);
}

// ── PowerPoint ───────────────────────────────────────────────────────────

const PPT_NAVY = '1E3A8A';
const PPT_SLATE = '64748B';
const PPT_TEXT = '0F172A';
const PPT_PALETTE = ['378ADD', '1D9E75', 'EF9F27', 'D85A30', '3C3489', '0F6E56'];
const PPT_TONE: Record<'good' | 'warn' | 'bad' | 'pos' | 'neg' | 'neutral', { fg: string; bg: string }> = {
  good: { fg: '0F6E56', bg: 'E1F5EE' }, pos: { fg: '0F6E56', bg: 'E1F5EE' },
  warn: { fg: 'B48214', bg: 'FEF9E7' },
  bad: { fg: '993C1D', bg: 'FAECE7' }, neg: { fg: '993C1D', bg: 'FAECE7' },
  neutral: { fg: PPT_TEXT, bg: 'EFF6FF' },
};
const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const PPT_MARGIN = 0.5;

interface PptTile { label: string; value: string; sub: string; tone: keyof typeof PPT_TONE }

function metricTone(m: ResolvedMetric): PptTile['tone'] {
  const s = thresholdStatus(m.value, m.thresholds);
  if (s) return s;
  if (m.value == null || Math.abs(m.value) < 0.005) return 'neutral';
  return m.value < 0 ? 'neg' : 'pos';
}
function metricTile(x: ExportMetric, unit: DisplayUnit, label = x.label): PptTile {
  const m = x.m;
  const sub = changeLine(m) || (m.thresholds ? `Target ${targetText(m)}${targetStatus(m) ? ` · ${targetStatus(m)}` : ''}` : '');
  return { label, value: formatNum(m.value, m.valueType, m.decimals, unit, m.rawUnit), sub, tone: metricTone(m) };
}
function hex(color: string | undefined, i: number): string {
  const c = (color ?? '').replace('#', '');
  return /^[0-9a-fA-F]{6}$/.test(c) ? c.toUpperCase() : PPT_PALETTE[i % PPT_PALETTE.length];
}
/** Chart values in the view's unit (currency scaled like the screen); percent/ratio/days as-is. */
function chartValue(v: number, m: ResolvedMetric, unit: DisplayUnit): number {
  return excelNumber(v, m.valueType, m.rawUnit, unit) ?? 0;
}
function axisFormat(m: ResolvedMetric): string {
  return m.valueType === 'percent' ? '0"%"' : m.valueType === 'ratio' ? '0.00"x"' : m.valueType === 'days' ? '0"d"' : '#,##0.00';
}

/**
 * Builds the deck without saving it — `Pptx` is the pptxgenjs constructor,
 * passed in so the browser can load the library only when someone actually
 * exports (and tests can use it directly in Node). Slides: a cover, KPI
 * tiles (single cards grouped, up to 8 a slide; a KPI group gets its own
 * slide), one slide per chart (NATIVE, editable charts — a mixed bar+line
 * chart becomes a PowerPoint combo chart with the right-axis series on a
 * secondary axis), and tables that page automatically.
 */
export function buildDashboardLayoutPptx(Pptx: new () => PptxGenJS, model: ExportBlock[], meta: LayoutExportMeta): PptxGenJS {
  const pptx = new Pptx();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = `${meta.title} — ${meta.companyName}`;
  pptx.company = meta.companyName;
  const unitHeader = getUnitHeader(meta.unit, meta.currency);
  const footer = `${meta.companyName} · ${meta.fyLabel} · ${meta.periodLabel}`;

  // Cover
  const cover = pptx.addSlide();
  cover.background = { color: PPT_NAVY };
  cover.addText(meta.companyName, { x: 0.8, y: 2.2, w: SLIDE_W - 1.6, h: 0.8, fontSize: 32, bold: true, color: 'FFFFFF', fontFace: 'Calibri' });
  cover.addText(meta.title, { x: 0.8, y: 3.0, w: SLIDE_W - 1.6, h: 0.6, fontSize: 22, color: 'DBEAFE', fontFace: 'Calibri' });
  cover.addText(`${meta.fyLabel} · ${meta.periodLabel}`, { x: 0.8, y: 3.7, w: SLIDE_W - 1.6, h: 0.4, fontSize: 14, color: 'BFDBFE', fontFace: 'Calibri' });
  cover.addText(`Amounts ${unitHeader}. Generated ${new Date().toLocaleString('en-IN')} from FinCommand Pro — values exactly as shown on screen.`,
    { x: 0.8, y: SLIDE_H - 1.0, w: SLIDE_W - 1.6, h: 0.4, fontSize: 10, color: '93C5FD', fontFace: 'Calibri' });

  const newSlide = (title: string, subtitle?: string) => {
    const s = pptx.addSlide();
    s.addText(title, { x: PPT_MARGIN, y: 0.3, w: SLIDE_W - 2 * PPT_MARGIN, h: 0.6, fontSize: 22, bold: true, color: PPT_NAVY, fontFace: 'Calibri' });
    if (subtitle) s.addText(subtitle, { x: PPT_MARGIN, y: 0.85, w: SLIDE_W - 2 * PPT_MARGIN, h: 0.3, fontSize: 11, color: PPT_SLATE, fontFace: 'Calibri' });
    s.addText(footer, { x: PPT_MARGIN, y: SLIDE_H - 0.45, w: SLIDE_W - 2 * PPT_MARGIN, h: 0.3, fontSize: 9, color: PPT_SLATE, fontFace: 'Calibri' });
    return s;
  };
  const TOP = 1.35;
  const BODY_H = SLIDE_H - TOP - 0.7;

  const drawTiles = (title: string, tiles: PptTile[]) => {
    const s = newSlide(title);
    const perRow = tiles.length <= 3 ? tiles.length : 4;
    const gap = 0.25;
    const tw = (SLIDE_W - 2 * PPT_MARGIN - (perRow - 1) * gap) / perRow;
    const th = 1.7;
    tiles.forEach((t, i) => {
      const x = PPT_MARGIN + (i % perRow) * (tw + gap);
      const y = TOP + 0.2 + Math.floor(i / perRow) * (th + gap);
      const tone = PPT_TONE[t.tone];
      s.addShape(pptx.ShapeType.rect, { x, y, w: tw, h: th, fill: { color: tone.bg }, line: { color: tone.bg } });
      s.addShape(pptx.ShapeType.rect, { x, y, w: 0.08, h: th, fill: { color: tone.fg }, line: { color: tone.fg } });
      s.addText(t.label.toUpperCase(), { x: x + 0.22, y: y + 0.12, w: tw - 0.35, h: 0.35, fontSize: 10, color: PPT_SLATE, fontFace: 'Calibri', fit: 'shrink' });
      s.addText(t.value, { x: x + 0.22, y: y + 0.5, w: tw - 0.35, h: 0.65, fontSize: 26, bold: true, color: tone.fg, fontFace: 'Calibri', fit: 'shrink' });
      if (t.sub) s.addText(t.sub, { x: x + 0.22, y: y + 1.18, w: tw - 0.35, h: 0.35, fontSize: 10, color: PPT_SLATE, fontFace: 'Calibri', fit: 'shrink' });
    });
  };

  const drawTable = (title: string, head: string[], body: string[][]) => {
    const s = newSlide(title, `Amounts ${unitHeader}`);
    const colW = [Math.max(3, (SLIDE_W - 2 * PPT_MARGIN) * (head.length > 6 ? 0.2 : 0.34))];
    const rest = (SLIDE_W - 2 * PPT_MARGIN - colW[0]) / Math.max(1, head.length - 1);
    for (let i = 1; i < head.length; i++) colW.push(rest);
    const fontSize = head.length > 8 ? 8 : 11;
    const headRow = head.map((h, i) => ({ text: h, options: { bold: true, color: 'FFFFFF', fill: { color: PPT_NAVY }, align: (i === 0 ? 'left' : 'right') as 'left' | 'right' } }));
    const rows = body.map((r) => r.map((c, i) => ({ text: c, options: { align: (i === 0 ? 'left' : 'right') as 'left' | 'right' } })));
    s.addTable([headRow, ...rows], {
      x: PPT_MARGIN, y: TOP, w: SLIDE_W - 2 * PPT_MARGIN, colW, fontSize, fontFace: 'Calibri', color: PPT_TEXT,
      border: { type: 'solid', pt: 0.5, color: 'E2E8F0' }, rowH: 0.32,
      autoPage: true, autoPageRepeatHeader: true, autoPageHeaderRows: 1, newSlideStartY: TOP,
    });
  };

  // Single KPI cards (stat cards, gauges, ratio cards) collect into shared
  // "Key figures" slides, in reading order, 8 to a slide.
  let pendingTiles: PptTile[] = [];
  const flushTiles = () => {
    for (let i = 0; i < pendingTiles.length; i += 8) drawTiles('Key figures', pendingTiles.slice(i, i + 8));
    pendingTiles = [];
  };
  const empties: string[] = [];

  for (const b of model) {
    if (b.kind === 'kpis' && b.metrics.length === 1) {
      pendingTiles.push(metricTile(b.metrics[0], meta.unit, b.title || b.metrics[0].label));
      continue;
    }
    if (b.kind === 'ratio') {
      const r = b.ratio;
      pendingTiles.push({
        label: b.title, value: ratioValueText(r, r.value),
        sub: ratioChangeText(r) || `${r.parts[0].label} ÷ ${r.parts[1].label}`, tone: 'neutral',
      });
      continue;
    }
    if (b.kind === 'empty') { empties.push(`${b.title} — ${b.reason}`); continue; }
    flushTiles();

    switch (b.kind) {
      case 'kpis':
        for (let i = 0; i < b.metrics.length; i += 8) drawTiles(b.title, b.metrics.slice(i, i + 8).map((x) => metricTile(x, meta.unit)));
        break;
      case 'series': {
        if (b.visual === 'table') {
          drawTable(b.title, ['Metric', ...b.columns], b.metrics.map((x) => [x.label, ...x.m.trend!.map((p) => formatNum(p.value, x.m.valueType, x.m.decimals, meta.unit, x.m.rawUnit))]));
          break;
        }
        const s = newSlide(b.title, `Amounts ${unitHeader} · monthly`);
        const leftMetric = b.metrics.find((x) => x.axis !== 'right')!.m;
        const rightMetric = b.metrics.find((x) => x.axis === 'right')?.m ?? null;
        const dataOf = (xs: ExportMetric[]) => xs.map((x) => ({ name: x.label, labels: b.columns, values: x.m.trend!.map((p) => chartValue(p.value, x.m, meta.unit)) }));
        const colorsOf = (xs: ExportMetric[]) => xs.map((x) => hex(x.color, b.metrics.indexOf(x)));
        // One PowerPoint chart group per (bars|line) × (left|right axis).
        const groups: { type: 'bar' | 'line'; axis: 'left' | 'right'; items: ExportMetric[] }[] = [];
        b.metrics.forEach((x) => {
          const type = x.renderAs ?? (b.visual === 'bar' ? 'bar' : 'line');
          const axis = x.axis === 'right' ? 'right' : 'left';
          const g = groups.find((gr) => gr.type === type && gr.axis === axis);
          if (g) g.items.push(x); else groups.push({ type, axis, items: [x] });
        });
        const stacked = b.widget.widgetType === 'bar_chart' && b.widget.vizConfig.stacked === true;
        const base = {
          x: PPT_MARGIN, y: TOP, w: SLIDE_W - 2 * PPT_MARGIN, h: BODY_H,
          showLegend: b.widget.vizConfig.legend !== false, legendPos: 'b' as const, legendFontSize: 11,
          catAxisLabelFontSize: 11, valAxisLabelFontSize: 10, fontFace: 'Calibri',
        };
        if (groups.length === 1) {
          const g = groups[0];
          s.addChart(g.type === 'bar' ? pptx.ChartType.bar : pptx.ChartType.line, dataOf(g.items), {
            ...base, chartColors: colorsOf(g.items), valAxisLabelFormatCode: axisFormat(leftMetric),
            ...(g.type === 'bar' ? { barDir: 'col', barGrouping: stacked ? 'stacked' : 'clustered' } : { lineSize: 2, lineDataSymbolSize: 5 }),
          });
        } else {
          // Combo: PowerPoint draws groups in order, so bars go first and
          // lines on top; right-axis groups use the secondary value axis.
          groups.sort((a, c) => (a.type === c.type ? 0 : a.type === 'bar' ? -1 : 1));
          const multi = groups.map((g) => ({
            type: g.type === 'bar' ? pptx.ChartType.bar : pptx.ChartType.line,
            data: dataOf(g.items),
            options: {
              chartColors: colorsOf(g.items),
              ...(g.type === 'bar' ? { barDir: 'col', barGrouping: stacked ? 'stacked' : 'clustered' } : { lineSize: 2, lineDataSymbolSize: 5 }),
              ...(g.axis === 'right' ? { secondaryValAxis: true, secondaryCatAxis: true } : {}),
            },
          }));
          // For a combo, pptxgenjs reads the 2nd argument as the options
          // unless it is empty-ish (`data || opt`) — an empty array is
          // truthy and would silently replace the options, so pass null.
          s.addChart(multi as unknown as PptxGenJS.IChartMulti[], null as never, {
            ...base,
            valAxes: [
              { showValAxisTitle: false, valAxisLabelFormatCode: axisFormat(leftMetric) },
              ...(rightMetric ? [{ showValAxisTitle: false, valAxisLabelFormatCode: axisFormat(rightMetric), valGridLine: { style: 'none' as const } }] : []),
            ],
            catAxes: [{ catAxisTitle: '' }, ...(rightMetric ? [{ catAxisHidden: true }] : [])],
          });
        }
        break;
      }
      case 'breakdown': {
        if (b.visual === 'table') {
          const total = b.items.reduce((sum, i) => sum + i.value, 0);
          drawTable(b.title, ['Item', 'Value', 'Share'], b.items.map((i) => [i.label, formatItem(i.value, b.metric, meta.unit), total ? pct((i.value / total) * 100) : '—']));
          break;
        }
        const s = newSlide(b.title, `Amounts ${unitHeader}`);
        // A horizontal bar chart plots its first category at the BOTTOM — reversed so the largest item reads first, as on screen.
        const items = b.visual === 'hbar' ? [...b.items].reverse() : b.items;
        const data = [{ name: b.metric.label, labels: items.map((i) => i.label), values: items.map((i) => excelNumber(i.value, 'currency', b.metric.m.rawUnit, meta.unit) ?? 0) }];
        if (b.visual === 'donut') {
          s.addChart(pptx.ChartType.doughnut, data, {
            x: PPT_MARGIN, y: TOP, w: SLIDE_W - 2 * PPT_MARGIN, h: BODY_H, holeSize: 55,
            showLegend: true, legendPos: 'r', legendFontSize: 11, showPercent: true, showValue: false, dataLabelColor: 'FFFFFF',
            chartColors: b.items.map((_, i) => PPT_PALETTE[i % PPT_PALETTE.length]),
          });
        } else {
          s.addChart(pptx.ChartType.bar, data, {
            x: PPT_MARGIN, y: TOP, w: SLIDE_W - 2 * PPT_MARGIN, h: BODY_H, barDir: 'bar',
            chartColors: [hex(b.widget.series[0]?.color, 0)], showLegend: false,
            catAxisLabelFontSize: 11, valAxisLabelFontSize: 10, valAxisLabelFormatCode: '#,##0.00',
            showValue: true, dataLabelFormatCode: '#,##0.00', dataLabelFontSize: 10,
          });
        }
        break;
      }
      case 'yoy':
        drawTable(b.title, ['Metric', 'Current', 'Comparative', 'Change'], b.metrics.map((x) => [
          x.label,
          formatNum(x.m.value, x.m.valueType, x.m.decimals, meta.unit, x.m.rawUnit),
          formatNum(x.m.previous, x.m.valueType, x.m.decimals, meta.unit, x.m.rawUnit),
          x.m.deltaPct != null ? `${signedPct(x.m.deltaPct)} ${comparisonOf(x.m)}` : '—',
        ]));
        break;
      case 'table':
        drawTable(b.title, b.head, b.rows.map((r) => r.map((c) => formatCell(c, meta.unit))));
        break;
      case 'text': {
        const s = newSlide(b.title);
        s.addText(b.text || ' ', { x: PPT_MARGIN, y: TOP, w: SLIDE_W - 2 * PPT_MARGIN, h: BODY_H, fontSize: 16, color: PPT_TEXT, valign: 'top', fontFace: 'Calibri' });
        break;
      }
    }
  }
  flushTiles();
  if (empties.length) {
    const s = newSlide('Not included', 'These widgets had no data for this period');
    s.addText(empties.map((t) => ({ text: t, options: { bullet: true } })), { x: PPT_MARGIN, y: TOP, w: SLIDE_W - 2 * PPT_MARGIN, h: BODY_H, fontSize: 14, color: PPT_SLATE, valign: 'top', fontFace: 'Calibri' });
  }
  return pptx;
}

export async function exportDashboardLayoutPptx(model: ExportBlock[], meta: LayoutExportMeta): Promise<void> {
  // Loaded only when someone exports — keeps ~400 KB out of every dashboard page load.
  const { default: Pptx } = await import('pptxgenjs');
  await buildDashboardLayoutPptx(Pptx, model, meta).writeFile({ fileName: `${fileBase(meta)}.pptx` });
}

// ── PNG ──────────────────────────────────────────────────────────────────

/** Longest side of the finished image — a very long view drops to 1× so the canvas stays within browser limits. */
const PNG_MAX_PX = 8000;

/**
 * A picture of the view exactly as on screen (charts, colours, theme),
 * under a navy header band naming the company, view and period — so the
 * image still says what it is when pasted into an email or a chat.
 */
export async function exportDashboardLayoutPng(root: HTMLElement, meta: LayoutExportMeta): Promise<void> {
  const { toCanvas } = await import('html-to-image');
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const bg = !bodyBg || bodyBg === 'transparent' || bodyBg === 'rgba(0, 0, 0, 0)' ? '#ffffff' : bodyBg;
  const rect = root.getBoundingClientRect();
  const ratio = Math.max(rect.width, rect.height) * 2 > PNG_MAX_PX ? 1 : 2;
  const grid = await toCanvas(root, {
    backgroundColor: bg, pixelRatio: ratio, cacheBust: true,
    // Web fonts are read from cross-origin stylesheets, which the browser
    // won't let a script inline — the system font fallback is used instead.
    skipFonts: true,
  });

  const pad = 24 * ratio;
  const band = 72 * ratio;
  const out = document.createElement('canvas');
  out.width = grid.width + pad * 2;
  out.height = grid.height + band + pad;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.fillStyle = '#1E3A8A';
  ctx.fillRect(0, 0, out.width, band - 12 * ratio);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  ctx.font = `600 ${18 * ratio}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillText(`${meta.companyName} — ${meta.title}`, pad, 12 * ratio);
  ctx.font = `${12 * ratio}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillStyle = '#BFDBFE';
  ctx.fillText(`${meta.fyLabel} · ${meta.periodLabel} · Amounts ${getUnitHeader(meta.unit, meta.currency)}`, pad, 38 * ratio);
  ctx.drawImage(grid, pad, band);

  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not encode the image');
  downloadBlob(blob, `${fileBase(meta)}.png`);
}

// ── PDF ──────────────────────────────────────────────────────────────────

const GAP = 3;
const BOTTOM_LIMIT = 280;   // A4 297mm minus footer band
const TOP_Y = 34;

const MAX_CHART_PX = 1400;

/**
 * The widget's own rendered Chart.js canvas, captured as an image (what the
 * reader saw), or null when it has none / isn't on screen. Flattened onto
 * white (Chart.js canvases are transparent), capped at MAX_CHART_PX wide and
 * JPEG-encoded — a raw high-DPI PNG per chart made a one-page export ~3 MB.
 */
function chartImage(root: HTMLElement | null | undefined, widgetId: string): { data: string; aspect: number } | null {
  if (!root) return null;
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(widgetId) : widgetId;
  const canvas = root.querySelector<HTMLCanvasElement>(`[data-widget-id="${esc}"] canvas`);
  if (!canvas || !canvas.width || !canvas.height) return null;
  try {
    const scale = Math.min(1, MAX_CHART_PX / canvas.width);
    const out = document.createElement('canvas');
    out.width = Math.round(canvas.width * scale);
    out.height = Math.round(canvas.height * scale);
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return { data: out.toDataURL('image/jpeg', 0.9), aspect: canvas.width / canvas.height };
  } catch {
    return null; // tainted/unsupported canvas — fall back to the table
  }
}

/** PDF-safe text: jsPDF's base-14 fonts can't draw ₹ (fn() doesn't emit it) — but guard anyway against stray non-Latin-1 glyphs in user titles. */
function safe(text: string): string {
  return text.replace(/₹/g, 'Rs.').replace(/[^\x20-\x7E -ÿ]/g, '');
}

function drawBoxTitle(doc: jsPDF, text: string, x: number, y: number, w: number): void {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...NAVY);
  const t = doc.splitTextToSize(safe(text), w)[0] ?? '';
  doc.text(t, x, y);
}

type Rgb = [number, number, number];
/** Card colours: a metric with a target reads green / amber (warn level) / red; one without reads by sign, as before. */
function kpiColors(m: ResolvedMetric): { fg: Rgb; tint: Rgb } {
  const s = thresholdStatus(m.value, m.thresholds);
  if (s === 'good') return { fg: GREEN, tint: GREEN_TINT };
  if (s === 'warn') return { fg: AMBER, tint: AMBER_TINT };
  if (s === 'bad') return { fg: RED, tint: RED_TINT };
  const v = m.value ?? 0;
  return { fg: toneColor(v), tint: toneTint(v) };
}

function drawTile(doc: jsPDF, label: string, value: string, sub: string, colors: { fg: Rgb; tint: Rgb }, left: number, top: number, w: number, h: number): void {
  doc.setFillColor(...colors.tint);
  doc.roundedRect(left, top, w, h, 2, 2, 'F');
  doc.setFillColor(...colors.fg);
  doc.roundedRect(left, top, 1.6, h, 0.8, 0.8, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...SLATE);
  doc.text(doc.splitTextToSize(safe(label.toUpperCase()), w - 6)[0] ?? '', left + 4, top + 5.5);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...colors.fg);
  doc.text(safe(value), left + 4, top + 13);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...SLATE);
  if (sub) doc.text(doc.splitTextToSize(safe(sub), w - 6)[0] ?? '', left + 4, top + h - 3.5);
}

function drawKpi(doc: jsPDF, x: ExportMetric, left: number, top: number, w: number, h: number, unit: DisplayUnit): void {
  const m = x.m;
  const sub = changeLine(m) || (m.thresholds ? `Target ${targetText(m, true)} · ${targetStatus(m)}` : '');
  drawTile(doc, x.label, formatNum(m.value, m.valueType, m.decimals, unit, m.rawUnit), sub, kpiColors(m), left, top, w, h);
}

type Placed = { block: ExportBlock; x: number; w: number };

/** Groups blocks into on-screen rows (same gridY) — KPI cards and charts keep their side-by-side placement and relative widths; tables always take a full row so they can flow across pages cleanly. */
function planRows(model: ExportBlock[]): Placed[][] {
  const rows: Placed[][] = [];
  let current: Placed[] = [];
  let currentY: number | null = null;
  const flush = () => { if (current.length) rows.push(current); current = []; };
  for (const block of model) {
    const w = block.widget;
    const isTable = block.kind === 'table' || block.kind === 'yoy'
      || (block.kind === 'series' && block.visual === 'table')
      || (block.kind === 'breakdown' && block.visual === 'table');
    const placed: Placed = { block, x: MARGIN + (w.gridX / 12) * CONTENT_W, w: (w.gridW / 12) * CONTENT_W - GAP };
    if (isTable) { flush(); rows.push([{ block, x: MARGIN, w: CONTENT_W }]); currentY = null; continue; }
    if (currentY !== null && w.gridY !== currentY) flush();
    currentY = w.gridY;
    current.push(placed);
  }
  flush();
  return rows;
}

export function exportDashboardLayoutPdf(model: ExportBlock[], meta: LayoutExportMeta, root?: HTMLElement | null): void {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const unitPdf = getUnitHeaderPdf(meta.unit, meta.currency);
  const header = () => addPdfHeader(doc, safe(meta.companyName), safe(`${meta.title} · Dashboard export`), safe(meta.fyLabel), safe(meta.periodLabel));
  header();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...SLATE);
  doc.text(`Amounts ${unitPdf}. Values exactly as shown on screen at export time.`, MARGIN, 31);
  let y = TOP_Y;

  const ensure = (h: number) => {
    if (y + h > BOTTOM_LIMIT) { doc.addPage(); header(); y = TOP_Y; }
  };

  for (const row of planRows(model)) {
    // Row height = tallest box in the row (tables handled separately below).
    const heights = row.map(({ block, w }) => {
      if (block.kind === 'kpis') return (block.metrics.length > 1 ? 6 : 0) + Math.ceil(block.metrics.length / Math.max(1, Math.floor(w / 42))) * 25 - 3;
      if (block.kind === 'ratio') return 22;
      if (block.kind === 'text') return 8 + Math.min(60, doc.splitTextToSize(safe(block.text), w).length * 4);
      if (block.kind === 'empty') return 16;
      if (block.kind === 'series' || block.kind === 'breakdown') {
        const img = chartImage(root, block.widget.id);
        return 7 + (img ? Math.min(85, w / img.aspect) : 30);
      }
      return 0;
    });
    const isTableRow = row.length === 1 && heights[0] === 0;

    if (isTableRow) {
      const { block } = row[0];
      ensure(20);
      drawBoxTitle(doc, block.title, MARGIN, y + 4, CONTENT_W);
      let head: string[] = [];
      let body: string[][] = [];
      if (block.kind === 'table') {
        head = block.head;
        body = block.rows.map((r) => r.map((c) => safe(formatCell(c, meta.unit))));
      } else if (block.kind === 'yoy') {
        head = ['Metric', 'Current', 'Comparative', 'Change'];
        body = block.metrics.map((x) => [safe(x.label),
          safe(formatNum(x.m.value, x.m.valueType, x.m.decimals, meta.unit, x.m.rawUnit)),
          safe(formatNum(x.m.previous, x.m.valueType, x.m.decimals, meta.unit, x.m.rawUnit)),
          x.m.deltaPct != null ? safe(`${signedPct(x.m.deltaPct)} ${comparisonOf(x.m)}`) : '—']);
      } else if (block.kind === 'series') {
        head = ['Metric', ...block.columns];
        body = block.metrics.map((x) => [safe(x.label), ...x.m.trend!.map((p) => safe(formatNum(p.value, x.m.valueType, x.m.decimals, meta.unit, x.m.rawUnit)))]);
      } else if (block.kind === 'breakdown') {
        const total = block.items.reduce((s, i) => s + i.value, 0);
        head = ['Item', 'Value', 'Share'];
        body = block.items.map((i) => [safe(i.label), safe(formatItem(i.value, block.metric, meta.unit)), total ? pct((i.value / total) * 100) : '—']);
      }
      autoTable(doc, {
        ...PDF_TABLE_STYLES,
        startY: y + 6,
        head: [head.map(safe)],
        body,
        styles: { ...PDF_TABLE_STYLES.styles, fontSize: head.length > 8 ? 6.5 : 8 },
        columnStyles: Object.fromEntries(head.map((_, i) => [i, { halign: i === 0 ? 'left' : 'right' }])),
        didDrawPage: () => { if (doc.getNumberOfPages() > 1) header(); },
        margin: { left: MARGIN, right: MARGIN, top: TOP_Y },
      });
      y = pdfTableBottom(doc) + 6;
      continue;
    }

    const rowH = Math.max(...heights);
    ensure(rowH + 2);
    row.forEach(({ block, x, w }, i) => {
      const top = y;
      if (block.kind !== 'kpis' && block.kind !== 'ratio') drawBoxTitle(doc, block.title, x, top + 4, w);
      if (block.kind === 'kpis') {
        const perRow = Math.max(1, Math.floor(w / 42));
        const cw = (w - (perRow - 1) * 2) / perRow;
        drawBoxTitle(doc, block.metrics.length > 1 ? block.title : '', x, top + 4, w);
        block.metrics.forEach((m, j) => {
          const cx = x + (j % perRow) * (cw + 2);
          const cy = top + (block.metrics.length > 1 ? 6 : 0) + Math.floor(j / perRow) * 25;
          drawKpi(doc, m, cx, cy, cw, 22, meta.unit);
        });
      } else if (block.kind === 'ratio') {
        const r = block.ratio;
        drawTile(doc, block.title, ratioValueText(r, r.value), ratioChangeText(r) || `${r.parts[0].label} / ${r.parts[1].label}`,
          { fg: NAVY, tint: [239, 246, 255] }, x, top, w, 22);
      } else if (block.kind === 'series' || block.kind === 'breakdown') {
        const img = chartImage(root, block.widget.id);
        if (img) {
          const h = heights[i] - 7;
          const iw = Math.min(w, h * img.aspect);
          doc.addImage(img.data, 'JPEG', x, top + 6, iw, h);
        } else {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7.5);
          doc.setTextColor(...SLATE);
          doc.text('Chart not rendered on screen — see the Excel export for its figures.', x, top + 12, { maxWidth: w });
        }
      } else if (block.kind === 'text') {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(30, 41, 59);
        doc.text(doc.splitTextToSize(safe(block.text), w), x, top + 10);
      } else if (block.kind === 'empty') {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(7.5);
        doc.setTextColor(...SLATE);
        doc.text(safe(block.reason), x, top + 11, { maxWidth: w });
      }
      doc.setDrawColor(...BORDER);
    });
    y += rowH + 4;
  }

  if (y === TOP_Y && model.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(...SLATE);
    doc.text('This view has no widgets.', PAGE_W / 2, TOP_Y + 10, { align: 'center' });
  }
  addPdfFooter(doc);
  doc.save(`${fileBase(meta)}.pdf`);
}
