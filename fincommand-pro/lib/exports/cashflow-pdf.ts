'use client';

/**
 * Bespoke, purpose-built PDF for the Cash Flow tab — KPI cards, a native
 * Opening→Closing cash "bridge" waterfall chart, and the full Indirect
 * Method statement (Operating/Investing/Financing) with color-coded values
 * and the same human-readable labels the on-screen tab uses.
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { ReportBundle } from '@/lib/dashboard/types';
import { fl, fn, fcPdf, getFyLabel, getFyShortLabel, getUnitHeaderPdf, unitSuffix, formatChg, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { cfLabel } from '@/lib/financial/cashflow-labels';
import {
  NAVY, NAVY_DARK, SLATE, BORDER, GREEN, RED, PAGE_W, MARGIN, CONTENT_W, DEFAULT_COMPANY_NAME,
  toneColor, addPdfHeader, addPdfFooter, drawKpiCards, pdfSectionTitle, pdfTableBottom, PDF_TABLE_STYLES,
} from './pdf-kit';

/**
 * Native "cash bridge" waterfall: Opening Cash (solid bar from 0), then each
 * activity's net contribution as a floating bar riding the running total,
 * ending at Closing Cash (solid bar from 0) — the standard way treasury/IR
 * decks show how a company got from last year-end's cash to this one's.
 */
function drawCashBridge(
  doc: jsPDF,
  opening: number,
  ocf: number,
  icf: number,
  fcf: number,
  closing: number,
  y: number,
  unit: DisplayUnit,
  currency: CurrencyCode
): number {
  const chartH = 50;
  const chartX = MARGIN + 22;
  const chartW = CONTENT_W - 22;
  const chartTop = y;
  const chartBottom = y + chartH;

  const steps = [
    { label: 'Opening Cash', delta: opening, running: opening, total: true },
    { label: 'Operating CF', delta: ocf, running: opening + ocf, total: false },
    { label: 'Investing CF', delta: icf, running: opening + ocf + icf, total: false },
    { label: 'Financing CF', delta: fcf, running: opening + ocf + icf + fcf, total: false },
    { label: 'Closing Cash', delta: closing, running: closing, total: true },
  ];

  const allTops = [0, ...steps.map(s => s.running), ...steps.map((s, i) => i === 0 || i === steps.length - 1 ? s.running : steps[i - 1].running)];
  const maxV = Math.max(...allTops, 0);
  const minV = Math.min(...allTops, 0);
  const range = Math.max(maxV - minV, 1);
  const valToY = (v: number) => chartBottom - ((v - minV) / range) * chartH;
  const zeroY = valToY(0);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...NAVY);
  doc.text('Cash Bridge — Opening to Closing', MARGIN, chartTop - 4);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...SLATE);
  doc.text(getUnitHeaderPdf(unit, currency), PAGE_W - MARGIN, chartTop - 4, { align: 'right' });

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

  const n = steps.length;
  const colW = chartW / n;
  const barW = colW * 0.5;
  let prevRunning = 0;

  steps.forEach((s, i) => {
    const colCenter = chartX + colW * i + colW / 2;
    let barTop: number, barBottom: number, color: [number, number, number];

    if (s.total) {
      barTop = valToY(s.running);
      barBottom = zeroY;
      color = NAVY;
    } else {
      const from = prevRunning;
      const to = s.running;
      barTop = valToY(Math.max(from, to));
      barBottom = valToY(Math.min(from, to));
      color = s.delta < 0 ? RED : GREEN;
      // Thin connector line from the previous bar's level to this one's start
      doc.setDrawColor(...BORDER);
      doc.setLineWidth(0.3);
      doc.line(colCenter - colW / 2, valToY(from), colCenter - barW / 2, valToY(from));
    }

    doc.setFillColor(...color);
    doc.rect(colCenter - barW / 2, barTop, barW, Math.max(barBottom - barTop, 0.3), 'F');

    doc.setFontSize(6.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...color);
    const valueLabel = s.total ? fl(s.running, 0, unit) : formatChg(s.delta, 0, unit);
    doc.text(valueLabel, colCenter, barTop - 2, { align: 'center' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(...SLATE);
    doc.text(s.label, colCenter, chartBottom + 5, { align: 'center' });

    prevRunning = s.running;
  });

  doc.setDrawColor(...SLATE);
  doc.setLineWidth(0.2);
  doc.line(chartX, zeroY, chartX + chartW, zeroY);
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.15);
  doc.line(chartX, chartBottom, chartX + chartW, chartBottom);

  return chartBottom + 9;
}

