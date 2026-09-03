'use client';

/**
 * Bespoke P&L Excel export — the full Schedule III statement as real
 * numbers with native Excel accounting formats (see xlsx-kit.ts), matching
 * the on-screen tab and PDF exactly, including "n/a" (not a formula) for
 * OCI/EPS where a Trial Balance genuinely can't support them.
 */
import * as XLSX from 'xlsx';
import type { ReportBundle } from '@/lib/dashboard/types';
import { getFyLabel, getFyShortLabel, formatDate, getUnitHeader, unitSuffix, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { ACC_FMT, PCT_FMT, DEFAULT_COMPANY_NAME, toUnit, buildSheet, buildInfoSheet, type SheetRow } from './xlsx-kit';

export function buildPlXlsx(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): { wb: XLSX.WorkBook; fyShort: string } {
  const wb = XLSX.utils.book_new();
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyFullLabel = getFyLabel(bundle.financial_year, yearType);
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  const { pl, prev_pl: prevPlRaw } = bundle;
  const prevPl = compare ? prevPlRaw : null;
  const hasPrev = !!prevPl;
  const unitLabel = getUnitHeader(unit, currency);
  const sfx = unitSuffix(unit);
  const symbol = getCurrencyMeta(currency).symbol;

  // `raw` = true for EPS: not a ₹-Lakhs table amount, so no toUnit(, unit) division.
  const row = (label: string, noteNo: number | string, cVal: number | null, pVal?: number | null, raw = false): SheetRow => {
    const c = cVal == null ? 'n/a' : (raw ? cVal : toUnit(cVal, unit));
    if (!hasPrev) return { cells: [label, noteNo, c], formats: [null, null, cVal == null ? null : ACC_FMT] };
    const p = pVal == null ? 'n/a' : (raw ? pVal : toUnit(pVal, unit));
    const chg = cVal != null && pVal != null ? (raw ? cVal - pVal : toUnit(cVal - pVal, unit)) : 'n/a';
    return { cells: [label, noteNo, c, p, chg], formats: [null, null, cVal == null ? null : ACC_FMT, pVal == null ? null : ACC_FMT, (cVal == null || pVal == null) ? null : ACC_FMT] };
  };
  const totalRow = (label: string, cVal: number | null, pVal?: number | null): SheetRow => ({ ...row(label, '', cVal, pVal), bold: true });

  const stmt: SheetRow[] = [
    { cells: ['FinCommand Pro — Statement of Profit & Loss'] },
    { cells: [`${companyName}  |  ${fyFullLabel}  |  ${bundle.period_label}  |  Schedule III · IND AS  |  ${unitLabel}`] },
    { cells: [] },
    hasPrev
      ? { cells: ['Particulars', 'Note', `${fyShort} (${symbol}${sfx})`, `${getFyShortLabel(bundle.prev_financial_year, yearType)} (${symbol}${sfx})`, `YoY Change (${symbol}${sfx})`], bold: true }
      : { cells: ['Particulars', 'Note', `Amount (${symbol}${sfx})`], bold: true },
    { cells: ['I. INCOME'], bold: true },
    row('Revenue from Operations', 20, pl.revenue, prevPl?.revenue),
    row('Other Income', 21, pl.other_income, prevPl?.other_income),
    totalRow('Total Income (I)', pl.total_income, prevPl?.total_income),
    { cells: [] },
    { cells: ['II. EXPENSES'], bold: true },
    row('Cost of Services / Materials Consumed', 22, pl.cos, prevPl?.cos),
    row('Employee Benefits Expense', 23, pl.employee_benefits, prevPl?.employee_benefits),
    row('Finance Costs', 24, pl.finance_costs, prevPl?.finance_costs),
    row('Depreciation & Amortisation', 25, pl.depreciation, prevPl?.depreciation),
    row('Other Expenses', 26, pl.other_expenses, prevPl?.other_expenses),
    totalRow('Total Expenses (II)', pl.total_expenses, prevPl?.total_expenses),
    { cells: [] },
    { cells: ['III. PROFIT'], bold: true },
    totalRow('Profit Before Tax (I - II)', pl.pbt, prevPl?.pbt),
    row('Current Tax (25%, estimated)', '', pl.current_tax, prevPl?.current_tax),
    row('Deferred Tax Charge / (Credit) (1%, estimated)', '', pl.deferred_tax, prevPl?.deferred_tax),
    totalRow('Profit After Tax (PAT)', pl.pat, prevPl?.pat),
    { cells: [] },
    { cells: ['IV. OTHER COMPREHENSIVE INCOME (IND AS 1)'], bold: true },
    row('Remeasurement of Defined Benefit Obligation', '', pl.oci_gross, prevPl?.oci_gross),
    row('Income Tax on OCI', '', pl.oci_tax, prevPl?.oci_tax),
    totalRow('Other Comprehensive Income (Net of Tax)', pl.oci_net, prevPl?.oci_net),
    totalRow('Total Comprehensive Income', pl.total_comprehensive_income, prevPl?.total_comprehensive_income),
    { cells: [] },
    { cells: ['V. EARNINGS PER SHARE (IND AS 33)'], bold: true },
    row(`Basic EPS (${symbol})`, '', pl.eps_basic, prevPl?.eps_basic, true),
    row(`Diluted EPS (${symbol})`, '', pl.eps_diluted, prevPl?.eps_diluted, true),
    { cells: [] },
    { cells: ['Every line above Section IV is computed directly from real Trial Balance ledger movements — no assumed percentages, except Current Tax and Deferred Tax, modeled at a flat rate on a profitable period since this Trial Balance carries no dedicated tax-provision ledger — and nil in a loss-making period (PBT ≤ 0), per IND AS 12, since no company owes current tax on a loss. Other Comprehensive Income and EPS are marked "n/a" rather than estimated: OCI requires an actuarial valuation and EPS requires the real face value per share and shares outstanding from the Register of Members — neither is derivable from ledger balances alone.'] },
  ];

  buildSheet(wb, 'Profit & Loss', stmt, hasPrev ? [40, 8, 15, 15, 15] : [40, 8, 16]);

  // ── Sheet 2: Year-on-Year (if prior year available) ──
  if (hasPrev && prevPl) {
    const prevFyShort = getFyShortLabel(bundle.prev_financial_year, yearType);
    const yoy = (curr: number, prev: number) => (prev !== 0 ? (curr - prev) / Math.abs(prev) : null);
    const yoyRows: SheetRow[] = [
      { cells: ['FinCommand Pro — P&L Year-on-Year'] },
      { cells: [`${companyName}  |  ${fyShort} vs ${prevFyShort}  |  ${unitLabel}`] },
      { cells: [] },
      { cells: ['Metric', fyShort, prevFyShort, 'YoY %'], bold: true },
      ...([
        { label: 'Revenue from Operations', curr: pl.revenue, prev: prevPl.revenue },
        { label: 'Total Income', curr: pl.total_income, prev: prevPl.total_income },
        { label: 'Total Expenses', curr: pl.total_expenses, prev: prevPl.total_expenses },
        { label: 'Profit Before Tax', curr: pl.pbt, prev: prevPl.pbt },
        { label: 'Profit After Tax', curr: pl.pat, prev: prevPl.pat },
      ].map((r): SheetRow => ({
        cells: [r.label, toUnit(r.curr, unit), toUnit(r.prev, unit), yoy(r.curr, r.prev)],
        formats: [null, ACC_FMT, ACC_FMT, PCT_FMT],
      }))),
    ];
    buildSheet(wb, 'YoY Comparison', yoyRows, [26, 14, 14, 12]);
  }

  buildInfoSheet(wb, { companyName, fyFullLabel, yearType, periodLabel: bundle.period_label, generatedAt: formatDate(bundle.generated_at) });

  return { wb, fyShort };
}

export function exportPlXlsx(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  const { wb, fyShort } = buildPlXlsx(bundle, companyName, unit, compare, currency);
  XLSX.writeFile(wb, `FinCommandPro_ProfitAndLoss_${fyShort}.xlsx`);
}
