/**
 * Presentation-currency conversion — IAS 21 / IND AS 21 in spirit, scoped
 * deliberately narrow: this converts a *single* already-computed
 * ReportBundle from its Source Currency (the currency the underlying Trial
 * Balance ledgers are actually recorded in) to a chosen Presentation
 * Currency, using ONE spot rate (see lib/services/currency.ts), for display
 * and export purposes only.
 *
 * This is NOT full statutory currency translation (IAS 21's dual closing-
 * rate-for-BS / average-rate-for-P&L treatment, with the resulting
 * translation difference recognised in OCI/a Foreign Currency Translation
 * Reserve) — that's a materially different feature aimed at multi-entity
 * consolidation, not "show a CFO/investor this company's own statements in
 * a currency they read more easily". A single disclosed spot rate, applied
 * uniformly, is the honest, useful scope for that job — same spirit as
 * every other estimate in this engine: real numbers, converted by a real
 * disclosed rate, never silently reinterpreted as something more precise
 * than it is. The rate and its as-of date are always shown alongside any
 * converted figure — see getUnitHeader()/getUnitHeaderPdf() and the
 * DashboardContext fxAsOf state.
 *
 * Only genuinely monetary (raw-currency-amount) fields are converted.
 * Ratios, percentages, day-counts (DSO/DPO/CCC), note numbers, and booleans
 * are currency-invariant by construction (or, for ratios of two monetary
 * figures scaled by the same rate, invariant under conversion anyway) and
 * are passed through unchanged — converting them would corrupt them, not
 * translate them.
 */
import type {
  MISColumn, MISResult, AggregatedNote, BSResult, PLResult, TreasuryEntry, TreasuryResult,
  CashFlowResult, RatiosResult, TopCustomer,
} from './tb-engine';
import type { ReportBundle, ThreeYearBundle, ThreeYearEntry } from '@/lib/dashboard/types';

/** Null-safe multiply — every optional monetary field (OCI, EPS, ocf_to_pat, ...) stays null when it was null; never turns "not derivable" into a fabricated 0. */
function cv(n: number | null | undefined, rate: number): number | null {
  if (n === null || n === undefined) return null;
  return n * rate;
}

function convertLedgerNet<T extends { net: number }>(l: T, rate: number): T {
  return { ...l, net: l.net * rate };
}

function convertNote(note: AggregatedNote, rate: number): AggregatedNote {
  return {
    ...note,
    ledgers: note.ledgers.map(l => convertLedgerNet(l, rate)),
    total: note.total * rate,
    monthly: note.monthly.map(m => m * rate),
  };
}

function convertNotes(notes: AggregatedNote[] | null | undefined, rate: number): AggregatedNote[] {
  return (notes || []).map(n => convertNote(n, rate));
}

function convertMISColumn(c: MISColumn, rate: number): MISColumn {
  return {
    ...c,
    rev: c.rev * rate, oth: c.oth * rate, totInc: c.totInc * rate,
    cos: c.cos * rate, emp: c.emp * rate, fin: c.fin * rate,
    dep: c.dep * rate, oex: c.oex * rate, totExp: c.totExp * rate,
    pbt: c.pbt * rate, tax: c.tax * rate, pat: c.pat * rate,
    ebitda: c.ebitda * rate,
    // gm/em/pm are margins (%) — currency-invariant, left unchanged.
  };
}

export function convertMIS(mis: MISResult, rate: number): MISResult {
  if (rate === 1) return mis;
  return {
    columns: mis.columns,
    data: mis.data.map(c => convertMISColumn(c, rate)),
    totals: convertMISColumn(mis.totals, rate) as MISResult['totals'],
  };
}

export function convertBS(bs: BSResult, rate: number): BSResult {
  if (rate === 1) return bs;
  return {
    equity_liabilities: {
      equity: convertNotes(bs.equity_liabilities.equity, rate),
      non_current_liab: convertNotes(bs.equity_liabilities.non_current_liab, rate),
      current_liab: convertNotes(bs.equity_liabilities.current_liab, rate),
      total_equity: bs.equity_liabilities.total_equity * rate,
      total_ncl: bs.equity_liabilities.total_ncl * rate,
      total_cl: bs.equity_liabilities.total_cl * rate,
      total: bs.equity_liabilities.total * rate,
    },
    assets: {
      non_current: convertNotes(bs.assets.non_current, rate),
      current: convertNotes(bs.assets.current, rate),
      total_nca: bs.assets.total_nca * rate,
      total_ca: bs.assets.total_ca * rate,
      total: bs.assets.total * rate,
    },
    // `balanced` is a true/false fact about the source-currency ledgers
    // tallying — invariant under conversion; only its numeric `difference`
    // (shown for disclosure) is converted, not re-derived from it.
    balanced: bs.balanced,
    difference: bs.difference * rate,
  };
}

