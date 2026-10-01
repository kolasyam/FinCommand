import type * as ExcelJS from 'exceljs';

/** A sheet as rows of cell values, row 1 first — what the export's readers see. */
function sheetRows(wb: ExcelJS.Workbook, name: string): (string | number)[][] {
  const rows: (string | number)[][] = [];
  wb.getWorksheet(name)!.eachRow({ includeEmpty: true }, (row, n) => { rows[n - 1] = (row.values as (string | number)[]).slice(1); });
  return Array.from(rows, (r) => r ?? []);
}
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import {
  buildLayoutExportModel, buildDashboardLayoutXlsx, buildDashboardLayoutCsv, buildDashboardLayoutPptx,
  formatNum, orderWidgets, ratioChangeText, CSV_HEADER, type ExportBlock,
} from '@/lib/exports/dashboard-layout-export';
import type { ResolvedMetric } from '@/lib/financial/dashboard-builder-engine';
import { resolveAnyMetric, type CustomMetricDefinition } from '@/lib/financial/custom-metric-engine';
import { PERIOD_SUMMARY_METRIC_KEYS, type DashboardWidget, type WidgetKind } from '@/lib/financial/dashboard-builder-engine';
import type { ReportBundle } from '@/lib/dashboard/types';
import type { MISColumn } from '@/lib/financial/tb-engine';

function col(rev: number, emp: number): MISColumn {
  return { rev, oth: 0, totInc: rev, cos: 0, emp, fin: 0, dep: 0, oex: 0, totExp: emp, pbt: rev - emp, tax: 0, pat: rev - emp, ebitda: rev - emp, gm: 100, em: 0, pm: 0 };
}
const bundle = {
  period_params: { periodType: 'annual', yearType: 'FY' },
  mis: { columns: ['Apr', 'May'], data: [col(2_00_000, 50_000), col(3_00_000, 50_000)], totals: col(5_00_000, 1_00_000) },
  prev_mis: { columns: [], data: [], totals: col(4_00_000, 80_000) },
  bs: {
    equity_liabilities: { equity: [], non_current_liab: [], current_liab: [], total_equity: 9_00_000, total_ncl: 0, total_cl: 1_00_000, total: 10_00_000 },
    assets: { non_current: [], current: [], total_nca: 4_00_000, total_ca: 6_00_000, total: 10_00_000 },
    balanced: true, difference: 0,
  },
  prev_bs: null,
  custom_metric_values: {
    salary_ledger: { value: 1_00_000, previous: null, trend: [{ label: 'Apr', value: 50_000 }, { label: 'May', value: 50_000 }], breakdown: [{ label: 'Salaries', value: 70_000 }, { label: 'Wages', value: 30_000 }], matchedCount: 2 },
  },
} as unknown as ReportBundle;
const customs: CustomMetricDefinition[] = [{
  key: 'salary_ledger', label: 'Salary (ledgers)', kind: 'ledger', valueType: 'currency', decimals: 2, expression: null, thresholds: null,
  ledgerSpec: { match: 'all', measure: 'movement', sign: 'natural', conditions: [{ field: 'ledger_name', operator: 'contains', value: 'sal' }] },
}];

let seq = 0;
const w = (widgetType: WidgetKind, x: number, y: number, series: string[] = [], extra: Partial<DashboardWidget> = {}): DashboardWidget => ({
  id: `w${seq++}`, widgetType, title: null, subtitle: null, gridX: x, gridY: y, gridW: 4, gridH: 4,
  series: series.map((metricKey) => ({ metricKey })), vizConfig: {}, sequence: seq, ...extra,
});
const resolveWidget = (wd: DashboardWidget) =>
  (wd.widgetType === 'period_summary' ? [...PERIOD_SUMMARY_METRIC_KEYS] : wd.series.map((s) => s.metricKey)).map((k) => resolveAnyMetric(k, bundle, customs));

const widgets: DashboardWidget[] = [
  w('line_chart', 0, 4, ['revenue', 'employee_cost']),
  w('stat_card', 4, 0, ['revenue']),
  w('stat_card', 0, 0, ['salary_ledger']),
  w('data_table', 4, 4, ['salary_ledger'], { vizConfig: { limit: 1 } }),
  w('text_block', 8, 0, [], { title: 'Commentary', vizConfig: { text: 'Strong quarter.' } }),
  w('period_summary', 0, 8, []),
  // Bound to a custom metric that has since been deleted — resolves to null.
  w('gauge', 8, 4, ['deleted_custom_metric']),
];

