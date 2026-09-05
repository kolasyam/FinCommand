import axios, { type AxiosError } from 'axios';
import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { query, withTransaction } from '@/lib/db/neon';
import { invalidateReportCache } from '@/lib/cache/report-cache';

export const ZOHO_ACCOUNTS: Record<string, string> = {
  IN: 'https://accounts.zoho.in',
  US: 'https://accounts.zoho.com',
  EU: 'https://accounts.zoho.eu',
  AU: 'https://accounts.zoho.com.au',
};
export const ZOHO_API: Record<string, string> = {
  IN: 'https://www.zohoapis.in/books/v3',
  US: 'https://www.zohoapis.com/books/v3',
  EU: 'https://www.zohoapis.eu/books/v3',
  AU: 'https://www.zohoapis.com.au/books/v3',
};

const FY_MONTHS_DR = [
  { name: 'Apr', from_suffix: '04-01', to_suffix: '04-30' },
  { name: 'May', from_suffix: '05-01', to_suffix: '05-31' },
  { name: 'Jun', from_suffix: '06-01', to_suffix: '06-30' },
  { name: 'Jul', from_suffix: '07-01', to_suffix: '07-31' },
  { name: 'Aug', from_suffix: '08-01', to_suffix: '08-31' },
  { name: 'Sep', from_suffix: '09-01', to_suffix: '09-30' },
  { name: 'Oct', from_suffix: '10-01', to_suffix: '10-31' },
  { name: 'Nov', from_suffix: '11-01', to_suffix: '11-30' },
  { name: 'Dec', from_suffix: '12-01', to_suffix: '12-31' },
  { name: 'Jan', next_yr: true, from_suffix: '01-01', to_suffix: '01-31' },
  { name: 'Feb', next_yr: true, from_suffix: '02-01', to_suffix: '02-28' },
  { name: 'Mar', next_yr: true, from_suffix: '03-01', to_suffix: '03-31' },
];

