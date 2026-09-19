import {
  withPeriodSurplus, computeBS, computePL, computeMIS, computeCashFlow, PERIOD_SURPLUS_CODE,
  type TbLedgerRow, type PeriodParams,
} from '@/lib/financial/tb-engine';
import { mergeCyLedgers } from '@/lib/financial/cy-merge';
import { buildSampleLedgers } from '@/lib/financial/sample-data';

type Sec = TbLedgerRow['section'];
const row = (name: string, section: Sec, normal: 'Dr' | 'Cr', op: [number, number], monthly: [number, number], code = name): TbLedgerRow => {
  const r: TbLedgerRow = { ledger_code: code, ledger_name: name, note_no: section === 'eq' ? 1 : section === 'inc' ? 20 : section === 'exp' ? 26 : 19, note_name: name, section, normal_bal: normal, op_dr: op[0], op_cr: op[1] };
  for (let m = 1; m <= 12; m++) { r[`m${m}_dr`] = monthly[0]; r[`m${m}_cr`] = monthly[1]; }
  return r;
};

/**
 * A genuine pre-closing trial balance: Bank 1,000 = Capital 1,000 at the
 * opening; every month revenue 100 (Cr), rent 40 (Dr), bank +60 (Dr).
 * Profit 60/month stays in the P&L accounts — nothing has been closed to equity.
 */
const balancedYear = (): TbLedgerRow[] => [
  row('Bank', 'ac', 'Dr', [1000, 0], [60, 0]),
  row('Capital', 'eq', 'Cr', [0, 1000], [0, 0]),
  row('Revenue', 'inc', 'Cr', [0, 0], [0, 100]),
  row('Rent', 'exp', 'Dr', [0, 0], [40, 0]),
];

const FY_VIEWS: PeriodParams[] = [
  { yearType: 'FY', periodType: 'annual', period: null },
  ...(['Q1', 'Q2', 'Q3', 'Q4'] as const).map((p) => ({ yearType: 'FY' as const, periodType: 'quarterly' as const, period: p })),
  ...(['H1', 'H2'] as const).map((p) => ({ yearType: 'FY' as const, periodType: 'halfyear' as const, period: p })),
];

describe('withPeriodSurplus — profit for the period in Other Equity (Schedule III)', () => {
  test('without it the Balance Sheet is short by exactly the year-to-date profit; with it, it balances in every FY view', () => {
    // The Balance Sheet is a position at the period END, so the missing amount is the
    // profit from the start of the year to that date (60 a month), not just the period's.
    const monthsToDate: Record<string, number> = { all: 12, Q1: 3, Q2: 6, Q3: 9, Q4: 12, H1: 6, H2: 12 };
    for (const params of FY_VIEWS) {
      const before = computeBS(balancedYear(), params);
      expect(before.difference).toBeCloseTo(-60 * monthsToDate[params.period ?? 'all'], 2);
      expect(before.balanced).toBe(false);
      const after = computeBS(withPeriodSurplus(balancedYear()), params);
      expect(after.difference).toBeCloseTo(0, 2);
      expect(after.balanced).toBe(true);
    }
  });

  test('adds one Note 2 Other Equity row whose monthly movement is the booked result', () => {
    const rows = withPeriodSurplus(balancedYear());
    const surplus = rows.find((r) => r.ledger_code === PERIOD_SURPLUS_CODE)!;
    expect(rows).toHaveLength(5);
    expect(surplus).toMatchObject({ note_no: 2, note_name: 'Other Equity', section: 'eq', normal_bal: 'Cr', is_system: true, op_dr: 0, op_cr: 0 });
    for (let m = 1; m <= 12; m++) expect(surplus[`m${m}_cr`]).toBe(60);
  });

  test('P&L, MIS and Cash Flow are identical with or without it (no double count in financing)', () => {
    for (const params of FY_VIEWS) {
      const plain = balancedYear(), withS = withPeriodSurplus(balancedYear());
      expect(computePL(withS, params)).toEqual(computePL(plain, params));
      expect(computeMIS(withS, params)).toEqual(computeMIS(plain, params));
      expect(computeCashFlow(withS, params)).toEqual(computeCashFlow(plain, params));
    }
  });

  test('a trial balance that does not balance is left alone — its real difference stays visible', () => {
    const broken = balancedYear();
    broken[0].op_dr = 1500; // opening no longer balances
    expect(withPeriodSurplus(broken)).toBe(broken);
  });

  test('the built-in sample data (equity already includes profit, not a Dr = Cr TB) is left alone', () => {
    for (const fy of ['FY25', 'FY24', 'FY23'] as const) {
      const rows = buildSampleLedgers(fy);
      expect(withPeriodSurplus(rows)).toBe(rows);
      expect(computeBS(rows, { yearType: 'FY', periodType: 'annual', period: null }).balanced).toBe(true);
    }
  });

  test('idempotent, and nothing is added when there is no profit or loss', () => {
    const once = withPeriodSurplus(balancedYear());
    expect(withPeriodSurplus(once)).toBe(once);
    const noPl = [row('Bank', 'ac', 'Dr', [1000, 0], [0, 0]), row('Capital', 'eq', 'Cr', [0, 1000], [0, 0])];
    expect(withPeriodSurplus(noPl)).toBe(noPl);
  });

  test('calendar-year views balance too: the merge carries the prior FY\'s profit across 31 March', () => {
    // FY1 as above (profit 720). FY2 opens with that profit closed into Retained Earnings b/f.
    const fy1 = balancedYear();
    const fy2 = [
      row('Bank', 'ac', 'Dr', [1720, 0], [60, 0]),
      row('Capital', 'eq', 'Cr', [0, 1000], [0, 0]),
      row('Retained Earnings b/f', 'eq', 'Cr', [0, 720], [0, 0], 'RE-BF'),
      row('Revenue', 'inc', 'Cr', [0, 0], [0, 100]),
      row('Rent', 'exp', 'Dr', [0, 0], [40, 0]),
    ];
    const merged = mergeCyLedgers(withPeriodSurplus(fy1), withPeriodSurplus(fy2));
    for (const params of [
      { yearType: 'CY' as const, periodType: 'annual' as const, period: null },
      ...(['Q1', 'Q2', 'Q3', 'Q4'] as const).map((p) => ({ yearType: 'CY' as const, periodType: 'quarterly' as const, period: p })),
    ]) {
      expect(computeBS(merged, params).difference).toBeCloseTo(0, 2);
    }
  });
});
