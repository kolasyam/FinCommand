'use client';

/**
 * Bespoke, purpose-built PDF for the MIS Report tab — KPI cards, a native
 * (not screenshotted) Revenue/EBITDA/PAT monthly trend chart, and the full
 * Particulars × Months + Total matrix with margin rows, color-coded and
 * laid out like a real management report rather than a plain key/value
 * table dump. Deliberately separate from lib/exports/pdf.ts's generic
 * per-section table exporter (used for every tab without a bespoke layout).
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { ReportBundle } from '@/lib/dashboard/types';
import { fl, fn, pct, signedPct, fcPdf, getFyLabel, getFyShortLabel, getUnitHeaderPdf, unitSuffix, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import {
  NAVY, NAVY_DARK, SLATE, BORDER, RED, GREEN, PAGE_W, MARGIN, CONTENT_W, DEFAULT_COMPANY_NAME,
  toneColor, addPdfHeader, addPdfFooter, drawKpiCards, pdfSectionTitle, pdfTableBottom, PDF_TABLE_STYLES,
} from './pdf-kit';

const REV_COLOR: [number, number, number] = [181, 212, 244]; // blue tint, matches Overview's chart
const EBITDA_COLOR: [number, number, number] = [93, 202, 165]; // green tint
const PAT_COLOR: [number, number, number] = [30, 58, 138]; // navy

/** Native 3-series grouped bar chart (Revenue / EBITDA / PAT per month) — drawn directly with jsPDF primitives, not a screenshotted <canvas>. */
function drawMisTrendChart(doc: jsPDF, labels: string[], revenue: number[], ebitda: number[], pat: number[], y: number, unit: DisplayUnit, currency: CurrencyCode): number {
  const chartH = 48;
  const chartX = MARGIN + 22;
  const chartW = CONTENT_W - 22;
  const chartTop = y;
  const chartBottom = y + chartH;

  const allVals = [...revenue, ...ebitda, ...pat];
  const maxV = Math.max(...allVals, 0);
  const minV = Math.min(...allVals, 0);
  const range = Math.max(maxV - minV, 1);
  const valToY = (v: number) => chartBottom - ((v - minV) / range) * chartH;
  const zeroY = valToY(0);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...NAVY);
  doc.text('Revenue, EBITDA & PAT — Monthly Trend', MARGIN, chartTop - 4);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...SLATE);
  doc.text(getUnitHeaderPdf(unit, currency), PAGE_W - MARGIN, chartTop - 4, { align: 'right' });

  const legendY = chartTop - 4;
  let lx = MARGIN + 62;
  const legendItem = (color: [number, number, number], label: string) => {
    doc.setFillColor(...color);
    doc.rect(lx, legendY - 3, 3, 3, 'F');
    doc.setFontSize(7);
    doc.setTextColor(...NAVY_DARK);
    doc.text(label, lx + 4, legendY);
    lx += doc.getTextWidth(label) + 10;
  };
  legendItem(REV_COLOR, 'Revenue');
  legendItem(EBITDA_COLOR, 'EBITDA');
  legendItem(PAT_COLOR, 'PAT');

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
  if (minV < 0) {
    doc.setDrawColor(...SLATE);
    doc.setLineWidth(0.3);
    doc.line(chartX, zeroY, chartX + chartW, zeroY);
  }

  const n = labels.length;
  const colW = chartW / n;
  const barW = Math.min(colW * 0.22, 3.2);
  const barGap = 0.6;

  labels.forEach((lbl, i) => {
    const colCenter = chartX + colW * i + colW / 2;
    const series: { v: number; color: [number, number, number] }[] = [
      { v: revenue[i] ?? 0, color: REV_COLOR },
      { v: ebitda[i] ?? 0, color: (ebitda[i] ?? 0) < 0 ? RED : EBITDA_COLOR },
      { v: pat[i] ?? 0, color: (pat[i] ?? 0) < 0 ? RED : PAT_COLOR },
    ];
    series.forEach((s, si) => {
      const bx = colCenter - (barW * 1.5 + barGap) + si * (barW + barGap);
      const top = Math.min(valToY(s.v), zeroY);
      const h = Math.max(Math.abs(valToY(s.v) - zeroY), 0.2);
      doc.setFillColor(...s.color);
      doc.rect(bx, top, barW, h, 'F');
    });

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

export function buildMisPdf(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): { doc: jsPDF; fyShort: string } {
  const doc = new jsPDF();
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyLabel = getFyLabel(bundle.financial_year, yearType);
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  const { mis } = bundle;
  const t = mis.totals;

  const header = () => addPdfHeader(doc, companyName, 'MIS Report · Monthly P&L', fyLabel, bundle.period_label);
  header();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...NAVY_DARK);
  doc.text('MIS Report — Monthly P&L', MARGIN, 36);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...SLATE);
  doc.text(`Month-wise Revenue, Costs, EBITDA, PAT & Margins · ${getUnitHeaderPdf(unit, currency)} unless noted`, MARGIN, 41.5);
  doc.setDrawColor(...BORDER);
  doc.line(MARGIN, 44, PAGE_W - MARGIN, 44);

  let y = drawKpiCards(doc, [
    { label: 'Revenue', value: fcPdf(t.rev, currency), sub: `${fl(t.rev, 2, unit)} ${unitSuffix(unit)}`, tone: 0 },
    { label: 'Gross Profit', value: fcPdf(t.rev - t.cos, currency), sub: `Margin ${pct(t.gm)}`, tone: t.rev - t.cos },
    { label: 'EBITDA (Operating)', value: fcPdf(t.ebitda, currency), sub: `Margin ${pct(t.em)}`, tone: t.ebitda },
    { label: 'PAT', value: fcPdf(t.pat, currency), sub: `Margin ${pct(t.pm)}`, tone: t.pat },
  ], 49);

  y += 6;
  y = drawMisTrendChart(doc, mis.columns, mis.data.map(d => d.rev), mis.data.map(d => d.ebitda), mis.data.map(d => d.pat), y, unit, currency);

  // ── Full monthly matrix ──
  y = pdfSectionTitle(doc, 'Monthly MIS — P&L', y, getUnitHeaderPdf(unit, currency));

  interface Row { label: string; key: keyof typeof t; bold?: boolean; grand?: boolean; tone?: boolean; pctRow?: boolean; }
  const rows: Row[] = [
    { label: 'Revenue from Operations', key: 'rev', bold: true },
    { label: 'Other Income', key: 'oth' },
    { label: 'Total Income', key: 'totInc', bold: true },
    { label: 'Cost of Services', key: 'cos' },
    { label: 'Employee Benefits', key: 'emp' },
    { label: 'Other Expenses', key: 'oex' },
    { label: 'EBITDA (Operating)', key: 'ebitda', bold: true, tone: true },
    { label: 'Finance Costs', key: 'fin' },
    { label: 'Depreciation & Amortisation', key: 'dep' },
    { label: 'Total Expenses', key: 'totExp', bold: true },
    { label: 'Profit Before Tax', key: 'pbt', bold: true, tone: true },
    { label: 'Tax (25%, estimated)', key: 'tax' },
    { label: 'Profit After Tax', key: 'pat', bold: true, tone: true },
    { label: 'Gross Margin %', key: 'gm', pctRow: true },
    { label: 'EBITDA Margin %', key: 'em', pctRow: true },
    { label: 'PAT Margin %', key: 'pm', pctRow: true },
  ];

  autoTable(doc, {
    startY: y,
    head: [['Particulars', ...mis.columns, 'Total']],
    body: rows.map(r => [
      r.label,
      ...mis.data.map(d => (r.pctRow ? pct(d[r.key] as number) : fn(d[r.key] as number, 2, unit))),
      r.pctRow ? pct(t[r.key] as number) : fn(t[r.key] as number, 2, unit),
    ]),
    ...PDF_TABLE_STYLES,
    styles: { ...PDF_TABLE_STYLES.styles, fontSize: 6.8, cellPadding: 1.8 },
    headStyles: { ...PDF_TABLE_STYLES.headStyles, fontSize: 6.8 },
    columnStyles: Object.fromEntries([...mis.columns, 'Total'].map((_, i) => [i + 1, { halign: 'right' as const }])),
    didParseCell: (data) => {
      if (data.column.index === 0) return;
      const r = rows[data.row.index];
      if (!r) return;
      if (r.bold) data.cell.styles.fontStyle = 'bold';
      if (r.tone || r.pctRow) {
        const isTotal = data.column.index === mis.columns.length + 1;
        const d = isTotal ? t : mis.data[data.column.index - 1];
        const v = d ? (d[r.key] as number) : null;
        if (v != null) data.cell.styles.textColor = toneColor(v);
      }
      if (data.column.index === mis.columns.length + 1) data.cell.styles.fontStyle = 'bold';
    },
  });
  y = pdfTableBottom(doc) + 8;

  // ── Year-on-Year ──
  if (bundle.prev_mis && compare) {
    if (y > 245) { doc.addPage(); header(); y = 32; }
    const prevT = bundle.prev_mis.totals;
    const prevFyShort = getFyShortLabel(bundle.prev_financial_year, yearType);
    y = pdfSectionTitle(doc, `Year-on-Year — ${fyShort} vs ${prevFyShort}`, y, getUnitHeaderPdf(unit, currency));
    const yoyRows: { label: string; curr: number; prev: number; bold?: boolean }[] = [
      { label: 'Revenue', curr: t.rev, prev: prevT.rev },
      { label: 'EBITDA', curr: t.ebitda, prev: prevT.ebitda },
      { label: 'Profit Before Tax', curr: t.pbt, prev: prevT.pbt },
      { label: 'PAT', curr: t.pat, prev: prevT.pat, bold: true },
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
    y = pdfTableBottom(doc) + 6;
  }

  // ── Tax methodology footnote ──
  if (y > 270) { doc.addPage(); header(); y = 32; }
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...SLATE);
  const note = 'Revenue, income and expense lines above are computed directly from real Trial Balance ledger movements for each month - no assumed percentages. Tax is the one modeled line: this Trial Balance carries no dedicated tax-provision ledger to derive a real figure from, so it is estimated at a flat 25% of Profit Before Tax in a profitable month, and nil in a loss-making month (PBT <= 0), per IND AS 12 - a company owes no current tax on a loss.';
  const split = doc.splitTextToSize(note, CONTENT_W);
  doc.text(split, MARGIN, y + 4);

  addPdfFooter(doc);
  return { doc, fyShort };
}

export function exportMisPdf(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  const { doc, fyShort } = buildMisPdf(bundle, companyName, unit, compare, currency);
  doc.save(`FinCommandPro_MIS_${fyShort}.pdf`);
}
