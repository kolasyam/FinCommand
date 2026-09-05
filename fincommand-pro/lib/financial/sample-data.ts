import type { TbLedgerRow } from './tb-engine';

/**
 * Synthetic "sample mode" dataset — unlike the original frontend (which had
 * a separate hand-hardcoded r/c/e/o/d model just for Overview/MIS charts,
 * plus static hardcoded mockup markup for every other tab), this dataset is
 * a real, internally-balanced set of tb_ledgers rows that runs through the
 * exact same lib/financial/tb-engine.ts used for live API data. Every one
 * of the 14 dashboard tabs is driven by real computed output in both modes.
 *
 * Design: all Balance Sheet ledgers carry their full balance as an opening
 * balance with ZERO monthly movement, so the BS is identical (and balanced:
 * Assets = Equity + Liabilities) at any period cut — annual, quarterly, or
 * half-yearly. P&L ledgers (revenue/costs) carry monthly movements with
 * realistic seasonality and zero opening balance, matching how a real new
 * financial year's P&L accounts start at zero. FY24/FY23 are the same
 * shape scaled down by a constant factor, which preserves the BS balance
 * identity automatically.
 */

export type SampleFyKey = 'FY25' | 'FY24' | 'FY23';

export interface SampleFyMeta {
  id: string;
  label: string;
  short_label: string;
  start_date: string;
  end_date: string;
  year_type: 'FY';
  is_locked: boolean;
}

export const SAMPLE_FY_META: Record<SampleFyKey, SampleFyMeta> = {
  FY25: { id: 'sample-fy25', label: 'FY 2024-25', short_label: 'FY25', start_date: '2024-04-01', end_date: '2025-03-31', year_type: 'FY', is_locked: false },
  FY24: { id: 'sample-fy24', label: 'FY 2023-24', short_label: 'FY24', start_date: '2023-04-01', end_date: '2024-03-31', year_type: 'FY', is_locked: false },
  FY23: { id: 'sample-fy23', label: 'FY 2022-23', short_label: 'FY23', start_date: '2022-04-01', end_date: '2023-03-31', year_type: 'FY', is_locked: false },
};

export const SAMPLE_FY_ORDER: SampleFyKey[] = ['FY25', 'FY24', 'FY23'];

/**
 * Illustrative customer mix for the Executive Overview "Top Customers" card
 * in sample mode only. Unlike live mode — where computeTopCustomers() (see
 * tb-engine.ts) uses real Zoho Sales-by-Customer data and honestly returns
 * [] when none exists — sample mode's entire dataset is already a synthetic
 * demo company, so fictional customer names here are consistent with the
 * rest of the demo rather than data presented as real. Percentages are
 * applied to whatever revenue the selected period actually computes to
 * (lib/dashboard/compute-local.ts), so they scale correctly across annual/
 * quarterly/half-year views instead of being a fixed Rupee amount.
 */
export const SAMPLE_TOP_CUSTOMERS: { customer: string; pct_of_total: number }[] = [
  { customer: 'TechCorp Global', pct_of_total: 32.5 },
  { customer: 'FinServ India', pct_of_total: 24.0 },
  { customer: 'RetailMax', pct_of_total: 15.0 },
  { customer: 'ManuCo Ltd', pct_of_total: 10.5 },
  { customer: 'GovProject A', pct_of_total: 6.0 },
];

/**
 * Illustrative vendor mix for the Vendor Expense Report tab in sample mode
 * only. Live mode's equivalent (computeVendorExpense() in tb-engine.ts)
 * uses real Zoho Bills data and honestly returns [] when none exists —
 * percentages here are applied to the period's total expenses (see
 * compute-local.ts), same scaling convention as SAMPLE_TOP_CUSTOMERS above.
 */
export const SAMPLE_VENDOR_EXPENSE: { vendor: string; pct_of_total: number }[] = [
  { vendor: 'CloudHost Infrastructure Pvt Ltd', pct_of_total: 28.0 },
  { vendor: 'Prime Staffing Solutions', pct_of_total: 22.0 },
  { vendor: 'Metro Office Realty', pct_of_total: 18.0 },
  { vendor: 'Apex Legal & Compliance', pct_of_total: 14.0 },
  { vendor: 'BlueWave Marketing Agency', pct_of_total: 10.0 },
  { vendor: 'Sundry Vendors (multiple, below reporting threshold)', pct_of_total: 8.0 },
];

