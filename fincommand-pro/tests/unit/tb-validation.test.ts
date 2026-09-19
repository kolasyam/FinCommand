import {
  summarizeTrialBalance, describeImbalance, decideSourceOwnership, findDuplicateLedgers, BALANCE_TOLERANCE, type TbAmountRow,
} from '@/lib/financial/tb-validation';

const row = (op: [number, number], months: [number, number][] = []): TbAmountRow => {
  const r: TbAmountRow = { op_dr: op[0], op_cr: op[1] };
  months.forEach(([dr, cr], i) => { r[`m${i + 1}_dr`] = dr; r[`m${i + 1}_cr`] = cr; });
  return r;
};

describe('summarizeTrialBalance — debit = credit, recorded not enforced', () => {
  test('a balanced TB: totals match, every difference is zero', () => {
    const s = summarizeTrialBalance([
      row([1000, 0], [[500, 0], [0, 0]]),
      row([0, 1000], [[0, 500], [0, 0]]),
    ]);
    expect(s.total_dr).toBe(1500);
    expect(s.total_cr).toBe(1500);
    expect(s.balance_diff).toBe(0);
    expect(s.is_balanced).toBe(true);
    expect(s.validation.opening_diff).toBe(0);
    expect(s.validation.month_diffs).toHaveLength(12);
    expect(s.validation.month_diffs.every(d => d === 0)).toBe(true);
  });

  test('pinpoints WHERE it breaks: opening and one month off, even when they cancel at closing', () => {
    // The real Zoho pattern: opening −X, month 1 +X — the closing TB balances
    // but opening and month 1 are each wrong, so it must NOT count as balanced.
    const s = summarizeTrialBalance([
      row([0, 5000], [[5000, 0]]),
    ]);
    expect(s.validation.opening_diff).toBe(-5000);
    expect(s.validation.month_diffs[0]).toBe(5000);
    expect(s.balance_diff).toBe(0);
    expect(s.is_balanced).toBe(false);
  });

  test(`differences up to ₹${BALANCE_TOLERANCE} are rounding, not an imbalance`, () => {
    expect(summarizeTrialBalance([row([100.5, 100])]).is_balanced).toBe(true);
    expect(summarizeTrialBalance([row([101, 100])]).is_balanced).toBe(true);
    expect(summarizeTrialBalance([row([101.01, 100])]).is_balanced).toBe(false);
  });

  test('sums in paise: many 2-dp amounts do not drift', () => {
    const rows = Array.from({ length: 1000 }, () => row([0.1, 0], [[0.2, 0]]));
    rows.push(row([0, 100], [[0, 200]]));
    const s = summarizeTrialBalance(rows);
    expect(s.total_dr).toBe(300);
    expect(s.balance_diff).toBe(0);
    expect(s.is_balanced).toBe(true);
  });

  test('accepts pg NUMERIC strings and treats missing/garbage as 0', () => {
    const s = summarizeTrialBalance([{ op_dr: '1234.56', op_cr: null, m1_dr: undefined, m1_cr: 'abc' } as TbAmountRow]);
    expect(s.total_dr).toBe(1234.56);
    expect(s.total_cr).toBe(0);
  });

  test('describeImbalance names the months that are off, and says the data was kept', () => {
    const s = summarizeTrialBalance([row([0, 5000], [[5000, 0]])]);
    const msg = describeImbalance(s, ['Apr', 'May'])!;
    expect(msg).toMatch(/opening/);
    expect(msg).toMatch(/Apr/);
    expect(msg).not.toMatch(/May/);
    expect(msg).toMatch(/saved/);
    expect(describeImbalance(summarizeTrialBalance([row([10, 10])]))).toBeNull();
  });
});

describe('decideSourceOwnership — first source owns the year', () => {
  test('an empty year, or the same source, is always writable', () => {
    expect(decideSourceOwnership(null, 'excel')).toBe('allow');
    expect(decideSourceOwnership(null, 'zoho', { scheduled: true })).toBe('allow');
    expect(decideSourceOwnership('zoho', 'zoho', { scheduled: true })).toBe('allow');
    expect(decideSourceOwnership('excel', 'excel')).toBe('allow');
  });

  test('switching source needs a person to confirm', () => {
    expect(decideSourceOwnership('zoho', 'excel')).toBe('needs_confirm');
    expect(decideSourceOwnership('zoho', 'excel', { confirmReplace: true })).toBe('allow');
    expect(decideSourceOwnership('excel', 'zoho')).toBe('needs_confirm');
    expect(decideSourceOwnership('excel', 'zoho', { confirmReplace: true })).toBe('allow');
  });

  test('the scheduler never switches a year — it skips, even if told to confirm', () => {
    expect(decideSourceOwnership('excel', 'zoho', { scheduled: true })).toBe('skip');
    expect(decideSourceOwnership('excel', 'zoho', { scheduled: true, confirmReplace: true })).toBe('skip');
  });
});

describe('findDuplicateLedgers', () => {
  test('same name (ignoring case/spaces) and same code is a duplicate', () => {
    expect(findDuplicateLedgers([
      { name: 'Cash in Hand', code: '2001' },
      { name: '  cash in hand ', code: '2001' },
      { name: 'Rent', code: '' },
      { name: 'RENT', code: null },
    ])).toEqual(['cash in hand (2001)', 'RENT']);
  });

  test('same name under two codes is allowed (Amortisation — Intangibles: 1023 and 7032)', () => {
    expect(findDuplicateLedgers([
      { name: 'Amortisation — Intangibles', code: '1023' },
      { name: 'Amortisation — Intangibles', code: '7032' },
    ])).toEqual([]);
  });
});
