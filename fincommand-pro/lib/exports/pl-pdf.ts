'use client';

/**
 * Bespoke, purpose-built PDF for the P&L Account tab — KPI cards, a native
 * (not screenshotted) profit waterfall (Revenue down to PAT), and the full
 * Schedule III statement with OCI/EPS honestly marked "n/a" where a Trial
 * Balance genuinely can't support them, laid out like a real statutory P&L
 * rather than a plain key/value table dump. Deliberately separate from
 * lib/exports/pdf.ts's generic per-section table exporter (used for every
 * tab without a bespoke layout).
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { ReportBundle } from '@/lib/dashboard/types';
import { fl, fn, frRaw, fcPdf, getFyLabel, getFyShortLabel, getUnitHeaderPdf, unitSuffix, formatChg, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import {
  NAVY, NAVY_DARK, SLATE, BORDER, RED, GREEN, PAGE_W, MARGIN, CONTENT_W, DEFAULT_COMPANY_NAME,
  toneColor, addPdfHeader, addPdfFooter, drawKpiCards, pdfSectionTitle, pdfTableBottom, PDF_TABLE_STYLES,
} from './pdf-kit';

/** Native profit waterfall: Revenue stepping down through each expense line to PAT — a floating-bar bridge, same construction as Cash Flow's cash bridge. */
function drawProfitWaterfall(doc: jsPDF, revenue: number, cos: number, emp: number, dep: number, fin: number, oex: number, pat: number, y: number, unit: DisplayUnit, currency: CurrencyCode): number {
  const chartH = 48;
  const chartX = MARGIN + 22;
  const chartW = CONTENT_W - 22;
  const chartTop = y;
  const chartBottom = y + chartH;

  const steps: { label: string; delta: number; total: boolean }[] = [
    { label: 'Revenue', delta: revenue, total: true },
    { label: '- Cost of Services', delta: -cos, total: false },
    { label: '- Employee Costs', delta: -emp, total: false },
    { label: '- Other Expenses', delta: -oex, total: false },
    { label: '- Finance Costs', delta: -fin, total: false },
    { label: '- Depreciation', delta: -dep, total: false },
    { label: 'PAT', delta: pat, total: true },
  ];

  let running = 0;
  const runningVals: number[] = [];
  steps.forEach((s, i) => {
    if (s.total && i === 0) running = s.delta;
    else if (s.total) running = s.delta; // PAT is itself the final total, not a delta on running
    else running += s.delta;
    runningVals.push(running);
  });

  const allTops = [0, ...runningVals];
  const maxV = Math.max(...allTops, 0);
  const minV = Math.min(...allTops, 0);
  const range = Math.max(maxV - minV, 1);
  const valToY = (v: number) => chartBottom - ((v - minV) / range) * chartH;
  const zeroY = valToY(0);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...NAVY);
  doc.text('Profit Bridge — Revenue to PAT', MARGIN, chartTop - 4);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
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
  if (minV < 0) {
    doc.setDrawColor(...SLATE);
    doc.setLineWidth(0.3);
    doc.line(chartX, zeroY, chartX + chartW, zeroY);
  }

  const n = steps.length;
  const colW = chartW / n;
  const barW = colW * 0.5;
  let prevRunning = 0;

  steps.forEach((s, i) => {
    const colCenter = chartX + colW * i + colW / 2;
    let barTop: number, barBottom: number, color: [number, number, number];

    if (s.total) {
      barTop = valToY(runningVals[i]);
      barBottom = zeroY;
      color = NAVY;
    } else {
      const from = prevRunning;
      const to = runningVals[i];
      barTop = valToY(Math.max(from, to));
      barBottom = valToY(Math.min(from, to));
      color = s.delta < 0 ? RED : GREEN;
      doc.setDrawColor(...BORDER);
      doc.setLineWidth(0.3);
      doc.line(colCenter - colW / 2, valToY(from), colCenter - barW / 2, valToY(from));
    }

    doc.setFillColor(...color);
    doc.rect(colCenter - barW / 2, barTop, barW, Math.max(barBottom - barTop, 0.3), 'F');

    doc.setFontSize(6.2);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...color);
    const valueLabel = s.total ? fl(runningVals[i], 0, unit) : formatChg(s.delta, 0, unit);
    doc.text(valueLabel, colCenter, barTop - 2, { align: 'center' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6);
    doc.setTextColor(...SLATE);
    doc.text(s.label, colCenter, chartBottom + 4, { align: 'center' });

    prevRunning = runningVals[i];
  });

  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.15);
  doc.line(chartX, chartBottom, chartX + chartW, chartBottom);

  return chartBottom + 9;
}

