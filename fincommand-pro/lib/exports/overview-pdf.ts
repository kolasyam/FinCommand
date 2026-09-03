'use client';

/**
 * Bespoke, purpose-built PDF for the Executive Overview tab — KPI cards, a
 * native (not screenshotted) Revenue/EBITDA bar chart, and color-coded
 * tables, laid out like a real corporate one-pager rather than a plain
 * key/value table dump. Deliberately separate from lib/exports/pdf.ts's
 * generic per-section table exporter (used for every other tab), which
 * doesn't attempt this kind of layout.
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { ReportBundle } from '@/lib/dashboard/types';
import { fl, fn, frRaw, pct, signedPct, fcPdf, getFyLabel, getFyShortLabel, getUnitHeaderPdf, unitSuffix, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import {
  NAVY, NAVY_DARK, SLATE, BORDER, RED, AMBER, GREEN, PAGE_W, MARGIN, CONTENT_W, DEFAULT_COMPANY_NAME,
  toneColor, addPdfHeader, addPdfFooter, drawKpiCards, pdfSectionTitle, pdfTableBottom, PDF_TABLE_STYLES,
} from './pdf-kit';

/** Native grouped bar chart (Revenue vs Operating EBITDA per period) — drawn directly with jsPDF primitives, not a screenshotted <canvas>, so it stays crisp at any zoom and needs no chart-render-timing workaround. */
function drawRevenueEbitdaChart(doc: jsPDF, labels: string[], revenue: number[], ebitda: number[], y: number, unit: DisplayUnit, currency: CurrencyCode): number {
  const chartH = 46;
  const chartX = MARGIN + 22; // room for Y-axis labels
  const chartW = CONTENT_W - 22;
  const chartTop = y;
  const chartBottom = y + chartH;

  const allVals = [...revenue, ...ebitda];
  const maxV = Math.max(...allVals, 0);
  const minV = Math.min(...allVals, 0);
  const range = Math.max(maxV - minV, 1);
  const zeroY = chartBottom - ((0 - minV) / range) * chartH;
  const valToY = (v: number) => chartBottom - ((v - minV) / range) * chartH;

  // Section heading + legend
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...NAVY);
  doc.text('Revenue & Operating EBITDA Trend', MARGIN, chartTop - 4);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...SLATE);
  doc.text(getUnitHeaderPdf(unit, currency), PAGE_W - MARGIN, chartTop - 4, { align: 'right' });

  const legendY = chartTop - 4;
  doc.setFillColor(181, 212, 244); // Revenue blue tint (matches on-screen chart)
  doc.rect(MARGIN + 62, legendY - 3, 3, 3, 'F');
  doc.setFontSize(7);
  doc.setTextColor(...NAVY_DARK);
  doc.text('Revenue', MARGIN + 66, legendY);
  doc.setFillColor(93, 202, 165); // EBITDA green tint
  doc.rect(MARGIN + 84, legendY - 3, 3, 3, 'F');
  doc.text('EBITDA', MARGIN + 88, legendY);

  // Gridlines + Y-axis labels (4 bands)
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.15);
  const bands = 4;
  for (let b = 0; b <= bands; b++) {
    const gy = chartTop + (chartH / bands) * b;
    doc.line(chartX, gy, chartX + chartW, gy);
    const gv = maxV - (range / bands) * b;
    doc.setFontSize(6.5);
    doc.setTextColor(...SLATE);
    doc.text(fl(gv, 0, unit), chartX - 2, gy + 1, { align: 'right' });
  }
  // Zero baseline, heavier if it's not already one of the gridlines (i.e. data goes negative)
  if (minV < 0) {
    doc.setDrawColor(...SLATE);
    doc.setLineWidth(0.3);
    doc.line(chartX, zeroY, chartX + chartW, zeroY);
  }

  // Bars
  const n = labels.length;
  const colW = chartW / n;
  const barW = Math.min(colW * 0.32, 5);
  const barGap = 0.8;

  labels.forEach((lbl, i) => {
    const colCenter = chartX + colW * i + colW / 2;
    const rv = revenue[i] ?? 0;
    const ev = ebitda[i] ?? 0;

    const rTop = Math.min(valToY(rv), zeroY);
    const rH = Math.max(Math.abs(valToY(rv) - zeroY), 0.2);
    doc.setFillColor(181, 212, 244);
    doc.rect(colCenter - barW - barGap / 2, rTop, barW, rH, 'F');

    const eColor: [number, number, number] = ev < 0 ? RED : [93, 202, 165];
    const eTop = Math.min(valToY(ev), zeroY);
    const eH = Math.max(Math.abs(valToY(ev) - zeroY), 0.2);
    doc.setFillColor(...eColor);
    doc.rect(colCenter + barGap / 2, eTop, barW, eH, 'F');

    // X label — every column if it fits, else thin them out
    const skip = n > 12 ? Math.ceil(n / 12) : 1;
    if (i % skip === 0) {
      doc.setFontSize(6);
      doc.setTextColor(...SLATE);
      doc.text(lbl, colCenter, chartBottom + 4, { align: 'center' });
    }
  });

  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.15);
  doc.line(chartX, chartBottom, chartX + chartW, chartBottom);

  return chartBottom + 8;
}

