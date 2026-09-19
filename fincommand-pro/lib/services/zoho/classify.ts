/** Zoho account → Schedule III note/section classification (the fallback when ledger_master has no mapping). */

export const ZOHO_TYPE_MAP: Record<string, { note_no: number; note_name: string; section: string; normal_bal: string; treasury_type?: string }> = {
  // Cash & Bank
  cash: { note_no: 19, note_name: 'Cash and Cash Equivalents', section: 'ac', normal_bal: 'Dr', treasury_type: 'cash' },
  petty_cash: { note_no: 19, note_name: 'Cash and Cash Equivalents', section: 'ac', normal_bal: 'Dr', treasury_type: 'cash' },
  bank: { note_no: 19, note_name: 'Cash and Cash Equivalents', section: 'ac', normal_bal: 'Dr', treasury_type: 'bank_ca' },
  bank_account: { note_no: 19, note_name: 'Cash and Cash Equivalents', section: 'ac', normal_bal: 'Dr', treasury_type: 'bank_ca' },
  
  // Current Assets
  accounts_receivable: { note_no: 16, note_name: 'Trade Receivables', section: 'ac', normal_bal: 'Dr' },
  receivable: { note_no: 16, note_name: 'Trade Receivables', section: 'ac', normal_bal: 'Dr' },
  inventory: { note_no: 15, note_name: 'Inventories', section: 'ac', normal_bal: 'Dr' },
  stock: { note_no: 15, note_name: 'Inventories', section: 'ac', normal_bal: 'Dr' },
  other_asset: { note_no: 23, note_name: 'Other Current Assets', section: 'ac', normal_bal: 'Dr' },
  other_current_asset: { note_no: 23, note_name: 'Other Current Assets', section: 'ac', normal_bal: 'Dr' },
  
  // Non-Current Assets
  fixed_asset: { note_no: 10, note_name: 'Property, Plant and Equipment', section: 'anc', normal_bal: 'Dr' },
  // Bare 'asset' deliberately maps to the *current*-asset default (same as
  // 'other_asset'), not PPE — this is the generic type Zoho reports when it
  // has no more specific classification to offer. It previously pointed at
  // PPE, which meant every unrecognized asset-side ledger (advances, GST
  // input credits, TDS receivables, prepaid expenses — all genuinely
  // current) got silently bucketed as non-current fixed assets, because
  // this exact-key match in classifyZohoLedger()'s step 1 short-circuited
  // its own smarter step-3 fixed-vs-current heuristic a few lines down.
  // Real fixed assets still route correctly via that step-3 check (name
  // contains "fixed") or via more specific keyword rules above it.
  asset: { note_no: 23, note_name: 'Other Current Assets', section: 'ac', normal_bal: 'Dr' },
  other_non_current_asset: { note_no: 14, note_name: 'Other Non-Current Assets', section: 'anc', normal_bal: 'Dr' },
  
  // Current Liabilities
  accounts_payable: { note_no: 7, note_name: 'Trade Payables', section: 'lc', normal_bal: 'Cr' },
  payable: { note_no: 7, note_name: 'Trade Payables', section: 'lc', normal_bal: 'Cr' },
  short_term_liability: { note_no: 9, note_name: 'Short-Term Borrowings', section: 'lc', normal_bal: 'Cr' },
  other_liability: { note_no: 17, note_name: 'Other Current Liabilities', section: 'lc', normal_bal: 'Cr' },
  other_current_liability: { note_no: 17, note_name: 'Other Current Liabilities', section: 'lc', normal_bal: 'Cr' },

  // Non-Current Liabilities
  other_non_current_liability: { note_no: 3, note_name: 'Long-Term Borrowings', section: 'lnc', normal_bal: 'Cr' },
  long_term_liability: { note_no: 3, note_name: 'Long-Term Borrowings', section: 'lnc', normal_bal: 'Cr' },

  // Equity
  equity: { note_no: 1, note_name: 'Share Capital', section: 'eq', normal_bal: 'Cr' },
  equity_share_capital: { note_no: 1, note_name: 'Share Capital', section: 'eq', normal_bal: 'Cr' },
  other_equity: { note_no: 2, note_name: 'Other Equity', section: 'eq', normal_bal: 'Cr' },
  retained_earnings: { note_no: 2, note_name: 'Other Equity', section: 'eq', normal_bal: 'Cr' },

  // Income
  income: { note_no: 20, note_name: 'Revenue from Operations', section: 'inc', normal_bal: 'Cr' },
  sales: { note_no: 20, note_name: 'Revenue from Operations', section: 'inc', normal_bal: 'Cr' },
  revenue: { note_no: 20, note_name: 'Revenue from Operations', section: 'inc', normal_bal: 'Cr' },
  other_income: { note_no: 21, note_name: 'Other Income', section: 'inc', normal_bal: 'Cr' },

  // Expenses
  cost_of_goods_sold: { note_no: 22, note_name: 'Cost of Services', section: 'exp', normal_bal: 'Dr' },
  cogs: { note_no: 22, note_name: 'Cost of Services', section: 'exp', normal_bal: 'Dr' },
  direct_expense: { note_no: 22, note_name: 'Cost of Services', section: 'exp', normal_bal: 'Dr' },
  employee_expense: { note_no: 23, note_name: 'Employee Benefits', section: 'exp', normal_bal: 'Dr' },
  payroll_expense: { note_no: 23, note_name: 'Employee Benefits', section: 'exp', normal_bal: 'Dr' },
  finance_cost: { note_no: 24, note_name: 'Finance Costs', section: 'exp', normal_bal: 'Dr' },
  interest_expense: { note_no: 24, note_name: 'Finance Costs', section: 'exp', normal_bal: 'Dr' },
  depreciation: { note_no: 25, note_name: 'Depreciation & Amort.', section: 'exp', normal_bal: 'Dr' },
  expense: { note_no: 26, note_name: 'Other Expenses', section: 'exp', normal_bal: 'Dr' },
  other_expense: { note_no: 26, note_name: 'Other Expenses', section: 'exp', normal_bal: 'Dr' },
  operating_expense: { note_no: 26, note_name: 'Other Expenses', section: 'exp', normal_bal: 'Dr' },
};

