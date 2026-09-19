import type { DashboardWidget, WidgetKind, WidgetSeriesBinding } from '@/lib/financial/dashboard-builder-engine';

/**
 * The template gallery offered when creating a new custom tab — curated,
 * finance-specific starting layouts, each built ONLY from real
 * METRIC_CATALOG keys (never a fabricated figure), laid out on the same
 * 12-column grid a user edits afterward. A template is copied once into the
 * new tab's company-default layout at creation (lib/db/queries/custom-tabs.ts)
 * and is never re-applied or linked afterward — editing the tab never
 * changes the template, and a future template change never rewrites a tab.
 *
 * tests/unit/dashboard-templates.test.ts proves every template passes
 * parseWidgetsInput() (the exact validation a real Save runs), stays inside
 * the grid, and has no overlapping widgets.
 */

export interface DashboardTemplate {
  key: string;
  name: string;
  description: string;
  icon: string;
  /** Short list of what the reader gets — shown on the gallery card. */
  highlights: string[];
  widgets: DashboardWidget[];
}

let seq = 0;
function w(
  id: string, widgetType: WidgetKind, title: string | null,
  x: number, y: number, width: number, height: number,
  series: (string | WidgetSeriesBinding)[] = [], vizConfig: Record<string, unknown> = {},
): DashboardWidget {
  return {
    id, widgetType, title, subtitle: null,
    gridX: x, gridY: y, gridW: width, gridH: height,
    series: series.map((s) => (typeof s === 'string' ? { metricKey: s } : s)),
    vizConfig, sequence: seq++,
  };
}

