import { assembleZohoLedgers, monthEndISO, dayBeforeISO, ZOHO_EARNINGS_BF_NAME } from '@/lib/services/zoho';
import { summarizeTrialBalance, type TbAmountRow } from '@/lib/financial/tb-validation';

// Minimal Zoho report trees, same shape as /reports/balancesheet and /reports/profitandloss.
const leaf = (name: string, total: number, id = name) => ({ name, account_id: id, total });
const bs = (assets: [string, number][], liabEq: [string, number][], currentYearEarnings = 0) => ({
  balance_sheet: [
    { name: 'Assets', account_transactions: [{ name: 'Current Assets', account_transactions: assets.map(([n, t]) => leaf(n, t)) }] },
    { name: 'Liabilities & Equities', account_transactions: [
      { name: 'Liabilities', account_transactions: liabEq.filter(([n]) => !n.startsWith('Eq:')).map(([n, t]) => leaf(n, t)) },
      { name: 'Equities', account_transactions: [
        ...liabEq.filter(([n]) => n.startsWith('Eq:')).map(([n, t]) => leaf(n.slice(3), t)),
        // Zoho's computed row: no account_id, so it is never a ledger.
        { name: 'Current Year Earnings', total: currentYearEarnings },
      ] },
    ] },
  ],
});
const pl = (income: number, expense: number) => ({
  profit_and_loss: [
    { name: 'Operating Income', account_transactions: [leaf('Sales', income)] },
    { name: 'Operating Expense', account_transactions: [leaf('Rent', expense)] },
  ],
});

const toRows = (ledgerMap: Record<string, { op_dr: number; op_cr: number; m: { dr: number; cr: number }[] }>): TbAmountRow[] =>
  Object.values(ledgerMap).map((r) => {
    const row: TbAmountRow = { op_dr: r.op_dr, op_cr: r.op_cr };
    r.m.forEach((mv, i) => { row[`m${i + 1}_dr`] = mv.dr; row[`m${i + 1}_cr`] = mv.cr; });
    return row;
  });

describe('assembleZohoLedgers — Zoho reports → trial balance', () => {
  // Books at the opening date: Bank 1,000 = Capital 700 + 300 of earlier profit
  // that Zoho shows only as the computed "Current Year Earnings" row.
  // April: sales 500, rent 200 → profit 300 → Bank 1,300.
  const empty = { pl: [] as never[], monthBs: [] as never[] };
  const opening = { key: -1, error: null, rawResponse: bs([['Bank', 1000]], [['Eq:Capital', 700]], 300) };
  const aprPl = { key: 0, error: null, rawResponse: pl(500, 200) };
  const aprBs = { key: 0, error: null, rawResponse: bs([['Bank', 1300]], [['Eq:Capital', 700]], 600) };

  test('adds the earnings brought forward, so the opening balances (Dr = Cr)', () => {
    const r = assembleZohoLedgers({ ...empty, openingBs: opening });
    expect(r.earningsBroughtForward).toBe(300);
    const bf = r.ledgerMap[ZOHO_EARNINGS_BF_NAME];
    expect(bf.op_cr).toBe(300);
    expect(bf.op_dr).toBe(0);
    expect(bf.zoho_account_type).toBe('retained_earnings');
    expect(summarizeTrialBalance(toRows(r.ledgerMap)).validation.opening_diff).toBe(0);
  });

  test('the whole year then balances: opening and every month', () => {
    // All 12 month-end snapshots exist in a real sync; nothing happens after April here.
    const monthBs = Array.from({ length: 12 }, (_, key) => ({ ...aprBs, key }));
    const r = assembleZohoLedgers({ pl: [aprPl], openingBs: opening, monthBs });
    const s = summarizeTrialBalance(toRows(r.ledgerMap));
    expect(s.validation.opening_diff).toBe(0);
    expect(s.validation.month_diffs[0]).toBe(0);
    expect(s.is_balanced).toBe(true);
    // Movements are unchanged: Bank +300 in April, Sales Cr 500, Rent Dr 200.
    expect(r.ledgerMap.Bank.m[0]).toEqual({ dr: 300, cr: 0 });
    expect(r.ledgerMap.Sales.m[0]).toEqual({ dr: 0, cr: 500 });
    expect(r.ledgerMap.Rent.m[0]).toEqual({ dr: 200, cr: 0 });
  });

  test('an accumulated LOSS is brought forward as a debit', () => {
    const r = assembleZohoLedgers({ ...empty, openingBs: { key: -1, error: null, rawResponse: bs([['Bank', 500]], [['Eq:Capital', 700]]) } });
    expect(r.earningsBroughtForward).toBe(-200);
    expect(r.ledgerMap[ZOHO_EARNINGS_BF_NAME]).toMatchObject({ op_dr: 200, op_cr: 0 });
  });

  test('no line when the books already balance at the opening, or when the opening snapshot failed', () => {
    expect(assembleZohoLedgers({ ...empty, openingBs: { key: -1, error: null, rawResponse: bs([['Bank', 700]], [['Eq:Capital', 700]]) } })
      .ledgerMap[ZOHO_EARNINGS_BF_NAME]).toBeUndefined();
    const failed = assembleZohoLedgers({ ...empty, openingBs: { key: -1, error: 'Opening: timeout' } });
    expect(failed.earningsBroughtForward).toBe(0);
    expect(failed.ledgerMap[ZOHO_EARNINGS_BF_NAME]).toBeUndefined();
  });

  test('the computed "Current Year Earnings" row is never a ledger of its own', () => {
    const r = assembleZohoLedgers({ ...empty, openingBs: opening });
    expect(Object.keys(r.ledgerMap).sort()).toEqual(['Bank', 'Capital', ZOHO_EARNINGS_BF_NAME].sort());
  });

  test('failed month reports are reported, not silently dropped', () => {
    const r = assembleZohoLedgers({ pl: [{ key: 0, error: 'Apr: timeout' }], openingBs: opening, monthBs: [{ key: 0, error: 'Apr BS: timeout' }] });
    expect(r.errors).toEqual(['Apr: timeout', 'Apr BS: timeout']);
  });
});

describe('Zoho sync dates', () => {
  test('month ends include 29 February in leap years (the old fixed "02-28" lost that day)', () => {
    expect(monthEndISO(2028, 2)).toBe('2028-02-29');
    expect(monthEndISO(2027, 2)).toBe('2027-02-28');
    expect(monthEndISO(2026, 3)).toBe('2026-03-31');
    expect(monthEndISO(2025, 4)).toBe('2025-04-30');
  });

  test('the opening snapshot is the day before the FY starts — 31 March, never 30 March', () => {
    expect(dayBeforeISO('2025-04-01')).toBe('2025-03-31');
    expect(dayBeforeISO('2024-04-01')).toBe('2024-03-31');
    expect(dayBeforeISO('2024-03-01')).toBe('2024-02-29');
    expect(dayBeforeISO('2026-01-01')).toBe('2025-12-31');
  });
});
