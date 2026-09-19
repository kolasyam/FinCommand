import type { DashboardWidget, FixedTabKey } from '@/lib/financial/dashboard-builder-engine';
/**
 * Starter widgets shown when a user has neither a personal layout nor their
 * company has set a shared default — so "My Dashboard" is never blank on
 * first visit, same "never show nothing" convention as sample mode. These
 * are plain in-memory data, never written to the database until the user
 * (or an admin/cfo/manager, for the company-wide default) explicitly saves —
 * same "nothing persists until Save" behavior as every other part of this
 * builder. IDs are stable strings (not real UUIDs) since they only ever
 * exist client-side until a save mints real database rows.
 */
export const SYSTEM_DEFAULT_WIDGETS: DashboardWidget[] = [
  {
    id: 'default-revenue', widgetType: 'stat_card', title: 'Revenue', subtitle: null,
    gridX: 0, gridY: 0, gridW: 3, gridH: 4,
    series: [{ metricKey: 'revenue' }], vizConfig: { compare: true }, sequence: 0,
  },
  {
    id: 'default-ebitda', widgetType: 'stat_card', title: 'EBITDA', subtitle: null,
    gridX: 3, gridY: 0, gridW: 3, gridH: 4,
    series: [{ metricKey: 'ebitda' }], vizConfig: { compare: true }, sequence: 1,
  },
  {
    id: 'default-pat', widgetType: 'stat_card', title: 'Profit After Tax', subtitle: null,
    gridX: 6, gridY: 0, gridW: 3, gridH: 4,
    series: [{ metricKey: 'pat' }], vizConfig: { compare: true }, sequence: 2,
  },
  {
    id: 'default-treasury', widgetType: 'stat_card', title: 'Total Treasury', subtitle: null,
    gridX: 9, gridY: 0, gridW: 3, gridH: 4,
    series: [{ metricKey: 'treasury_total' }], vizConfig: { compare: true }, sequence: 3,
  },
  {
    id: 'default-trend', widgetType: 'line_chart', title: 'Revenue vs EBITDA', subtitle: null,
    gridX: 0, gridY: 4, gridW: 7, gridH: 7,
    series: [{ metricKey: 'revenue', label: 'Revenue' }, { metricKey: 'ebitda', label: 'EBITDA' }],
    vizConfig: { legend: true }, sequence: 4,
  },
  {
    id: 'default-treasury-mix', widgetType: 'donut_chart', title: 'Treasury Composition', subtitle: null,
    gridX: 7, gridY: 4, gridW: 5, gridH: 7,
    series: [{ metricKey: 'treasury_composition' }], vizConfig: {}, sequence: 5,
  },
  {
    id: 'default-top-customers', widgetType: 'data_table', title: 'Top Customers by Revenue', subtitle: null,
    gridX: 0, gridY: 11, gridW: 12, gridH: 6,
    series: [{ metricKey: 'top_customers_revenue' }], vizConfig: { limit: 5 }, sequence: 6,
  },
];

/**
 * Per-tab starter widget sets below — the first-time "Customize this view"
 * starting point for each of the 8 generalized tabs (see
 * components/dashboard/tabs/dashboard-builder/CustomizableTabPanel.tsx).
 * Each is a reasonable widget approximation of that tab's own real fixed
 * content, built only from real METRIC_CATALOG keys — never a fabricated
 * number. Same "never written until Save" contract as SYSTEM_DEFAULT_WIDGETS.
 */

