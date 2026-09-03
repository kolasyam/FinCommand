'use client';

/**
 * Bespoke MIS Report Excel export — the full Particulars × Months + Total
 * matrix as real numbers with native Excel accounting formats (see
 * xlsx-kit.ts), matching the on-screen tab and PDF exactly.
 */
import * as XLSX from 'xlsx';
import type { ReportBundle } from '@/lib/dashboard/types';
import type { MISColumn } from '@/lib/financial/tb-engine';
import { getFyLabel, getFyShortLabel, formatDate, getUnitHeader, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { ACC_FMT, PCT_FMT, DEFAULT_COMPANY_NAME, toUnit, buildSheet, buildInfoSheet, type SheetRow } from './xlsx-kit';

/** `unit` and `compare` mirror the on-screen tab's current Display Unit selector and "Compare with prior year" toggle — a downloaded report shows exactly what the tab showed at the moment it was downloaded, not always ₹ Lakhs / always-on comparison regardless of what the user picked. */
export function buildMisXlsx(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): { wb: XLSX.WorkBook; fyShort: string } {
  const wb = XLSX.utils.book_new();
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyFullLabel = getFyLabel(bundle.financial_year, yearType);
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  const { mis, prev_mis: prevMis } = bundle;
  const t = mis.totals;
  const unitLabel = getUnitHeader(unit, currency);

  // ── Sheet 1: Monthly MIS — P&L ──
  interface RowDef { label: string; key: keyof MISColumn; bold?: boolean; pctRow?: boolean; }
  const rowDefs: RowDef[] = [
    { label: 'Revenue from Operations', key: 'rev', bold: true },
    { label: 'Other Income', key: 'oth' },
    { label: 'Total Income', key: 'totInc', bold: true },
    { label: 'Cost of Services', key: 'cos' },
    { label: 'Employee Benefits', key: 'emp' },
    { label: 'Other Expenses', key: 'oex' },
    { label: 'EBITDA (Operating)', key: 'ebitda', bold: true },
    { label: 'Finance Costs', key: 'fin' },
    { label: 'Depreciation & Amortisation', key: 'dep' },
    { label: 'Total Expenses', key: 'totExp', bold: true },
    { label: 'Profit Before Tax', key: 'pbt', bold: true },
    { label: 'Tax (25%, estimated)', key: 'tax' },
    { label: 'Profit After Tax', key: 'pat', bold: true },
  ];
  const marginDefs: RowDef[] = [
    { label: 'Gross Margin %', key: 'gm', pctRow: true },
    { label: 'EBITDA Margin %', key: 'em', pctRow: true },
    { label: 'PAT Margin %', key: 'pm', pctRow: true },
  ];

  const monthFmts = mis.columns.map(() => ACC_FMT);
  const stmt: SheetRow[] = [
    { cells: ['FinCommand Pro — MIS Report'] },
    { cells: [`${companyName}  |  ${fyFullLabel}  |  ${bundle.period_label}  |  ${unitLabel}`] },
    { cells: [] },
    { cells: ['Particulars', ...mis.columns, 'Total'], bold: true },
    ...rowDefs.map((r): SheetRow => ({
      cells: [r.label, ...mis.data.map(d => toUnit(d[r.key] as number, unit)), toUnit(t[r.key] as number, unit)],
      formats: [null, ...monthFmts, ACC_FMT],
      bold: r.bold,
    })),
    { cells: [] },
    ...marginDefs.map((r): SheetRow => ({
      cells: [r.label, ...mis.data.map(d => (d[r.key] as number) / 100), (t[r.key] as number) / 100],
      formats: [null, ...mis.columns.map(() => PCT_FMT), PCT_FMT],
    })),
    { cells: [] },
    { cells: ['Tax is estimated at a flat 25% of Profit Before Tax in a profitable month — this Trial Balance carries no dedicated tax-provision ledger to derive a real cash-tax figure from — and nil in a loss-making month (PBT ≤ 0), per IND AS 12, since no company owes current tax on a loss. Every other line above is computed directly from real Trial Balance ledger movements for the period shown.'] },
  ];
  buildSheet(wb, 'MIS Report', stmt, [26, ...mis.columns.map(() => 11), 13]);

  // ── Sheet 2: Year-on-Year (if prior year available) ──
  if (prevMis && compare) {
    const prevT = prevMis.totals;
    const prevFyShort = getFyShortLabel(bundle.prev_financial_year, yearType);
    const yoy = (curr: number, prev: number) => (prev !== 0 ? (curr - prev) / Math.abs(prev) : null);

    const yoyRows: SheetRow[] = [
      { cells: ['FinCommand Pro — MIS Year-on-Year'] },
      { cells: [`${companyName}  |  ${fyShort} vs ${prevFyShort}  |  ${unitLabel}`] },
      { cells: [] },
      { cells: ['Metric', fyShort, prevFyShort, 'YoY %'], bold: true },
      ...([
        { label: 'Revenue', curr: t.rev, prev: prevT.rev },
        { label: 'Total Income', curr: t.totInc, prev: prevT.totInc },
        { label: 'EBITDA (Operating)', curr: t.ebitda, prev: prevT.ebitda },
        { label: 'Profit Before Tax', curr: t.pbt, prev: prevT.pbt },
        { label: 'Profit After Tax', curr: t.pat, prev: prevT.pat },
        { label: 'Employee Cost', curr: t.emp, prev: prevT.emp },
      ].map((r): SheetRow => ({
        cells: [r.label, toUnit(r.curr, unit), toUnit(r.prev, unit), yoy(r.curr, r.prev)],
        formats: [null, ACC_FMT, ACC_FMT, PCT_FMT],
      }))),
      { cells: [] },
      { cells: ['Margin', fyShort, prevFyShort, 'Change (pp)'], bold: true },
      ...([
        { label: 'Gross Margin %', curr: t.gm, prev: prevT.gm },
        { label: 'EBITDA Margin %', curr: t.em, prev: prevT.em },
        { label: 'PAT Margin %', curr: t.pm, prev: prevT.pm },
      ].map((r): SheetRow => ({
        cells: [r.label, r.curr / 100, r.prev / 100, (r.curr - r.prev) / 100],
        formats: [null, PCT_FMT, PCT_FMT, PCT_FMT],
      }))),
    ];
    buildSheet(wb, 'YoY Comparison', yoyRows, [24, 14, 14, 14]);
  }

  buildInfoSheet(wb, { companyName, fyFullLabel, yearType, periodLabel: bundle.period_label, generatedAt: formatDate(bundle.generated_at) });

  return { wb, fyShort };
}

export function exportMisXlsx(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  const { wb, fyShort } = buildMisXlsx(bundle, companyName, unit, compare, currency);
  XLSX.writeFile(wb, `FinCommandPro_MIS_${fyShort}.xlsx`);
}