describe('buildLayoutExportModel', () => {
  const model = buildLayoutExportModel(widgets, resolveWidget, bundle);

  test('follows the on-screen reading order: top-to-bottom, then left-to-right', () => {
    expect(orderWidgets(widgets).map((x) => `${x.gridY},${x.gridX}`)).toEqual(['0,0', '0,4', '0,8', '4,0', '4,4', '4,8', '8,0']);
    expect(model.map((b) => b.kind)).toEqual(['kpis', 'kpis', 'text', 'series', 'breakdown', 'empty', 'table']);
  });
  test('values are the exact resolved metrics the grid shows — including custom ledger metrics', () => {
    const ledgerCard = model[0];
    expect(ledgerCard.kind === 'kpis' && ledgerCard.metrics[0].m.value).toBe(1_00_000);
  });
  test('series blocks carry the real monthly trend for every metric', () => {
    const s = model[3];
    expect(s.kind === 'series' && s.columns).toEqual(['Apr', 'May']);
    expect(s.kind === 'series' && s.metrics.map((x) => x.m.trend!.map((p) => p.value))).toEqual([[2_00_000, 3_00_000], [50_000, 50_000]]);
  });
  test('ranked tables respect the widget row limit', () => {
    const b = model[4];
    expect(b.kind === 'breakdown' && b.items).toEqual([{ label: 'Salaries', value: 70_000 }]);
  });
  test('a widget whose metric has no data exports an honest "empty" block, not a fabricated zero', () => {
    expect(model[5]).toMatchObject({ kind: 'empty' });
  });
});

describe('buildDashboardLayoutXlsx', () => {
  const model = buildLayoutExportModel(widgets, resolveWidget, bundle);
  const wb = buildDashboardLayoutXlsx(model, {
    title: 'QA View', companyName: 'Test Co', fyLabel: 'FY 2025-26', fyShort: 'FY26', periodLabel: 'FY Annual', unit: 'Lakhs', currency: 'INR',
  });

  test('has Info, Widgets, Trends, Breakdowns and Tables sheets', () => {
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Info', 'Widgets', 'Trends', 'Breakdowns', 'Tables']);
  });
  test('amounts are real numbers in the selected unit (5,00,000 rupees = 5 Lakhs), with a native number format', () => {
    const rows = sheetRows(wb, 'Widgets');
    const revenueRow = rows.find((r) => r[2] === 'Revenue from Operations' && r[1] === 'stat_card')!;
    expect(revenueRow[3]).toBeCloseTo(5, 10);
    expect(revenueRow[4]).toBeCloseTo(4, 10);
    expect(revenueRow[5]).toBeCloseTo(25, 10);
    const cell = wb.getWorksheet('Widgets')!.getCell(rows.indexOf(revenueRow) + 1, 4);
    expect(cell.numFmt).toBeTruthy();
  });
  test('trend sheet holds one real number per month', () => {
    const rows = sheetRows(wb, 'Trends');
    expect(rows[1]).toEqual(['Metric', 'Apr', 'May']);
    expect(rows[2][0]).toBe('Revenue from Operations');
    expect(rows[2][1]).toBeCloseTo(2, 10);
  });
});

test('formatNum matches the on-screen widget formatting', () => {
  expect(formatNum(5_00_000, 'currency', 2, 'Lakhs')).toBe('5.00');
  expect(formatNum(12.345, 'percent', 1, 'Lakhs')).toBe('12.3%');
  expect(formatNum(-1.5, 'ratio', 2, 'Lakhs')).toBe('(1.50x)');
  expect(formatNum(45.6, 'days', 0, 'Lakhs')).toBe('46d');
  expect(formatNum(0.65, 'currency', 2, 'Lakhs', 'crore')).toBe('0.65 Cr');
  expect(formatNum(null, 'currency', 2, 'Lakhs')).toBe('—');
});

// ── New widget types, warn levels, comparisons, and the CSV / PowerPoint exports ──

// Same company, but last year's employee cost was 1,00,000 on revenue 4,00,000 (25%).
const bundle2 = { ...bundle, prev_mis: { columns: [], data: [], totals: col(4_00_000, 1_00_000) } } as unknown as ReportBundle;
const customs2: CustomMetricDefinition[] = [...customs, {
  key: 'emp_share', label: 'Employee cost share', kind: 'formula', valueType: 'percent', decimals: 1, ledgerSpec: null,
  expression: { type: 'op', op: 'percent_of', args: [{ type: 'metric', key: 'employee_cost' }, { type: 'metric', key: 'revenue' }] },
  thresholds: { direction: 'lower_is_better', target: 15, warn: 25 },
}];
const resolve2 = (wd: DashboardWidget) => wd.series.map((s) => resolveAnyMetric(s.metricKey, bundle2, customs2));
const META = { title: 'QA View', companyName: 'Test Co', fyLabel: 'FY 2025-26', fyShort: 'FY26', periodLabel: 'FY Annual', unit: 'Lakhs' as const, currency: 'INR' as const };