export function classifyZohoLedger(nameKey: string, rawType: string) {
  const normType = rawType.toLowerCase().replace(/[\s_-]+/g, '_');
  const lowerName = nameKey.toLowerCase().trim();

  // 1. Direct type map check
  let fallback = ZOHO_TYPE_MAP[normType] || ZOHO_TYPE_MAP[rawType.toLowerCase().trim()];

  // 2. High-precision keyword check
  if (lowerName.includes('share capital') || (lowerName.includes('capital') && !lowerName.includes('work')) || lowerName.includes('securities premium') || lowerName.includes('retained earnings')) {
    return lowerName.includes('premium') || lowerName.includes('earnings') ? ZOHO_TYPE_MAP['other_equity'] : ZOHO_TYPE_MAP['equity_share_capital'];
  }
  if (lowerName.includes('loan') || lowerName.includes('borrowing') || lowerName.includes(' (od)') || lowerName.includes(' overdraft')) {
    return lowerName.includes('long') || lowerName.includes('term loan') ? ZOHO_TYPE_MAP['long_term_liability'] : ZOHO_TYPE_MAP['short_term_liability'];
  }
  if (lowerName.includes('sales') || lowerName.includes('revenue') || lowerName.includes('income from services')) {
    return ZOHO_TYPE_MAP['sales'];
  }
  if (lowerName.includes('interest income') || lowerName.includes('other income') || lowerName.includes('other charges received') || lowerName.includes('dividend')) {
    return ZOHO_TYPE_MAP['other_income'];
  }
  if (lowerName.includes('salary') || lowerName.includes('salaries') || lowerName.includes('wages') || lowerName.includes('payroll') || lowerName.includes('pf ') || lowerName.includes('esic') || lowerName.includes('employee')) {
    // "...Payable"-suffixed names are the obvious liability case, but a
    // genuine Zoho liability signal (e.g. "EPF Employee Contribution" and
    // "PF Employer Contribution" under Zoho's own Current Liabilities group
    // — accrued-but-unremitted withholdings, not yet a P&L cost) must win
    // even when the name itself doesn't say "payable".
    if (lowerName.includes('payable') || normType.includes('liability') || normType.includes('payable')) {
      return ZOHO_TYPE_MAP['other_current_liability'];
    }
    return ZOHO_TYPE_MAP['employee_expense'];
  }
  if (lowerName.includes('deprec') || lowerName.includes('amort')) {
    return ZOHO_TYPE_MAP['depreciation'];
  }
  if (
    (lowerName.includes('interest') && (lowerName.includes('exp') || lowerName.includes('paid') || lowerName.includes('charge'))) ||
    lowerName.includes('finance cost') || lowerName.includes('financial cost') ||
    lowerName.includes('financial charge') || lowerName.includes('bank charge') ||
    lowerName.includes('loan processing')
  ) {
    return ZOHO_TYPE_MAP['finance_cost'];
  }
  if (lowerName.includes('accounts payable') || lowerName.includes('trade payable') || lowerName.includes('creditor')) {
    return ZOHO_TYPE_MAP['accounts_payable'];
  }
  if (lowerName.includes('accounts receivable') || lowerName.includes('trade receivable') || lowerName.includes('debtor')) {
    return ZOHO_TYPE_MAP['accounts_receivable'];
  }
  if (lowerName.includes('fixed deposit') || lowerName.includes(' fd')) {
    return ZOHO_TYPE_MAP['bank'];
  }

  if (fallback) return fallback;

  // 3. Category inference fallback — normType (Zoho's own reported nature —
  // asset/liability/income/expense) is a *stronger* signal than a name
  // substring and must be checked first. Previously, a name merely
  // containing "tax", "fee", or "rent" forced an Expense classification
  // even when normType clearly said 'liability' — e.g. "Tax Payable",
  // "Professional Tax Payable", "TDS on Professional Fees" and
  // "194I_rent TDS Payable" are genuine Balance Sheet Current Liabilities
  // in Zoho's own report, but were landing in P&L "Other Expenses" (Note
  // 26) and silently distorting EBITDA/PAT. Liability/payable/receivable/
  // asset checks now run before the name-keyword expense catch-all.
  if (normType.includes('income') || normType.includes('sales') || normType.includes('revenue')) {
    return ZOHO_TYPE_MAP['income'];
  }
  if (normType.includes('cogs') || normType.includes('cost')) {
    return ZOHO_TYPE_MAP['cost_of_goods_sold'];
  }
  if (normType.includes('payable')) {
    return ZOHO_TYPE_MAP['accounts_payable'];
  }
  if (normType.includes('liability')) {
    return ZOHO_TYPE_MAP['other_liability'];
  }
  if (normType.includes('receivable')) {
    return ZOHO_TYPE_MAP['accounts_receivable'];
  }
  if (normType.includes('asset')) {
    return lowerName.includes('fixed') ? ZOHO_TYPE_MAP['fixed_asset'] : ZOHO_TYPE_MAP['other_asset'];
  }
  if (normType.includes('equity')) {
    return ZOHO_TYPE_MAP['equity'];
  }
  if (normType.includes('expense') || lowerName.includes('expense') || lowerName.includes('exp') || lowerName.includes('fee') || lowerName.includes('rent') || lowerName.includes('tax')) {
    return ZOHO_TYPE_MAP['expense'];
  }
  if (normType.includes('bank') || normType.includes('cash')) {
    return ZOHO_TYPE_MAP['bank'];
  }

  return ZOHO_TYPE_MAP['expense'];
}