export function buildPlPdf(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): { doc: jsPDF; fyShort: string } {
  const doc = new jsPDF();
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyLabel = getFyLabel(bundle.financial_year, yearType);
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  const { pl } = bundle;
  const prevPl = compare ? bundle.prev_pl : null;
  const hasPrev = !!prevPl;

  const header = () => addPdfHeader(doc, companyName, 'Statement of Profit & Loss · Schedule III, IND AS', fyLabel, bundle.period_label);
  header();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...NAVY_DARK);
  doc.text('Statement of Profit & Loss', MARGIN, 36);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...SLATE);
  doc.text(`Schedule III · IND AS · ${getUnitHeaderPdf(unit, currency)} unless noted`, MARGIN, 41.5);
  doc.setDrawColor(...BORDER);
  doc.line(MARGIN, 44, PAGE_W - MARGIN, 44);

  let y = drawKpiCards(doc, [
    { label: 'Total Income', value: fcPdf(pl.total_income, currency), sub: `Revenue ${fl(pl.revenue, 2, unit)}${unitSuffix(unit)} + Other ${fl(pl.other_income, 2, unit)}${unitSuffix(unit)}`, tone: 0 },
    { label: 'Total Expenses', value: fcPdf(pl.total_expenses, currency), sub: `${pl.revenue > 0 ? ((pl.total_expenses / pl.revenue) * 100).toFixed(1) : '—'}% of Revenue`, tone: 0 },
    { label: 'Profit Before Tax', value: fcPdf(pl.pbt, currency), sub: `Margin ${pl.revenue > 0 ? ((pl.pbt / pl.revenue) * 100).toFixed(1) : '—'}%`, tone: pl.pbt },
    { label: 'Profit After Tax', value: fcPdf(pl.pat, currency), sub: `Margin ${pl.revenue > 0 ? ((pl.pat / pl.revenue) * 100).toFixed(1) : '—'}%`, tone: pl.pat },
  ], 49);

  y += 6;
  y = drawProfitWaterfall(doc, pl.revenue, pl.cos, pl.employee_benefits, pl.depreciation, pl.finance_costs, pl.other_expenses, pl.pat, y, unit, currency);

  // ── Full statement table ──
  y = pdfSectionTitle(doc, 'Statement of Profit & Loss', y, hasPrev ? `vs ${getFyShortLabel(bundle.prev_financial_year, yearType)}` : getUnitHeaderPdf(unit, currency));

  interface Row { label: string; noteNo?: number; curr: number | null; prev?: number | null; bold?: boolean; grand?: boolean; section?: boolean; sep?: boolean; raw?: boolean; }
  const rows: Row[] = [
    { label: 'I. INCOME', curr: null, section: true },
    { label: 'Revenue from Operations', noteNo: 20, curr: pl.revenue, prev: prevPl?.revenue },
    { label: 'Other Income', noteNo: 21, curr: pl.other_income, prev: prevPl?.other_income },
    { label: 'Total Income (I)', curr: pl.total_income, prev: prevPl?.total_income, bold: true },
    { label: '', curr: null, sep: true },
    { label: 'II. EXPENSES', curr: null, section: true },
    { label: 'Cost of Services / Materials Consumed', noteNo: 22, curr: pl.cos, prev: prevPl?.cos },
    { label: 'Employee Benefits Expense', noteNo: 23, curr: pl.employee_benefits, prev: prevPl?.employee_benefits },
    { label: 'Finance Costs', noteNo: 24, curr: pl.finance_costs, prev: prevPl?.finance_costs },
    { label: 'Depreciation & Amortisation', noteNo: 25, curr: pl.depreciation, prev: prevPl?.depreciation },
    { label: 'Other Expenses', noteNo: 26, curr: pl.other_expenses, prev: prevPl?.other_expenses },
    { label: 'Total Expenses (II)', curr: pl.total_expenses, prev: prevPl?.total_expenses, bold: true },
    { label: '', curr: null, sep: true },
    { label: 'III. PROFIT', curr: null, section: true },
    { label: 'Profit Before Tax (I - II)', curr: pl.pbt, prev: prevPl?.pbt, bold: true },
    { label: 'Current Tax (25%, estimated)', curr: pl.current_tax, prev: prevPl?.current_tax },
    { label: 'Deferred Tax Charge / (Credit) (1%, estimated)', curr: pl.deferred_tax, prev: prevPl?.deferred_tax },
    { label: 'Profit After Tax (PAT)', curr: pl.pat, prev: prevPl?.pat, grand: true },
    { label: '', curr: null, sep: true },
    { label: 'IV. OTHER COMPREHENSIVE INCOME (IND AS 1)', curr: null, section: true },
    { label: 'Remeasurement of Defined Benefit Obligation', curr: pl.oci_gross, prev: prevPl?.oci_gross },
    { label: 'Income Tax on OCI', curr: pl.oci_tax, prev: prevPl?.oci_tax },
    { label: 'Other Comprehensive Income (Net of Tax)', curr: pl.oci_net, prev: prevPl?.oci_net, bold: true },
    { label: 'Total Comprehensive Income', curr: pl.total_comprehensive_income, prev: prevPl?.total_comprehensive_income, grand: true },
    { label: '', curr: null, sep: true },
    { label: 'V. EARNINGS PER SHARE (IND AS 33)', curr: null, section: true },
    { label: 'Basic EPS (Rs.)', curr: pl.eps_basic, prev: prevPl?.eps_basic, raw: true },
    { label: 'Diluted EPS (Rs.)', curr: pl.eps_diluted, prev: prevPl?.eps_diluted, raw: true },
  ];

  const disp = (v: number | null | undefined, raw?: boolean) => (v == null ? 'n/a' : (raw ? frRaw(v) : fn(v, 2, unit)));
  // Same '+—' guard as formatChg(), generalized for the raw (EPS, no unit
  // conversion) vs. table-unit-converted dual mode disp() already handles.
  const dispChg = (v: number, raw?: boolean) => {
    const text = raw ? frRaw(v) : fn(v, 2, unit);
    return text === '—' ? '—' : (v > 0 ? `+${text}` : text);
  };

  const head = hasPrev
    ? [['Particulars', 'Note', `${fyShort} (${getCurrencyMeta(currency).pdfSymbol} ${unitSuffix(unit)})`, `${getFyShortLabel(bundle.prev_financial_year, yearType)} (${getCurrencyMeta(currency).pdfSymbol} ${unitSuffix(unit)})`, 'YoY Change']]
    : [['Particulars', 'Note', `Amount (${getCurrencyMeta(currency).pdfSymbol} ${unitSuffix(unit)})`]];

  autoTable(doc, {
    startY: y,
    head,
    body: rows.map(r => {
      if (r.section || r.sep) return hasPrev ? [r.label, '', '', '', ''] : [r.label, '', ''];
      const chg = hasPrev && r.curr != null && r.prev != null ? r.curr - r.prev : null;
      const base = [r.label, r.noteNo ? String(r.noteNo) : '', disp(r.curr, r.raw)];
      if (!hasPrev) return base;
      return [...base, disp(r.prev, r.raw), chg != null ? dispChg(chg, r.raw) : (r.curr == null ? 'n/a' : '—')];
    }),
    ...PDF_TABLE_STYLES,
    styles: { ...PDF_TABLE_STYLES.styles, fontSize: 7, cellPadding: 1.9 },
    columnStyles: hasPrev
      ? { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } }
      : { 2: { halign: 'right' } },
    didParseCell: (data) => {
      const r = rows[data.row.index];
      if (!r) return;
      if (r.section) { data.cell.styles.fillColor = [241, 245, 249]; data.cell.styles.fontStyle = 'bold'; data.cell.styles.fontSize = 7.3; }
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

  // ── Methodology footnote ──
  if (y > 265) { doc.addPage(); header(); y = 32; }
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...SLATE);
  const note = 'Every line above Section IV is computed directly from real Trial Balance ledger movements - no assumed percentages, except Current Tax and Deferred Tax, modeled at a flat rate on a profitable period since this Trial Balance carries no dedicated tax-provision ledger - and nil in a loss-making period (PBT <= 0), per IND AS 12, since no company owes current tax on a loss. Other Comprehensive Income and EPS are marked "n/a" rather than estimated: OCI requires an actuarial valuation and EPS requires the real face value per share and shares outstanding from the Register of Members - neither is derivable from ledger balances alone.';
  const split = doc.splitTextToSize(note, CONTENT_W);
  doc.text(split, MARGIN, y + 4);

  addPdfFooter(doc);
  return { doc, fyShort };
}

export function exportPlPdf(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  const { doc, fyShort } = buildPlPdf(bundle, companyName, unit, compare, currency);
  doc.save(`FinCommandPro_ProfitAndLoss_${fyShort}.pdf`);
}