export function convertPL(pl: PLResult, rate: number): PLResult {
  if (rate === 1) return pl;
  return {
    ...pl,
    revenue: pl.revenue * rate, other_income: pl.other_income * rate, total_income: pl.total_income * rate,
    cos: pl.cos * rate, employee_benefits: pl.employee_benefits * rate, finance_costs: pl.finance_costs * rate,
    depreciation: pl.depreciation * rate, other_expenses: pl.other_expenses * rate, total_expenses: pl.total_expenses * rate,
    pbt: pl.pbt * rate, current_tax: pl.current_tax * rate, deferred_tax: pl.deferred_tax * rate, pat: pl.pat * rate,
    oci_gross: cv(pl.oci_gross, rate), oci_tax: cv(pl.oci_tax, rate), oci_net: cv(pl.oci_net, rate),
    total_comprehensive_income: cv(pl.total_comprehensive_income, rate),
    // EPS is a real ₹-per-share (not a table-unit) figure — genuinely
    // converts to $/€/£/AED-per-share under a presentation currency, same
    // as every other monetary figure here.
    eps_basic: cv(pl.eps_basic, rate), eps_diluted: cv(pl.eps_diluted, rate),
    // `notes` (20-26) is a PRESERVED QUIRK — always null (see computePL's
    // own comment); nothing to convert.
  };
}

function convertTreasuryEntry(e: TreasuryEntry, rate: number): TreasuryEntry {
  return { ...e, closing: e.closing * rate };
}

export function convertTreasury(t: TreasuryResult, rate: number): TreasuryResult {
  if (rate === 1) return t;
  return {
    cash: t.cash.map(e => convertTreasuryEntry(e, rate)),
    bank_ca: t.bank_ca.map(e => convertTreasuryEntry(e, rate)),
    bank_sb: t.bank_sb.map(e => convertTreasuryEntry(e, rate)),
    fds: t.fds.map(e => convertTreasuryEntry(e, rate)),
    mfs: t.mfs.map(e => convertTreasuryEntry(e, rate)),
    total_cash_and_bank: t.total_cash_and_bank * rate,
    total_fd: t.total_fd * rate,
    total_mf: t.total_mf * rate,
    total: t.total * rate,
  };
}

/** Every value in a dynamic `Record<string, number>` (e.g. wc_changes, whose keys are real ledger/note names) is monetary — convert them all uniformly. */
function convertRecordValues(rec: Record<string, unknown>, rate: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  Object.entries(rec).forEach(([k, v]) => { out[k] = typeof v === 'number' ? v * rate : v; });
  return out;
}

export function convertCashFlow(cf: CashFlowResult, rate: number): CashFlowResult {
  if (rate === 1) return cf;
  const op = cf.operating as Record<string, unknown>;
  const inv = cf.investing as Record<string, unknown>;
  const fin = cf.financing as Record<string, unknown>;
  return {
    operating: {
      ...convertRecordValues(op, rate),
      // adjustments/wc_changes are nested Records themselves — convert their
      // inner values too (convertRecordValues above only handles this
      // object's own top-level numeric fields, e.g. pbt/operating_profit/
      // total; tax_paid stays null via the typeof-number guard).
      adjustments: convertRecordValues((op.adjustments || {}) as Record<string, unknown>, rate),
      wc_changes: convertRecordValues((op.wc_changes || {}) as Record<string, unknown>, rate),
    },
    investing: convertRecordValues(inv, rate),
    financing: convertRecordValues(fin, rate),
    net_change: cf.net_change * rate,
    opening_cash: cf.opening_cash * rate,
    closing_cash: cf.closing_cash * rate,
    free_cash_flow: cf.free_cash_flow * rate,
    // A ratio of two monetary figures both scaled by the same rate is
    // currency-invariant by construction — left unchanged (also avoids ever
    // re-deriving it from already-rounded converted figures).
    ocf_to_pat: cf.ocf_to_pat,
    reconciling_gap: cf.reconciling_gap * rate,
  };
}