const VALID_SECTIONS = new Set(['anc', 'ac', 'eq', 'lnc', 'lc', 'inc', 'exp']);
const VALID_TREASURY = new Set(['cash', 'bank_ca', 'bank_sb', 'fd', 'mf']);

export function sanitizeSection(sec: string | null | undefined): string | null {
  if (!sec) return null;
  const s = sec.toLowerCase().trim();
  if (VALID_SECTIONS.has(s)) return s;
  if (s.includes('asset') && s.includes('non')) return 'anc';
  if (s.includes('asset')) return 'ac';
  if (s.includes('liab') && s.includes('non')) return 'lnc';
  if (s.includes('liab')) return 'lc';
  if (s.includes('equity') || s === 'eq') return 'eq';
  if (s.includes('income') || s.includes('rev') || s === 'inc') return 'inc';
  if (s.includes('exp') || s.includes('cost')) return 'exp';
  return null;
}

export function sanitizeTreasuryType(tr: string | null | undefined): string | null {
  if (!tr) return null;
  const t = tr.toLowerCase().trim();
  if (VALID_TREASURY.has(t)) return t;
  if (t.includes('cash')) return 'cash';
  if (t.includes('bank')) return 'bank_ca';
  if (t.includes('fd') || t.includes('dep')) return 'fd';
  if (t.includes('mf') || t.includes('fund')) return 'mf';
  return null;
}

/**
 * Prefers a specific, recognized category hint (e.g. "Bank" → 'bank') over a
 * broad fallback type — only when the hint is an actual ZOHO_TYPE_MAP key.
 * Zoho's real group names are usually plural ("Other Current Assets",
 * "Fixed Assets", "Other Expenses", "Equities") while this map's keys are
 * singular ("other_current_asset", "fixed_asset", "other_expense",
 * "equity") — a naive lowercase+underscore normalization alone never
 * matches, silently losing this precise signal and falling back to a bare
 * 'asset'/'liability'/'expense' broad type instead. "Equities" specifically
 * needs -ies→-y stemming, not just a trailing-s strip ("equitie" isn't a
 * key) — without it, any equity-side ledger whose *name* doesn't happen to
 * contain "capital"/"share capital"/"premium"/"earnings" (e.g. a bare
 * shareholder or entity name used as the ledger name) falls through to the
 * generic 'liability' broad type and gets misclassified as a Current
 * Liability instead of Equity.
 */
export function classifyHint(categoryHint: string | undefined, broadType: string): string {
  if (!categoryHint) return broadType;
  const norm = categoryHint.toLowerCase().trim().replace(/[\s_-]+/g, '_');
  if (norm in ZOHO_TYPE_MAP) return norm;
  const candidates = [
    norm.endsWith('ies') ? `${norm.slice(0, -3)}y` : null, // equities -> equity
    norm.endsWith('s') && !norm.endsWith('ss') ? norm.slice(0, -1) : null, // assets -> asset
  ];
  for (const c of candidates) {
    if (c && c in ZOHO_TYPE_MAP) return c;
  }
  return broadType;
}
