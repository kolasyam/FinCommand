/**
 * computeCashFlow()'s adjustments/investing/financing objects use plain
 * snake_case keys as their field names (e.g. `finance_costs`), not display
 * text — shared by the on-screen tab, PDF, and Excel exports so a label
 * only has to be written once and never drifts between them. The Working
 * Capital section's keys are already human-readable (built from real note
 * names, e.g. "(Increase)/Decrease in Trade Receivables") and don't need
 * this. A generic fallback prettifier handles any key not explicitly named
 * below rather than ever showing a raw snake_case string to the user.
 */
export const CF_LABELS: Record<string, string> = {
  depreciation: 'Depreciation & Amortisation',
  finance_costs: 'Finance Costs',
  interest_income: 'Less: Interest / Other Income',
  net_non_current_assets: 'Net Purchase of Fixed Assets & Investments',
  fd_movement: 'Movement in Fixed Deposits',
  mf_movement: 'Movement in Mutual Funds',
  interest_dividend_received: 'Interest & Dividend Income Received',
  long_term_borrowings_and_leases_movement: 'Long-Term Borrowings & Lease Liabilities (Net)',
  short_term_borrowings_movement: 'Short-Term Borrowings (Net)',
  finance_costs_paid: 'Finance Costs Paid',
  equity_movement_net: 'Equity Raised / (Dividends Paid), Net',
};

export function cfLabel(key: string): string {
  return CF_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