/**
 * Illustrative direct-cost tagging for the Customer Margin Report tab, in
 * sample mode only — deliberately covers only 2 of the 5 SAMPLE_TOP_CUSTOMERS
 * (as a fraction of that customer's own revenue), demonstrating what an org
 * that DOES use Zoho's billable-expense-to-customer tagging looks like. Most
 * real orgs never use this tagging at all (see tb_customer_cost's schema
 * comment) — live mode's equivalent is computeCustomerMargin() in
 * tb-engine.ts, which honestly reports org_tracks_direct_cost=false when
 * that's the real, common case, unlike this demo's deliberately-illustrated
 * happy path.
 */
export const SAMPLE_CUSTOMER_DIRECT_COST: { customer: string; pct_of_revenue: number }[] = [
  { customer: 'TechCorp Global', pct_of_revenue: 22.0 },
  { customer: 'FinServ India', pct_of_revenue: 18.0 },
];

const SCALE: Record<SampleFyKey, number> = { FY25: 1, FY24: 0.78, FY23: 0.635 };

function dr(monthly: number[]): number[] { return monthly; }
function zeros(): number[] { return Array(12).fill(0); }

interface BsLine {
  note_no: number; note_name: string; section: TbLedgerRow['section'];
  treasury_type?: TbLedgerRow['treasury_type']; normal_bal: 'Dr' | 'Cr';
  ledger_name: string; ledger_code: string; amount: number;
}

