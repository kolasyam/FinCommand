'use client';

/**
 * Bespoke Executive Overview Excel export — see xlsx-kit.ts for the shared
 * real-numbers-with-native-accounting-format approach used here.
 */
import * as XLSX from 'xlsx';
import type { ReportBundle } from '@/lib/dashboard/types';
import { getFyLabel, getFyShortLabel, formatDate, getUnitHeader, unitSuffix, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { ACC_FMT, PCT_FMT, DEFAULT_COMPANY_NAME, toUnit, buildSheet, buildInfoSheet, type SheetRow } from './xlsx-kit';

/**
 * Builds the workbook without triggering a browser download — kept
 * testable/reusable independent of XLSX.writeFile's DOM-dependent save
 * mechanism. `unit` and `compare` mirror the on-screen tab's current
 * Display Unit selector and comparison state at download time.
 */
export function buildOverviewXlsx(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): { wb: XLSX.WorkBook; fyShort: string } {
  const wb = XLSX.utils.book_new();
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyFullLabel = getFyLabel(bundle.financial_year, yearType);
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  const { mis, top_customers, prev_mis } = bundle;
  const t = mis.totals;
  const grossProfit = t.rev - t.cos;
  const unitLabel = getUnitHeader(unit, currency);
  const sfx = unitSuffix(unit);
  const symbol = getCurrencyMeta(currency).symbol;

  // ── Sheet 1: Executive Summary ──
  const summary: SheetRow[] = [
    { cells: ['FinCommand Pro — Executive Overview'] },
    { cells: [`${companyName}  |  ${fyFullLabel}  |  ${bundle.period_label}  |  ${unitLabel}`] },
    { cells: [] },
    { cells: ['KEY PERFORMANCE INDICATORS'], bold: true },
    { cells: ['Metric', `Value (${symbol}${sfx})`, '% of Revenue'], bold: true },
    { cells: ['Revenue', toUnit(t.rev, unit), 1], formats: [null, ACC_FMT, PCT_FMT] },
    { cells: ['Gross Profit', toUnit(grossProfit, unit), t.gm / 100], formats: [null, ACC_FMT, PCT_FMT] },
    { cells: ['EBITDA (Operating)', toUnit(t.ebitda, unit), t.em / 100], formats: [null, ACC_FMT, PCT_FMT], bold: true },
    { cells: ['Profit Before Tax', toUnit(t.pbt, unit), t.rev > 0 ? t.pbt / t.rev : null], formats: [null, ACC_FMT, PCT_FMT] },
    { cells: ['Profit After Tax', toUnit(t.pat, unit), t.pm / 100], formats: [null, ACC_FMT, PCT_FMT], bold: true },
    { cells: ['Employee Cost', toUnit(t.emp, unit), t.rev > 0 ? t.emp / t.rev : null], formats: [null, ACC_FMT, PCT_FMT] },
    { cells: [] },
  ];

  if (top_customers && top_customers.length) {
    summary.push(
      { cells: ['TOP 5 CUSTOMERS BY REVENUE'], bold: true },
      { cells: ['Customer', `Revenue (${symbol} Cr)`, '% of Revenue', 'Status'], bold: true },
      ...top_customers.map((c): SheetRow => ({
        cells: [c.customer, c.revenue_cr, c.pct_of_total / 100, c.status],
        formats: [null, '#,##0.00', PCT_FMT, null],
      })),
      { cells: [] },
    );
  }

  if (prev_mis && compare) {
    const prevT = prev_mis.totals;
    const prevFyShort = getFyShortLabel(bundle.prev_financial_year, yearType);
    const yoy = (curr: number, prev: number) => (prev !== 0 ? (curr - prev) / Math.abs(prev) : null);
    summary.push(
      { cells: [`YEAR-ON-YEAR — ${fyShort} vs ${prevFyShort}`], bold: true },
      { cells: ['Metric', fyShort, prevFyShort, 'YoY %'], bold: true },
      { cells: ['Revenue', toUnit(t.rev, unit), toUnit(prevT.rev, unit), yoy(t.rev, prevT.rev)], formats: [null, ACC_FMT, ACC_FMT, PCT_FMT] },
      { cells: ['EBITDA', toUnit(t.ebitda, unit), toUnit(prevT.ebitda, unit), yoy(t.ebitda, prevT.ebitda)], formats: [null, ACC_FMT, ACC_FMT, PCT_FMT] },
      { cells: ['PAT', toUnit(t.pat, unit), toUnit(prevT.pat, unit), yoy(t.pat, prevT.pat)], formats: [null, ACC_FMT, ACC_FMT, PCT_FMT], bold: true },
      { cells: ['Employee Cost', toUnit(t.emp, unit), toUnit(prevT.emp, unit), yoy(t.emp, prevT.emp)], formats: [null, ACC_FMT, ACC_FMT, PCT_FMT] },
    );
  }

  buildSheet(wb, 'Executive Summary', summary, [26, 16, 14, 16]);

  // ── Sheet 2: Monthly / Period Trend (feeds a user's own Excel chart) ──
  const trend: SheetRow[] = [
    { cells: ['Monthly Trend', ...mis.columns], bold: true },
    { cells: ['Revenue', ...mis.data.map(d => toUnit(d.rev, unit))], formats: [null, ...mis.data.map(() => ACC_FMT)] },
    { cells: ['Gross Profit', ...mis.data.map(d => toUnit(d.rev - d.cos, unit))], formats: [null, ...mis.data.map(() => ACC_FMT)] },
    { cells: ['EBITDA', ...mis.data.map(d => toUnit(d.ebitda, unit))], formats: [null, ...mis.data.map(() => ACC_FMT)] },
    { cells: ['PAT', ...mis.data.map(d => toUnit(d.pat, unit))], formats: [null, ...mis.data.map(() => ACC_FMT)] },
    { cells: ['Gross Margin %', ...mis.data.map(d => d.gm / 100)], formats: [null, ...mis.data.map(() => PCT_FMT)] },
    { cells: ['EBITDA Margin %', ...mis.data.map(d => d.em / 100)], formats: [null, ...mis.data.map(() => PCT_FMT)] },
    { cells: ['PAT Margin %', ...mis.data.map(d => d.pm / 100)], formats: [null, ...mis.data.map(() => PCT_FMT)] },
  ];
  buildSheet(wb, 'Monthly Trend', trend, [18, ...mis.columns.map(() => 11)]);

  buildInfoSheet(wb, { companyName, fyFullLabel, yearType, periodLabel: bundle.period_label, generatedAt: formatDate(bundle.generated_at) });

  return { wb, fyShort };
}

export function exportOverviewXlsx(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  const { wb, fyShort } = buildOverviewXlsx(bundle, companyName, unit, compare, currency);
  XLSX.writeFile(wb, `FinCommandPro_ExecutiveOverview_${fyShort}.xlsx`);
}
