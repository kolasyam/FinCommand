'use client';

/**
 * Bespoke Cash Flow Excel export — the full Indirect Method statement as
 * real numbers with native Excel accounting formats (see xlsx-kit.ts),
 * using the same human-readable labels as the on-screen tab and PDF.
 */
import * as XLSX from 'xlsx';
import type { ReportBundle } from '@/lib/dashboard/types';
import { getFyLabel, getFyShortLabel, formatDate, getUnitHeader, unitSuffix, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { cfLabel } from '@/lib/financial/cashflow-labels';
import { ACC_FMT, PCT_FMT, DEFAULT_COMPANY_NAME, toUnit, buildSheet, buildInfoSheet, type SheetRow } from './xlsx-kit';

export function buildCashFlowXlsx(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): { wb: XLSX.WorkBook; fyShort: string } {
  const wb = XLSX.utils.book_new();
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyFullLabel = getFyLabel(bundle.financial_year, yearType);
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  const cf = bundle.cashflow;
  const prevCf = compare ? bundle.prev_cashflow : null;
  const op = cf.operating as Record<string, unknown>;
  const inv = cf.investing as Record<string, unknown>;
  const fin = cf.financing as Record<string, unknown>;
  const adj = (op.adjustments || {}) as Record<string, number>;
  const wc = (op.wc_changes || {}) as Record<string, number>;
  const unitLabel = getUnitHeader(unit, currency);
  const sfx = unitSuffix(unit);
  const symbol = getCurrencyMeta(currency).symbol;

  // ── Sheet 1: Statement of Cash Flows ──
  const stmt: SheetRow[] = [
    { cells: ['FinCommand Pro — Statement of Cash Flows'] },
    { cells: [`${companyName}  |  ${fyFullLabel}  |  ${bundle.period_label}  |  Indirect Method · IND AS 7  |  ${unitLabel}`] },
    { cells: [] },
    { cells: ['Particulars', `Amount (${symbol}${sfx})`], bold: true },
    { cells: ['A. Cash Flow from Operating Activities'], bold: true },
    { cells: ['Profit Before Tax', toUnit(op.pbt as number, unit)], formats: [null, ACC_FMT], bold: true },
    { cells: ['Adjustments for non-cash items:'] },
    ...Object.entries(adj).map(([k, v]): SheetRow => ({ cells: [cfLabel(k), toUnit(v, unit)], formats: [null, ACC_FMT] })),
    { cells: ['Changes in Working Capital:'] },
    ...Object.entries(wc).map(([k, v]): SheetRow => ({ cells: [k, toUnit(v, unit)], formats: [null, ACC_FMT] })),
    { cells: ['A. Net Cash from Operating Activities', toUnit(op.total as number, unit)], formats: [null, ACC_FMT], bold: true },
    { cells: [] },
    { cells: ['B. Cash Flow from Investing Activities'], bold: true },
    ...Object.entries(inv).filter(([k]) => k !== 'total').map(([k, v]): SheetRow => ({ cells: [cfLabel(k), toUnit(v as number, unit)], formats: [null, ACC_FMT] })),
    { cells: ['B. Net Cash from Investing Activities', toUnit(inv.total as number, unit)], formats: [null, ACC_FMT], bold: true },
    { cells: [] },
    { cells: ['C. Cash Flow from Financing Activities'], bold: true },
    ...Object.entries(fin).filter(([k]) => k !== 'total').map(([k, v]): SheetRow => ({ cells: [cfLabel(k), toUnit(v as number, unit)], formats: [null, ACC_FMT] })),
    { cells: ['C. Net Cash from Financing Activities', toUnit(fin.total as number, unit)], formats: [null, ACC_FMT], bold: true },
    { cells: [] },
    { cells: ['Net Change in Cash / Net Increase (Decrease) — (A+B+C)', toUnit(cf.net_change, unit)], formats: [null, ACC_FMT], bold: true },
    { cells: ['Opening Cash & Bank Balances', toUnit(cf.opening_cash, unit)], formats: [null, ACC_FMT] },
    ...(Math.abs(cf.reconciling_gap) >= 1000
      ? [{ cells: ['Reconciling Difference (see note below)', toUnit(cf.reconciling_gap, unit)], formats: [null, ACC_FMT] } as SheetRow]
      : []),
    { cells: ['Closing Cash & Bank Balances', toUnit(cf.closing_cash, unit)], formats: [null, ACC_FMT], bold: true },
    { cells: [] },
    { cells: ['KEY METRICS'], bold: true },
    { cells: ['Free Cash Flow (OCF − Capex)', toUnit(cf.free_cash_flow, unit)], formats: [null, ACC_FMT] },
    { cells: ['OCF / PAT', cf.ocf_to_pat != null ? cf.ocf_to_pat : null], formats: [null, '0.00"x"'] },
  ];

  if (Math.abs(cf.reconciling_gap) >= 1000) {
    stmt.push(
      { cells: [] },
      { cells: ["This statement is derived entirely from real Trial Balance ledger movements — no assumed percentages. The Reconciling Difference line ties the statement above to actual opening and closing cash/bank balances; the most common cause is cash tax paid, which isn't shown as its own modeled line since no dedicated tax-provision ledger exists in this Chart of Accounts to trace it from — plus any Balance Sheet tally difference. Opening + Net Change + that line equals the real Closing Cash & Bank balance."] },
    );
  }

  buildSheet(wb, 'Cash Flow Statement', stmt, [48, 16]);

  // ── Sheet 2: Year-on-Year (if prior year available) ──
  if (prevCf) {
    const prevOp = prevCf.operating as Record<string, unknown>;
    const prevInv = prevCf.investing as Record<string, unknown>;
    const prevFin = prevCf.financing as Record<string, unknown>;
    const prevFyShort = getFyShortLabel(bundle.prev_financial_year, yearType);
    const yoy = (curr: number, prev: number) => (prev !== 0 ? (curr - prev) / Math.abs(prev) : null);

    const yoyRows: SheetRow[] = [
      { cells: ['FinCommand Pro — Cash Flow Year-on-Year'] },
      { cells: [`${companyName}  |  ${fyShort} vs ${prevFyShort}  |  ${unitLabel}`] },
      { cells: [] },
      { cells: ['Metric', fyShort, prevFyShort, 'YoY %'], bold: true },
      ...([
        { label: 'Operating Cash Flow', curr: op.total as number, prev: prevOp.total as number },
        { label: 'Investing Cash Flow', curr: inv.total as number, prev: prevInv.total as number },
        { label: 'Financing Cash Flow', curr: fin.total as number, prev: prevFin.total as number },
        { label: 'Net Change in Cash', curr: cf.net_change, prev: prevCf.net_change },
        { label: 'Closing Cash & Bank', curr: cf.closing_cash, prev: prevCf.closing_cash },
        { label: 'Free Cash Flow', curr: cf.free_cash_flow, prev: prevCf.free_cash_flow },
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

export function exportCashFlowXlsx(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  const { wb, fyShort } = buildCashFlowXlsx(bundle, companyName, unit, compare, currency);
  XLSX.writeFile(wb, `FinCommandPro_CashFlow_${fyShort}.xlsx`);
}
