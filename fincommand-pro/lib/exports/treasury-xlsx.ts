'use client';

/**
 * Bespoke Treasury Excel export — summary + full instrument-level detail as
 * real numbers with native Excel accounting formats (see xlsx-kit.ts),
 * matching the on-screen tab and PDF exactly.
 */
import * as XLSX from 'xlsx';
import type { ReportBundle } from '@/lib/dashboard/types';
import type { TreasuryEntry, TreasuryResult } from '@/lib/financial/tb-engine';
import { getFyLabel, getFyShortLabel, formatDate, getUnitHeader, unitSuffix, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { ACC_FMT, PCT_FMT, DEFAULT_COMPANY_NAME, toUnit, buildSheet, buildInfoSheet, type SheetRow } from './xlsx-kit';

function allEntries(t: TreasuryResult): TreasuryEntry[] {
  return [...t.cash, ...t.bank_ca, ...t.bank_sb, ...t.fds, ...t.mfs];
}

export function buildTreasuryXlsx(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): { wb: XLSX.WorkBook; fyShort: string } {
  const wb = XLSX.utils.book_new();
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyFullLabel = getFyLabel(bundle.financial_year, yearType);
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  const { treasury: t, prev_treasury: prevTreasuryRaw } = bundle;
  const prevT = compare ? prevTreasuryRaw : null;
  const hasPrev = !!prevT;
  const prevFyShort = getFyShortLabel(bundle.prev_financial_year, yearType);
  const unitLabel = getUnitHeader(unit, currency);
  const sfx = unitSuffix(unit);
  const symbol = getCurrencyMeta(currency).symbol;
  const yoy = (curr: number, prev: number) => (prev !== 0 ? (curr - prev) / Math.abs(prev) : null);

  const liquidPct = t.total > 0 ? t.total_cash_and_bank / t.total : null;
  const investedPct = t.total > 0 ? (t.total_fd + t.total_mf) / t.total : null;
  const entries = allEntries(t);
  const largest = entries.reduce((max, e) => (Math.abs(e.closing) > Math.abs(max?.closing ?? 0) ? e : max), undefined as TreasuryEntry | undefined);
  const largestPct = largest && t.total > 0 ? largest.closing / t.total : null;

  // ── Sheet 1: Treasury Summary ──
  const summary: SheetRow[] = [
    { cells: ['FinCommand Pro — Treasury Report'] },
    { cells: [`${companyName}  |  ${fyFullLabel}  |  ${bundle.period_label}  |  ${unitLabel}`] },
    { cells: [] },
    { cells: ['SUMMARY'], bold: true },
    hasPrev
      ? { cells: ['Metric', fyShort, prevFyShort, 'YoY %'], bold: true }
      : { cells: ['Metric', `Value (${symbol}${sfx})`], bold: true },
    ...([
      { label: 'Cash & Bank', curr: t.total_cash_and_bank, prev: prevT?.total_cash_and_bank ?? 0 },
      { label: 'Fixed Deposits', curr: t.total_fd, prev: prevT?.total_fd ?? 0 },
      { label: 'Mutual Funds', curr: t.total_mf, prev: prevT?.total_mf ?? 0 },
      { label: 'TOTAL TREASURY', curr: t.total, prev: prevT?.total ?? 0 },
    ].map((r): SheetRow => hasPrev
      ? { cells: [r.label, toUnit(r.curr, unit), toUnit(r.prev, unit), yoy(r.curr, r.prev)], formats: [null, ACC_FMT, ACC_FMT, PCT_FMT] }
      : { cells: [r.label, toUnit(r.curr, unit)], formats: [null, ACC_FMT] })),
    { cells: [] },
    { cells: ['LIQUIDITY & CONCENTRATION'], bold: true },
    { cells: ['Liquid (Cash + Bank)', liquidPct], formats: [null, PCT_FMT] },
    { cells: ['Invested (FD + MF)', investedPct], formats: [null, PCT_FMT] },
    { cells: ['Largest Single Holding', largest ? `${largest.name} (${toUnit(largest.closing, unit).toFixed(2)} ${symbol}${sfx}, ${largestPct != null ? (largestPct * 100).toFixed(1) : '—'}% of treasury)` : '—'] },
  ];
  buildSheet(wb, 'Treasury Summary', summary, hasPrev ? [26, 14, 14, 12] : [26, 14]);

  // ── Sheet 2: Instrument Detail ──
  const detail: SheetRow[] = [
    { cells: ['FinCommand Pro — Treasury Instrument Detail'] },
    { cells: [`${companyName}  |  ${fyFullLabel}  |  ${unitLabel}`] },
    { cells: [] },
  ];
  const sections: { title: string; entries: TreasuryEntry[]; prevEntries: TreasuryEntry[] }[] = [
    { title: 'Cash in Hand', entries: t.cash, prevEntries: prevT?.cash || [] },
    { title: 'Bank — Current Accounts', entries: t.bank_ca, prevEntries: prevT?.bank_ca || [] },
    { title: 'Bank — Savings / Sweep', entries: t.bank_sb, prevEntries: prevT?.bank_sb || [] },
    { title: 'Fixed Deposits', entries: t.fds, prevEntries: prevT?.fds || [] },
    { title: 'Mutual Funds', entries: t.mfs, prevEntries: prevT?.mfs || [] },
  ];
  sections.forEach(sec => {
    if (!sec.entries.length && !sec.prevEntries.length) return;
    detail.push({ cells: [sec.title], bold: true });
    detail.push(hasPrev
      ? { cells: ['Instrument', `${fyShort} (${symbol}${sfx})`, `${prevFyShort} (${symbol}${sfx})`], bold: true }
      : { cells: ['Instrument', `Amount (${symbol}${sfx})`], bold: true });

    sec.entries.forEach(e => {
      const match = sec.prevEntries.find(p => (e.code && p.code === e.code) || p.name.toLowerCase() === e.name.toLowerCase());
      detail.push(hasPrev
        ? { cells: [e.name, toUnit(e.closing, unit), match ? toUnit(match.closing, unit) : null], formats: [null, ACC_FMT, ACC_FMT] }
        : { cells: [e.name, toUnit(e.closing, unit)], formats: [null, ACC_FMT] });
    });

    const subtotal = sec.entries.reduce((s, e) => s + e.closing, 0);
    const prevSubtotal = sec.prevEntries.reduce((s, e) => s + e.closing, 0);
    detail.push(hasPrev
      ? { cells: ['Subtotal', toUnit(subtotal, unit), toUnit(prevSubtotal, unit)], formats: [null, ACC_FMT, ACC_FMT], bold: true }
      : { cells: ['Subtotal', toUnit(subtotal, unit)], formats: [null, ACC_FMT], bold: true });
    detail.push({ cells: [] });
  });
  buildSheet(wb, 'Instrument Detail', detail, hasPrev ? [40, 15, 15] : [40, 16]);

  buildInfoSheet(wb, { companyName, fyFullLabel, yearType, periodLabel: bundle.period_label, generatedAt: formatDate(bundle.generated_at) });

  return { wb, fyShort };
}

export function exportTreasuryXlsx(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  const { wb, fyShort } = buildTreasuryXlsx(bundle, companyName, unit, compare, currency);
  XLSX.writeFile(wb, `FinCommandPro_Treasury_${fyShort}.xlsx`);
}