export function convertRatios(r: RatiosResult, rate: number): RatiosResult {
  if (rate === 1) return r;
  return {
    // liquidity/profitability/leverage/efficiency/dupont are all pure
    // ratios, percentages, or day-counts — currency-invariant, unchanged.
    ...r,
    cashflow: {
      // The one genuinely monetary figure in this whole result shape.
      free_cash_flow: r.cashflow.free_cash_flow * rate,
      ocf_to_pat: r.cashflow.ocf_to_pat,
    },
  };
}

export function convertTopCustomers(list: TopCustomer[] | null | undefined, rate: number): TopCustomer[] {
  if (!list || rate === 1) return list || [];
  return list.map(c => ({ ...c, revenue_cr: c.revenue_cr * rate /* pct_of_total is a %, currency-invariant */ }));
}

/**
 * Converts an entire ReportBundle from its source currency to a
 * presentation currency using one spot `rate`. Pass `rate = 1` (or simply
 * skip calling this) when presentation currency equals source currency —
 * every converter below short-circuits and returns its input unchanged in
 * that case, so this is always safe to call unconditionally.
 */
export function convertReportBundle(bundle: ReportBundle, rate: number): ReportBundle {
  if (rate === 1) return bundle;
  return {
    ...bundle,
    mis: convertMIS(bundle.mis, rate),
    prev_mis: bundle.prev_mis ? convertMIS(bundle.prev_mis, rate) : bundle.prev_mis,
    bs: convertBS(bundle.bs, rate),
    prev_bs: bundle.prev_bs ? convertBS(bundle.prev_bs, rate) : bundle.prev_bs,
    pl: convertPL(bundle.pl, rate),
    prev_pl: bundle.prev_pl ? convertPL(bundle.prev_pl, rate) : bundle.prev_pl,
    notes: convertNotes(bundle.notes, rate),
    prev_notes: bundle.prev_notes ? convertNotes(bundle.prev_notes, rate) : bundle.prev_notes,
    treasury: convertTreasury(bundle.treasury, rate),
    prev_treasury: bundle.prev_treasury ? convertTreasury(bundle.prev_treasury, rate) : bundle.prev_treasury,
    cashflow: convertCashFlow(bundle.cashflow, rate),
    prev_cashflow: bundle.prev_cashflow ? convertCashFlow(bundle.prev_cashflow, rate) : bundle.prev_cashflow,
    ratios: convertRatios(bundle.ratios, rate),
    top_customers: convertTopCustomers(bundle.top_customers, rate),
  };
}

function convertThreeYearEntry(y: ThreeYearEntry, rate: number): ThreeYearEntry {
  if (y.no_data) return y;
  return {
    ...y,
    mis: y.mis ? (convertMISColumn(y.mis, rate) as ThreeYearEntry['mis']) : y.mis,
    pl: y.pl ? convertPL(y.pl, rate) : y.pl,
    treasury: y.treasury ? {
      total: y.treasury.total * rate, cash: y.treasury.cash * rate, fd: y.treasury.fd * rate, mf: y.treasury.mf * rate,
    } : y.treasury,
    ratios: y.ratios ? convertRatios(y.ratios, rate) : y.ratios,
    cashflow: y.cashflow ? {
      ocf: y.cashflow.ocf * rate, icf: y.cashflow.icf * rate, fcf: y.cashflow.fcf * rate,
      net_change: y.cashflow.net_change * rate, opening_cash: y.cashflow.opening_cash * rate, closing_cash: y.cashflow.closing_cash * rate,
      ocf_to_pat: y.cashflow.ocf_to_pat, // ratio — currency-invariant
    } : y.cashflow,
    bs_summary: y.bs_summary ? {
      total_assets: y.bs_summary.total_assets * rate, equity: y.bs_summary.equity * rate,
      ncl: y.bs_summary.ncl * rate, cl: y.bs_summary.cl * rate,
      nca: y.bs_summary.nca * rate, ca: y.bs_summary.ca * rate,
      balanced: y.bs_summary.balanced, // fact about source-currency tallying — invariant
    } : y.bs_summary,
    // yoy is all growth percentages — currency-invariant, unchanged.
  };
}

/** Converts the 3-Year Frame tab's own bundle shape (distinct from ReportBundle) the same way — one spot rate, only genuinely monetary fields touched. */
export function convertThreeYearBundle(bundle: ThreeYearBundle, rate: number): ThreeYearBundle {
  if (rate === 1) return bundle;
  return {
    ...bundle,
    years: bundle.years.map(y => convertThreeYearEntry(y, rate)),
    // cagr is a growth %, currency-invariant.
  };
}