/** Builds the document without triggering a browser download — the actual layout logic, kept testable/reusable independent of jsPDF's DOM-dependent .save(). */
export function buildOverviewPdf(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): { doc: jsPDF; fyShort: string } {
  const doc = new jsPDF();
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyLabel = getFyLabel(bundle.financial_year, yearType);
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  const { mis } = bundle;
  const t = mis.totals;
  const grossProfit = t.rev - t.cos;

  const header = () => addPdfHeader(doc, companyName, 'Executive Overview · CFO Financial Command Center', fyLabel, bundle.period_label);
  header();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...NAVY_DARK);
  doc.text('Executive Overview', MARGIN, 36);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...SLATE);
  doc.text(`Key Performance Indicators, Revenue & EBITDA Trend, Margins · ${getUnitHeaderPdf(unit, currency)} unless noted`, MARGIN, 41.5);
  doc.setDrawColor(...BORDER);
  doc.line(MARGIN, 44, PAGE_W - MARGIN, 44);

  let y = drawKpiCards(doc, [
    { label: 'Revenue', value: fcPdf(t.rev, currency), sub: `${fl(t.rev, 2, unit)} ${unitSuffix(unit)}`, tone: 0 },
    { label: 'Gross Profit', value: fcPdf(grossProfit, currency), sub: `Margin ${pct(t.gm)}`, tone: grossProfit },
    { label: 'EBITDA (Operating)', value: fcPdf(t.ebitda, currency), sub: `Margin ${pct(t.em)}`, tone: t.ebitda },
    { label: 'PAT', value: fcPdf(t.pat, currency), sub: `Net Margin ${pct(t.pm)}`, tone: t.pat },
  ], 49);

  y += 6;
  y = drawRevenueEbitdaChart(doc, mis.columns, mis.data.map(d => d.rev), mis.data.map(d => d.ebitda), y, unit, currency);

  // ── Period Summary table ──
  y = pdfSectionTitle(doc, 'Period Summary', y, getUnitHeaderPdf(unit, currency));
  const summaryRows: { label: string; val: number; pctOfRev: number | null; bold?: boolean; tone?: boolean }[] = [
    { label: 'Revenue', val: t.rev, pctOfRev: 100 },
    { label: 'Gross Profit', val: grossProfit, pctOfRev: t.gm, tone: true },
    { label: 'EBITDA (Operating)', val: t.ebitda, pctOfRev: t.em, tone: true, bold: true },
    { label: 'Profit Before Tax', val: t.pbt, pctOfRev: t.rev > 0 ? (t.pbt / t.rev) * 100 : null, tone: true },
    { label: 'Profit After Tax', val: t.pat, pctOfRev: t.pm, tone: true, bold: true },
    { label: 'Employee Cost', val: t.emp, pctOfRev: t.rev > 0 ? (t.emp / t.rev) * 100 : null },
  ];
  autoTable(doc, {
    startY: y,
    head: [['Metric', 'Value', '% of Revenue']],
    body: summaryRows.map(r => [r.label, fn(r.val, 2, unit), r.pctOfRev != null ? pct(r.pctOfRev) : '—']),
    ...PDF_TABLE_STYLES,
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
    didParseCell: (data) => {
      const r = summaryRows[data.row.index];
      if (!r) return;
      if (r.bold) data.cell.styles.fontStyle = 'bold';
      if (r.tone && (data.column.index === 1 || data.column.index === 2)) {
        const v = data.column.index === 1 ? r.val : r.pctOfRev;
        if (v != null) data.cell.styles.textColor = toneColor(v);
      }
    },
  });
  y = pdfTableBottom(doc) + 8;

  // ── Top Customers ──
  if (bundle.top_customers && bundle.top_customers.length > 0) {
    if (y > 250) { doc.addPage(); header(); y = 32; }
    const sourceLabel = bundle.top_customers[0]?.source === 'zoho' ? 'Zoho — Sales by Customer' : bundle.top_customers[0]?.source === 'ledger_estimate' ? 'Estimated — Revenue Ledger Split' : 'Sample Data';
    y = pdfSectionTitle(doc, 'Top 5 Customers by Revenue', y, sourceLabel);
    const custRows = bundle.top_customers;
    autoTable(doc, {
      startY: y,
      head: [['Customer', `Revenue (${getCurrencyMeta(currency).pdfSymbol} Cr)`, '% of Revenue', 'Status']],
      body: custRows.map(c => [c.customer, frRaw(c.revenue_cr, 2), pct(c.pct_of_total), c.status]),
      ...PDF_TABLE_STYLES,
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
      didParseCell: (data) => {
        if (data.column.index === 3 && data.row.section === 'body') {
          const status = custRows[data.row.index]?.status;
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.textColor = status === 'Concentration Risk' ? RED : status === 'Key Account' ? AMBER : GREEN;
        }
      },
    });
    y = pdfTableBottom(doc) + 8;
  }

  // ── Year-on-Year Comparison ──
  if (bundle.prev_mis && compare) {
    if (y > 245) { doc.addPage(); header(); y = 32; }
    const prevT = bundle.prev_mis.totals;
    const prevFyShort = getFyShortLabel(bundle.prev_financial_year, yearType);
    y = pdfSectionTitle(doc, `Year-on-Year — ${fyShort} vs ${prevFyShort}`, y, getUnitHeaderPdf(unit, currency));
    const yoyRows: { label: string; curr: number; prev: number; bold?: boolean }[] = [
      { label: 'Revenue', curr: t.rev, prev: prevT.rev },
      { label: 'EBITDA', curr: t.ebitda, prev: prevT.ebitda },
      { label: 'PAT', curr: t.pat, prev: prevT.pat, bold: true },
      { label: 'Employee Cost', curr: t.emp, prev: prevT.emp },
    ];
    autoTable(doc, {
      startY: y,
      head: [['Metric', fyShort, prevFyShort, 'YoY']],
      body: yoyRows.map(r => {
        const chg = r.prev !== 0 ? ((r.curr - r.prev) / Math.abs(r.prev)) * 100 : null;
        return [r.label, fn(r.curr, 2, unit), fn(r.prev, 2, unit), chg != null ? signedPct(chg) : '—'];
      }),
      ...PDF_TABLE_STYLES,
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
      didParseCell: (data) => {
        const r = yoyRows[data.row.index];
        if (!r) return;
        if (r.bold) data.cell.styles.fontStyle = 'bold';
        if (data.column.index === 1) data.cell.styles.textColor = toneColor(r.curr);
        if (data.column.index === 2) data.cell.styles.textColor = SLATE;
        if (data.column.index === 3) {
          const chg = r.prev !== 0 ? ((r.curr - r.prev) / Math.abs(r.prev)) * 100 : 0;
          data.cell.styles.textColor = toneColor(chg);
          data.cell.styles.fontStyle = 'bold';
        }
      },
    });
  }

  addPdfFooter(doc);
  return { doc, fyShort };
}

export function exportOverviewPdf(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  const { doc, fyShort } = buildOverviewPdf(bundle, companyName, unit, compare, currency);
  doc.save(`FinCommandPro_ExecutiveOverview_${fyShort}.pdf`);
}