export const OVERVIEW_DEFAULT_WIDGETS: DashboardWidget[] = [
  // Row 1: P&L profitability waterfall (Revenue -> Gross Profit -> EBITDA ->
  // PAT), 4 cards. Row 2: cash position (Treasury, Operating CF, Free Cash
  // Flow — the last added after this build's own gap audit found it real,
  // already-computed [computeCashFlow()'s own free_cash_flow field / this
  // catalog's existing 'free_cash_flow' key, already used by the Cash Flow
  // tab] but never surfaced here despite being a headline cash metric).
  // Mirrors the fixed view's own supplementaryView grid4+grid3 split exactly.
  { id: 'ov-revenue', widgetType: 'stat_card', title: 'Revenue', subtitle: null, gridX: 0, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'revenue' }], vizConfig: { compare: true }, sequence: 0 },
  { id: 'ov-gross-profit', widgetType: 'stat_card', title: 'Gross Profit', subtitle: null, gridX: 3, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'gross_profit' }], vizConfig: { compare: true }, sequence: 1 },
  { id: 'ov-ebitda', widgetType: 'stat_card', title: 'EBITDA', subtitle: null, gridX: 6, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'ebitda' }], vizConfig: { compare: true }, sequence: 2 },
  { id: 'ov-pat', widgetType: 'stat_card', title: 'Profit After Tax', subtitle: null, gridX: 9, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'pat' }], vizConfig: { compare: true }, sequence: 3 },
  { id: 'ov-treasury', widgetType: 'stat_card', title: 'Total Treasury', subtitle: null, gridX: 0, gridY: 4, gridW: 4, gridH: 4, series: [{ metricKey: 'treasury_total' }], vizConfig: { compare: true }, sequence: 4 },
  { id: 'ov-ocf', widgetType: 'stat_card', title: 'Operating Cash Flow', subtitle: null, gridX: 4, gridY: 4, gridW: 4, gridH: 4, series: [{ metricKey: 'operating_cash_flow' }], vizConfig: { compare: true }, sequence: 5 },
  { id: 'ov-fcf', widgetType: 'stat_card', title: 'Free Cash Flow', subtitle: null, gridX: 8, gridY: 4, gridW: 4, gridH: 4, series: [{ metricKey: 'free_cash_flow' }], vizConfig: { compare: true }, sequence: 6 },
  { id: 'ov-fin-health', widgetType: 'financial_health', title: 'Financial Health & Solvency', subtitle: 'Liquidity · Profitability · Leverage', gridX: 0, gridY: 8, gridW: 12, gridH: 5, series: [], vizConfig: {}, sequence: 7 },
  {
    id: 'ov-trend', widgetType: 'bar_chart', title: 'Revenue vs EBITDA', subtitle: null, gridX: 0, gridY: 13, gridW: 6, gridH: 7,
    series: [{ metricKey: 'revenue', label: 'Revenue' }, { metricKey: 'ebitda', label: 'EBITDA' }], vizConfig: { legend: true }, sequence: 8,
  },
  {
    id: 'ov-margins', widgetType: 'line_chart', title: 'Margin Trends', subtitle: null, gridX: 6, gridY: 13, gridW: 6, gridH: 7,
    series: [
      { metricKey: 'gross_margin_pct', label: 'Gross %' }, { metricKey: 'ebitda_margin_pct', label: 'EBITDA %' }, { metricKey: 'pat_margin_pct', label: 'PAT %' },
    ], vizConfig: { legend: true }, sequence: 9,
  },
  { id: 'ov-period-summary', widgetType: 'period_summary', title: 'Period Summary', subtitle: null, gridX: 0, gridY: 20, gridW: 12, gridH: 7, series: [], vizConfig: {}, sequence: 10 },
  {
    id: 'ov-yoy', widgetType: 'yoy_variance', title: 'Year-on-Year Variance', subtitle: null, gridX: 0, gridY: 27, gridW: 6, gridH: 6,
    series: [
      { metricKey: 'revenue' },
      { metricKey: 'gross_profit' },
      { metricKey: 'ebitda' },
      { metricKey: 'pbt' },
      { metricKey: 'pat' },
      { metricKey: 'employee_cost' },
    ], vizConfig: {}, sequence: 11,
  },
  { id: 'ov-top-customers', widgetType: 'top_customers', title: 'Top 5 Customers by Revenue', subtitle: null, gridX: 6, gridY: 27, gridW: 6, gridH: 6, series: [], vizConfig: {}, sequence: 12 },
];