// Balance Sheet skeleton (₹ Lakhs, FY25 base values) — see module doc for why
// opening-balance-only ledgers keep the BS balanced at every period cut.
const BS_LINES: BsLine[] = [
  // Non-current assets
  { note_no: 10, note_name: 'PPE', section: 'anc', normal_bal: 'Dr', ledger_name: 'Plant, Machinery, Furniture & Computers (net)', ledger_code: 'S1001', amount: 6800 },
  { note_no: 11, note_name: 'ROU Assets', section: 'anc', normal_bal: 'Dr', ledger_name: 'Right-of-Use Asset — Office (net)', ledger_code: 'S1011', amount: 420 },
  { note_no: 12, note_name: 'Intangibles', section: 'anc', normal_bal: 'Dr', ledger_name: 'Computer Software (net)', ledger_code: 'S1021', amount: 380 },
  { note_no: 14, note_name: 'Other NC Assets', section: 'anc', normal_bal: 'Dr', ledger_name: 'Security Deposit & Advance Tax (NC)', ledger_code: 'S1041', amount: 210 },
  // Current assets
  { note_no: 13, note_name: 'Investments Current', section: 'ac', treasury_type: 'mf', normal_bal: 'Dr', ledger_name: 'Liquid Mutual Funds', ledger_code: 'S1033', amount: 850 },
  { note_no: 15, note_name: 'Inventories', section: 'ac', normal_bal: 'Dr', ledger_name: 'Traded Goods / Stock-in-Trade', ledger_code: 'S1051', amount: 424 },
  { note_no: 16, note_name: 'Trade Receivables', section: 'ac', normal_bal: 'Dr', ledger_name: 'Sundry Debtors', ledger_code: 'S1061', amount: 3480 },
  { note_no: 19, note_name: 'Cash & CE', section: 'ac', treasury_type: 'cash', normal_bal: 'Dr', ledger_name: 'Cash in Hand', ledger_code: 'S2001', amount: 42 },
  { note_no: 19, note_name: 'Cash & CE', section: 'ac', treasury_type: 'bank_ca', normal_bal: 'Dr', ledger_name: 'HDFC Bank — Current Account', ledger_code: 'S2101', amount: 680 },
  { note_no: 19, note_name: 'Cash & CE', section: 'ac', treasury_type: 'bank_sb', normal_bal: 'Dr', ledger_name: 'Kotak Bank — Savings / Sweep', ledger_code: 'S2201', amount: 560 },
  { note_no: 20, note_name: 'Bank Balances (FDs)', section: 'ac', treasury_type: 'fd', normal_bal: 'Dr', ledger_name: 'HDFC Fixed Deposit', ledger_code: 'S2301', amount: 2400 },
  { note_no: 21, note_name: 'Loans & Advances', section: 'ac', normal_bal: 'Dr', ledger_name: 'Staff Advance & Prepaid Expenses', ledger_code: 'S1071', amount: 340 },
  { note_no: 23, note_name: 'Other Current Assets', section: 'ac', normal_bal: 'Dr', ledger_name: 'GST ITC & TDS Receivable', ledger_code: 'S1081', amount: 560 },
  // Equity
  { note_no: 1, note_name: 'Share Capital', section: 'eq', normal_bal: 'Cr', ledger_name: 'Equity Share Capital', ledger_code: 'S3001', amount: 10000 },
  { note_no: 2, note_name: 'Other Equity', section: 'eq', normal_bal: 'Cr', ledger_name: 'Reserves & Retained Earnings', ledger_code: 'S3011', amount: 1000 },
  // Non-current liabilities
  { note_no: 3, note_name: 'Long-Term Borrowings', section: 'lnc', normal_bal: 'Cr', ledger_name: 'Term Loan — HDFC Bank', ledger_code: 'S4001', amount: 1800 },
  { note_no: 4, note_name: 'Lease Liabilities', section: 'lnc', normal_bal: 'Cr', ledger_name: 'Lease Liability — Long Term', ledger_code: 'S4011', amount: 180 },
  { note_no: 5, note_name: 'Deferred Tax', section: 'lnc', normal_bal: 'Cr', ledger_name: 'Deferred Tax Liability', ledger_code: 'S4021', amount: 60 },
  { note_no: 6, note_name: 'Long-Term Provisions', section: 'lnc', normal_bal: 'Cr', ledger_name: 'Gratuity & Leave Encashment', ledger_code: 'S4031', amount: 140 },
  // Current liabilities
  { note_no: 7, note_name: 'Trade Payables', section: 'lc', normal_bal: 'Cr', ledger_name: 'MSME & Other Trade Creditors', ledger_code: 'S5001', amount: 2140 },
  { note_no: 8, note_name: 'Other Financial Liabilities', section: 'lc', normal_bal: 'Cr', ledger_name: 'Accrued Salaries & Lease Liability (Current)', ledger_code: 'S5011', amount: 620 },
  { note_no: 9, note_name: 'ST Borrowings', section: 'lc', normal_bal: 'Cr', ledger_name: 'Working Capital Loan — HDFC', ledger_code: 'S5021', amount: 480 },
  { note_no: 17, note_name: 'Other Current Liabilities', section: 'lc', normal_bal: 'Cr', ledger_name: 'Statutory Dues & Advance from Customers', ledger_code: 'S5031', amount: 726 },
];

// P&L monthly seasonality (₹ Lakhs, FY25 base) — revenue/cost/employee/other-expense
// arrays are the same shape as the original frontend's hardcoded D.FY.FY25 sample.
const PL_MONTHLY = {
  revenue:      [2012,2104,2218,2340,2280,2420,2510,2680,2590,2720,2850,2736],
  other_income: [40,42,44,46,44,46,48,50,48,50,52,50],
  cos:          [964,1009,1064,1123,1094,1161,1205,1286,1243,1306,1368,1313],
  employee:     [624,652,687,725,706,750,777,830,803,843,883,760],
  finance:      [16,16,16,17,17,17,17,17,17,18,18,17],
  depreciation: [66,66,66,68,68,68,69,69,69,70,70,69],
  other_exp:    [168,175,185,195,190,202,209,223,216,226,237,234],
};

function scaleArr(arr: number[], factor: number): number[] {
  return arr.map(v => Math.round(v * factor));
}

let cachedByFy: Partial<Record<SampleFyKey, TbLedgerRow[]>> = {};

