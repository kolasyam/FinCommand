'use client';

/**
 * Bespoke, purpose-built PDF for the Balance Sheet tab — KPI cards, a native
 * (not screenshotted) Equity & Liabilities / Assets composition chart, and
 * the full Schedule III statement with Note-level breakdowns, color-coded
 * and laid out like a real audited balance sheet rather than a plain
 * key/value table dump. Deliberately separate from lib/exports/pdf.ts's
 * generic per-section table exporter (used for every tab without a bespoke
 * layout).
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { ReportBundle } from '@/lib/dashboard/types';
import type { AggregatedNote } from '@/lib/financial/tb-engine';
import { fl, fn, fcPdf, getFyLabel, getFyShortLabel, cyYearFromFy, formatDate, getUnitHeaderPdf, unitSuffix, formatChg, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { resolvePeriod } from '@/lib/financial/tb-engine';
import {
  NAVY, NAVY_DARK, SLATE, BORDER, RED, GREEN, PAGE_W, MARGIN, CONTENT_W, DEFAULT_COMPANY_NAME,
  toneColor, addPdfHeader, addPdfFooter, drawKpiCards, pdfSectionTitle, pdfTableBottom, PDF_TABLE_STYLES,
} from './pdf-kit';

/** Same "as at" date logic as BalanceSheetTab.tsx — the Balance Sheet is inherently a point-in-time statement, so a Quarterly/H1-H2 export must not claim the fiscal year-end date. */
function resolveAsAtDate(financialYear: { start_date: string; end_date: string }, yearType: string, periodParams: ReportBundle['period_params']): string {
  const resolved = resolvePeriod(periodParams);
  if (yearType === 'CY') {
    const cyYear = cyYearFromFy(financialYear);
    return resolved.periodEnd ? `${resolved.periodEnd} ${cyYear}` : `31 Dec ${cyYear}`;
  }
  if (resolved.periodEnd) {
    const fyStartYear = parseInt(financialYear.start_date.slice(0, 4), 10);
    const year = fyStartYear + (resolved.bsLastIdx >= 9 ? 1 : 0);
    return `${resolved.periodEnd} ${year}`;
  }
  return formatDate(financialYear.end_date);
}

/** Native two-bar composition chart: Equity+Liabilities broken into Equity/NCL/CL, Assets broken into NCA/CA — the two sides of the same total, side by side. */
function drawCompositionChart(doc: jsPDF, eq: number, ncl: number, cl: number, nca: number, ca: number, y: number, unit: DisplayUnit, currency: CurrencyCode): number {
  const chartH = 42;
  const chartX = MARGIN + 22;
  const chartW = CONTENT_W - 22;
  const chartTop = y;
  const chartBottom = y + chartH;
  const total = Math.max(eq + ncl + cl, nca + ca, 1);
  const valToH = (v: number) => (v / total) * chartH;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...NAVY);
  doc.text('Equity & Liabilities vs. Assets — Composition', MARGIN, chartTop - 4);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...SLATE);
  doc.text(getUnitHeaderPdf(unit, currency), PAGE_W - MARGIN, chartTop - 4, { align: 'right' });

  const barW = 26;
  const gap = chartW - barW * 2;
  const elX = chartX;
  const asX = chartX + barW + gap;

  const drawStack = (x: number, segments: { v: number; color: [number, number, number]; label: string }[]) => {
    let cursorY = chartBottom;
    segments.forEach(s => {
      const h = Math.max(valToH(s.v), 0.3);
      cursorY -= h;
      doc.setFillColor(...s.color);
      doc.rect(x, cursorY, barW, h, 'F');
      if (h > 4) {
        doc.setFontSize(6);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(255, 255, 255);
        doc.text(fl(s.v, 0, unit), x + barW / 2, cursorY + h / 2 + 1, { align: 'center' });
      }
    });
  };

  drawStack(elX, [
    { v: eq, color: [30, 58, 138], label: 'Equity' },
    { v: ncl, color: [93, 141, 202], label: 'Non-Current Liab.' },
    { v: cl, color: [181, 212, 244], label: 'Current Liab.' },
  ]);
  drawStack(asX, [
    { v: nca, color: [15, 110, 86], label: 'Non-Current Assets' },
    { v: ca, color: [147, 205, 187], label: 'Current Assets' },
  ]);

  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.15);
  doc.line(chartX, chartBottom, chartX + chartW, chartBottom);

  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...NAVY_DARK);
  doc.text('Equity & Liabilities', elX + barW / 2, chartBottom + 5, { align: 'center' });
  doc.text('Assets', asX + barW / 2, chartBottom + 5, { align: 'center' });

  // Legend
  const legendY = chartBottom + 11;
  const legendItems: { color: [number, number, number]; label: string }[] = [
    { color: [30, 58, 138], label: 'Equity' },
    { color: [93, 141, 202], label: 'Non-Current Liabilities' },
    { color: [181, 212, 244], label: 'Current Liabilities' },
    { color: [15, 110, 86], label: 'Non-Current Assets' },
    { color: [147, 205, 187], label: 'Current Assets' },
  ];
  let lx = chartX;
  legendItems.forEach(it => {
    doc.setFillColor(...it.color);
    doc.rect(lx, legendY - 3, 3, 3, 'F');
    doc.setFontSize(6.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...SLATE);
    doc.text(it.label, lx + 4, legendY);
    lx += doc.getTextWidth(it.label) + 10;
  });

  return legendY + 8;
}