export const MIS_DEFAULT_WIDGETS: DashboardWidget[] = [
  { id: 'mis-revenue', widgetType: 'stat_card', title: 'Period Revenue', subtitle: null, gridX: 0, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'revenue' }], vizConfig: { compare: true }, sequence: 0 },
  { id: 'mis-gm', widgetType: 'stat_card', title: 'Gross Margin', subtitle: null, gridX: 3, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'gross_margin_pct' }], vizConfig: { compare: true }, sequence: 1 },
  { id: 'mis-em', widgetType: 'stat_card', title: 'EBITDA Margin', subtitle: null, gridX: 6, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'ebitda_margin_pct' }], vizConfig: { compare: true }, sequence: 2 },
  { id: 'mis-pat', widgetType: 'stat_card', title: 'Profit After Tax', subtitle: null, gridX: 9, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'pat' }], vizConfig: { compare: true }, sequence: 3 },
  {
    id: 'mis-trend', widgetType: 'bar_chart', title: 'Revenue, EBITDA & PAT — Monthly Trend', subtitle: null, gridX: 0, gridY: 4, gridW: 12, gridH: 7,
    series: [
      { metricKey: 'revenue', label: 'Revenue' },
      { metricKey: 'ebitda', label: 'EBITDA' },
      { metricKey: 'pat', label: 'PAT' },
    ], vizConfig: { legend: true }, sequence: 4,
  },
  {
    id: 'mis-table', widgetType: 'metric_table', title: 'Monthly MIS — P&L', subtitle: null, gridX: 0, gridY: 11, gridW: 12, gridH: 10,
    series: [
      { metricKey: 'revenue', label: 'Revenue from Operations' },
      { metricKey: 'other_income', label: 'Other Income' },
      { metricKey: 'total_income', label: 'Total Income' },
      { metricKey: 'cost_of_services', label: 'Cost of Services' },
      { metricKey: 'employee_cost', label: 'Employee Benefits' },
      { metricKey: 'other_expenses', label: 'Other Expenses' },
      { metricKey: 'ebitda', label: 'EBITDA (Operating)' },
      { metricKey: 'finance_costs', label: 'Finance Costs' },
      { metricKey: 'depreciation', label: 'Depreciation & Amortisation' },
      { metricKey: 'pbt', label: 'Profit Before Tax' },
      { metricKey: 'pat', label: 'Profit After Tax' },
      { metricKey: 'gross_margin_pct', label: 'Gross Margin %' },
      { metricKey: 'ebitda_margin_pct', label: 'EBITDA Margin %' },
      { metricKey: 'pat_margin_pct', label: 'PAT Margin %' },
    ], vizConfig: {}, sequence: 5,
  },
];

export const RATIOS_DEFAULT_WIDGETS: DashboardWidget[] = [
  { id: 'ratio-current', widgetType: 'gauge', title: 'Current Ratio', subtitle: null, gridX: 0, gridY: 0, gridW: 3, gridH: 5, series: [{ metricKey: 'current_ratio' }], vizConfig: {}, sequence: 0 },
  { id: 'ratio-quick', widgetType: 'gauge', title: 'Quick Ratio', subtitle: null, gridX: 3, gridY: 0, gridW: 3, gridH: 5, series: [{ metricKey: 'quick_ratio' }], vizConfig: {}, sequence: 1 },
  { id: 'ratio-de', widgetType: 'gauge', title: 'Debt / Equity', subtitle: null, gridX: 6, gridY: 0, gridW: 3, gridH: 5, series: [{ metricKey: 'debt_equity' }], vizConfig: {}, sequence: 2 },
  { id: 'ratio-ic', widgetType: 'gauge', title: 'Interest Coverage', subtitle: null, gridX: 9, gridY: 0, gridW: 3, gridH: 5, series: [{ metricKey: 'interest_cover' }], vizConfig: {}, sequence: 3 },
  { id: 'ratio-roe', widgetType: 'gauge', title: 'Return on Equity', subtitle: null, gridX: 0, gridY: 5, gridW: 3, gridH: 5, series: [{ metricKey: 'roe_pct' }], vizConfig: {}, sequence: 4 },
  { id: 'ratio-roce', widgetType: 'gauge', title: 'Return on Capital Employed', subtitle: null, gridX: 3, gridY: 5, gridW: 3, gridH: 5, series: [{ metricKey: 'roce_pct' }], vizConfig: {}, sequence: 5 },
  { id: 'ratio-nm', widgetType: 'gauge', title: 'Net Margin', subtitle: null, gridX: 6, gridY: 5, gridW: 3, gridH: 5, series: [{ metricKey: 'net_margin_pct' }], vizConfig: {}, sequence: 6 },
  { id: 'ratio-dso', widgetType: 'gauge', title: 'Days Sales Outstanding', subtitle: null, gridX: 9, gridY: 5, gridW: 3, gridH: 5, series: [{ metricKey: 'dso_days' }], vizConfig: {}, sequence: 7 },
];

