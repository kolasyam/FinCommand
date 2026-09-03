'use client';

/**
 * Bespoke, purpose-built PDF for the Treasury tab — KPI cards, a native
 * (not screenshotted) composition bar across all five instrument types, a
 * Liquidity & Concentration insight box, and full instrument-level detail,
 * color-coded and laid out like a real treasury report rather than a plain
 * key/value table dump. Deliberately separate from lib/exports/pdf.ts's
 * generic per-section table exporter (used for every tab without a bespoke
 * layout).
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { ReportBundle } from '@/lib/dashboard/types';
import type { TreasuryEntry, TreasuryResult } from '@/lib/financial/tb-engine';
import { fl, fn, fcPdf, pct, signedPct, getFyLabel, getFyShortLabel, getUnitHeaderPdf, unitSuffix, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import {
  NAVY, NAVY_DARK, SLATE, BORDER, AMBER, PAGE_W, MARGIN, CONTENT_W, DEFAULT_COMPANY_NAME,
  toneColor, addPdfHeader, addPdfFooter, drawKpiCards, pdfSectionTitle, pdfTableBottom, PDF_TABLE_STYLES,
} from './pdf-kit';

const COMPOSITION_COLORS: [number, number, number][] = [
  [239, 159, 39], [55, 138, 221], [147, 197, 253], [29, 158, 117], [93, 202, 165],
];

function allEntries(t: TreasuryResult): TreasuryEntry[] {
  return [...t.cash, ...t.bank_ca, ...t.bank_sb, ...t.fds, ...t.mfs];
}

/** Native segmented composition bar — one horizontal bar split proportionally across Cash / Bank CA / Bank SB / FD / MF, with a legend below. */
function drawCompositionBar(doc: jsPDF, segments: { label: string; value: number }[], y: number, unit: DisplayUnit, currency: CurrencyCode): number {
  const barH = 14;
  const barX = MARGIN;
  const barW = CONTENT_W;
  const total = segments.reduce((s, x) => s + Math.abs(x.value), 0);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...NAVY);
  doc.text('Treasury Composition', MARGIN, y - 4);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...SLATE);
  doc.text(getUnitHeaderPdf(unit, currency), PAGE_W - MARGIN, y - 4, { align: 'right' });

  if (total <= 0) {
    doc.setFontSize(8);
    doc.setTextColor(...SLATE);
    doc.text('No treasury balances to chart.', MARGIN, y + 8);
    return y + 16;
  }

  let x = barX;
  const present = segments.filter(s => Math.abs(s.value) > 0.005);
  present.forEach((s, i) => {
    const w = (Math.abs(s.value) / total) * barW;
    doc.setFillColor(...COMPOSITION_COLORS[i % COMPOSITION_COLORS.length]);
    doc.rect(x, y, Math.max(w, 0.3), barH, 'F');
    x += w;
  });
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.2);
  doc.rect(barX, y, barW, barH);

  // Legend, wrapped across lines as needed
  let lx = MARGIN;
  let ly = y + barH + 7;
  present.forEach((s, i) => {
    const pctStr = `${s.label} — ${pct((Math.abs(s.value) / total) * 100)}`;
    const w = doc.getTextWidth(pctStr) + 12;
    if (lx + w > MARGIN + CONTENT_W) { lx = MARGIN; ly += 6; }
    doc.setFillColor(...COMPOSITION_COLORS[i % COMPOSITION_COLORS.length]);
    doc.rect(lx, ly - 3, 3, 3, 'F');
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...NAVY_DARK);
    doc.text(pctStr, lx + 4, ly);
    lx += w;
  });

  return ly + 8;
}

