'use client';

/**
 * Bespoke, purpose-built PDF for the Notes to Accounts tab — KPI cards, a
 * Note Index summary table (like a real audited financial statement's
 * "Notes forming part of the accounts" contents page), then full
 * ledger-level detail for every note, color-coded and paginated properly.
 * Deliberately separate from lib/exports/pdf.ts's generic per-section table
 * exporter (used for every tab without a bespoke layout). Unlike Overview/
 * Cash Flow/MIS/P&L, this tab is inherently a detailed ledger schedule, not
 * a KPI-summary statement — real audited "Notes" sections are pure tabular
 * detail, so there's no native chart here by design.
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { ReportBundle } from '@/lib/dashboard/types';
import type { AggregatedNote } from '@/lib/financial/tb-engine';
import { fn, fcPdf, getFyLabel, getFyShortLabel, getUnitHeaderPdf, unitSuffix, formatChg, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import {
  NAVY, NAVY_DARK, SLATE, BORDER, PAGE_W, MARGIN, CONTENT_W, DEFAULT_COMPANY_NAME,
  toneColor, addPdfHeader, addPdfFooter, drawKpiCards, pdfSectionTitle, pdfTableBottom, PDF_TABLE_STYLES,
} from './pdf-kit';

const isBSSection = (sec?: string | null) => ['anc', 'ac', 'eq', 'lnc', 'lc'].includes(sec || '');
const noteKey = (n: AggregatedNote) => `${isBSSection(n.section) ? 'bs' : 'pl'}_${n.note_no}`;

export function buildNotesPdf(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): { doc: jsPDF; fyShort: string } {
  const doc = new jsPDF();
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyLabel = getFyLabel(bundle.financial_year, yearType);
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  const prevFyShort = getFyShortLabel(bundle.prev_financial_year, yearType);
  const notes = bundle.notes || [];
  const prevNotes = compare ? (bundle.prev_notes || []) : [];
  const hasPrev = !!(prevNotes.length > 0 && bundle.prev_financial_year);

  const allKeys = Array.from(new Set([...notes.map(noteKey), ...prevNotes.map(noteKey)]));
  const combined = allKeys.map(key => {
    const curr = notes.find(n => noteKey(n) === key);
    const prev = prevNotes.find(n => noteKey(n) === key);
    return { key, noteNo: curr?.note_no ?? prev?.note_no ?? 0, curr, prev };
  }).sort((a, b) => a.noteNo - b.noteNo);

  const eqLiabTotal = notes.filter(n => ['eq', 'lnc', 'lc'].includes(n.section || '')).reduce((s, n) => s + n.total, 0);
  const assetsTotal = notes.filter(n => ['anc', 'ac'].includes(n.section || '')).reduce((s, n) => s + n.total, 0);
  const plTotal = notes.filter(n => ['inc', 'exp'].includes(n.section || '')).reduce((s, n) => s + Math.abs(n.total), 0);

  const header = () => addPdfHeader(doc, companyName, 'Notes to Accounts · Schedule III, IND AS', fyLabel, bundle.period_label);
  header();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...NAVY_DARK);
  doc.text('Notes to Accounts', MARGIN, 36);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...SLATE);
  doc.text(`Notes forming part of the Financial Statements · ${getUnitHeaderPdf(unit, currency)} unless noted`, MARGIN, 41.5);
  doc.setDrawColor(...BORDER);
  doc.line(MARGIN, 44, PAGE_W - MARGIN, 44);

  let y = drawKpiCards(doc, [
    { label: 'Total Notes', value: String(combined.length), sub: `${combined.filter(c => isBSSection(c.curr?.section || c.prev?.section)).length} Balance Sheet, ${combined.length - combined.filter(c => isBSSection(c.curr?.section || c.prev?.section)).length} P&L`, tone: 0 },
    { label: 'Equity & Liabilities Notes', value: fcPdf(eqLiabTotal, currency), sub: 'Notes 1-19 range', tone: 0 },
    { label: 'Assets Notes', value: fcPdf(assetsTotal, currency), sub: 'Non-current + Current', tone: 0 },
    { label: 'Income & Expense Notes', value: fcPdf(plTotal, currency), sub: 'Notes 20-26 range', tone: 0 },
  ], 49);

  y += 8;

  // ── Note Index (contents page) ──
  y = pdfSectionTitle(doc, 'Note Index', y, hasPrev ? `vs ${prevFyShort}` : getUnitHeaderPdf(unit, currency));
  const idxHead = hasPrev
    ? [['Note', 'Description', 'Section', `${fyShort} (${getCurrencyMeta(currency).pdfSymbol} ${unitSuffix(unit)})`, `${prevFyShort} (${getCurrencyMeta(currency).pdfSymbol} ${unitSuffix(unit)})`, 'YoY']]
    : [['Note', 'Description', 'Section', `Amount (${getCurrencyMeta(currency).pdfSymbol} ${unitSuffix(unit)})`]];
  const SECTION_LABEL: Record<string, string> = { eq: 'Equity', lnc: 'Non-Curr. Liab.', lc: 'Curr. Liab.', anc: 'Non-Curr. Assets', ac: 'Curr. Assets', inc: 'Income', exp: 'Expense' };
  autoTable(doc, {
    startY: y,
    head: idxHead,
    body: combined.map(c => {
      const sec = c.curr?.section || c.prev?.section || '';
      const name = c.curr?.note_name || c.prev?.note_name || `Note ${c.noteNo}`;
      const cVal = c.curr?.total ?? 0;
      const pVal = c.prev?.total ?? 0;
      const row = [String(c.noteNo), name, SECTION_LABEL[sec] || sec, fn(cVal, 2, unit)];
      if (!hasPrev) return row;
      const chg = cVal - pVal;
      return [...row.slice(0, 3), fn(cVal, 2, unit), fn(pVal, 2, unit), formatChg(chg, 2, unit)];
    }),
    ...PDF_TABLE_STYLES,
    styles: { ...PDF_TABLE_STYLES.styles, fontSize: 7.3 },
    columnStyles: hasPrev
      ? { 0: { cellWidth: 12 }, 2: { cellWidth: 24 }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } }
      : { 0: { cellWidth: 12 }, 2: { cellWidth: 24 }, 3: { halign: 'right' } },
  });
  y = pdfTableBottom(doc) + 8;

  // ── Per-note ledger detail ──
  combined.forEach(c => {
    if (y > 250) { doc.addPage(); header(); y = 32; }
    const name = c.curr?.note_name || c.prev?.note_name || `Note ${c.noteNo}`;
    y = pdfSectionTitle(doc, `Note ${c.noteNo} — ${name}`, y);

    const currLedgers = c.curr?.ledgers || [];
    const prevLedgers = c.prev?.ledgers || [];

    interface LRow { name: string; cNet: number; pNet: number | null; }
    let ledgerRows: LRow[];
    if (!hasPrev || !c.prev) {
      ledgerRows = currLedgers.map(l => ({ name: l.ledger_name, cNet: l.net, pNet: null }));
    } else {
      const seen = new Set<string>();
      ledgerRows = [];
      currLedgers.forEach(l => {
        const match = prevLedgers.find(p => (l.ledger_code && p.ledger_code === l.ledger_code) || p.ledger_name.toLowerCase() === l.ledger_name.toLowerCase());
        seen.add(l.ledger_code ? `code_${l.ledger_code}` : `name_${l.ledger_name.toLowerCase()}`);
        ledgerRows.push({ name: l.ledger_name, cNet: l.net, pNet: match?.net ?? 0 });
      });
      prevLedgers.forEach(p => {
        const key = p.ledger_code ? `code_${p.ledger_code}` : `name_${p.ledger_name.toLowerCase()}`;
        if (!seen.has(key)) ledgerRows.push({ name: p.ledger_name, cNet: 0, pNet: p.net });
      });
    }

    const cTotal = c.curr?.total ?? 0;
    const pTotal = c.prev?.total ?? 0;
    const rows: { label: string; cVal: number; pVal: number | null; bold?: boolean }[] = [
      ...ledgerRows.map(l => ({ label: l.name, cVal: l.cNet, pVal: l.pNet })),
      { label: 'Total', cVal: cTotal, pVal: hasPrev ? pTotal : null, bold: true },
    ];

    autoTable(doc, {
      startY: y,
      head: hasPrev ? [['Ledger', `${fyShort} (${getCurrencyMeta(currency).pdfSymbol} ${unitSuffix(unit)})`, `${prevFyShort} (${getCurrencyMeta(currency).pdfSymbol} ${unitSuffix(unit)})`, 'YoY']] : [['Ledger', `Amount (${getCurrencyMeta(currency).pdfSymbol} ${unitSuffix(unit)})`]],
      body: rows.map(r => {
        if (!hasPrev) return [r.label, fn(r.cVal, 2, unit)];
        const chg = r.pVal != null ? r.cVal - r.pVal : null;
        return [r.label, fn(r.cVal, 2, unit), r.pVal != null ? fn(r.pVal, 2, unit) : '—', chg != null ? formatChg(chg, 2, unit) : '—'];
      }),
      ...PDF_TABLE_STYLES,
      styles: { ...PDF_TABLE_STYLES.styles, fontSize: 7, cellPadding: 1.8 },
      columnStyles: hasPrev
        ? { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } }
        : { 1: { halign: 'right' } },
      didParseCell: (data) => {
        const r = rows[data.row.index];
        if (!r) return;
        if (r.bold) { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = [248, 250, 252]; }
        if (data.column.index === 1) data.cell.styles.textColor = toneColor(r.cVal);
        if (hasPrev && data.column.index === 3 && r.pVal != null) data.cell.styles.textColor = toneColor(r.cVal - r.pVal);
      },
      margin: { left: MARGIN + 4, right: MARGIN },
    });
    y = pdfTableBottom(doc) + 7;
  });

  addPdfFooter(doc);
  return { doc, fyShort };
}

export function exportNotesPdf(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  const { doc, fyShort } = buildNotesPdf(bundle, companyName, unit, compare, currency);
  doc.save(`FinCommandPro_NotesToAccounts_${fyShort}.pdf`);
}