export const TREASURY_DEFAULT_WIDGETS: DashboardWidget[] = [
  { id: 'treas-cash', widgetType: 'stat_card', title: 'Cash & Bank', subtitle: null, gridX: 0, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'cash_and_bank' }], vizConfig: { compare: true }, sequence: 0 },
  { id: 'treas-fd', widgetType: 'stat_card', title: 'Fixed Deposits', subtitle: null, gridX: 3, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'fixed_deposits' }], vizConfig: { compare: true }, sequence: 1 },
  { id: 'treas-mf', widgetType: 'stat_card', title: 'Mutual Funds', subtitle: null, gridX: 6, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'mutual_funds' }], vizConfig: { compare: true }, sequence: 2 },
  { id: 'treas-total', widgetType: 'stat_card', title: 'Total Treasury', subtitle: null, gridX: 9, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'treasury_total' }], vizConfig: { compare: true }, sequence: 3 },
  { id: 'treas-mix', widgetType: 'donut_chart', title: 'Treasury Composition', subtitle: null, gridX: 0, gridY: 4, gridW: 12, gridH: 8, series: [{ metricKey: 'treasury_composition' }], vizConfig: {}, sequence: 4 },
];

export const WORKING_CAPITAL_DEFAULT_WIDGETS: DashboardWidget[] = [
  { id: 'wc-nwc', widgetType: 'stat_card', title: 'Net Working Capital', subtitle: null, gridX: 0, gridY: 0, gridW: 4, gridH: 4, series: [{ metricKey: 'net_working_capital' }], vizConfig: { compare: true }, sequence: 0 },
  { id: 'wc-current', widgetType: 'gauge', title: 'Current Ratio', subtitle: null, gridX: 4, gridY: 0, gridW: 4, gridH: 4, series: [{ metricKey: 'current_ratio' }], vizConfig: {}, sequence: 1 },
  { id: 'wc-quick', widgetType: 'gauge', title: 'Quick Ratio', subtitle: null, gridX: 8, gridY: 0, gridW: 4, gridH: 4, series: [{ metricKey: 'quick_ratio' }], vizConfig: {}, sequence: 2 },
  { id: 'wc-dso', widgetType: 'gauge', title: 'Days Sales Outstanding', subtitle: null, gridX: 0, gridY: 4, gridW: 4, gridH: 5, series: [{ metricKey: 'dso_days' }], vizConfig: {}, sequence: 3 },
  { id: 'wc-dpo', widgetType: 'gauge', title: 'Days Payable Outstanding', subtitle: null, gridX: 4, gridY: 4, gridW: 4, gridH: 5, series: [{ metricKey: 'dpo_days' }], vizConfig: {}, sequence: 4 },
  { id: 'wc-ccc', widgetType: 'gauge', title: 'Cash Conversion Cycle', subtitle: null, gridX: 8, gridY: 4, gridW: 4, gridH: 5, series: [{ metricKey: 'ccc_days' }], vizConfig: {}, sequence: 5 },
];

export const CUSTOMER_MARGIN_DEFAULT_WIDGETS: DashboardWidget[] = [
  { id: 'cm-table', widgetType: 'data_table', title: 'Direct Margin by Customer', subtitle: null, gridX: 0, gridY: 0, gridW: 12, gridH: 8, series: [{ metricKey: 'customer_direct_margin' }], vizConfig: { limit: 10 }, sequence: 0 },
];

export const VENDOR_EXPENSE_DEFAULT_WIDGETS: DashboardWidget[] = [
  { id: 've-table', widgetType: 'data_table', title: 'Vendor Spend by Vendor', subtitle: null, gridX: 0, gridY: 0, gridW: 12, gridH: 8, series: [{ metricKey: 'vendor_expense_by_vendor' }], vizConfig: { limit: 10 }, sequence: 0 },
];

