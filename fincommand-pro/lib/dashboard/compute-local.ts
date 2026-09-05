import {
  computeMIS, computeBS, computePL, computeNotes, computeTreasury, computeCashFlow, computeRatios, resolvePeriod,
  customerStatusFromPct, vendorStatusFromPct,
  type PeriodParams, type TbLedgerRow, type TopCustomer, type VendorExpense, type CustomerMarginResult,
} from '@/lib/financial/tb-engine';
import { mergeCyLedgers } from '@/lib/financial/cy-merge';
import { buildSampleLedgers, SAMPLE_FY_META, SAMPLE_FY_ORDER, SAMPLE_TOP_CUSTOMERS, SAMPLE_VENDOR_EXPENSE, SAMPLE_CUSTOMER_DIRECT_COST, type SampleFyKey } from '@/lib/financial/sample-data';
import type { ReportBundle, ThreeYearBundle, ThreeYearEntry } from './types';

/**
 * Sample-mode equivalent of GET /reports/all — same engine, same shape, local data.
 *
 * In FY mode: uses ledgers from the selected FY key directly.
 * In CY mode: the selected fyKey is the "prevFY" (Jan–Mar source).
 *   The "nextFY" is the chronologically adjacent newer FY.
 *   e.g. fyKey='FY24' → prevFY=FY24, nextFY=FY25 → CY2024
 *        fyKey='FY25' → prevFY=FY25, nextFY=(none, FY26 not in sample) → CY2025 (Jan–Mar only)
 */
export function computeLocalReportBundle(fyKey: SampleFyKey, params: PeriodParams): ReportBundle {
  const isCY = params.yearType === 'CY';
  const fy = SAMPLE_FY_META[fyKey];

  let computeLedgers: TbLedgerRow[];
  let cyNextFy = null;

  if (isCY) {
    // prevFY = selected key; nextFY = the chronologically newer FY in the sample set
    // SAMPLE_FY_ORDER = ['FY25', 'FY24', 'FY23'] — newest first
    // A lower index means a newer (next) FY chronologically
    const prevIdx = SAMPLE_FY_ORDER.indexOf(fyKey);
    const nextKey: SampleFyKey | null = prevIdx > 0 ? SAMPLE_FY_ORDER[prevIdx - 1] : null;

    const prevLedgers = buildSampleLedgers(fyKey);
    const nextLedgers: TbLedgerRow[] = nextKey ? buildSampleLedgers(nextKey) : [];
    computeLedgers = mergeCyLedgers(prevLedgers, nextLedgers);

    if (nextKey) cyNextFy = SAMPLE_FY_META[nextKey];
  } else {
    computeLedgers = buildSampleLedgers(fyKey);
  }

  // Previous FY for cash-flow comparison (FY mode only, mirrors API route behaviour)
  const idx = SAMPLE_FY_ORDER.indexOf(fyKey);
  const prevKey = !isCY && idx >= 0 && idx + 1 < SAMPLE_FY_ORDER.length
    ? SAMPLE_FY_ORDER[idx + 1]
    : null;
  let prev_cashflow = null;
  let prev_bs = null;
  let prev_pl = null;
  let prev_mis = null;
  let prev_notes = null;
  let prev_treasury = null;
  let prev_financial_year = null;

  if (prevKey) {
    const prevLedgers = buildSampleLedgers(prevKey);
    prev_cashflow = computeCashFlow(prevLedgers, params);
    prev_bs = computeBS(prevLedgers, params);
    prev_pl = computePL(prevLedgers, params);
    prev_mis = computeMIS(prevLedgers, params);
    prev_notes = Object.values(computeNotes(prevLedgers, params)).sort((a, b) => a.note_no - b.note_no);
    prev_treasury = computeTreasury(prevLedgers, params);
    prev_financial_year = SAMPLE_FY_META[prevKey];
  }

  const mis = computeMIS(computeLedgers, params);

  // Sample mode has no real Zoho customer data to read — this is the demo
  // company's own illustrative customer mix (see sample-data.ts), scaled to
  // whatever revenue the selected period actually computes to. Live mode's
  // equivalent (computeTopCustomers in tb-engine.ts) reads real Zoho
  // Sales-by-Customer data and returns [] honestly when none exists.
  const top_customers: TopCustomer[] = mis.totals.rev > 0
    ? SAMPLE_TOP_CUSTOMERS.map(c => ({
        customer: c.customer,
        revenue_cr: parseFloat((mis.totals.rev * c.pct_of_total / 100 / 10000000).toFixed(2)),
        pct_of_total: c.pct_of_total,
        status: customerStatusFromPct(c.pct_of_total),
        source: 'sample' as const,
      }))
    : [];

  // Same "illustrative demo, scaled to whatever the period actually
  // computes to" approach as top_customers above — see SAMPLE_VENDOR_EXPENSE
  // and SAMPLE_CUSTOMER_DIRECT_COST's own doc comments in sample-data.ts.
  const vendor_expense: VendorExpense[] = mis.totals.totExp > 0
    ? SAMPLE_VENDOR_EXPENSE.map(v => ({
        vendor: v.vendor,
        amount: parseFloat((mis.totals.totExp * v.pct_of_total / 100).toFixed(2)),
        pct_of_total: v.pct_of_total,
        status: vendorStatusFromPct(v.pct_of_total),
      }))
    : [];

  const customer_margin: CustomerMarginResult = mis.totals.rev > 0
    ? (() => {
        const costPctByCustomer = new Map(SAMPLE_CUSTOMER_DIRECT_COST.map(c => [c.customer, c.pct_of_revenue]));
        const entries = SAMPLE_TOP_CUSTOMERS
          .map((c) => {
            const revenue = parseFloat((mis.totals.rev * c.pct_of_total / 100).toFixed(2));
            const direct_cost = parseFloat((revenue * (costPctByCustomer.get(c.customer) ?? 0) / 100).toFixed(2));
            const direct_margin = revenue - direct_cost;
            return {
              customer: c.customer, revenue, direct_cost, direct_margin,
              direct_margin_pct: revenue > 0 ? parseFloat(((direct_margin / revenue) * 100).toFixed(1)) : null,
            };
          })
          .sort((a, b) => b.revenue - a.revenue);
        return { entries, org_tracks_direct_cost: SAMPLE_CUSTOMER_DIRECT_COST.length > 0 };
      })()
    : { entries: [], org_tracks_direct_cost: false };

  return {
    financial_year: fy,
    cy_next_financial_year: cyNextFy,
    prev_financial_year,
    period_params: params,
    period_label: resolvePeriod(params).label,
    // Sample data is always modeled in INR — this app's real companies (see
    // ReportBundle.source_currency) can differ, but the bundled demo
    // Trial Balance is a fixed INR dataset.
    source_currency: 'INR',
    default_presentation_currency: null,
    mis,
    prev_mis,
    bs: computeBS(computeLedgers, params),
    prev_bs,
    pl: computePL(computeLedgers, params),
    prev_pl,
    notes: Object.values(computeNotes(computeLedgers, params)).sort((a, b) => a.note_no - b.note_no),
    prev_notes,
    treasury: computeTreasury(computeLedgers, params),
    prev_treasury,
    cashflow: computeCashFlow(computeLedgers, params),
    prev_cashflow,
    ratios: computeRatios(computeLedgers, params),
    top_customers,
    vendor_expense,
    customer_margin,
    generated_at: new Date().toISOString(),
  };
}