export function buildCashFlowPdf(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): { doc: jsPDF; fyShort: string } {
  const doc = new jsPDF();
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyLabel = getFyLabel(bundle.financial_year, yearType);
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  const cf = bundle.cashflow;
  const op = cf.operating as Record<string, unknown>;
  const inv = cf.investing as Record<string, unknown>;
  const fin = cf.financing as Record<string, unknown>;
  const adj = (op.adjustments || {}) as Record<string, number>;
  const wc = (op.wc_changes || {}) as Record<string, number>;
  const ocfTotal = op.total as number;
  const icfTotal = inv.total as number;
  const fcfTotal = fin.total as number;

  const header = () => addPdfHeader(doc, companyName, 'Statement of Cash Flows · IND AS 7, Indirect Method', fyLabel, bundle.period_label);
  header();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...NAVY_DARK);
  doc.text('Statement of Cash Flows', MARGIN, 36);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...SLATE);
  doc.text(`Indirect Method · IND AS 7 · ${getUnitHeaderPdf(unit, currency)} unless noted`, MARGIN, 41.5);
  doc.setDrawColor(...BORDER);
  doc.line(MARGIN, 44, PAGE_W - MARGIN, 44);

  let y = drawKpiCards(doc, [
    { label: 'Operating Cash Flow', value: fcPdf(ocfTotal, currency), sub: cf.ocf_to_pat != null ? `OCF/PAT = ${cf.ocf_to_pat.toFixed(2)}x` : 'OCF/PAT: n/a (loss)', tone: ocfTotal },
    { label: 'Investing Cash Flow', value: fcPdf(icfTotal, currency), sub: 'Capex + FD/MF movements', tone: icfTotal },
    { label: 'Financing Cash Flow', value: fcPdf(fcfTotal, currency), sub: 'Borrowings + equity, net', tone: fcfTotal },
    { label: 'Net Change in Cash', value: fcPdf(cf.net_change, currency), sub: `Closing: ${fl(cf.closing_cash, 2, unit)}${unitSuffix(unit)}`, tone: cf.net_change },
  ], 49);

  y += 6;
  y = drawCashBridge(doc, cf.opening_cash, ocfTotal, icfTotal, fcfTotal, cf.closing_cash, y, unit, currency);

  // ── Full statement table ──
  y = pdfSectionTitle(doc, 'Statement of Cash Flows — Indirect Method', y, getUnitHeaderPdf(unit, currency));

  interface Row { label: string; val: number | null; indent?: number; bold?: boolean; section?: boolean; tone?: boolean; sep?: boolean; }
  const rows: Row[] = [
    { label: 'A. Cash Flow from Operating Activities', val: null, section: true },
    { label: 'Profit Before Tax', val: op.pbt as number, indent: 1, bold: true, tone: true },
    { label: 'Adjustments for non-cash items:', val: null, indent: 2, section: true },
    ...Object.entries(adj).map(([k, v]): Row => ({ label: cfLabel(k), val: v, indent: 2, tone: true })),
    { label: 'Changes in Working Capital:', val: null, indent: 2, section: true },
    ...Object.entries(wc).map(([k, v]): Row => ({ label: k, val: v, indent: 2, tone: true })),
    { label: 'A. Net Cash from Operating Activities', val: ocfTotal, bold: true, tone: true },
    { label: '', val: null, sep: true },
    { label: 'B. Cash Flow from Investing Activities', val: null, section: true },
    ...Object.entries(inv).filter(([k]) => k !== 'total').map(([k, v]): Row => ({ label: cfLabel(k), val: v as number, indent: 1, tone: true })),
    { label: 'B. Net Cash from Investing Activities', val: icfTotal, bold: true, tone: true },
    { label: '', val: null, sep: true },
    { label: 'C. Cash Flow from Financing Activities', val: null, section: true },
    ...Object.entries(fin).filter(([k]) => k !== 'total').map(([k, v]): Row => ({ label: cfLabel(k), val: v as number, indent: 1, tone: true })),
    { label: 'C. Net Cash from Financing Activities', val: fcfTotal, bold: true, tone: true },
    { label: '', val: null, sep: true },
    { label: 'Net Change in Cash / Net Increase (Decrease) — (A+B+C)', val: cf.net_change, bold: true, tone: true },
    { label: 'Opening Cash & Bank Balances', val: cf.opening_cash, indent: 1, tone: true },
    ...(Math.abs(cf.reconciling_gap) >= 1000 ? [{ label: 'Reconciling Difference (see note below)', val: cf.reconciling_gap, indent: 1, tone: true } as Row] : []),
    { label: 'Closing Cash & Bank Balances', val: cf.closing_cash, bold: true, tone: true },
  ];

  autoTable(doc, {
    startY: y,
    head: [['Particulars', `${fyShort} (${getCurrencyMeta(currency).pdfSymbol} ${unitSuffix(unit)})`]],
    body: rows.map(r => [r.label, r.val != null ? fn(r.val, 2, unit) : '']),
    ...PDF_TABLE_STYLES,
    columnStyles: { 1: { halign: 'right' } },
    didParseCell: (data) => {
      const r = rows[data.row.index];
      if (!r) return;
      if (r.section) { data.cell.styles.fillColor = [241, 245, 249]; data.cell.styles.fontStyle = 'bold'; data.cell.styles.fontSize = 7.5; }
      if (r.bold) data.cell.styles.fontStyle = 'bold';
      if (r.indent === 1) data.cell.styles.cellPadding = { top: 2.6, bottom: 2.6, left: 8, right: 2.6 };
      if (r.indent === 2) data.cell.styles.cellPadding = { top: 2.6, bottom: 2.6, left: 12, right: 2.6 };
      if (r.tone && data.column.index === 1 && r.val != null) data.cell.styles.textColor = toneColor(r.val);
    },
  });
  y = pdfTableBottom(doc) + 6;

  if (Math.abs(cf.reconciling_gap) >= 1000) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...SLATE);
    const note = 'This statement is derived entirely from real Trial Balance ledger movements - no assumed percentages. The Reconciling Difference line ties the statement above to actual opening and closing cash/bank balances; the most common cause is cash tax paid, which is not shown as its own modeled line since no dedicated tax-provision ledger exists in this Chart of Accounts to trace it from - plus any Balance Sheet tally difference. Opening + Net Change + that line equals the real Closing Cash & Bank balance.';
    const split = doc.splitTextToSize(note, CONTENT_W);
    doc.text(split, MARGIN, y);
  }

  addPdfFooter(doc);
  return { doc, fyShort };
}

export function exportCashFlowPdf(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  const { doc, fyShort } = buildCashFlowPdf(bundle, companyName, unit, compare, currency);
  doc.save(`FinCommandPro_CashFlow_${fyShort}.pdf`);
}