export const BOARDPACK_DEFAULT_WIDGETS: DashboardWidget[] = [
  { id: 'bp-revenue', widgetType: 'stat_card', title: 'Revenue', subtitle: null, gridX: 0, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'revenue' }], vizConfig: { compare: true }, sequence: 0 },
  { id: 'bp-ebitda', widgetType: 'stat_card', title: 'EBITDA', subtitle: null, gridX: 3, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'ebitda' }], vizConfig: { compare: true }, sequence: 1 },
  { id: 'bp-pat', widgetType: 'stat_card', title: 'Profit After Tax', subtitle: null, gridX: 6, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'pat' }], vizConfig: { compare: true }, sequence: 2 },
  { id: 'bp-ocf', widgetType: 'stat_card', title: 'Operating Cash Flow', subtitle: null, gridX: 9, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'operating_cash_flow' }], vizConfig: { compare: true }, sequence: 3 },
  { id: 'bp-current', widgetType: 'gauge', title: 'Current Ratio', subtitle: null, gridX: 0, gridY: 4, gridW: 4, gridH: 5, series: [{ metricKey: 'current_ratio' }], vizConfig: {}, sequence: 4 },
  { id: 'bp-roe', widgetType: 'gauge', title: 'Return on Equity', subtitle: null, gridX: 4, gridY: 4, gridW: 4, gridH: 5, series: [{ metricKey: 'roe_pct' }], vizConfig: {}, sequence: 5 },
  { id: 'bp-de', widgetType: 'gauge', title: 'Debt / Equity', subtitle: null, gridX: 8, gridY: 4, gridW: 4, gridH: 5, series: [{ metricKey: 'debt_equity' }], vizConfig: {}, sequence: 6 },
];

// Balance Sheet — the opt-in supplementary grid alongside BalanceSheetTab's
// permanent, unmodifiable statutory statement (see TabKey's own doc comment
// in dashboard-builder-engine.ts for why 'bs' is safe to customize at all).
// Every widget here binds a REAL already-computed BS summary figure — never
// a line from the statutory table itself, which stays entirely outside this
// grid. The two composition donuts mirror BalanceSheetTab.tsx's own two
// CompositionBar charts (bs_equity_liab_composition / bs_assets_composition
// — see those METRIC_CATALOG entries' own comment for why this is two real
// breakdowns, not one trivial ~50/50 "Assets vs Equity & Liabilities" donut).
export const BALANCE_SHEET_DEFAULT_WIDGETS: DashboardWidget[] = [
  { id: 'bs-total-assets', widgetType: 'stat_card', title: 'Total Assets', subtitle: null, gridX: 0, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'total_assets' }], vizConfig: { compare: true }, sequence: 0 },
  { id: 'bs-total-equity', widgetType: 'stat_card', title: 'Total Equity', subtitle: null, gridX: 3, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'total_equity' }], vizConfig: { compare: true }, sequence: 1 },
  { id: 'bs-total-liabilities', widgetType: 'stat_card', title: 'Total Liabilities', subtitle: null, gridX: 6, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'total_liabilities' }], vizConfig: { compare: true }, sequence: 2 },
  { id: 'bs-nwc', widgetType: 'stat_card', title: 'Net Working Capital', subtitle: null, gridX: 9, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'net_working_capital' }], vizConfig: { compare: true }, sequence: 3 },
  { id: 'bs-current-ratio', widgetType: 'gauge', title: 'Current Ratio', subtitle: null, gridX: 0, gridY: 4, gridW: 6, gridH: 5, series: [{ metricKey: 'current_ratio' }], vizConfig: {}, sequence: 4 },
  { id: 'bs-quick-ratio', widgetType: 'gauge', title: 'Quick Ratio', subtitle: null, gridX: 6, gridY: 4, gridW: 6, gridH: 5, series: [{ metricKey: 'quick_ratio' }], vizConfig: {}, sequence: 5 },
  { id: 'bs-equity-liab-mix', widgetType: 'donut_chart', title: 'Equity & Liabilities Composition', subtitle: null, gridX: 0, gridY: 9, gridW: 6, gridH: 8, series: [{ metricKey: 'bs_equity_liab_composition' }], vizConfig: {}, sequence: 6 },
  { id: 'bs-assets-mix', widgetType: 'donut_chart', title: 'Assets Composition', subtitle: null, gridX: 6, gridY: 9, gridW: 6, gridH: 8, series: [{ metricKey: 'bs_assets_composition' }], vizConfig: {}, sequence: 7 },
  {
    id: 'bs-yoy', widgetType: 'yoy_variance', title: 'Year-on-Year Variance', subtitle: null, gridX: 0, gridY: 17, gridW: 12, gridH: 6,
    series: [
      { metricKey: 'total_assets' },
      { metricKey: 'total_equity' },
      { metricKey: 'non_current_liabilities' },
      { metricKey: 'current_liabilities' },
    ], vizConfig: {}, sequence: 8,
  },
];