/** Sample-mode equivalent of GET /reports/threeyear across all 3 sample FYs. */
export function computeLocalThreeYear(): ThreeYearBundle {
  const params: PeriodParams = { periodType: 'annual', period: null, yearType: 'FY' };
  const orderedOldToNew = [...SAMPLE_FY_ORDER].reverse(); // FY23, FY24, FY25

  const results: ThreeYearEntry[] = orderedOldToNew.map((key) => {
    const ledgers = buildSampleLedgers(key);
    const mis = computeMIS(ledgers, params);
    const pl = computePL(ledgers, params);
    const treasury = computeTreasury(ledgers, params);
    const ratios = computeRatios(ledgers, params);
    const cf = computeCashFlow(ledgers, params);
    const bs = computeBS(ledgers, params);

    const cfOp = cf.operating as Record<string, unknown>;
    const cfInv = cf.investing as Record<string, unknown>;

    return {
      financial_year: SAMPLE_FY_META[key],
      mis: mis.totals,
      pl,
      treasury: { total: treasury.total, cash: treasury.total_cash_and_bank, fd: treasury.total_fd, mf: treasury.total_mf },
      ratios,
      cashflow: {
        ocf: cfOp.total as number,
        icf: cfInv.total as number,
        fcf: cf.free_cash_flow as number, // OCF − Capex — matches computeCashFlow()'s own definition, not a looser OCF+full-Investing figure
        net_change: (cf.net_change as number) ?? 0,
        opening_cash: (cf.opening_cash as number) ?? 0,
        closing_cash: (cf.closing_cash as number) ?? 0,
        ocf_to_pat: cf.ocf_to_pat as number | null,
      },
      bs_summary: {
        total_assets: bs.assets.total,
        equity: bs.equity_liabilities.total_equity,
        ncl: bs.equity_liabilities.total_ncl,
        cl: bs.equity_liabilities.total_cl,
        nca: bs.assets.total_nca,
        ca: bs.assets.total_ca,
        balanced: bs.balanced,
      },
    };
  });

  const withGrowth = results.map((r, i) => {
    if (i === 0 || !results[i - 1].mis || !r.mis) return r;
    const prev = results[i - 1].mis!;
    const cur = r.mis!;
    return {
      ...r,
      yoy: {
        revenue_growth: prev.rev > 0 ? +((cur.rev - prev.rev) / prev.rev * 100).toFixed(1) : null,
        ebitda_growth: prev.pbt > 0 ? +((cur.pbt - prev.pbt) / prev.pbt * 100).toFixed(1) : null,
        pat_growth: prev.pat > 0 ? +((cur.pat - prev.pat) / prev.pat * 100).toFixed(1) : null,
      },
    };
  });

  // CAGR: works for 2+ years with data
  const withData = withGrowth.filter(r => !r.no_data && r.mis);
  let cagr: { revenue: number | null; pat: number | null } | null = null;
  if (withData.length >= 2) {
    const first = withData[0].mis!;
    const last = withData[withData.length - 1].mis!;
    const n = withData.length - 1;
    cagr = {
      revenue: first.rev > 0 ? +((Math.pow(last.rev / first.rev, 1 / n) - 1) * 100).toFixed(1) : null,
      pat: first.pat > 0 ? +((Math.pow(last.pat / first.pat, 1 / n) - 1) * 100).toFixed(1) : null,
    };
  }

  // Sample data is always modeled in INR — see computeLocalReportBundle()'s own comment.
  return { years: withGrowth, cagr, generated_at: new Date().toISOString(), source_currency: 'INR' };
}