export function buildBsPdf(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): { doc: jsPDF; fyShort: string } {
  const doc = new jsPDF();
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyLabel = getFyLabel(bundle.financial_year, yearType);
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  const { bs } = bundle;
  const prevBs = compare ? bundle.prev_bs : null;
  const eq = bs.equity_liabilities;
  const as = bs.assets;
  const asAtDate = resolveAsAtDate(bundle.financial_year, yearType, bundle.period_params);
  const hasPrev = !!(prevBs);

  const header = () => addPdfHeader(doc, companyName, 'Balance Sheet · Schedule III, IND AS', fyLabel, bundle.period_label);
  header();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...NAVY_DARK);
  doc.text('Balance Sheet', MARGIN, 36);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...SLATE);
  doc.text(`Schedule III · IND AS · As at ${asAtDate} · ${getUnitHeaderPdf(unit, currency)} unless noted`, MARGIN, 41.5);
  doc.setDrawColor(...BORDER);
  doc.line(MARGIN, 44, PAGE_W - MARGIN, 44);

  let y = drawKpiCards(doc, [
    { label: 'Total Assets', value: fcPdf(as.total, currency), sub: `NCA ${fl(as.total_nca, 2, unit)}${unitSuffix(unit)} + CA ${fl(as.total_ca, 2, unit)}${unitSuffix(unit)}`, tone: 0 },
    { label: 'Total Equity', value: fcPdf(eq.total_equity, currency), sub: 'Shareholders\' funds', tone: eq.total_equity },
    { label: 'Total Liabilities', value: fcPdf(eq.total_ncl + eq.total_cl, currency), sub: `NCL ${fl(eq.total_ncl, 2, unit)}${unitSuffix(unit)} + CL ${fl(eq.total_cl, 2, unit)}${unitSuffix(unit)}`, tone: 0 },
    {
      label: 'Balance Check',
      value: bs.balanced ? 'Balanced' : 'Out of Balance',
      sub: bs.balanced ? 'Assets = Equity + Liabilities' : `Diff: ${getCurrencyMeta(currency).pdfSymbol} ${fl(bs.difference, 2, unit)}${unitSuffix(unit)}`,
      tone: bs.balanced ? 1 : -1,
    },
  ], 49);

  y += 6;
  y = drawCompositionChart(doc, eq.total_equity, eq.total_ncl, eq.total_cl, as.total_nca, as.total_ca, y, unit, currency);

  if (!bs.balanced) {
    doc.setFillColor(254, 242, 242);
    doc.setDrawColor(...RED);
    doc.setLineWidth(0.3);
    doc.roundedRect(MARGIN, y, CONTENT_W, 9, 1.5, 1.5, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...RED);
    doc.text(`Balance Sheet is out of balance by ${getCurrencyMeta(currency).pdfSymbol} ${fl(bs.difference, 2, unit)}${unitSuffix(unit)} — review ledger section mappings before circulating.`, MARGIN + 3, y + 5.8);
    y += 13;
  }

  // ── Full statement table ──
  y = pdfSectionTitle(doc, 'Balance Sheet — Schedule III', y, hasPrev ? `vs ${getFyShortLabel(bundle.prev_financial_year, yearType)}` : getUnitHeaderPdf(unit, currency));

  interface Row { label: string; noteNo?: number; curr: number | null; prev?: number | null; bold?: boolean; grand?: boolean; section?: boolean; sep?: boolean; }
  const rows: Row[] = [];
  const pushNotes = (notes: AggregatedNote[], prevNotes?: AggregatedNote[]) => {
    if (!hasPrev) {
      notes.forEach(n => rows.push({ label: n.note_name || `Note ${n.note_no}`, noteNo: n.note_no, curr: n.total }));
      return;
    }
    const allNos = Array.from(new Set([...notes.map(n => n.note_no), ...(prevNotes || []).map(n => n.note_no)])).sort((a, b) => a - b);
    allNos.forEach(no => {
      const c = notes.find(n => n.note_no === no);
      const p = (prevNotes || []).find(n => n.note_no === no);
      rows.push({ label: c?.note_name || p?.note_name || `Note ${no}`, noteNo: no, curr: c?.total ?? 0, prev: p?.total ?? 0 });
    });
  };
  const prevEq = prevBs?.equity_liabilities;
  const prevAs = prevBs?.assets;

  rows.push({ label: 'EQUITY & LIABILITIES', curr: null, section: true });
  rows.push({ label: "Shareholders' Equity", curr: eq.total_equity, prev: prevEq?.total_equity, bold: true });
  pushNotes(eq.equity, prevEq?.equity);
  rows.push({ label: 'Non-Current Liabilities', curr: eq.total_ncl, prev: prevEq?.total_ncl, bold: true });
  pushNotes(eq.non_current_liab, prevEq?.non_current_liab);
  rows.push({ label: 'Current Liabilities', curr: eq.total_cl, prev: prevEq?.total_cl, bold: true });
  pushNotes(eq.current_liab, prevEq?.current_liab);
  rows.push({ label: 'TOTAL EQUITY & LIABILITIES', curr: eq.total, prev: prevEq?.total, grand: true });
  rows.push({ label: '', curr: null, sep: true });
  rows.push({ label: 'ASSETS', curr: null, section: true });
  rows.push({ label: 'Non-Current Assets', curr: as.total_nca, prev: prevAs?.total_nca, bold: true });
  pushNotes(as.non_current, prevAs?.non_current);
  rows.push({ label: 'Current Assets', curr: as.total_ca, prev: prevAs?.total_ca, bold: true });
  pushNotes(as.current, prevAs?.current);
  rows.push({ label: 'TOTAL ASSETS', curr: as.total, prev: prevAs?.total, grand: true });

  const head = hasPrev
    ? [['Particulars', 'Note', `${fyShort} (${getCurrencyMeta(currency).pdfSymbol} ${unitSuffix(unit)})`, `${getFyShortLabel(bundle.prev_financial_year, yearType)} (${getCurrencyMeta(currency).pdfSymbol} ${unitSuffix(unit)})`, 'YoY Change']]
    : [['Particulars', 'Note', `Amount (${getCurrencyMeta(currency).pdfSymbol} ${unitSuffix(unit)})`]];

  autoTable(doc, {
    startY: y,
    head,
    body: rows.map(r => {
      if (r.section) return [r.label, '', ...(hasPrev ? ['', '', ''] : [''])];
      if (r.sep) return hasPrev ? ['', '', '', '', ''] : ['', '', ''];
      const chg = hasPrev && r.curr != null && r.prev != null ? r.curr - r.prev : null;
      const base = [r.label, r.noteNo ? String(r.noteNo) : '', r.curr != null ? fn(r.curr, 2, unit) : ''];
      if (!hasPrev) return base;
      return [...base, r.prev != null ? fn(r.prev, 2, unit) : '', chg != null ? formatChg(chg, 2, unit) : '—'];
    }),
    ...PDF_TABLE_STYLES,
    styles: { ...PDF_TABLE_STYLES.styles, fontSize: 7.2, cellPadding: 2 },
    columnStyles: hasPrev
      ? { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } }
      : { 2: { halign: 'right' } },
    didParseCell: (data) => {
      const r = rows[data.row.index];
      if (!r) return;
      if (r.section) { data.cell.styles.fillColor = [241, 245, 249]; data.cell.styles.fontStyle = 'bold'; data.cell.styles.fontSize = 7.5; }
      if (r.bold || r.grand) data.cell.styles.fontStyle = 'bold';
      if (r.grand) data.cell.styles.fillColor = [248, 250, 252];
      if (data.column.index === 1) data.cell.styles.halign = 'center';
      if (!r.section && !r.sep) {
        const isTotalCol = data.column.index === 2;
        const isPrevCol = hasPrev && data.column.index === 3;
        const isChgCol = hasPrev && data.column.index === 4;
        if (isTotalCol && r.curr != null && (r.bold || r.grand)) data.cell.styles.textColor = toneColor(r.curr);
        if (isPrevCol) data.cell.styles.textColor = SLATE;
        if (isChgCol && r.curr != null && r.prev != null) data.cell.styles.textColor = toneColor(r.curr - r.prev);
      }
    },
  });
  y = pdfTableBottom(doc) + 6;

  addPdfFooter(doc);
  return { doc, fyShort };
}

export function exportBsPdf(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  const { doc, fyShort } = buildBsPdf(bundle, companyName, unit, compare, currency);
  doc.save(`FinCommandPro_BalanceSheet_${fyShort}.pdf`);
}
