'use client';

/**
 * Bespoke Balance Sheet Excel export — the full Schedule III statement with
 * Note-level breakdowns as real numbers with native Excel accounting
 * formats (see xlsx-kit.ts), matching the on-screen tab and PDF exactly.
 */
import * as XLSX from 'xlsx';
import type { ReportBundle } from '@/lib/dashboard/types';
import type { AggregatedNote } from '@/lib/financial/tb-engine';
import { resolvePeriod } from '@/lib/financial/tb-engine';
import { getFyLabel, getFyShortLabel, formatDate, cyYearFromFy, getUnitHeader, unitSuffix, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { ACC_FMT, PCT_FMT, DEFAULT_COMPANY_NAME, toUnit, buildSheet, buildInfoSheet, type SheetRow } from './xlsx-kit';

/** Same "as at" date logic as BalanceSheetTab.tsx / bs-pdf.ts. */
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

export function buildBsXlsx(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): { wb: XLSX.WorkBook; fyShort: string } {
  const wb = XLSX.utils.book_new();
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyFullLabel = getFyLabel(bundle.financial_year, yearType);
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  const { bs, prev_bs: prevBsRaw } = bundle;
  const prevBs = compare ? prevBsRaw : null;
  const eq = bs.equity_liabilities;
  const as = bs.assets;
  const prevEq = prevBs?.equity_liabilities;
  const prevAs = prevBs?.assets;
  const hasPrev = !!prevBs;
  const asAtDate = resolveAsAtDate(bundle.financial_year, yearType, bundle.period_params);
  const unitLabel = getUnitHeader(unit, currency);
  const sfx = unitSuffix(unit);
  const symbol = getCurrencyMeta(currency).symbol;

  // ── Sheet 1: Balance Sheet ──
  const stmt: SheetRow[] = [
    { cells: ['FinCommand Pro — Balance Sheet'] },
    { cells: [`${companyName}  |  ${fyFullLabel}  |  As at ${asAtDate}  |  Schedule III · IND AS  |  ${unitLabel}`] },
    { cells: [] },
  ];
  const headerRow: SheetRow = hasPrev
    ? { cells: ['Particulars', 'Note', `${fyShort} (${symbol}${sfx})`, `${getFyShortLabel(bundle.prev_financial_year, yearType)} (${symbol}${sfx})`, `YoY Change (${symbol}${sfx})`], bold: true }
    : { cells: ['Particulars', 'Note', `Amount (${symbol}${sfx})`], bold: true };
  stmt.push(headerRow);

  const pushNoteRows = (notes: AggregatedNote[], prevNotes?: AggregatedNote[]) => {
    if (!hasPrev) {
      notes.forEach(n => stmt.push({ cells: [n.note_name || `Note ${n.note_no}`, n.note_no, toUnit(n.total, unit)], formats: [null, null, ACC_FMT] }));
      return;
    }
    const allNos = Array.from(new Set([...notes.map(n => n.note_no), ...(prevNotes || []).map(n => n.note_no)])).sort((a, b) => a - b);
    allNos.forEach(no => {
      const c = notes.find(n => n.note_no === no);
      const p = (prevNotes || []).find(n => n.note_no === no);
      const cVal = c?.total ?? 0;
      const pVal = p?.total ?? 0;
      stmt.push({
        cells: [c?.note_name || p?.note_name || `Note ${no}`, no, toUnit(cVal, unit), toUnit(pVal, unit), toUnit(cVal - pVal, unit)],
        formats: [null, null, ACC_FMT, ACC_FMT, ACC_FMT],
      });
    });
  };
  const totalRow = (label: string, cVal: number, pVal?: number, bold = true): SheetRow =>
    hasPrev
      ? { cells: [label, '', toUnit(cVal, unit), toUnit(pVal ?? 0, unit), toUnit(cVal - (pVal ?? 0), unit)], formats: [null, null, ACC_FMT, ACC_FMT, ACC_FMT], bold }
      : { cells: [label, '', toUnit(cVal, unit)], formats: [null, null, ACC_FMT], bold };

  stmt.push({ cells: ['EQUITY & LIABILITIES'], bold: true });
  stmt.push(totalRow("Shareholders' Equity", eq.total_equity, prevEq?.total_equity));
  pushNoteRows(eq.equity, prevEq?.equity);
  stmt.push(totalRow('Non-Current Liabilities', eq.total_ncl, prevEq?.total_ncl));
  pushNoteRows(eq.non_current_liab, prevEq?.non_current_liab);
  stmt.push(totalRow('Current Liabilities', eq.total_cl, prevEq?.total_cl));
  pushNoteRows(eq.current_liab, prevEq?.current_liab);
  stmt.push(totalRow('TOTAL EQUITY & LIABILITIES', eq.total, prevEq?.total));
  stmt.push({ cells: [] });
  stmt.push({ cells: ['ASSETS'], bold: true });
  stmt.push(totalRow('Non-Current Assets', as.total_nca, prevAs?.total_nca));
  pushNoteRows(as.non_current, prevAs?.non_current);
  stmt.push(totalRow('Current Assets', as.total_ca, prevAs?.total_ca));
  pushNoteRows(as.current, prevAs?.current);
  stmt.push(totalRow('TOTAL ASSETS', as.total, prevAs?.total));
  stmt.push({ cells: [] });
  stmt.push({
    cells: [bs.balanced
      ? 'Audit Check: Balance Sheet tallies (Assets = Equity + Liabilities).'
      : `Audit Check: OUT OF BALANCE by ${symbol}${toUnit(bs.difference, unit).toFixed(2)}${sfx} — review ledger section mappings before circulating.`],
  });

  buildSheet(wb, 'Balance Sheet', stmt, hasPrev ? [34, 8, 15, 15, 15] : [34, 8, 16]);

  // ── Sheet 2: Year-on-Year ratios (if prior year available) ──
  if (hasPrev && prevBs) {
    const prevFyShort = getFyShortLabel(bundle.prev_financial_year, yearType);
    const yoy = (curr: number, prev: number) => (prev !== 0 ? (curr - prev) / Math.abs(prev) : null);
    const yoyRows: SheetRow[] = [
      { cells: ['FinCommand Pro — Balance Sheet Year-on-Year'] },
      { cells: [`${companyName}  |  ${fyShort} vs ${prevFyShort}  |  ${unitLabel}`] },
      { cells: [] },
      { cells: ['Metric', fyShort, prevFyShort, 'YoY %'], bold: true },
      ...([
        { label: 'Total Assets', curr: as.total, prev: prevAs!.total },
        { label: 'Total Equity', curr: eq.total_equity, prev: prevEq!.total_equity },
        { label: 'Non-Current Liabilities', curr: eq.total_ncl, prev: prevEq!.total_ncl },
        { label: 'Current Liabilities', curr: eq.total_cl, prev: prevEq!.total_cl },
        { label: 'Non-Current Assets', curr: as.total_nca, prev: prevAs!.total_nca },
        { label: 'Current Assets', curr: as.total_ca, prev: prevAs!.total_ca },
        { label: 'Net Working Capital (CA − CL)', curr: as.total_ca - eq.total_cl, prev: prevAs!.total_ca - prevEq!.total_cl },
      ].map((r): SheetRow => ({
        cells: [r.label, toUnit(r.curr, unit), toUnit(r.prev, unit), yoy(r.curr, r.prev)],
        formats: [null, ACC_FMT, ACC_FMT, PCT_FMT],
      }))),
    ];
    buildSheet(wb, 'YoY Comparison', yoyRows, [30, 14, 14, 12]);
  }

  buildInfoSheet(wb, { companyName, fyFullLabel, yearType, periodLabel: bundle.period_label, generatedAt: formatDate(bundle.generated_at) });

  return { wb, fyShort };
}

export function exportBsXlsx(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  const { wb, fyShort } = buildBsXlsx(bundle, companyName, unit, compare, currency);
  XLSX.writeFile(wb, `FinCommandPro_BalanceSheet_${fyShort}.xlsx`);
}