export function buildTreasuryPdf(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): { doc: jsPDF; fyShort: string } {
  const doc = new jsPDF();
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyLabel = getFyLabel(bundle.financial_year, yearType);
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  const { treasury: t } = bundle;
  const prevT = compare ? bundle.prev_treasury : null;
  const hasPrev = !!prevT;
  const prevFyShort = getFyShortLabel(bundle.prev_financial_year, yearType);

  const yoy = (curr: number, prev: number) => (prev !== 0 ? (curr - prev) / Math.abs(prev) : null);

  const header = () => addPdfHeader(doc, companyName, 'Treasury Report · Cash, Bank, FDs & MFs', fyLabel, bundle.period_label);
  header();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...NAVY_DARK);
  doc.text('Treasury Position', MARGIN, 36);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...SLATE);
  doc.text(`Cash, Bank, Fixed Deposits & Mutual Funds · ${getUnitHeaderPdf(unit, currency)} unless noted`, MARGIN, 41.5);
  doc.setDrawColor(...BORDER);
  doc.line(MARGIN, 44, PAGE_W - MARGIN, 44);

  let y = drawKpiCards(doc, [
    { label: 'Cash & Bank', value: fcPdf(t.total_cash_and_bank, currency), sub: hasPrev ? `${yoy(t.total_cash_and_bank, prevT.total_cash_and_bank) != null ? signedPct(yoy(t.total_cash_and_bank, prevT.total_cash_and_bank)! * 100) : '—'} vs ${prevFyShort}` : 'Liquid balances', tone: 0 },
    { label: 'Fixed Deposits', value: fcPdf(t.total_fd, currency), sub: hasPrev ? `${yoy(t.total_fd, prevT.total_fd) != null ? signedPct(yoy(t.total_fd, prevT.total_fd)! * 100) : '—'} vs ${prevFyShort}` : 'Invested', tone: 0 },
    { label: 'Mutual Funds', value: fcPdf(t.total_mf, currency), sub: hasPrev ? `${yoy(t.total_mf, prevT.total_mf) != null ? signedPct(yoy(t.total_mf, prevT.total_mf)! * 100) : '—'} vs ${prevFyShort}` : 'Invested', tone: 0 },
    { label: 'Total Treasury', value: fcPdf(t.total, currency), sub: hasPrev ? `${yoy(t.total, prevT.total) != null ? signedPct(yoy(t.total, prevT.total)! * 100) : '—'} vs ${prevFyShort}` : 'All instruments', tone: 0 },
  ], 49);

  y += 8;
  y = drawCompositionBar(doc, [
    { label: 'Cash in Hand', value: t.cash.reduce((s, e) => s + e.closing, 0) },
    { label: 'Bank — Current', value: t.bank_ca.reduce((s, e) => s + e.closing, 0) },
    { label: 'Bank — Savings/Sweep', value: t.bank_sb.reduce((s, e) => s + e.closing, 0) },
    { label: 'Fixed Deposits', value: t.total_fd },
    { label: 'Mutual Funds', value: t.total_mf },
  ], y, unit, currency);

  // ── Liquidity & Concentration ──
  const liquidPct = t.total > 0 ? (t.total_cash_and_bank / t.total) * 100 : null;
  const investedPct = t.total > 0 ? ((t.total_fd + t.total_mf) / t.total) * 100 : null;
  const entries = allEntries(t);
  const largest = entries.reduce((max, e) => (Math.abs(e.closing) > Math.abs(max?.closing ?? 0) ? e : max), undefined as TreasuryEntry | undefined);
  const largestPct = largest && t.total > 0 ? (largest.closing / t.total) * 100 : null;

  y = pdfSectionTitle(doc, 'Liquidity & Concentration', y + 4);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...NAVY_DARK);
  doc.text(`Liquid (Cash + Bank): ${liquidPct != null ? pct(liquidPct) : '—'}   |   Invested (FD + MF): ${investedPct != null ? pct(investedPct) : '—'}`, MARGIN, y + 4);
  doc.text(`Largest single holding: ${largest ? `${largest.name} — ${fl(largest.closing, 2, unit)}${unitSuffix(unit)} (${largestPct != null ? pct(Math.abs(largestPct)) : '—'} of treasury)` : '—'}`, MARGIN, y + 10);
  y += 14;
  if (largestPct != null && Math.abs(largestPct) >= 40) {
    doc.setFillColor(254, 249, 231);
    doc.setDrawColor(...AMBER);
    doc.setLineWidth(0.3);
    doc.roundedRect(MARGIN, y, CONTENT_W, 9, 1.5, 1.5, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.3);
    doc.setTextColor(...AMBER);
    doc.text(`${pct(Math.abs(largestPct))} of total treasury sits in a single instrument — a real concentration risk worth reviewing for diversification.`, MARGIN + 3, y + 5.8);
    y += 13;
  }

  // ── Instrument-level detail tables ──
  const sections: { title: string; entries: TreasuryEntry[]; prevEntries: TreasuryEntry[] }[] = [
    { title: 'Cash in Hand', entries: t.cash, prevEntries: prevT?.cash || [] },
    { title: 'Bank — Current Accounts', entries: t.bank_ca, prevEntries: prevT?.bank_ca || [] },
    { title: 'Bank — Savings / Sweep', entries: t.bank_sb, prevEntries: prevT?.bank_sb || [] },
    { title: 'Fixed Deposits', entries: t.fds, prevEntries: prevT?.fds || [] },
    { title: 'Mutual Funds', entries: t.mfs, prevEntries: prevT?.mfs || [] },
  ];

  sections.forEach(sec => {
    if (!sec.entries.length && !sec.prevEntries.length) return;
    if (y > 250) { doc.addPage(); header(); y = 32; }
    y = pdfSectionTitle(doc, sec.title, y);

    const subtotal = sec.entries.reduce((s, e) => s + e.closing, 0);
    const prevSubtotal = sec.prevEntries.reduce((s, e) => s + e.closing, 0);
    const rows: { label: string; cVal: number; pVal: number | null; bold?: boolean }[] = sec.entries.map(e => ({ label: e.name, cVal: e.closing, pVal: null }));
    rows.push({ label: 'Subtotal', cVal: subtotal, pVal: hasPrev ? prevSubtotal : null, bold: true });

    autoTable(doc, {
      startY: y,
      head: hasPrev ? [['Instrument', `${fyShort} (${getCurrencyMeta(currency).pdfSymbol} ${unitSuffix(unit)})`, `${prevFyShort} (${getCurrencyMeta(currency).pdfSymbol} ${unitSuffix(unit)})`]] : [['Instrument', `Amount (${getCurrencyMeta(currency).pdfSymbol} ${unitSuffix(unit)})`]],
      body: rows.map(r => hasPrev ? [r.label, fn(r.cVal, 2, unit), r.pVal != null ? fn(r.pVal, 2, unit) : '—'] : [r.label, fn(r.cVal, 2, unit)]),
      ...PDF_TABLE_STYLES,
      styles: { ...PDF_TABLE_STYLES.styles, fontSize: 7.3, cellPadding: 1.9 },
      columnStyles: hasPrev ? { 1: { halign: 'right' }, 2: { halign: 'right' } } : { 1: { halign: 'right' } },
      didParseCell: (data) => {
        const r = rows[data.row.index];
        if (!r) return;
        if (r.bold) { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = [248, 250, 252]; }
        if (data.column.index === 1) data.cell.styles.textColor = toneColor(r.cVal);
      },
      margin: { left: MARGIN + 4, right: MARGIN },
    });
    y = pdfTableBottom(doc) + 7;
  });

  addPdfFooter(doc);
  return { doc, fyShort };
}

export function exportTreasuryPdf(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  const { doc, fyShort } = buildTreasuryPdf(bundle, companyName, unit, compare, currency);
  doc.save(`FinCommandPro_Treasury_${fyShort}.pdf`);
}
