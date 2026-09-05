import type {
  MISResult, BSResult, PLResult, AggregatedNote, TreasuryResult, CashFlowResult, RatiosResult, PeriodParams, TopCustomer,
  VendorExpense, CustomerMarginResult,
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
  /** Real per-vendor spend for the selected period (Zoho Bills only — see VendorExpense's own doc comment). Undefined/[] when unavailable (Excel-uploaded TB, or no Zoho bill data synced yet) — VendorExpenseTab must show that honestly, not a mock table. */
  vendor_expense?: VendorExpense[];
  /** Real per-customer revenue + DIRECT cost for the selected period (see CustomerMarginResult's own doc comment for exactly what "direct" means and why this is not a fully-loaded margin). */
  customer_margin?: CustomerMarginResult;
  /** Real, company-wide audit_trail activity — drives the Compliance tab's "Audit trail enabled" check. Undefined in sample mode (there's no real company to have an audit trail for); ComplianceTab treats that the same as dataMode !== 'api'. */
  audit_summary?: { total_events: number; last_event_at: string | null };
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
  /** Same meaning as ReportBundle.audit_summary — carried here too for the same reason as source_currency above. */
  audit_summary?: { total_events: number; last_event_at: string | null };
}