export function buildSampleLedgers(fyKey: SampleFyKey): TbLedgerRow[] {
  if (cachedByFy[fyKey]) return cachedByFy[fyKey]!;

  const factor = SCALE[fyKey];
  const rows: TbLedgerRow[] = [];

  // Balance sheet ledgers: full opening balance, zero movement all year.
  BS_LINES.forEach((line, i) => {
    const amt = Math.round(line.amount * factor);
    const isDr = line.normal_bal === 'Dr';
    rows.push({
      id: `sample-bs-${fyKey}-${i}`,
      ledger_code: line.ledger_code,
      ledger_name: line.ledger_name,
      note_no: line.note_no,
      note_name: line.note_name,
      section: line.section,
      treasury_type: line.treasury_type ?? null,
      normal_bal: line.normal_bal,
      op_dr: isDr ? amt : 0,
      op_cr: isDr ? 0 : amt,
      m1_dr: 0, m1_cr: 0, m2_dr: 0, m2_cr: 0, m3_dr: 0, m3_cr: 0, m4_dr: 0, m4_cr: 0,
      m5_dr: 0, m5_cr: 0, m6_dr: 0, m6_cr: 0, m7_dr: 0, m7_cr: 0, m8_dr: 0, m8_cr: 0,
      m9_dr: 0, m9_cr: 0, m10_dr: 0, m10_cr: 0, m11_dr: 0, m11_cr: 0, m12_dr: 0, m12_cr: 0,
    });
  });

  // P&L ledgers: zero opening balance, seasonal monthly movement.
  const plLine = (
    code: string, name: string, note_no: number, note_name: string,
    section: 'inc' | 'exp', normal_bal: 'Dr' | 'Cr', monthly: number[]
  ) => {
    const scaled = scaleArr(monthly, factor);
    const row: TbLedgerRow = {
      id: `sample-pl-${fyKey}-${code}`,
      ledger_code: code, ledger_name: name, note_no, note_name, section,
      treasury_type: null, normal_bal, op_dr: 0, op_cr: 0,
    };
    scaled.forEach((v, mi) => {
      const m = mi + 1;
      if (normal_bal === 'Cr') { row[`m${m}_dr`] = 0; row[`m${m}_cr`] = v; }
      else { row[`m${m}_dr`] = v; row[`m${m}_cr`] = 0; }
    });
    return row;
  };

  const revTotal = PL_MONTHLY.revenue;
  rows.push(plLine('S6001_1', 'TechCorp Global (BFSI)', 20, 'Revenue from Operations', 'inc', 'Cr', revTotal.map(v => Math.round(v * 0.35))));
  rows.push(plLine('S6001_2', 'FinServ India (BFSI)', 20, 'Revenue from Operations', 'inc', 'Cr', revTotal.map(v => Math.round(v * 0.28))));
  rows.push(plLine('S6001_3', 'RetailMax (Retail)', 20, 'Revenue from Operations', 'inc', 'Cr', revTotal.map(v => Math.round(v * 0.18))));
  rows.push(plLine('S6001_4', 'ManuCo Ltd (Mfg)', 20, 'Revenue from Operations', 'inc', 'Cr', revTotal.map(v => Math.round(v * 0.12))));
  rows.push(plLine('S6001_5', 'GovProject A (Govt)', 20, 'Revenue from Operations', 'inc', 'Cr', revTotal.map(v => Math.round(v * 0.07))));
  rows.push(plLine('S6011', 'Interest on FDs & Dividend from MFs', 21, 'Other Income', 'inc', 'Cr', dr(PL_MONTHLY.other_income)));
  rows.push(plLine('S7001', 'Subcontracting & Cloud Infrastructure Costs', 22, 'Cost of Services', 'exp', 'Dr', dr(PL_MONTHLY.cos)));
  rows.push(plLine('S7011', 'Salaries, PF & Employee Benefits', 23, 'Employee Benefits', 'exp', 'Dr', dr(PL_MONTHLY.employee)));
  rows.push(plLine('S7021', 'Interest on Term Loans & Leases', 24, 'Finance Costs', 'exp', 'Dr', dr(PL_MONTHLY.finance)));
  rows.push(plLine('S7031', 'Depreciation on PPE, ROU & Intangibles', 25, 'Depreciation & Amort.', 'exp', 'Dr', dr(PL_MONTHLY.depreciation)));
  rows.push(plLine('S7041', 'Rent, Marketing, Professional & Admin Costs', 26, 'Other Expenses', 'exp', 'Dr', dr(PL_MONTHLY.other_exp)));

  cachedByFy[fyKey] = rows;
  return rows;
}

/** Test/dev helper — clears the module-level cache (values are static, so this is rarely needed). */
export function _resetSampleCache(): void {
  cachedByFy = {};
}