// P&L Account — the opt-in supplementary grid alongside PLTab's permanent,
// unmodifiable Schedule III statutory statement (see TabKey's own doc
// comment in dashboard-builder-engine.ts for the same 'pl' split 'bs'
// already established). All 4 KPI widgets bind the new `pl_*` METRIC_CATALOG
// entries — sourced straight from bundle.pl, never bundle.mis.totals — see
// plMetric()'s own doc comment for why the P&L zone specifically needs that
// distinct sourcing (Phase 1 of this build found mis.totals.pat can differ
// from pl.pat by a small rounding residual in a profitable period; binding
// here to pl-sourced metrics makes that class of drift impossible, by
// construction, rather than relying on rate-matching alone). The waterfall
// is `profit_bridge` — a fixed-content widget (like period_summary/
// financial_health/top_customers), reading bundle.pl directly and reusing
// the exact same WaterfallChart component/step construction PLTab.tsx's own
// fixed zone uses, so the two can never visually or numerically diverge.
//
// PBT/PAT bind `pl_pbt`/`pl_pat` (raw currency) here, NOT the `*_margin_pct`
// entries — a real user-reported bug found the starter grid showing "PBT
// Margin: (5.4%)" where the fixed view, a few pixels away, showed "Profit
// Before Tax: (17.69)": both numbers were correct and fully reconciled, but
// a different label over a different KIND of number read as "a different
// widget with a different number" on first glance. Every KPI here now
// matches its fixed-view counterpart's label and value kind exactly —
// currency for currency, same title — so only the caption style (a
// generic YoY% here vs. the fixed view's own "Margin X%" text) differs,
// the same acceptable difference Balance Sheet's own default widgets
// already have relative to its fixed KPI strip.
export const PL_DEFAULT_WIDGETS: DashboardWidget[] = [
  { id: 'pl-total-income', widgetType: 'stat_card', title: 'Total Income', subtitle: null, gridX: 0, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'pl_total_income' }], vizConfig: { compare: true }, sequence: 0 },
  { id: 'pl-total-expenses', widgetType: 'stat_card', title: 'Total Expenses', subtitle: null, gridX: 3, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'pl_total_expenses' }], vizConfig: { compare: true }, sequence: 1 },
  { id: 'pl-pbt', widgetType: 'stat_card', title: 'Profit Before Tax', subtitle: null, gridX: 6, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'pl_pbt' }], vizConfig: { compare: true }, sequence: 2 },
  { id: 'pl-pat', widgetType: 'stat_card', title: 'Profit After Tax', subtitle: null, gridX: 9, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'pl_pat' }], vizConfig: { compare: true }, sequence: 3 },
  { id: 'pl-profit-bridge', widgetType: 'profit_bridge', title: 'Profit Bridge — Revenue to PAT', subtitle: null, gridX: 0, gridY: 4, gridW: 12, gridH: 9, series: [], vizConfig: {}, sequence: 4 },
];

// Cash Flow — the opt-in supplementary grid alongside CashFlowTab's
// permanent, unmodifiable IND AS 7 statutory statement (see TabKey's own doc
// comment in dashboard-builder-engine.ts for the same 'cashflow' split 'bs'
// and 'pl' already established). All 3 KPI widgets bind the existing
// cfMetric()-sourced METRIC_CATALOG entries (free_cash_flow/opening_cash/
// closing_cash) — already thin accessors straight onto bundle.cashflow, the
// identical object CashFlowTab.tsx's own fixed KPI strip reads, confirmed
// byte-for-byte against real Acme Technologies ledger data in this build's
// own Phase 1 diagnostic (since deleted). The waterfall is `cash_bridge` — a
// fixed-content widget (like profit_bridge/period_summary/financial_health/
// top_customers), reading bundle.cashflow directly and reusing the exact
// same WaterfallChart component/step construction CashFlowTab.tsx's own
// fixed zone uses (including the conditional Reconciling Diff step), so the
// two can never visually or numerically diverge.
export const CASHFLOW_DEFAULT_WIDGETS: DashboardWidget[] = [
  { id: 'cf-free-cash-flow', widgetType: 'stat_card', title: 'Free Cash Flow', subtitle: null, gridX: 0, gridY: 0, gridW: 4, gridH: 4, series: [{ metricKey: 'free_cash_flow' }], vizConfig: { compare: true }, sequence: 0 },
  { id: 'cf-opening-cash', widgetType: 'stat_card', title: 'Opening Cash & Bank', subtitle: null, gridX: 4, gridY: 0, gridW: 4, gridH: 4, series: [{ metricKey: 'opening_cash' }], vizConfig: { compare: true }, sequence: 1 },
  { id: 'cf-closing-cash', widgetType: 'stat_card', title: 'Closing Cash & Bank', subtitle: null, gridX: 8, gridY: 0, gridW: 4, gridH: 4, series: [{ metricKey: 'closing_cash' }], vizConfig: { compare: true }, sequence: 2 },
  { id: 'cf-cash-bridge', widgetType: 'cash_bridge', title: 'Cash Bridge — Opening to Closing', subtitle: null, gridX: 0, gridY: 4, gridW: 12, gridH: 9, series: [], vizConfig: {}, sequence: 3 },
];