const widgets2: DashboardWidget[] = [
  w('ratio_card', 0, 0, ['employee_cost', 'revenue']),
  w('ratio_card', 4, 0, ['revenue', 'employee_cost'], { vizConfig: { ratio_format: 'multiple' } }),
  w('kpi_group', 8, 0, ['revenue', 'emp_share', 'salary_ledger'], { title: 'Headline' }),
  w('hbar_chart', 0, 4, ['salary_ledger']),
  w('bar_chart', 4, 4, [], { title: 'Revenue vs cost share', series: [{ metricKey: 'revenue' }, { metricKey: 'emp_share', renderAs: 'line', axis: 'right', color: '#FF0000' }] }),
  w('line_chart', 8, 4, [], { series: [{ metricKey: 'revenue', axis: 'right' }] }),
  w('text_block', 0, 8, [], { title: '=HYPERLINK("http://x")', vizConfig: { text: 'Hello, "board"\nsecond line' } }),
];

describe('export model — new widget types and chart options', () => {
  const model = buildLayoutExportModel(widgets2, resolve2, bundle2);
  const at = <K extends ExportBlock['kind']>(i: number, kind: K) => {
    expect(model[i].kind).toBe(kind);
    return model[i] as Extract<ExportBlock, { kind: K }>;
  };

  test('ratio card = numerator ÷ denominator, with a like-for-like change in points or x', () => {
    const pctRatio = at(0, 'ratio').ratio;
    expect(pctRatio).toMatchObject({ format: 'percent', label: 'Employee Benefits ÷ Revenue from Operations', comparisonLabel: 'YoY' });
    expect(pctRatio.value).toBeCloseTo(20, 10);
    expect(pctRatio.prior).toBeCloseTo(25, 10);
    expect(pctRatio.change).toBeCloseTo(-5, 10);
    expect(ratioChangeText(pctRatio)).toBe('-5.0 pts YoY');
    const multiple = at(1, 'ratio').ratio;
    expect(multiple.value).toBeCloseTo(5, 10);
    expect(multiple.prior).toBeCloseTo(4, 10);
    expect(ratioChangeText(multiple)).toBe('+1.00x YoY');
  });

  test('a ratio whose two sides compare against different periods shows no change', () => {
    const fake = (key: string, value: number, previous: number, comparisonLabel?: string): ResolvedMetric =>
      ({ key, label: key, value, previous, deltaPct: null, valueType: 'currency', rawUnit: 'rupee', decimals: 2, thresholds: null, comparisonLabel });
    const [b] = buildLayoutExportModel([w('ratio_card', 0, 0, ['a', 'b'])], () => [fake('a', 10, 8, 'vs prior period'), fake('b', 100, 100, 'YoY')], bundle2);
    expect(b.kind === 'ratio' && [b.ratio.value, b.ratio.prior, b.ratio.change]).toEqual([10, null, null]);
  });

  test('a KPI group exports every one of its figures', () => {
    const k = at(2, 'kpis');
    expect(k.title).toBe('Headline');
    expect(k.metrics.map((x) => x.m.key)).toEqual(['revenue', 'emp_share', 'salary_ledger']);
  });

  test('a horizontal bar exports its breakdown (non-zero rows, default top 8)', () => {
    const h = at(3, 'breakdown');
    expect(h.visual).toBe('hbar');
    expect(h.items.map((i) => i.label)).toEqual(['Salaries', 'Wages']);
  });

  test('series keep each binding\'s drawing style and axis; a lone right-axis series falls back to the left axis', () => {
    expect(at(4, 'series').metrics.map((x) => [x.renderAs, x.axis, x.color])).toEqual([['bar', 'left', undefined], ['line', 'right', '#FF0000']]);
    expect(at(5, 'series').metrics.map((x) => [x.renderAs, x.axis])).toEqual([['line', 'left']]);
  });
});

