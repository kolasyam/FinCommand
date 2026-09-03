import type {
  MISResult, BSResult, PLResult, AggregatedNote, TreasuryResult, CashFlowResult, RatiosResult, PeriodParams, TopCustomer,
} from '@/lib/financial/tb-engine';

export interface FyLike {
  id: string;
  label: string;
  short_label: string;
  start_date: string;
  end_date: string;
  year_type?: string;
  is_locked: boolean;
}

/** Shape returned by both /api/v1/reports/all (live) and computeLocalReportBundle() (sample). */
export interface ReportBundle {
  financial_year: FyLike;
  /** In CY mode: the FY whose m1–m9 supply Apr–Dec of the calendar year. Null in FY mode. */
  cy_next_financial_year?: FyLike | null;
  prev_financial_year?: FyLike | null;
  period_params: PeriodParams;
  period_label: string;
  /** Source/Functional Currency — the currency the Trial Balance ledgers are actually recorded in (IAS 21 / IND AS 21). Real, per-company: auto-detected from the connected Zoho org where available, 'INR' by default for Excel uploads. Every number in this bundle is in this currency unless it's already been run through convertReportBundle() for a different Presentation Currency — see lib/financial/currency-convert.ts. */
  source_currency?: string;
  /** The company's saved default Presentation Currency (Company Settings), if one was set — DashboardContext seeds its own session state from this but a signed-in user can still override it locally, same as the Unit Selector. */
  default_presentation_currency?: string | null;
  mis: MISResult;
  prev_mis?: MISResult | null;
  bs: BSResult;
  prev_bs?: BSResult | null;
  pl: PLResult;
  prev_pl?: PLResult | null;
  notes: AggregatedNote[];
  prev_notes?: AggregatedNote[] | null;
  treasury: TreasuryResult;
  prev_treasury?: TreasuryResult | null;
  cashflow: CashFlowResult;
  prev_cashflow?: CashFlowResult | null;
  ratios: RatiosResult;
  top_customers?: TopCustomer[];
  generated_at: string;
}

export interface ThreeYearEntry {
  financial_year: FyLike;
  no_data?: boolean;
  mis?: MISResult['totals'];
  pl?: PLResult;
  treasury?: { total: number; cash: number; fd: number; mf: number };
  ratios?: RatiosResult;
  /** Abbreviated Cash Flow summary for 3-year comparison. */
  cashflow?: {
    ocf: number; icf: number; fcf: number;
    net_change: number; opening_cash: number; closing_cash: number; ocf_to_pat: number | null;
  };
  /** Abbreviated Balance Sheet summary for 3-year comparison. */
  bs_summary?: {
    total_assets: number; equity: number; ncl: number; cl: number;
    nca: number; ca: number; balanced: boolean;
  };
  yoy?: { revenue_growth: number | null; ebitda_growth: number | null; pat_growth: number | null };
}

export interface ThreeYearBundle {
  years: ThreeYearEntry[];
  cagr: { revenue: number | null; pat: number | null } | null;
  generated_at: string;
  /** Same meaning as ReportBundle.source_currency — carried here too because DashboardContext has no ReportBundle to read it from while granularity === '3year' (rawBundle is null in that mode); without this, the FX conversion driving the 3-Year Frame silently fell back to assuming 'INR' regardless of the company's real Source Currency. */
  source_currency?: string;
}