export const DASHBOARD_TEMPLATES: DashboardTemplate[] = [
  {
    key: 'cfo-snapshot',
    name: 'CFO Snapshot',
    icon: '🧭',
    description: 'The headline numbers on one screen — performance, cash, and the three ratios lenders ask about first.',
    highlights: ['Revenue, EBITDA, PAT, closing cash', 'Revenue vs EBITDA trend', 'Treasury mix', 'Current ratio, D/E, DSO gauges'],
    widgets: [
      w('cfo-rev', 'stat_card', 'Revenue', 0, 0, 3, 4, ['revenue'], { compare: true }),
      w('cfo-ebitda', 'stat_card', 'EBITDA', 3, 0, 3, 4, ['ebitda'], { compare: true }),
      w('cfo-pat', 'stat_card', 'Profit After Tax', 6, 0, 3, 4, ['pat'], { compare: true }),
      w('cfo-cash', 'stat_card', 'Closing Cash & Bank', 9, 0, 3, 4, ['closing_cash'], { compare: true }),
      w('cfo-trend', 'line_chart', 'Revenue vs EBITDA', 0, 4, 7, 7, [{ metricKey: 'revenue', label: 'Revenue' }, { metricKey: 'ebitda', label: 'EBITDA' }], { legend: true }),
      w('cfo-treasury', 'donut_chart', 'Treasury Composition', 7, 4, 5, 7, ['treasury_composition']),
      w('cfo-cr', 'gauge', 'Current Ratio', 0, 11, 4, 5, ['current_ratio']),
      w('cfo-de', 'gauge', 'Debt / Equity', 4, 11, 4, 5, ['debt_equity']),
      w('cfo-dso', 'gauge', 'Days Sales Outstanding', 8, 11, 4, 5, ['dso_days']),
    ],
  },
  {
    key: 'profitability',
    name: 'Profitability & Margins',
    icon: '📈',
    description: 'Where margin is made and lost — margin trends, the cost lines behind them, and year-on-year movement.',
    highlights: ['Gross, EBITDA, PAT margins + ROE', 'Stacked cost lines by month', 'Margin trend', 'YoY variance table'],
    widgets: [
      w('pr-gm', 'stat_card', 'Gross Margin %', 0, 0, 3, 4, ['gross_margin_pct'], { compare: true }),
      w('pr-em', 'stat_card', 'EBITDA Margin %', 3, 0, 3, 4, ['ebitda_margin_pct'], { compare: true }),
      w('pr-pm', 'stat_card', 'PAT Margin %', 6, 0, 3, 4, ['pat_margin_pct'], { compare: true }),
      w('pr-roe', 'stat_card', 'Return on Equity', 9, 0, 3, 4, ['roe_pct'], { compare: false }),
      w('pr-costs', 'bar_chart', 'Cost Lines by Month', 0, 4, 7, 7,
        [{ metricKey: 'employee_cost', label: 'Employee' }, { metricKey: 'other_expenses', label: 'Other' }, { metricKey: 'finance_costs', label: 'Finance' }],
        { legend: true, stacked: true }),
      w('pr-margins', 'line_chart', 'Margin Trend', 7, 4, 5, 7,
        [{ metricKey: 'ebitda_margin_pct', label: 'EBITDA %' }, { metricKey: 'pat_margin_pct', label: 'PAT %' }], { legend: true }),
      w('pr-yoy', 'yoy_variance', 'Year-on-Year Variance', 0, 11, 12, 6, ['revenue', 'gross_profit', 'ebitda', 'pat']),
    ],
  },
  {
    key: 'liquidity',
    name: 'Liquidity & Working Capital',
    icon: '💧',
    description: 'Can the business meet its obligations — liquidity ratios, the cash conversion cycle, and balance-sheet mix.',
    highlights: ['Current & quick ratio gauges', 'Net working capital', 'DSO / DPO / CCC', 'Asset and funding composition'],
    widgets: [
      w('lq-cr', 'gauge', 'Current Ratio', 0, 0, 4, 5, ['current_ratio']),
      w('lq-qr', 'gauge', 'Quick Ratio', 4, 0, 4, 5, ['quick_ratio']),
      w('lq-cash', 'stat_card', 'Cash Ratio', 8, 0, 4, 5, ['cash_ratio'], { compare: false }),
      w('lq-nwc', 'stat_card', 'Net Working Capital', 0, 5, 3, 4, ['net_working_capital'], { compare: true }),
      w('lq-dso', 'stat_card', 'DSO', 3, 5, 3, 4, ['dso_days'], { compare: false }),
      w('lq-dpo', 'stat_card', 'DPO', 6, 5, 3, 4, ['dpo_days'], { compare: false }),
      w('lq-ccc', 'stat_card', 'Cash Conversion Cycle', 9, 5, 3, 4, ['ccc_days'], { compare: false }),
      w('lq-assets', 'donut_chart', 'Assets Composition', 0, 9, 6, 7, ['bs_assets_composition']),
      w('lq-funding', 'donut_chart', 'Equity & Liabilities Composition', 6, 9, 6, 7, ['bs_equity_liab_composition']),
    ],
  },
  {
    key: 'cash-treasury',
    name: 'Cash & Treasury',
    icon: '🏦',
    description: 'How cash moved this period and where it sits now — the IND AS 7 bridge plus the treasury position.',
    highlights: ['Opening → closing cash bridge', 'Operating & free cash flow', 'Treasury mix', 'FDs, MFs, cash & bank'],
    widgets: [
      w('ct-open', 'stat_card', 'Opening Cash & Bank', 0, 0, 3, 4, ['opening_cash'], { compare: true }),
      w('ct-ocf', 'stat_card', 'Operating Cash Flow', 3, 0, 3, 4, ['operating_cash_flow'], { compare: true }),
      w('ct-fcf', 'stat_card', 'Free Cash Flow', 6, 0, 3, 4, ['free_cash_flow'], { compare: true }),
      w('ct-close', 'stat_card', 'Closing Cash & Bank', 9, 0, 3, 4, ['closing_cash'], { compare: true }),
      w('ct-bridge', 'cash_bridge', 'Cash Bridge', 0, 4, 12, 9),
      w('ct-mix', 'donut_chart', 'Treasury Composition', 0, 13, 6, 7, ['treasury_composition']),
      w('ct-total', 'stat_card', 'Total Treasury', 6, 13, 3, 4, ['treasury_total'], { compare: true }),
      w('ct-fd', 'stat_card', 'Fixed Deposits', 9, 13, 3, 4, ['fixed_deposits'], { compare: true }),
      w('ct-bank', 'stat_card', 'Cash & Bank', 6, 17, 3, 3, ['cash_and_bank'], { compare: true }),
      w('ct-mf', 'stat_card', 'Mutual Funds', 9, 17, 3, 3, ['mutual_funds'], { compare: true }),
    ],
  },
  {
    key: 'board-summary',
    name: 'Board Summary',
    icon: '📑',
    description: 'A board-ready page — the P&L waterfall, solvency, YoY movement, top customers, and space for commentary.',
    highlights: ['Revenue → PAT period summary', 'Financial health & solvency', 'YoY variance', 'Top 5 customers', 'Commentary box'],
    widgets: [
      w('bd-summary', 'period_summary', 'Period Summary', 0, 0, 12, 7),
      w('bd-health', 'financial_health', 'Financial Health & Solvency', 0, 7, 12, 5),
      w('bd-yoy', 'yoy_variance', 'Year-on-Year Variance', 0, 12, 8, 6, ['revenue', 'ebitda', 'pat', 'employee_cost']),
      w('bd-note', 'text_block', 'Commentary', 8, 12, 4, 6, [], { text: 'Add the board commentary for this period here — key drivers, risks, and actions.' }),
      w('bd-customers', 'top_customers', 'Top Customers', 0, 18, 12, 6),
    ],
  },
  {
    key: 'cost-control',
    name: 'Cost Control',
    icon: '🧾',
    description: 'Every major cost line month by month, the biggest vendors, and cost growth against revenue.',
    highlights: ['Employee, other & finance cost trends', 'Month-by-month cost table', 'Top vendors by spend', 'Revenue vs employee cost'],
    widgets: [
      w('cc-emp', 'stat_card_sparkline', 'Employee Benefits', 0, 0, 4, 6, ['employee_cost']),
      w('cc-oex', 'stat_card_sparkline', 'Other Expenses', 4, 0, 4, 6, ['other_expenses']),
      w('cc-fin', 'stat_card_sparkline', 'Finance Costs', 8, 0, 4, 6, ['finance_costs']),
      w('cc-table', 'metric_table', 'Cost Lines by Month', 0, 6, 12, 7, ['employee_cost', 'other_expenses', 'finance_costs', 'depreciation']),
      w('cc-vendors', 'data_table', 'Top Vendors by Spend', 0, 13, 6, 7, ['vendor_expense_by_vendor'], { limit: 10 }),
      w('cc-rev-emp', 'bar_chart', 'Revenue vs Employee Cost', 6, 13, 6, 7,
        [{ metricKey: 'revenue', label: 'Revenue' }, { metricKey: 'employee_cost', label: 'Employee cost' }], { legend: true }),
    ],
  },
];

export function findTemplate(key: string): DashboardTemplate | undefined {
  return DASHBOARD_TEMPLATES.find((t) => t.key === key);
}