const ZOHO_TYPE_MAP: Record<string, { note_no: number; note_name: string; section: string; normal_bal: string; treasury_type?: string }> = {
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

function classifyZohoLedger(nameKey: string, rawType: string) {
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

function sanitizeSection(sec: string | null | undefined): string | null {
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

function sanitizeTreasuryType(tr: string | null | undefined): string | null {
  if (!tr) return null;
  const t = tr.toLowerCase().trim();
  if (VALID_TREASURY.has(t)) return t;
  if (t.includes('cash')) return 'cash';
  if (t.includes('bank')) return 'bank_ca';
  if (t.includes('fd') || t.includes('dep')) return 'fd';
  if (t.includes('mf') || t.includes('fund')) return 'mf';
  return null;
}

interface ZohoConfigRow {
  company_id: string;
  org_id: string | null;
  access_token: string;
  refresh_token: string;
  token_expiry: string;
  data_center: string;
}

/** Extracts a useful message from a Zoho API error — ported verbatim. */
export function zohoErrorMessage(err: unknown): string {
  const axErr = err as AxiosError<{ message?: string; code?: number }>;
  const data = axErr.response?.data;
  if (data?.message) return `${data.message}${data.code ? ` (code ${data.code})` : ''}`;
  if (typeof data === 'string' && (data as string).trim()) return (data as string).trim();
  return (err as Error).message;
}

export interface ZohoReportLeaf {
  account_id?: string;
  account_code?: string;
  account_name: string;
  /** Signed; positive when in this account's own normal/expected direction (Cr for income, Dr for expense/asset, Cr for liability/equity). */
  total: number;
  depth: number;
  is_child_present: boolean;
  /** Name of the immediately-enclosing group, e.g. "Bank", "Cost of Goods Sold" — a far more precise classification signal than a bare asset/liability/income/expense type. */
  category_hint?: string;
}

/**
 * Generic leaf-account extractor for Zoho's report-tree shape, shared by
 * /reports/profitandloss and /reports/balancesheet — both nest groups
 * inside `account_transactions` down to leaf accounts carrying a single
 * signed `total`. A leaf is any node with an `account_id` and no children.
 */
function extractZohoReportLeaves(topArray: unknown): ZohoReportLeaf[] {
  const list: ZohoReportLeaf[] = [];
  if (!Array.isArray(topArray)) return list;

  const isHeaderName = (name: string) => {
    const l = name.toLowerCase().trim();
    return !l || l === 'total' || l.startsWith('total ');
  };

  function walk(arr: Record<string, unknown>[], parentGroupName?: string) {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (!item) continue;
      const name = String(item.name || item.account_name || '').trim();
      const accId = item.account_id ? String(item.account_id) : undefined;
      const nested = item.account_transactions;
      const hasChildren = Array.isArray(nested) && nested.length > 0;

      if (accId && !hasChildren && name && !isHeaderName(name)) {
        const total = parseFloat(String(item.total ?? item.total_sub_account ?? 0));
        list.push({
          account_id: accId,
          account_code: item.account_code ? String(item.account_code) : undefined,
          account_name: name,
          total: isNaN(total) ? 0 : total,
          depth: typeof item.depth === 'number' ? item.depth : 0,
          is_child_present: item.is_child_present === true,
          category_hint: parentGroupName,
        });
      }

      if (hasChildren) {
        walk(nested as Record<string, unknown>[], name || parentGroupName);
      }
    }
  }

  walk(topArray as Record<string, unknown>[]);
  return list;
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
function classifyHint(categoryHint: string | undefined, broadType: string): string {
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

async function refreshZohoToken(config: ZohoConfigRow): Promise<string> {
  const base = ZOHO_ACCOUNTS[config.data_center] || ZOHO_ACCOUNTS.IN;
  let res;
  try {
    res = await axios.post(`${base}/oauth/v2/token`, null, {
      timeout: 15000,
      params: {
        refresh_token: config.refresh_token,
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type: 'refresh_token',
      },
    });
  } catch (err) {
    throw new Error(`Zoho token refresh failed: ${zohoErrorMessage(err)}`);
  }
  if (res.data.error || !res.data.access_token) {
    await query(
      `UPDATE zoho_config SET is_active=FALSE, last_sync_status='error',
        last_sync_error=$1, updated_at=NOW() WHERE company_id=$2`,
      [`Refresh token invalid (${res.data.error || 'no access_token returned'}). Please reconnect Zoho Books.`, config.company_id]
    );
    throw new Error(`Zoho refresh token is no longer valid (${res.data.error || 'unknown reason'}). Please reconnect Zoho Books.`);
  }
  const { access_token, expires_in } = res.data;
  const expiry = new Date(Date.now() + (expires_in - 60) * 1000);
  await query(`UPDATE zoho_config SET access_token=$1, token_expiry=$2 WHERE company_id=$3`, [access_token, expiry, config.company_id]);
  return access_token;
}

/**
 * Calls Zoho, auto-refreshing the token once on 401/INVALID_OAUTHTOKEN.
 * Ported verbatim from routes/zoho.js callZoho().
 */
/**
 * Calls Zoho, auto-refreshing the token once on 401/INVALID_OAUTHTOKEN,
 * and retrying with exponential backoff on rate-limit (Code 43 / 429).
 */
export async function callZoho<T>(
  companyId: string,
  requestFn: (token: string) => Promise<T>,
  retriesLeft = 2
): Promise<T> {
  const { rows } = await query<ZohoConfigRow>(
    `SELECT * FROM zoho_config WHERE company_id=$1 AND is_active=TRUE AND refresh_token IS NOT NULL`,
    [companyId]
  );
  if (!rows.length) throw new Error('Zoho Books not connected. Please authenticate first by clicking "Connect Zoho Books".');
  const cfg = rows[0];

  let token = new Date(cfg.token_expiry) <= new Date() ? await refreshZohoToken(cfg) : cfg.access_token;

  try {
    return await requestFn(token);
  } catch (err) {
    const axErr = err as AxiosError<{ code?: number }>;
    const status = axErr.response?.status;
    const zohoCode = axErr.response?.data?.code;

    // Handle Zoho Rate Limit (Code 43 or HTTP 429) with automatic backoff retry
    const isRateLimit = status === 429 || zohoCode === 43;
    if (isRateLimit && retriesLeft > 0) {
      const delayMs = (3 - retriesLeft) * 800; // 800ms, 1600ms backoff
      await new Promise(r => setTimeout(r, delayMs));
      return callZoho(companyId, requestFn, retriesLeft - 1);
    }

    const isAuthError = status === 401 || zohoCode === 57; /* INVALID_OAUTHTOKEN */
    if (!isAuthError) {
      const e = new Error(zohoErrorMessage(err)) as Error & { status?: number };
      e.status = status;
      throw e;
    }
    try {
      token = await refreshZohoToken(cfg);
    } catch (refreshErr) {
      const e = new Error(
        `Zoho re-authentication failed: ${zohoErrorMessage(refreshErr)}. ` +
        `You may need to reconnect Zoho Books from the integrations page.`
      ) as Error & { status?: number };
      e.status = 401;
      throw e;
    }
    try {
      return await requestFn(token);
    } catch (retryErr) {
      const retryAxErr = retryErr as AxiosError<{ code?: number }>;
      const retryZohoCode = retryAxErr.response?.data?.code;
      if ((retryAxErr.response?.status === 429 || retryZohoCode === 43) && retriesLeft > 0) {
        await new Promise(r => setTimeout(r, 1000));
        return callZoho(companyId, requestFn, retriesLeft - 1);
      }
      const e = new Error(zohoErrorMessage(retryErr)) as Error & { status?: number };
      e.status = retryAxErr.response?.status;
      throw e;
    }
  }
}

/**
 * Fetches the connected Zoho organization's real base currency
 * (`GET /organizations/{org_id}`, response field `currency_code`) and
 * stores it as this company's Source Currency — called right after the CFO
 * saves an Organisation ID (see app/api/v1/zoho/config/route.ts), so
 * `companies.currency` reflects the org's actual currency instead of
 * silently staying at its 'INR' column default for a non-INR org. Returns
 * the detected code, or `null` (never throws) if Zoho couldn't be reached —
 * this must never block saving the org_id itself, and must never guess a
 * currency when the real one couldn't be confirmed.
 */
export async function fetchAndStoreZohoOrgCurrency(companyId: string, orgId: string): Promise<string | null> {
  try {
    const { rows: cfgRows } = await query<ZohoConfigRow>(`SELECT * FROM zoho_config WHERE company_id=$1`, [companyId]);
    if (!cfgRows.length) return null;
    const apiBase = ZOHO_API[cfgRows[0].data_center] || ZOHO_API.IN;

    const res = await callZoho(companyId, (token) =>
      axios.get(`${apiBase}/organizations/${orgId}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        timeout: 15000,
      })
    );
    const code = res.data?.organization?.currency_code;
    if (typeof code !== 'string' || code.length !== 3) return null;

    await query(`UPDATE companies SET currency=$1, updated_at=NOW() WHERE id=$2`, [code.toUpperCase(), companyId]);
    return code.toUpperCase();
  } catch (err) {
    console.warn(`Could not auto-detect Zoho org currency for company ${companyId}, org ${orgId}:`, (err as Error).message);
    return null;
  }
}

export interface SyncResult {
  ledgers_synced: number;
  mapped: number;
  upload_id: string;
  duration_ms: number;
  warning: string | null;
}

/** Core Zoho → tb_ledgers sync — ported verbatim from routes/zoho.js syncFromZoho(). */
export async function syncFromZoho(companyId: string, fyId: string, triggeredBy: string | null = null): Promise<SyncResult> {
  const logId = uuid();
  const start = Date.now();

  const { rows: fyRows } = await query(`SELECT * FROM financial_years WHERE id=$1 AND company_id=$2`, [fyId, companyId]);
  if (!fyRows.length) throw new Error('Financial year not found');
  const fy = fyRows[0] as { start_date: string; label: string };
  const startYear = new Date(fy.start_date).getFullYear();

  const { rows: coRows } = await query<{ currency: string }>(`SELECT currency FROM companies WHERE id=$1`, [companyId]);
  const baseCurrency = (coRows[0]?.currency || 'INR').toUpperCase();

  const { rows: cfgRows } = await query<ZohoConfigRow>(`SELECT * FROM zoho_config WHERE company_id=$1`, [companyId]);
  if (!cfgRows.length) throw new Error('Zoho Books not connected');
  const cfg = cfgRows[0];
  const orgId = cfg.org_id;
  if (!orgId) throw new Error('Zoho Organisation ID not set');

  await query(`UPDATE zoho_config SET last_sync_status='running', updated_at=NOW() WHERE company_id=$1`, [companyId]);
  await query(
    `INSERT INTO sync_logs (id,company_id,source,financial_year,triggered_by,status,started_at)
     VALUES ($1,$2,'zoho',$3,$4,'running',NOW())`,
    [logId, companyId, fy.label, triggeredBy]
  );

  const apiBase = ZOHO_API[cfg.data_center] || ZOHO_API.IN;
  const ZOHO_TIMEOUT_MS = 20000;

  // Ensure token is fresh before starting requests
  if (new Date(cfg.token_expiry) <= new Date(Date.now() + 30000)) {
    await refreshZohoToken(cfg).catch(() => {});
  }

  // 1. Fetch Chart of Accounts
  const coaMap = new Map<string, { account_type: string; account_code?: string }>();
  let coaError: string | null = null;
  try {
    const coaRes = await callZoho(companyId, (token) => axios.get(`${apiBase}/chartofaccounts`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: orgId },
      timeout: ZOHO_TIMEOUT_MS,
    }));
    const accounts = coaRes.data?.chartofaccounts || coaRes.data?.accounts || [];
    accounts.forEach((acct: Record<string, unknown>) => {
      const n = String(acct.account_name || acct.name || '').toLowerCase().trim();
      const t = String(acct.account_type || acct.type || '').toLowerCase().trim();
      const c = String(acct.account_code || acct.code || '').trim();
      if (n) coaMap.set(n, { account_type: t, account_code: c });
    });
  } catch (e) {
    coaError = (e as Error).message;
    console.warn('COA fetch failed:', (e as Error).message);
  }

  // 2. Fetch monthly Income/Expense movement from the P&L report and
  //    point-in-time Asset/Liability/Equity balances from the Balance Sheet
  //    report — NOT the single /reports/trialbalance endpoint, which turned
  //    out to silently ignore from_date/to_date entirely for this
  //    integration (confirmed empirically: a request for 2000-01-01 returns
  //    the exact same totals as one for 2026-03-31). /reports/profitandloss
  //    and /reports/balancesheet are Zoho's documented reports and both
  //    correctly vary by date — confirmed empirically the same way.
  //
  //    P&L leaves carry a `total` that IS already the period's movement,
  //    signed positive-when-normal (Cr for income, Dr for expense) — used
  //    directly, no differencing needed.
  //    Balance Sheet leaves carry a CUMULATIVE balance as of `to_date`,
  //    signed positive-when-normal for that leaf's structural half of the
  //    report (Dr under "Assets", Cr under "Liabilities & Equities") — each
  //    month's movement is the difference between consecutive snapshots,
  //    with one extra "Opening" snapshot as of the day before the FY starts
  //    supplying real opening balances (previously always defaulted to 0).
  //    Batched in groups of 3 to comply with Zoho API rate limits (Code 43).
  interface ReportFetchResult {
    kind: 'pl' | 'bs' | 'cust' | 'bill' | 'exp';
    key: number; // pl/cust/bill/exp: 0-11 month index. bs: -1 = Opening, 0-11 = month-end index.
    label: string;
    error: string | null;
    to_date: string;
    fromDate?: string;
    rawResponse?: unknown;
    fetchedAt?: string;
  }

  /** Day before `dateVal`, in UTC to avoid local-timezone day-shift. */
  function dayBeforeISO(dateVal: string | Date): string {
    const d = new Date(dateVal);
    const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    utc.setUTCDate(utc.getUTCDate() - 1);
    return utc.toISOString().slice(0, 10);
  }

  const openingToDate = dayBeforeISO(fy.start_date);

  type FetchDef = { kind: 'pl' | 'bs' | 'cust' | 'bill' | 'exp'; key: number; label: string; from_date?: string; to_date: string };
  const fetchDefs: FetchDef[] = [
    { kind: 'bs', key: -1, label: 'Opening', to_date: openingToDate },
    ...FY_MONTHS_DR.map((m, mi) => {
      const yr = m.next_yr ? startYear + 1 : startYear;
      return { kind: 'pl' as const, key: mi, label: m.name, from_date: `${yr}-${m.from_suffix}`, to_date: `${yr}-${m.to_suffix}` };
    }),
    ...FY_MONTHS_DR.map((m, mi) => {
      const yr = m.next_yr ? startYear + 1 : startYear;
      return { kind: 'bs' as const, key: mi, label: m.name, to_date: `${yr}-${m.to_suffix}` };
    }),
    // Sales by Customer — same monthly movement window as P&L. Feeds the
    // Executive Overview "Top Customers" table with real Zoho data instead
    // of guessing customers from ledger names. Non-fatal if this report
    // isn't available on the org's plan/API version: a total failure here
    // just leaves tb_customer_revenue empty for this upload, and the UI
    // shows an honest "not available" state rather than fabricating names.
    ...FY_MONTHS_DR.map((m, mi) => {
      const yr = m.next_yr ? startYear + 1 : startYear;
      return { kind: 'cust' as const, key: mi, label: m.name, from_date: `${yr}-${m.from_suffix}`, to_date: `${yr}-${m.to_suffix}` };
    }),
    // Vendor Bills — real per-vendor spend, feeds the Vendor Expense Report
    // tab. Same monthly window as P&L/Sales-by-Customer. Non-fatal: a
    // failure here just leaves tb_vendor_expense empty for this upload,
    // same "not available" convention as customer revenue above.
    ...FY_MONTHS_DR.map((m, mi) => {
      const yr = m.next_yr ? startYear + 1 : startYear;
      return { kind: 'bill' as const, key: mi, label: m.name, from_date: `${yr}-${m.from_suffix}`, to_date: `${yr}-${m.to_suffix}` };
    }),
    // Expenses — the subset explicitly marked "Billable" and assigned to a
    // customer feeds real per-customer DIRECT cost for the Customer Margin
    // Report tab. Most orgs never tag expenses this way (see
    // tb_customer_cost's own schema comment) — that's a real fact about the
    // org's Zoho usage, not a fetch failure, and is surfaced honestly rather
    // than papered over.
    ...FY_MONTHS_DR.map((m, mi) => {
      const yr = m.next_yr ? startYear + 1 : startYear;
      return { kind: 'exp' as const, key: mi, label: m.name, from_date: `${yr}-${m.from_suffix}`, to_date: `${yr}-${m.to_suffix}` };
    }),
  ];

  const fetchResults: ReportFetchResult[] = [];
  const BATCH_SIZE = 3;

  for (let i = 0; i < fetchDefs.length; i += BATCH_SIZE) {
    const batch = fetchDefs.slice(i, i + BATCH_SIZE).map((def) => {
      return (async (): Promise<ReportFetchResult> => {
        // Bills and Expenses are plain paginated list resources (`/bills`,
        // `/expenses`), NOT `/reports/*` endpoints, and Zoho names their
        // date-range filters differently (`date_start`/`date_end`, verified
        // empirically to actually filter — see the comment on
        // extractVendorBills below for why that was checked rather than
        // assumed). Handled as a fully separate branch rather than forcing
        // them through the single-report-call shape below.
        if (def.kind === 'bill' || def.kind === 'exp') {
          const listKey = def.kind === 'bill' ? 'bills' : 'expenses';
          const pathSeg = def.kind === 'bill' ? 'bills' : 'expenses';
          try {
            const merged: Record<string, unknown>[] = [];
            let page = 1;
            let zohoCode: number | undefined;
            let zohoMessage: string | undefined;
            let httpStatus: number | undefined;
            // 200/page is Zoho's max; loop until the last page. A single
            // month realistically has far fewer than 200 bills/expenses for
            // most orgs, but this must not silently drop records for a
            // busier one.
            for (;;) {
              const res = await callZoho(companyId, (token) => axios.get(`${apiBase}/${pathSeg}`, {
                headers: { Authorization: `Zoho-oauthtoken ${token}` },
                params: { organization_id: orgId, date_start: def.from_date, date_end: def.to_date, per_page: 200, page },
                timeout: ZOHO_TIMEOUT_MS,
              }));
              httpStatus = res.status; zohoCode = res.data?.code; zohoMessage = res.data?.message;
              const pageItems = Array.isArray(res.data?.[listKey]) ? res.data[listKey] as Record<string, unknown>[] : [];
              merged.push(...pageItems);
              if (!res.data?.page_context?.has_more_page) break;
              page++;
            }
            const mergedResponse = { [listKey]: merged };

            // Debug dump — first month only, same rationale/pattern as
            // salesbycustomer below: these fields aren't reliably documented
            // publicly, so verify/adjust extraction against the real shape.
            if (def.key === 0) {
              try {
                const debugFile = path.join(process.cwd(), `zoho_debug_${listKey}.json`);
                fs.writeFileSync(debugFile, JSON.stringify({
                  _debug_info: {
                    snapshot: def.label, endpoint: pathSeg,
                    params: { date_start: def.from_date, date_end: def.to_date },
                    http_status: httpStatus, zoho_code: zohoCode, zoho_message: zohoMessage,
                    page_count: page, total_records: merged.length,
                    first_record_keys: merged[0] ? Object.keys(merged[0]) : [],
                    written_at: new Date().toISOString(),
                  },
                  raw_response: mergedResponse,
                }, null, 2), 'utf8');
                console.log(`\n✅ [ZOHO DEBUG] ${listKey} raw response written to: ${debugFile}\n`);
              } catch (writeErr) {
                console.warn(`[ZOHO DEBUG] Could not write ${listKey} debug file:`, (writeErr as Error).message);
              }
            }

            return {
              kind: def.kind, key: def.key, label: def.label, error: null,
              to_date: def.to_date, fromDate: def.from_date,
              rawResponse: mergedResponse, fetchedAt: new Date().toISOString(),
            };
          } catch (e) {
            const err = e as Error & { status?: number };
            const kindLabel = def.kind === 'bill' ? 'Vendor Bills' : 'Expenses';
            console.warn(`${kindLabel} ${def.label} fetch failed:`, err.message);
            return {
              kind: def.kind, key: def.key, label: def.label,
              error: `${def.label}: ${err.message}`, to_date: def.to_date, fromDate: def.from_date,
              rawResponse: null, fetchedAt: new Date().toISOString(),
            };
          }
        }

        const endpoint = def.kind === 'pl' ? 'profitandloss' : def.kind === 'cust' ? 'salesbycustomer' : 'balancesheet';
        const params: Record<string, string> = def.kind === 'bs'
          ? { organization_id: orgId, to_date: def.to_date }
          : { organization_id: orgId, from_date: def.from_date!, to_date: def.to_date };

        try {
          const res = await callZoho(companyId, (token) => axios.get(`${apiBase}/reports/${endpoint}`, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            params,
            timeout: ZOHO_TIMEOUT_MS,
          }));

          // ─── DEBUG: Write full raw Zoho response to JSON file for inspection ───
          if (def.kind === 'bs' && def.key === -1) {
            try {
              const debugPayload = {
                _debug_info: {
                  snapshot: def.label,
                  endpoint,
                  params,
                  http_status: res.status,
                  zoho_code: res.data?.code,
                  zoho_message: res.data?.message,
                  top_level_keys: Object.keys(res.data || {}),
                  written_at: new Date().toISOString(),
                },
                raw_response: res.data,
              };
              const debugFile = path.join(process.cwd(), 'zoho_debug_raw.json');
              fs.writeFileSync(debugFile, JSON.stringify(debugPayload, null, 2), 'utf8');
              console.log(`\n✅ [ZOHO DEBUG] Full raw response written to: ${debugFile}\n   Open this file in VS Code to see the complete Zoho API data.\n`);
            } catch (writeErr) {
              console.warn('[ZOHO DEBUG] Could not write debug file:', (writeErr as Error).message);
            }
          }
          // Second debug dump, specifically for Sales by Customer — this
          // report's exact response field names aren't reliably documented
          // publicly, so the first month's raw payload is always dumped to
          // disk to verify/adjust extractSalesByCustomer()'s field guesses
          // against the real org's response shape.
          if (def.kind === 'cust' && def.key === 0) {
            try {
              const debugFile = path.join(process.cwd(), 'zoho_debug_salesbycustomer.json');
              fs.writeFileSync(debugFile, JSON.stringify({
                _debug_info: {
                  snapshot: def.label, endpoint, params, http_status: res.status,
                  zoho_code: res.data?.code, zoho_message: res.data?.message,
                  top_level_keys: Object.keys(res.data || {}),
                  written_at: new Date().toISOString(),
                },
                raw_response: res.data,
              }, null, 2), 'utf8');
              console.log(`\n✅ [ZOHO DEBUG] Sales by Customer raw response written to: ${debugFile}\n`);
            } catch (writeErr) {
              console.warn('[ZOHO DEBUG] Could not write salesbycustomer debug file:', (writeErr as Error).message);
            }
          }
          // ──────────────────────────────────────────────────────────────────────

          return {
            kind: def.kind,
            key: def.key,
            label: def.label,
            error: null,
            to_date: def.to_date,
            fromDate: def.from_date,
            rawResponse: res.data,
            fetchedAt: new Date().toISOString(),
          };
        } catch (e) {
          const err = e as Error & { status?: number };
          const kindLabel = def.kind === 'pl' ? 'P&L' : def.kind === 'cust' ? 'Sales by Customer' : 'Balance Sheet';
          console.warn(`${kindLabel} ${def.label} fetch failed:`, err.message);
          return {
            kind: def.kind,
            key: def.key,
            label: def.label,
            error: `${def.label}: ${err.message}`,
            to_date: def.to_date,
            fromDate: def.from_date,
            rawResponse: null,
            fetchedAt: new Date().toISOString(),
          };
        }
      })();
    });

    const res = await Promise.all(batch);
    fetchResults.push(...res);

    if (i + BATCH_SIZE < fetchDefs.length) {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }

  const plResults = fetchResults.filter(r => r.kind === 'pl').sort((a, b) => a.key - b.key);
  const bsResults = fetchResults.filter(r => r.kind === 'bs').sort((a, b) => a.key - b.key);
  const custResults = fetchResults.filter(r => r.kind === 'cust').sort((a, b) => a.key - b.key);
  const billResults = fetchResults.filter(r => r.kind === 'bill').sort((a, b) => a.key - b.key);
  const expResults = fetchResults.filter(r => r.kind === 'exp').sort((a, b) => a.key - b.key);
  // Opening-snapshot failure is non-fatal — fall back to a zero opening
  // balance (previous behaviour) rather than failing the whole sync.
  const openingResult = bsResults.find(r => r.key === -1);
  const bsMonthResults = bsResults.filter(r => r.key >= 0);

  const monthErrors: string[] = [];
  if (openingResult?.error) monthErrors.push(`Opening balance: ${openingResult.error} (opening balances defaulted to 0)`);

  // Collect raw payloads for audit storage (P&L ×12 + Balance Sheet Opening + ×12)
  const rawZohoMonths: Array<{
    month: string; from_date: string; to_date: string; fetched_at: string; raw_response: unknown;
  }> = fetchResults
    .filter(r => !r.error && r.rawResponse)
    .map(r => ({
      month: `${{ pl: 'P&L', cust: 'Sales by Customer', bill: 'Vendor Bills', exp: 'Expenses', bs: 'BS' }[r.kind]} ${r.label}`,
      from_date: r.fromDate || r.to_date,
      to_date: r.to_date,
      fetched_at: r.fetchedAt || new Date().toISOString(),
      raw_response: r.rawResponse,
    }));

  // ── Sales by Customer (real per-customer revenue, replaces the old
  //    ledger-name-guessing "Top Customers" heuristic entirely) ──
  //    Each month's `total` is a movement (same date semantics as P&L),
  //    summed per customer into a 12-month array. Field names for this
  //    report aren't reliably documented publicly, so extraction is
  //    defensive — see zoho_debug_salesbycustomer.json (written above) to
  //    verify/adjust against a real org's response shape.
  interface ZohoCustomerLeaf { customer_id?: string; customer_name: string; total: number; currency_code?: string }
  function extractSalesByCustomer(rawResponse: unknown): ZohoCustomerLeaf[] {
    const data = rawResponse as Record<string, unknown> | null;
    if (!data) return [];
    // Confirmed against a real org's response (see zoho_debug_salesbycustomer.json):
    // the array is under `sales`, and each item's amount field is also named
    // `sales` (tax-exclusive; `sales_with_tax` is the tax-inclusive sibling —
    // `sales` is used to match the tax-exclusive GL revenue everywhere else
    // in this engine). Other candidate keys are kept as a defensive fallback
    // in case this differs across Zoho API versions/regions. Each item also
    // carries `currency_code` — the report returns amounts in each
    // customer's *transaction* currency, not the org's base currency (unlike
    // /reports/profitandloss and /reports/balancesheet, which are always in
    // base currency), so a mixed-currency org needs that field to avoid
    // silently summing e.g. USD and INR as if they were the same unit.
    const candidates = [
      data.sales, data.sales_by_customers, data.salesbycustomer, data.sales_by_customer, data.customers, data.customer_summary,
    ];
    const arr = candidates.find(c => Array.isArray(c)) as Record<string, unknown>[] | undefined;
    if (!arr) return [];
    return arr
      .map((item) => {
        const name = String(item.customer_name ?? item.contact_name ?? item.name ?? '').trim();
        const idRaw = item.customer_id ?? item.contact_id ?? item.entity_id;
        const totalRaw = item.sales ?? item.total ?? item.invoiced_amount ?? item.sales_with_tax ?? item.amount ?? 0;
        const currency = item.currency_code ?? item.currency ?? undefined;
        return {
          customer_id: idRaw != null ? String(idRaw) : undefined,
          customer_name: name,
          total: parseFloat(String(totalRaw)) || 0,
          currency_code: currency != null ? String(currency).toUpperCase() : undefined,
        };
      })
      .filter((c) => c.customer_name);
  }

  const customerRevMap = new Map<string, { customer_id?: string; name: string; m: number[] }>();
  let custFetchErrors = 0;
  let custSkippedForeignCurrency = 0;
  const foreignCurrenciesSeen = new Set<string>();
  custResults.forEach((res) => {
    if (res.error) { custFetchErrors++; return; }
    extractSalesByCustomer(res.rawResponse).forEach((leaf) => {
      // No conversion rate is available from this report — rather than
      // silently mis-summing a foreign-currency amount as if it were the
      // org's base currency (which would badly distort both the revenue
      // figure and the concentration-risk ranking), these customers are
      // excluded from tb_customer_revenue entirely. They still count toward
      // real company revenue via the ledger-based P&L/BS reports, which
      // Zoho itself reports in base currency — only the customer-level
      // breakdown for this specific customer is unavailable.
      if (leaf.currency_code && leaf.currency_code !== baseCurrency) {
        custSkippedForeignCurrency++;
        foreignCurrenciesSeen.add(`${leaf.customer_name} (${leaf.currency_code})`);
        return;
      }
      if (!customerRevMap.has(leaf.customer_name)) {
        customerRevMap.set(leaf.customer_name, { customer_id: leaf.customer_id, name: leaf.customer_name, m: Array(12).fill(0) });
      }
      const entry = customerRevMap.get(leaf.customer_name)!;
      entry.m[res.key] += leaf.total;
      if (leaf.customer_id && !entry.customer_id) entry.customer_id = leaf.customer_id;
    });
  });
  if (custSkippedForeignCurrency > 0) {
    console.warn(
      `Sales by Customer: skipped ${custSkippedForeignCurrency} customer-month row(s) in a currency other than the org's base currency (${baseCurrency}) — no conversion rate available from this report. Affected: ${[...foreignCurrenciesSeen].join(', ')}`
    );
  }
  if (customerRevMap.size === 0) {
    console.warn(
      custFetchErrors === custResults.length
        ? `Sales by Customer: all ${custResults.length} month(s) failed — Top Customers will show "not available" for this sync. Check zoho_debug_salesbycustomer.json if a debug dump was written.`
        : 'Sales by Customer: report returned no customer rows for this period.'
    );
  }

  // ── Vendor Bills (real per-vendor spend — feeds the Vendor Expense Report
  //    tab). `/bills` is a plain list resource, not a report — each item's
  //    `total` is that bill's full amount (Zoho confirms `date` is the bill
  //    date, and date_start/date_end was verified empirically to actually
  //    filter by it — see the fetchDef loop above), summed per vendor into a
  //    12-month array, same shape as customerRevMap above. Field names
  //    confirmed against a real org's response (see
  //    zoho_debug_bills.json, written above) — no candidate-field guessing
  //    needed here the way salesbycustomer required, since Bills is a
  //    documented core resource, not a specialty report.
  interface ZohoVendorBillLeaf { vendor_id?: string; vendor_name: string; total: number; currency_code?: string }
  function extractVendorBills(rawResponse: unknown): ZohoVendorBillLeaf[] {
    const data = rawResponse as { bills?: unknown } | null;
    const arr = Array.isArray(data?.bills) ? data!.bills as Record<string, unknown>[] : [];
    return arr
      .map((item) => ({
        vendor_id: item.vendor_id != null ? String(item.vendor_id) : undefined,
        vendor_name: String(item.vendor_name ?? '').trim(),
        total: parseFloat(String(item.total ?? 0)) || 0,
        currency_code: item.currency_code != null ? String(item.currency_code).toUpperCase() : undefined,
      }))
      .filter((b) => b.vendor_name);
  }

  const vendorExpenseMap = new Map<string, { vendor_id?: string; name: string; m: number[] }>();
  let billFetchErrors = 0;
  let billSkippedForeignCurrency = 0;
  const billForeignCurrenciesSeen = new Set<string>();
  billResults.forEach((res) => {
    if (res.error) { billFetchErrors++; return; }
    extractVendorBills(res.rawResponse).forEach((leaf) => {
      // Bills carries no bcy_total (base-currency) field, unlike Expenses
      // below — so, same reasoning as Sales by Customer above, a bill in a
      // foreign currency is excluded rather than mis-summed as if it were
      // the org's base currency.
      if (leaf.currency_code && leaf.currency_code !== baseCurrency) {
        billSkippedForeignCurrency++;
        billForeignCurrenciesSeen.add(`${leaf.vendor_name} (${leaf.currency_code})`);
        return;
      }
      if (!vendorExpenseMap.has(leaf.vendor_name)) {
        vendorExpenseMap.set(leaf.vendor_name, { vendor_id: leaf.vendor_id, name: leaf.vendor_name, m: Array(12).fill(0) });
      }
      const entry = vendorExpenseMap.get(leaf.vendor_name)!;
      entry.m[res.key] += leaf.total;
      if (leaf.vendor_id && !entry.vendor_id) entry.vendor_id = leaf.vendor_id;
    });
  });
  if (billSkippedForeignCurrency > 0) {
    console.warn(
      `Vendor Bills: skipped ${billSkippedForeignCurrency} bill(s) in a currency other than the org's base currency (${baseCurrency}). Affected: ${[...billForeignCurrenciesSeen].join(', ')}`
    );
  }
  if (vendorExpenseMap.size === 0) {
    console.warn(
      billFetchErrors === billResults.length
        ? `Vendor Bills: all ${billResults.length} month(s) failed — Vendor Expense Report will show "not available" for this sync. Check zoho_debug_bills.json if a debug dump was written.`
        : 'Vendor Bills: no bills found for this period.'
    );
  }

  // ── Customer-tagged direct cost (real per-customer DIRECT cost — feeds
  //    the Customer Margin Report tab). Sourced from `/expenses` filtered to
  //    rows where the org actually assigned a `customer_id` (Zoho's
  //    "Billable" + "Customer" fields on an expense) — NOT from Bills, which
  //    carry no customer association at all in Zoho's data model (vendor
  //    bills are money owed to a vendor, not inherently tied to a customer).
  //    `bcy_total` (base-currency total) is used directly — unlike Bills,
  //    Expenses already carries a base-currency-converted figure, so no
  //    foreign-currency exclusion is needed here.
  //    IMPORTANT — most Zoho orgs never use this tagging at all: confirmed
  //    empirically on the first company synced with this feature, 0 of 780
  //    real expenses for the year were customer-tagged. An empty
  //    tb_customer_cost for a company is a real fact about that org's Zoho
  //    usage (see tb_customer_cost's schema comment) — never treated as a
  //    fetch failure, and never backfilled with a guess.
  interface ZohoBillableExpenseLeaf { customer_id: string; customer_name: string; total: number }
  function extractBillableCustomerExpenses(rawResponse: unknown): ZohoBillableExpenseLeaf[] {
    const data = rawResponse as { expenses?: unknown } | null;
    const arr = Array.isArray(data?.expenses) ? data!.expenses as Record<string, unknown>[] : [];
    return arr
      .filter((item) => item.customer_id != null && String(item.customer_id).trim() !== '')
      .map((item) => ({
        customer_id: String(item.customer_id),
        customer_name: String(item.customer_name ?? '').trim(),
        total: parseFloat(String(item.bcy_total ?? item.total ?? 0)) || 0,
      }))
      .filter((e) => e.customer_name);
  }

  const customerCostMap = new Map<string, { customer_id?: string; name: string; m: number[] }>();
  let expFetchErrors = 0;
  expResults.forEach((res) => {
    if (res.error) { expFetchErrors++; return; }
    extractBillableCustomerExpenses(res.rawResponse).forEach((leaf) => {
      if (!customerCostMap.has(leaf.customer_name)) {
        customerCostMap.set(leaf.customer_name, { customer_id: leaf.customer_id, name: leaf.customer_name, m: Array(12).fill(0) });
      }
      const entry = customerCostMap.get(leaf.customer_name)!;
      entry.m[res.key] += leaf.total;
      if (leaf.customer_id && !entry.customer_id) entry.customer_id = leaf.customer_id;
    });
  });
  if (customerCostMap.size === 0) {
    console.warn(
      expFetchErrors === expResults.length
        ? `Expenses: all ${expResults.length} month(s) failed — Customer Margin Report will show direct cost as unavailable for this sync. Check zoho_debug_expenses.json if a debug dump was written.`
        : 'Expenses: no expense was billable-and-customer-tagged for this period — this Zoho org does not appear to track direct per-customer cost. Customer Margin Report will show real revenue with direct cost disclosed as "not tracked", not a fabricated figure.'
    );
  }

  interface LedgerAcc {
    code: string; name: string; op_dr: number; op_cr: number;
    m: { dr: number; cr: number }[];
    // Zoho metadata — taken from the first snapshot this ledger appears in
    zoho_account_id?: string;
    zoho_account_type?: string;
    depth: number;
    is_child_present: boolean;
  }
  const ledgerMap: Record<string, LedgerAcc> = {};
  const metaByLedger = new Map<string, { code: string; account_id?: string; account_type?: string; depth: number; is_child_present: boolean }>();

  function ensureMeta(name: string, leaf: ZohoReportLeaf, broadType: string) {
    if (metaByLedger.has(name)) return;
    metaByLedger.set(name, {
      code: leaf.account_code || leaf.account_id || '',
      account_id: leaf.account_id,
      account_type: classifyHint(leaf.category_hint, broadType),
      depth: leaf.depth,
      is_child_present: leaf.is_child_present,
    });
  }
  function ensureLedger(name: string): LedgerAcc {
    if (!ledgerMap[name]) {
      ledgerMap[name] = { code: '', name, op_dr: 0, op_cr: 0, m: Array.from({ length: 12 }, () => ({ dr: 0, cr: 0 })), depth: 0, is_child_present: false };
    }
    return ledgerMap[name];
  }

  /** Maps a P&L leaf's enclosing group name to whether it's income vs. expense, and a precise ZOHO_TYPE_MAP-friendly broad type. */
  function plBroadType(categoryHint: string | undefined): { isIncome: boolean; broadType: string } {
    const h = (categoryHint || '').toLowerCase();
    if (h.includes('cost of goods')) return { isIncome: false, broadType: 'cost_of_goods_sold' };
    if (h.includes('non operating income')) return { isIncome: true, broadType: 'other_income' };
    if (h.includes('income')) return { isIncome: true, broadType: 'income' };
    return { isIncome: false, broadType: 'expense' };
  }

  // ── P&L (Income/Expense): each month's `total` is already the movement ──
  plResults.forEach((res) => {
    if (res.error) { monthErrors.push(res.error); return; }
    const topArray = (res.rawResponse as { profit_and_loss?: unknown } | null)?.profit_and_loss;
    extractZohoReportLeaves(topArray).forEach((leaf) => {
      const name = leaf.account_name;
      if (!name) return;
      const { isIncome, broadType } = plBroadType(leaf.category_hint);
      ensureMeta(name, leaf, broadType);
      const row = ensureLedger(name);
      const prev = row.m[res.key];
      row.m[res.key] = isIncome
        ? { dr: prev.dr + Math.max(0, -leaf.total), cr: prev.cr + Math.max(0, leaf.total) }
        : { dr: prev.dr + Math.max(0, leaf.total), cr: prev.cr + Math.max(0, -leaf.total) };
    });
  });

  // ── Balance Sheet (Assets/Liabilities/Equity): cumulative snapshots, differenced ──
  // Signed net per ledger, per snapshot index (0 = Opening, 1..12 = month-end),
  // positive = matches the leaf's structural side (Dr for Assets, Cr for
  // Liabilities & Equities). A ledger absent from a given snapshot is
  // treated as net-zero as of that date — Zoho's own report already omits
  // zero-balance rows, so this matches its convention rather than
  // approximating it.
  const cumByLedger = new Map<string, { isAssetSide: boolean; net: number[] }>();

  function recordBsSnapshot(snapIdx: number, leaves: ZohoReportLeaf[], isAssetSide: boolean) {
    leaves.forEach((leaf) => {
      const name = leaf.account_name;
      if (!name) return;
      if (!cumByLedger.has(name)) cumByLedger.set(name, { isAssetSide, net: Array(13).fill(0) });
      ensureMeta(name, leaf, isAssetSide ? 'asset' : 'liability');
      cumByLedger.get(name)!.net[snapIdx] = leaf.total;
    });
  }

  function recordBsResult(snapIdx: number, res: ReportFetchResult | undefined) {
    if (!res || res.error) return;
    // The response's top-level array has one half per side (Assets, then
    // Liabilities & Equities) — detect by name rather than position, and
    // walk each half separately so the correct structural side is recorded.
    const topArray = (res.rawResponse as { balance_sheet?: unknown } | null)?.balance_sheet;
    if (!Array.isArray(topArray)) return;
    (topArray as Record<string, unknown>[]).forEach((half) => {
      if (!half) return;
      const isAssetSide = String(half.name || '').toLowerCase().includes('asset');
      recordBsSnapshot(snapIdx, extractZohoReportLeaves([half]), isAssetSide);
    });
  }

  recordBsResult(0, openingResult);
  bsMonthResults.forEach((res) => {
    if (res.error) { monthErrors.push(res.error); return; }
    recordBsResult(res.key + 1, res);
  });

  cumByLedger.forEach((entry, name) => {
    const row = ensureLedger(name);
    const { isAssetSide, net } = entry;
    const openNet = net[0];
    row.op_dr = isAssetSide ? Math.max(0, openNet) : Math.max(0, -openNet);
    row.op_cr = isAssetSide ? Math.max(0, -openNet) : Math.max(0, openNet);
    for (let mi = 0; mi < 12; mi++) {
      const movement = net[mi + 1] - net[mi];
      row.m[mi] = {
        dr: isAssetSide ? Math.max(0, movement) : Math.max(0, -movement),
        cr: isAssetSide ? Math.max(0, -movement) : Math.max(0, movement),
      };
    }
  });

  // Fill in metadata (code, zoho_account_id, zoho_account_type, depth, is_child_present) now every ledger name is known.
  metaByLedger.forEach((meta, name) => {
    const row = ledgerMap[name];
    if (!row) return;
    row.code = meta.code;
    row.zoho_account_id = meta.account_id;
    row.zoho_account_type = meta.account_type;
    row.depth = meta.depth;
    row.is_child_present = meta.is_child_present;
  });

  if (Object.keys(ledgerMap).length === 0) {
    const reason = monthErrors[0] || coaError || 'Zoho returned no trial balance data for this period';
    const err = new Error(`Zoho sync failed: ${reason}`);
    await query(`UPDATE zoho_config SET last_sync_status='error',last_sync_error=$1,updated_at=NOW() WHERE company_id=$2`, [err.message, companyId]);
    await query(`UPDATE sync_logs SET status='error',error_message=$1,completed_at=NOW() WHERE id=$2`, [err.message, logId]);
    throw err;
  }

  const { rows: lmRows } = await query<{
    ledger_code: string | null;
    ledger_name: string;
    note_no: number;
    note_name: string;
    section: string;
    treasury_type: string | null;
    normal_bal: string;
  }>(
    `SELECT * FROM ledger_master WHERE (company_id=$1 OR company_id IS NULL) AND is_active=TRUE`,
    [companyId]
  );

  const lmByName = new Map(lmRows.map(r => [r.ledger_name.toLowerCase().trim(), r]));
  const lmByCode = new Map(lmRows.filter(r => r.ledger_code).map(r => [r.ledger_code!.trim(), r]));
  const normalizeStr = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const lmByNorm = new Map(lmRows.map(r => [normalizeStr(r.ledger_name), r]));

  const tbRows = Object.values(ledgerMap);
  let mapped = 0;
  const uploadId = uuid();

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE tb_uploads SET is_current=FALSE, status='superseded'
       WHERE company_id=$1 AND financial_year_id=$2 AND is_current=TRUE`,
      [companyId, fyId]
    );

    // Pre-calculate mapped count
    for (const row of tbRows) {
      const nameKey = row.name.toLowerCase().trim();
      const codeKey = row.code.trim();
      const normKey = normalizeStr(row.name);

      let lm = lmByName.get(nameKey) || (codeKey ? lmByCode.get(codeKey) : undefined) || lmByNorm.get(normKey);

      if (!lm) {
        const coaInfo = coaMap.get(nameKey);
        const fallback = classifyZohoLedger(nameKey, row.zoho_account_type || coaInfo?.account_type || '');

        if (fallback) {
          lm = {
            ledger_code: row.code || coaInfo?.account_code || null,
            ledger_name: row.name,
            note_no: fallback.note_no,
            note_name: fallback.note_name,
            section: fallback.section,
            treasury_type: fallback.treasury_type || null,
            normal_bal: fallback.normal_bal,
          };
        }
      }
      if (lm && lm.note_no && lm.section) mapped++;
    }

    // Insert parent record into tb_uploads FIRST to satisfy Foreign Key constraint
    await client.query('SAVEPOINT tb_uploads_sp');
    try {
      await client.query(
        `INSERT INTO tb_uploads
          (id,company_id,financial_year_id,uploaded_by,source,ledger_count,
           mapped_count,has_monthly_cols,status,is_current,raw_zoho_months)
         VALUES ($1,$2,$3,$4,'zoho',$5,$6,TRUE,'complete',TRUE,$7::jsonb)`,
        [uploadId, companyId, fyId, triggeredBy, tbRows.length, mapped, JSON.stringify(rawZohoMonths)]
      );
      await client.query('RELEASE SAVEPOINT tb_uploads_sp');
    } catch (insertErr) {
      await client.query('ROLLBACK TO SAVEPOINT tb_uploads_sp').catch(() => {});
      if ((insertErr as Error).message?.includes('raw_zoho_months')) {
        console.warn('Falling back to tb_uploads insert without raw_zoho_months column...');
        await client.query(
          `INSERT INTO tb_uploads
            (id,company_id,financial_year_id,uploaded_by,source,ledger_count,
             mapped_count,has_monthly_cols,status,is_current)
           VALUES ($1,$2,$3,$4,'zoho',$5,$6,TRUE,'complete',TRUE)`,
          [uploadId, companyId, fyId, triggeredBy, tbRows.length, mapped]
        );
      } else {
        throw insertErr;
      }
    }

    // Chunked batch insert into tb_ledgers (50 rows per batch query)
    const chunkSize = 50;
    for (let i = 0; i < tbRows.length; i += chunkSize) {
      const chunk = tbRows.slice(i, i + chunkSize);
      const valueClauses: string[] = [];
      const queryParams: unknown[] = [];
      let paramIdx = 1;

      for (const row of chunk) {
        const nameKey = row.name.toLowerCase().trim();
        const codeKey = row.code.trim();
        const normKey = normalizeStr(row.name);

        let lm = lmByName.get(nameKey) || (codeKey ? lmByCode.get(codeKey) : undefined) || lmByNorm.get(normKey);

        if (!lm) {
          const coaInfo = coaMap.get(nameKey);
          const fallback = classifyZohoLedger(nameKey, row.zoho_account_type || coaInfo?.account_type || '');

          if (fallback) {
            lm = {
              ledger_code: row.code || coaInfo?.account_code || null,
              ledger_name: row.name,
              note_no: fallback.note_no,
              note_name: fallback.note_name,
              section: fallback.section,
              treasury_type: fallback.treasury_type || null,
              normal_bal: fallback.normal_bal,
            };
            await client.query(
              `INSERT INTO ledger_master
                (company_id, ledger_code, ledger_name, note_no, note_name, section, treasury_type, normal_bal, is_global)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE)
               ON CONFLICT DO NOTHING`,
              [companyId, lm.ledger_code, lm.ledger_name, lm.note_no, lm.note_name, sanitizeSection(lm.section) || 'ac', sanitizeTreasuryType(lm.treasury_type), lm.normal_bal]
            ).catch(() => {});
          }
        }

        const rowValues = [
          uploadId, companyId, fyId, row.code, row.name,
          lm?.note_no || null, lm?.note_name || null, sanitizeSection(lm?.section),
          sanitizeTreasuryType(lm?.treasury_type), lm?.normal_bal || 'Dr',
          row.op_dr, row.op_cr,
          row.m[0].dr, row.m[0].cr, row.m[1].dr, row.m[1].cr,
          row.m[2].dr, row.m[2].cr, row.m[3].dr, row.m[3].cr,
          row.m[4].dr, row.m[4].cr, row.m[5].dr, row.m[5].cr,
          row.m[6].dr, row.m[6].cr, row.m[7].dr, row.m[7].cr,
          row.m[8].dr, row.m[8].cr, row.m[9].dr, row.m[9].cr,
          row.m[10].dr, row.m[10].cr, row.m[11].dr, row.m[11].cr,
          // Zoho metadata fields
          row.zoho_account_id || null,
          row.zoho_account_type || null,
          row.depth ?? 0,
          row.is_child_present ?? false,
        ];

        const placeholders = rowValues.map(() => `$${paramIdx++}`);
        valueClauses.push(`(${placeholders.join(',')})`);
        queryParams.push(...rowValues);
      }

      const batchInsertSql = `
        INSERT INTO tb_ledgers
          (upload_id,company_id,financial_year_id,ledger_code,ledger_name,
           note_no,note_name,section,treasury_type,normal_bal,
           op_dr,op_cr,
           m1_dr,m1_cr,m2_dr,m2_cr,m3_dr,m3_cr,m4_dr,m4_cr,
           m5_dr,m5_cr,m6_dr,m6_cr,m7_dr,m7_cr,m8_dr,m8_cr,
           m9_dr,m9_cr,m10_dr,m10_cr,m11_dr,m11_cr,m12_dr,m12_cr,
           zoho_account_id,zoho_account_type,depth,is_child_present)
        VALUES ${valueClauses.join(', ')}
      `;

      await client.query('SAVEPOINT tb_ledgers_sp');
      try {
        await client.query(batchInsertSql, queryParams);
        await client.query('RELEASE SAVEPOINT tb_ledgers_sp');
      } catch (insertLedgersErr) {
        await client.query('ROLLBACK TO SAVEPOINT tb_ledgers_sp').catch(() => {});
        if ((insertLedgersErr as Error).message?.match(/zoho_account_id|depth|is_child_present|zoho_account_type/)) {
          console.warn('Falling back to tb_ledgers insert without extra zoho columns...');
          // Build 36-col fallback SQL
          let fParamIdx = 1;
          const fValueClauses: string[] = [];
          const fQueryParams: unknown[] = [];
          for (const row of chunk) {
            const nameKey = row.name.toLowerCase().trim();
            const codeKey = row.code.trim();
            const normKey = normalizeStr(row.name);
            let lm = lmByName.get(nameKey) || (codeKey ? lmByCode.get(codeKey) : undefined) || lmByNorm.get(normKey);

            if (!lm) {
              const coaInfo = coaMap.get(nameKey);
              const fallback = classifyZohoLedger(nameKey, row.zoho_account_type || coaInfo?.account_type || '');

              if (fallback) {
                lm = {
                  ledger_code: row.code || coaInfo?.account_code || null,
                  ledger_name: row.name,
                  note_no: fallback.note_no,
                  note_name: fallback.note_name,
                  section: fallback.section,
                  treasury_type: fallback.treasury_type || null,
                  normal_bal: fallback.normal_bal,
                };
                await client.query(
                  `INSERT INTO ledger_master
                    (company_id, ledger_code, ledger_name, note_no, note_name, section, treasury_type, normal_bal, is_global)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE)
                   ON CONFLICT DO NOTHING`,
                  [companyId, lm.ledger_code, lm.ledger_name, lm.note_no, lm.note_name, sanitizeSection(lm.section) || 'ac', sanitizeTreasuryType(lm.treasury_type), lm.normal_bal]
                ).catch(() => {});
              }
            }

            const row36 = [
              uploadId, companyId, fyId, row.code, row.name,
              lm?.note_no || null, lm?.note_name || null, sanitizeSection(lm?.section),
              sanitizeTreasuryType(lm?.treasury_type), lm?.normal_bal || 'Dr',
              row.op_dr, row.op_cr,
              row.m[0].dr, row.m[0].cr, row.m[1].dr, row.m[1].cr,
              row.m[2].dr, row.m[2].cr, row.m[3].dr, row.m[3].cr,
              row.m[4].dr, row.m[4].cr, row.m[5].dr, row.m[5].cr,
              row.m[6].dr, row.m[6].cr, row.m[7].dr, row.m[7].cr,
              row.m[8].dr, row.m[8].cr, row.m[9].dr, row.m[9].cr,
              row.m[10].dr, row.m[10].cr, row.m[11].dr, row.m[11].cr,
            ];
            const ph = row36.map(() => `$${fParamIdx++}`);
            fValueClauses.push(`(${ph.join(',')})`);
            fQueryParams.push(...row36);
          }
          const fSql = `
            INSERT INTO tb_ledgers
              (upload_id,company_id,financial_year_id,ledger_code,ledger_name,
               note_no,note_name,section,treasury_type,normal_bal,
               op_dr,op_cr,
               m1_dr,m1_cr,m2_dr,m2_cr,m3_dr,m3_cr,m4_dr,m4_cr,
               m5_dr,m5_cr,m6_dr,m6_cr,m7_dr,m7_cr,m8_dr,m8_cr,
               m9_dr,m9_cr,m10_dr,m10_cr,m11_dr,m11_cr,m12_dr,m12_cr)
            VALUES ${fValueClauses.join(', ')}
          `;
          await client.query(fSql, fQueryParams);
        } else {
          throw insertLedgersErr;
        }
      }
    }

    // Insert real per-customer revenue (empty no-op if the Sales by Customer
    // report was unavailable — tb_customer_revenue simply stays empty for
    // this upload, and computeTopCustomers() reports "not available" rather
    // than fabricating names).
    const customerRows = Array.from(customerRevMap.values());
    if (customerRows.length > 0) {
      const custChunkSize = 50;
      for (let i = 0; i < customerRows.length; i += custChunkSize) {
        const chunk = customerRows.slice(i, i + custChunkSize);
        const valueClauses: string[] = [];
        const queryParams: unknown[] = [];
        let paramIdx = 1;
        for (const c of chunk) {
          const rowValues = [uploadId, companyId, fyId, c.customer_id || null, c.name, ...c.m];
          const placeholders = rowValues.map(() => `$${paramIdx++}`);
          valueClauses.push(`(${placeholders.join(',')})`);
          queryParams.push(...rowValues);
        }
        // SAVEPOINT so a failure here (e.g. schema not yet migrated on an
        // older DB) can't abort the whole transaction — the Trial Balance
        // sync itself already succeeded above and must not be rolled back
        // just because the newer, optional customer-revenue table is missing.
        await client.query('SAVEPOINT tb_customer_revenue_sp');
        try {
          await client.query(
            `INSERT INTO tb_customer_revenue
              (upload_id,company_id,financial_year_id,zoho_customer_id,customer_name,
               m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12)
             VALUES ${valueClauses.join(', ')}`,
            queryParams
          );
          await client.query('RELEASE SAVEPOINT tb_customer_revenue_sp');
        } catch (custInsertErr) {
          await client.query('ROLLBACK TO SAVEPOINT tb_customer_revenue_sp').catch(() => {});
          console.warn('tb_customer_revenue insert failed (non-fatal):', (custInsertErr as Error).message);
        }
      }
    }

    // Insert real per-vendor spend and real per-customer direct cost — same
    // chunked/savepointed pattern as tb_customer_revenue above, factored out
    // since it's now used three times. Both are empty no-ops (never fatal to
    // the Trial Balance sync itself) when Zoho returned nothing — see
    // tb_vendor_expense/tb_customer_cost's own schema comments for what an
    // empty result honestly means for each.
    async function insertMonthlyEntityRows(
      table: 'tb_vendor_expense' | 'tb_customer_cost',
      idColumn: 'zoho_vendor_id' | 'zoho_customer_id',
      nameColumn: 'vendor_name' | 'customer_name',
      rows: { customer_id?: string; vendor_id?: string; name: string; m: number[] }[]
    ) {
      const chunkSize = 50;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const valueClauses: string[] = [];
        const queryParams: unknown[] = [];
        let paramIdx = 1;
        for (const r of chunk) {
          const rowValues = [uploadId, companyId, fyId, r.vendor_id ?? r.customer_id ?? null, r.name, ...r.m];
          const placeholders = rowValues.map(() => `$${paramIdx++}`);
          valueClauses.push(`(${placeholders.join(',')})`);
          queryParams.push(...rowValues);
        }
        await client.query(`SAVEPOINT ${table}_sp`);
        try {
          await client.query(
            `INSERT INTO ${table}
              (upload_id,company_id,financial_year_id,${idColumn},${nameColumn},
               m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12)
             VALUES ${valueClauses.join(', ')}`,
            queryParams
          );
          await client.query(`RELEASE SAVEPOINT ${table}_sp`);
        } catch (insertErr) {
          await client.query(`ROLLBACK TO SAVEPOINT ${table}_sp`).catch(() => {});
          console.warn(`${table} insert failed (non-fatal):`, (insertErr as Error).message);
        }
      }
    }

    const vendorExpenseRows = Array.from(vendorExpenseMap.values());
    if (vendorExpenseRows.length > 0) {
      await insertMonthlyEntityRows('tb_vendor_expense', 'zoho_vendor_id', 'vendor_name', vendorExpenseRows);
    }
    const customerCostRows = Array.from(customerCostMap.values());
    if (customerCostRows.length > 0) {
      await insertMonthlyEntityRows('tb_customer_cost', 'zoho_customer_id', 'customer_name', customerCostRows);
    }
  });

  const duration = Date.now() - start;
  const partialWarning = monthErrors.length
    ? `Synced with ${monthErrors.length}/12 month(s) failing: ${monthErrors.join('; ')}`
    : null;
  const dbStatus = partialWarning ? 'error' : 'success';

  await query(
    `UPDATE zoho_config SET last_synced_at=NOW(),last_sync_status=$1,last_sync_error=$2,
      synced_ledgers=$3, updated_at=NOW() WHERE company_id=$4`,
    [dbStatus, partialWarning, tbRows.length, companyId]
  );
  await query(
    `UPDATE sync_logs SET status=$1,ledgers_synced=$2,duration_ms=$3,error_message=$4,completed_at=NOW() WHERE id=$5`,
    [dbStatus, tbRows.length, duration, partialWarning, logId]
  );

  invalidateReportCache(companyId);

  return { ledgers_synced: tbRows.length, mapped, upload_id: uploadId, duration_ms: duration, warning: partialWarning };
}