describe('warn level and comparison in the Excel export', () => {
  const wb = buildDashboardLayoutXlsx(buildLayoutExportModel(widgets2, resolve2, bundle2), META);
  const rows = sheetRows(wb, 'Widgets');

  test('a figure between its target and warn level is "Warning", with both levels spelled out', () => {
    expect(rows[0]).toEqual(['Widget', 'Type', 'Metric', 'Value (₹ in Lakhs)', 'Comparative', 'Change', 'Compared with', 'Target', 'Status']);
    const share = rows.find((r) => r[2] === 'Employee cost share')!;
    expect(share[3]).toBeCloseTo(20, 10);
    expect(share[6]).toBe('Same period last year');
    expect(share[7]).toBe('≤ 15%, warn ≤ 25%');
    expect(share[8]).toBe('Warning');
  });
  test('a ratio card row carries its value, prior and change, plus its two parts', () => {
    const ratio = rows.find((r) => r[1] === 'ratio_card')!;
    expect([ratio[3], ratio[4], ratio[5]].map((v) => Math.round(Number(v) * 100) / 100)).toEqual([20, 25, -5]);
    expect(rows.filter((r) => String(r[1]).startsWith('ratio_card (')).map((r) => r[1]).slice(0, 2)).toEqual(['ratio_card (numerator)', 'ratio_card (denominator)']);
  });
});

describe('CSV export', () => {
  const csv = buildDashboardLayoutCsv(buildLayoutExportModel(widgets2, resolve2, bundle2), META);
  const lines = csv.split('\r\n');

  test('one tidy header row and CRLF line endings', () => {
    expect(lines[0]).toBe(CSV_HEADER.join(','));
    expect(csv).not.toMatch(/[^\r]\n(?![^"]*"(?:,|$))/); // bare LF only inside a quoted cell
  });
  test('figures are plain numbers in the view unit, next to the screen text', () => {
    expect(lines).toContain('Headline,kpi_group,Revenue from Operations,value,Current period,5,₹ in Lakhs,5.00');
    expect(lines).toContain('Headline,kpi_group,Revenue from Operations,comparative,Same period last year,4,₹ in Lakhs,4.00');
    expect(lines).toContain('Headline,kpi_group,Revenue from Operations,change,Change % (YoY),25,%,+25.0%');
    expect(lines.some((l) => l.startsWith('Revenue vs cost share,bar_chart,Revenue from Operations,month,Apr,2,'))).toBe(true);
    expect(lines).toContain('Salary (ledgers),hbar_chart,Salary (ledgers),item,Salaries,0.7,₹ in Lakhs,0.70');
  });
  test('ratio rows: value, comparative and change in points', () => {
    const title = 'Employee Benefits ÷ Revenue from Operations';
    expect(lines).toContain(`${title},ratio_card,${title},value,Current period,20,%,20.0%`);
    expect(lines).toContain(`${title},ratio_card,${title},change,Change (YoY),-5,pts,-5.0 pts`);
  });
  test('quotes, commas and line breaks are escaped; formula-like text is neutralised', () => {
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")",text_block,,text,,,,"Hello, ""board""\nsecond line"`);
    // Our own signed numbers are left alone.
    expect(csv).not.toContain("'+25.0%");
  });
});

describe('PowerPoint export', () => {
  test('builds a real deck: cover, KPI tiles, native charts (a bar+line combo on two axes), tables', async () => {
    const model = buildLayoutExportModel(widgets2, resolve2, bundle2);
    const deck = buildDashboardLayoutPptx(PptxGenJS, model, META);
    const buf = await deck.write({ outputType: 'nodebuffer' }) as Buffer;
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files);
    const slides = names.filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    // cover + "Key figures" (2 ratio cards) + Headline tiles + hbar + combo + line + text
    expect(slides).toHaveLength(7);
    const charts = await Promise.all(names.filter((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f)).map((f) => zip.file(f)!.async('string')));
    expect(charts).toHaveLength(3);
    const combo = charts.find((x) => x.includes('<c:barChart>') && x.includes('<c:lineChart>'));
    expect(combo).toBeDefined();
    expect((combo!.match(/<c:valAx>/g) ?? []).length).toBe(2);
    expect(combo).toContain('FF0000'); // the binding's own colour
    const hbar = charts.find((x) => x.includes('<c:barDir val="bar"/>'));
    expect(hbar).toBeDefined();
    const allSlides = (await Promise.all(slides.map((f) => zip.file(f)!.async('string')))).join('');
    expect(allSlides).toContain('20.0%');          // ratio tile value
    expect(allSlides).toContain('-5.0 pts YoY');   // ratio tile change
    expect(allSlides).toContain('Test Co');
  });
});
