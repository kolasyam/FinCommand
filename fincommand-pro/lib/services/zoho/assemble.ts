import { classifyHint } from './classify';

/** Pure: Zoho report trees → trial-balance rows, plus the FY date helpers. No DB, no network. */

// Month ends are computed (monthEndISO), not listed — a fixed '02-28' lost
// every 29 February transaction in a leap year.
export const FY_MONTHS_DR: { name: string; from_suffix: string; next_yr?: boolean }[] = [
  { name: 'Apr', from_suffix: '04-01' },
  { name: 'May', from_suffix: '05-01' },
  { name: 'Jun', from_suffix: '06-01' },
  { name: 'Jul', from_suffix: '07-01' },
  { name: 'Aug', from_suffix: '08-01' },
  { name: 'Sep', from_suffix: '09-01' },
  { name: 'Oct', from_suffix: '10-01' },
  { name: 'Nov', from_suffix: '11-01' },
  { name: 'Dec', from_suffix: '12-01' },
  { name: 'Jan', next_yr: true, from_suffix: '01-01' },
  { name: 'Feb', next_yr: true, from_suffix: '02-01' },
  { name: 'Mar', next_yr: true, from_suffix: '03-01' },
];

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
export function extractZohoReportLeaves(topArray: unknown): ZohoReportLeaf[] {
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

export interface ZohoLedgerAcc {
  code: string; name: string; op_dr: number; op_cr: number;
  m: { dr: number; cr: number }[];
  // Zoho metadata — taken from the first snapshot this ledger appears in
  zoho_account_id?: string;
  zoho_account_type?: string;
  depth: number;
  is_child_present: boolean;
}

/** One fetched Zoho report: `key` is the FY month index 0–11 (unused for the opening snapshot). */
export interface ZohoReportInput { key: number; error: string | null; rawResponse?: unknown }

/**
 * The equity line that carries profit earned before this financial year but
 * not yet closed into any Zoho account. Zoho shows it on its Balance Sheet
 * as "Current Year Earnings", a computed row WITHOUT an account_id, so the
 * leaf extractor never sees it. Without this line the opening trial balance
 * is short by exactly that amount: Dr ≠ Cr, and the Balance Sheet never
 * balances. The name contains "Retained Earnings" so the classifier maps it
 * to Note 2 Other Equity; it's a normal ledger, so it can be reclassified.
 */
export const ZOHO_EARNINGS_BF_NAME = 'Retained Earnings — brought forward (Zoho opening)';
export const ZOHO_EARNINGS_BF_CODE = 'ZOHO-RE-BF';

/** Maps a P&L leaf's enclosing group name to whether it's income vs. expense, and a precise ZOHO_TYPE_MAP-friendly broad type. */
function plBroadType(categoryHint: string | undefined): { isIncome: boolean; broadType: string } {
  const h = (categoryHint || '').toLowerCase();
  if (h.includes('cost of goods')) return { isIncome: false, broadType: 'cost_of_goods_sold' };
  if (h.includes('non operating income')) return { isIncome: true, broadType: 'other_income' };
  if (h.includes('income')) return { isIncome: true, broadType: 'income' };
  return { isIncome: false, broadType: 'expense' };
}

/**
 * Builds trial-balance rows from Zoho's monthly P&L reports and Balance Sheet
 * snapshots. Pure (no DB, no network), so it's unit-tested and can be replayed
 * against the raw responses stored in tb_uploads.raw_zoho_months.
 *
 * - P&L (income/expense): each month's `total` already IS the movement.
 * - Balance Sheet (assets/liabilities/equity): each snapshot is a cumulative
 *   balance; the opening is the snapshot on the day before the FY starts, and
 *   each month's movement is the difference between consecutive snapshots.
 * - Earnings brought forward: see ZOHO_EARNINGS_BF_NAME. Its value is the
 *   opening snapshot's leaf Assets − (Liabilities + Equity), i.e. the only
 *   amount that makes the opening balance — nothing is estimated.
 */
export function assembleZohoLedgers(input: {
  pl: ZohoReportInput[]; openingBs?: ZohoReportInput; monthBs: ZohoReportInput[];
}): { ledgerMap: Record<string, ZohoLedgerAcc>; errors: string[]; earningsBroughtForward: number } {
  const errors: string[] = [];
  const ledgerMap: Record<string, ZohoLedgerAcc> = {};
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
  function ensureLedger(name: string): ZohoLedgerAcc {
    if (!ledgerMap[name]) {
      ledgerMap[name] = { code: '', name, op_dr: 0, op_cr: 0, m: Array.from({ length: 12 }, () => ({ dr: 0, cr: 0 })), depth: 0, is_child_present: false };
    }
    return ledgerMap[name];
  }

  // ── P&L (Income/Expense): each month's `total` is already the movement ──
  input.pl.forEach((res) => {
    if (res.error) { errors.push(res.error); return; }
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

  function recordBsResult(snapIdx: number, res: ZohoReportInput | undefined): boolean {
    if (!res || res.error) return false;
    // The response's top-level array has one half per side (Assets, then
    // Liabilities & Equities) — detect by name rather than position, and
    // walk each half separately so the correct structural side is recorded.
    const topArray = (res.rawResponse as { balance_sheet?: unknown } | null)?.balance_sheet;
    if (!Array.isArray(topArray)) return false;
    (topArray as Record<string, unknown>[]).forEach((half) => {
      if (!half) return;
      const isAssetSide = String(half.name || '').toLowerCase().includes('asset');
      recordBsSnapshot(snapIdx, extractZohoReportLeaves([half]), isAssetSide);
    });
    return true;
  }

  const haveOpening = recordBsResult(0, input.openingBs);
  input.monthBs.forEach((res) => {
    if (res.error) { errors.push(res.error); return; }
    recordBsResult(res.key + 1, res);
  });

  let openingGap = 0; // leaf Assets − leaf (Liabilities + Equity), at the opening date
  cumByLedger.forEach((entry, name) => {
    const row = ensureLedger(name);
    const { isAssetSide, net } = entry;
    const openNet = net[0];
    openingGap += isAssetSide ? openNet : -openNet;
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

  // Earnings brought forward — only with a real opening snapshot (without
  // one, every opening is 0 and there is nothing to balance).
  const earningsBroughtForward = haveOpening ? Math.round(openingGap * 100) / 100 : 0;
  if (earningsBroughtForward !== 0) {
    const row = ensureLedger(ZOHO_EARNINGS_BF_NAME);
    row.op_cr = Math.max(0, earningsBroughtForward);  // profit brought forward = credit
    row.op_dr = Math.max(0, -earningsBroughtForward); // accumulated loss = debit
    metaByLedger.set(ZOHO_EARNINGS_BF_NAME, {
      code: ZOHO_EARNINGS_BF_CODE, account_type: 'retained_earnings', depth: 0, is_child_present: false,
    });
  }

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

  return { ledgerMap, errors, earningsBroughtForward };
}

/** Last calendar day of a month (1–12), as YYYY-MM-DD — handles leap-year February. */
export function monthEndISO(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

/** Day before a YYYY-MM-DD date, computed in UTC so no local timezone can shift it. */
export function dayBeforeISO(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}
