'use client';

/**
 * Bespoke Notes to Accounts Excel export — a Note Index summary sheet plus
 * full ledger-level detail for every note, as real numbers with native
 * Excel accounting formats (see xlsx-kit.ts), matching the on-screen tab
 * and PDF exactly.
 */
import * as XLSX from 'xlsx';
import type { ReportBundle } from '@/lib/dashboard/types';
import type { AggregatedNote } from '@/lib/financial/tb-engine';
import { getFyLabel, getFyShortLabel, formatDate, getUnitHeader, unitSuffix, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { ACC_FMT, PCT_FMT, DEFAULT_COMPANY_NAME, toUnit, buildSheet, buildInfoSheet, type SheetRow } from './xlsx-kit';

const isBSSection = (sec?: string | null) => ['anc', 'ac', 'eq', 'lnc', 'lc'].includes(sec || '');
const noteKey = (n: AggregatedNote) => `${isBSSection(n.section) ? 'bs' : 'pl'}_${n.note_no}`;
const SECTION_LABEL: Record<string, string> = { eq: 'Equity', lnc: 'Non-Current Liabilities', lc: 'Current Liabilities', anc: 'Non-Current Assets', ac: 'Current Assets', inc: 'Income', exp: 'Expense' };

export function buildNotesXlsx(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): { wb: XLSX.WorkBook; fyShort: string } {
  const wb = XLSX.utils.book_new();
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyFullLabel = getFyLabel(bundle.financial_year, yearType);
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  const prevFyShort = getFyShortLabel(bundle.prev_financial_year, yearType);
  const notes = bundle.notes || [];
  const prevNotes = compare ? (bundle.prev_notes || []) : [];
  const hasPrev = !!(prevNotes.length > 0 && bundle.prev_financial_year && compare);
  const unitLabel = getUnitHeader(unit, currency);
  const sfx = unitSuffix(unit);
  const symbol = getCurrencyMeta(currency).symbol;

  const allKeys = Array.from(new Set([...notes.map(noteKey), ...prevNotes.map(noteKey)]));
  const combined = allKeys.map(key => {
    const curr = notes.find(n => noteKey(n) === key);
    const prev = prevNotes.find(n => noteKey(n) === key);
    return { key, noteNo: curr?.note_no ?? prev?.note_no ?? 0, curr, prev };
  }).sort((a, b) => a.noteNo - b.noteNo);

  // ── Sheet 1: Note Index ──
  const idx: SheetRow[] = [
    { cells: ['FinCommand Pro — Notes to Accounts — Index'] },
    { cells: [`${companyName}  |  ${fyFullLabel}  |  ${bundle.period_label}  |  Schedule III · IND AS  |  ${unitLabel}`] },
    { cells: [] },
    hasPrev
      ? { cells: ['Note', 'Description', 'Section', `${fyShort} (${symbol}${sfx})`, `${prevFyShort} (${symbol}${sfx})`, 'YoY %'], bold: true }
      : { cells: ['Note', 'Description', 'Section', `Amount (${symbol}${sfx})`], bold: true },
    ...combined.map((c): SheetRow => {
      const sec = c.curr?.section || c.prev?.section || '';
      const name = c.curr?.note_name || c.prev?.note_name || `Note ${c.noteNo}`;
      const cVal = c.curr?.total ?? 0;
      const pVal = c.prev?.total ?? 0;
      if (!hasPrev) return { cells: [c.noteNo, name, SECTION_LABEL[sec] || sec, toUnit(cVal, unit)], formats: [null, null, null, ACC_FMT] };
      const yoy = pVal !== 0 ? (cVal - pVal) / Math.abs(pVal) : null;
      return { cells: [c.noteNo, name, SECTION_LABEL[sec] || sec, toUnit(cVal, unit), toUnit(pVal, unit), yoy], formats: [null, null, null, ACC_FMT, ACC_FMT, PCT_FMT] };
    }),
  ];
  buildSheet(wb, 'Note Index', idx, hasPrev ? [8, 34, 18, 14, 14, 10] : [8, 34, 18, 14]);

  // ── Sheet 2: Notes Detail (every note's ledger-level breakdown, sequentially) ──
  const detail: SheetRow[] = [
    { cells: ['FinCommand Pro — Notes to Accounts — Detail'] },
    { cells: [`${companyName}  |  ${fyFullLabel}  |  ${unitLabel}`] },
    { cells: [] },
  ];
  combined.forEach(c => {
    const name = c.curr?.note_name || c.prev?.note_name || `Note ${c.noteNo}`;
    detail.push({ cells: [`Note ${c.noteNo} — ${name}`], bold: true });
    detail.push(hasPrev
      ? { cells: ['Ledger', `${fyShort} (${symbol}${sfx})`, `${prevFyShort} (${symbol}${sfx})`, `YoY (${symbol}${sfx})`], bold: true }
      : { cells: ['Ledger', `Amount (${symbol}${sfx})`], bold: true });

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

    ledgerRows.forEach(l => {
      if (!hasPrev) { detail.push({ cells: [l.name, toUnit(l.cNet, unit)], formats: [null, ACC_FMT] }); return; }
      const chg = l.pNet != null ? l.cNet - l.pNet : null;
      detail.push({ cells: [l.name, toUnit(l.cNet, unit), l.pNet != null ? toUnit(l.pNet, unit) : null, chg != null ? toUnit(chg, unit) : null], formats: [null, ACC_FMT, ACC_FMT, ACC_FMT] });
    });

    const cTotal = c.curr?.total ?? 0;
    const pTotal = c.prev?.total ?? 0;
    detail.push(hasPrev
      ? { cells: ['Total', toUnit(cTotal, unit), toUnit(pTotal, unit), toUnit(cTotal - pTotal, unit)], formats: [null, ACC_FMT, ACC_FMT, ACC_FMT], bold: true }
      : { cells: ['Total', toUnit(cTotal, unit)], formats: [null, ACC_FMT], bold: true });
    detail.push({ cells: [] });
  });
  buildSheet(wb, 'Notes Detail', detail, hasPrev ? [40, 15, 15, 15] : [40, 16]);

  buildInfoSheet(wb, { companyName, fyFullLabel, yearType, periodLabel: bundle.period_label, generatedAt: formatDate(bundle.generated_at) });

  return { wb, fyShort };
}

export function exportNotesXlsx(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  const { wb, fyShort } = buildNotesXlsx(bundle, companyName, unit, compare, currency);
  XLSX.writeFile(wb, `FinCommandPro_NotesToAccounts_${fyShort}.xlsx`);
}