// Notes to Accounts — the opt-in supplementary grid alongside NotesTab.tsx's
// permanent, unmodifiable Schedule III note schedule (see TabKey's own doc
// comment in dashboard-builder-engine.ts for the same 'notes' split 'bs'/
// 'pl'/'cashflow' already established). The 4 KPI widgets bind the new
// `notes_*` METRIC_CATALOG entries — thin accessors onto bundle.notes/
// prev_notes, the identical AggregatedNote[] arrays NotesTab.tsx's own fixed
// KPI strip reads. Note Index is `note_index` — a fixed-content widget (like
// top_customers/profit_bridge/cash_bridge), reading bundle.notes/prev_notes
// directly and reusing jumpToNoteCard() (lib/utils/note-navigation.ts), the
// exact function the fixed zone's own Note Index and cross-tab jump both
// use, so a row clicked here always lands on the same real note card.
export const NOTES_DEFAULT_WIDGETS: DashboardWidget[] = [
  { id: 'notes-total-count', widgetType: 'stat_card', title: 'Total Notes', subtitle: null, gridX: 0, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'notes_total_count' }], vizConfig: { compare: false }, sequence: 0 },
  { id: 'notes-eq-liab', widgetType: 'stat_card', title: 'Equity & Liabilities Notes', subtitle: null, gridX: 3, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'notes_eq_liab_total' }], vizConfig: { compare: true }, sequence: 1 },
  { id: 'notes-assets', widgetType: 'stat_card', title: 'Assets Notes', subtitle: null, gridX: 6, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'notes_assets_total' }], vizConfig: { compare: true }, sequence: 2 },
  { id: 'notes-pl', widgetType: 'stat_card', title: 'Income & Expense Notes', subtitle: null, gridX: 9, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'notes_pl_total' }], vizConfig: { compare: true }, sequence: 3 },
  { id: 'notes-index', widgetType: 'note_index', title: 'Note Index', subtitle: null, gridX: 0, gridY: 4, gridW: 12, gridH: 8, series: [], vizConfig: {}, sequence: 4 },
];

/**
 * Every fixed tab's starter widget set, keyed by tab — the single map used
 * wherever a fixed tab's "what would Customize start from" layout is needed
 * outside that tab's own component: copying a fixed tab into a new custom
 * tab ("start from an existing tab", lib/db/queries/custom-tabs.ts) and the
 * starter-layout audit tests.
 */
export const STARTER_WIDGETS_BY_TAB: Record<FixedTabKey, DashboardWidget[]> = {
  'my-dashboard': SYSTEM_DEFAULT_WIDGETS,
  overview: OVERVIEW_DEFAULT_WIDGETS,
  mis: MIS_DEFAULT_WIDGETS,
  ratios: RATIOS_DEFAULT_WIDGETS,
  funds: TREASURY_DEFAULT_WIDGETS,
  wc: WORKING_CAPITAL_DEFAULT_WIDGETS,
  'customer-margin': CUSTOMER_MARGIN_DEFAULT_WIDGETS,
  'vendor-expense': VENDOR_EXPENSE_DEFAULT_WIDGETS,
  boardpack: BOARDPACK_DEFAULT_WIDGETS,
  bs: BALANCE_SHEET_DEFAULT_WIDGETS,
  pl: PL_DEFAULT_WIDGETS,
  cashflow: CASHFLOW_DEFAULT_WIDGETS,
  notes: NOTES_DEFAULT_WIDGETS,
};
