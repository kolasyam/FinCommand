import { computeLedgerMetric, ledgerMatchesSpec, priorPeriodOf, type TbLedgerRow, type LedgerMetricSpec } from '@/lib/financial/tb-engine';

/** One TB ledger row: `months` are [dr, cr] pairs for m1 (Apr in FY) onward. */
function ledger(
  name: string, normal_bal: 'Dr' | 'Cr',
  opts: { code?: string; note_no?: number; section?: string; op_dr?: number; op_cr?: number; months?: [number, number][]; parent?: boolean } = {},
): TbLedgerRow {
  const row: TbLedgerRow = {
    ledger_name: name, ledger_code: opts.code ?? null, normal_bal,
    note_no: opts.note_no ?? null, section: (opts.section ?? null) as TbLedgerRow['section'],
    op_dr: opts.op_dr ?? 0, op_cr: opts.op_cr ?? 0, is_child_present: opts.parent ?? false,
  };
  (opts.months ?? []).forEach(([dr, cr], i) => { row[`m${i + 1}_dr`] = dr; row[`m${i + 1}_cr`] = cr; });
  return row;
}

// Mirrors a real Zoho TB: "salary" appears in both expense ledgers (Note 23)
// AND salary-payable liabilities (Note 17) — the exact ambiguity filters exist for.
const LEDGERS: TbLedgerRow[] = [
  ledger('Salaries and Employee Wages', 'Dr', { note_no: 23, section: 'exp', months: [[100, 0], [120, 0], [110, 0]] }),
  ledger('Office Maid & Driver salaries', 'Dr', { note_no: 23, section: 'exp', months: [[10, 0], [10, 0], [10, 0]] }),
  ledger('Arun Salary Payable', 'Cr', { note_no: 17, section: 'lc', op_cr: 50, months: [[90, 100], [120, 120]] }),
  ledger('Rent', 'Dr', { note_no: 26, section: 'exp', months: [[30, 0]] }),
  ledger('Salaries (group)', 'Dr', { note_no: 23, section: 'exp', months: [[999, 0]], parent: true }),
];

const spec = (s: Partial<LedgerMetricSpec>): LedgerMetricSpec => ({ match: 'all', conditions: [], measure: 'movement', sign: 'natural', ...s });
const ANNUAL = { periodType: 'annual' as const, yearType: 'FY' as const };
const Q1 = { periodType: 'quarterly' as const, period: 'Q1' as const, yearType: 'FY' as const };

describe('ledgerMatchesSpec', () => {
  test('contains is case-insensitive and ignores surrounding whitespace', () => {
    const s = spec({ conditions: [{ field: 'ledger_name', operator: 'contains', value: '  SALAR ' }] });
    expect(LEDGERS.filter((l) => ledgerMatchesSpec(l, s)).map((l) => l.ledger_name))
      .toEqual(['Salaries and Employee Wages', 'Office Maid & Driver salaries', 'Arun Salary Payable']);
  });

  test('a Zoho parent/group row never matches (no double counting group + children)', () => {
    const s = spec({ conditions: [{ field: 'note_no', operator: 'equals', value: '23' }] });
    expect(LEDGERS.filter((l) => ledgerMatchesSpec(l, s)).map((l) => l.ledger_name)).not.toContain('Salaries (group)');
  });

  test('all = every condition; any = at least one', () => {
    const all = spec({ conditions: [{ field: 'ledger_name', operator: 'contains', value: 'salar' }, { field: 'note_no', operator: 'equals', value: '23' }] });
    expect(LEDGERS.filter((l) => ledgerMatchesSpec(l, all))).toHaveLength(2);
    const any = spec({ match: 'any', conditions: [{ field: 'note_no', operator: 'equals', value: '26' }, { field: 'section', operator: 'equals', value: 'lc' }] });
    expect(LEDGERS.filter((l) => ledgerMatchesSpec(l, any)).map((l) => l.ledger_name)).toEqual(['Arun Salary Payable', 'Rent']);
  });

  test('in / not_in / not_contains / starts_with / not_equals', () => {
    const inSpec = spec({ conditions: [{ field: 'note_no', operator: 'in', value: ['23', '26'] }] });
    expect(LEDGERS.filter((l) => ledgerMatchesSpec(l, inSpec))).toHaveLength(3);
    const notIn = spec({ conditions: [{ field: 'note_no', operator: 'not_in', value: ['23', '26'] }] });
    expect(LEDGERS.filter((l) => ledgerMatchesSpec(l, notIn)).map((l) => l.ledger_name)).toEqual(['Arun Salary Payable']);
    const notContains = spec({ conditions: [{ field: 'ledger_name', operator: 'contains', value: 'salar' }, { field: 'ledger_name', operator: 'not_contains', value: 'payable' }] });
    expect(LEDGERS.filter((l) => ledgerMatchesSpec(l, notContains))).toHaveLength(2);
    const starts = spec({ conditions: [{ field: 'ledger_name', operator: 'starts_with', value: 'office' }] });
    expect(LEDGERS.filter((l) => ledgerMatchesSpec(l, starts))).toHaveLength(1);
    const notEq = spec({ conditions: [{ field: 'section', operator: 'not_equals', value: 'exp' }] });
    expect(LEDGERS.filter((l) => ledgerMatchesSpec(l, notEq))).toHaveLength(1);
  });

  test('no conditions matches NOTHING (an unfiltered sum of a whole TB is meaningless)', () => {
    expect(LEDGERS.some((l) => ledgerMatchesSpec(l, spec({ conditions: [] })))).toBe(false);
  });
});

describe('computeLedgerMetric', () => {
  const salaryExpense = spec({ conditions: [{ field: 'ledger_name', operator: 'contains', value: 'salar' }, { field: 'note_no', operator: 'equals', value: '23' }] });

  test('movement over the annual period = sum of each ledger\'s normal-balance net movement', () => {
    const r = computeLedgerMetric(LEDGERS, salaryExpense, ANNUAL);
    expect(r.value).toBe(330 + 30);
    expect(r.matchedCount).toBe(2);
  });

  test('annual trend has one point per month, labelled like MIS (Apr..Mar)', () => {
    const r = computeLedgerMetric(LEDGERS, salaryExpense, ANNUAL);
    expect(r.trend).toHaveLength(12);
    expect(r.trend.slice(0, 3)).toEqual([{ label: 'Apr', value: 110 }, { label: 'May', value: 130 }, { label: 'Jun', value: 120 }]);
    expect(r.trend[11]).toEqual({ label: 'Mar', value: 0 });
  });

  test('a quarter only sums that quarter\'s months', () => {
    const r = computeLedgerMetric(LEDGERS, salaryExpense, Q1);
    expect(r.value).toBe(360);
    expect(r.trend.map((p) => p.value)).toEqual([110, 130, 120]);
  });

  test('Cr-normal ledgers net as Cr − Dr (the engine\'s normal-balance convention)', () => {
    const payable = spec({ conditions: [{ field: 'ledger_name', operator: 'contains', value: 'payable' }] });
    expect(computeLedgerMetric(LEDGERS, payable, ANNUAL).value).toBe(10); // Apr: 100 − 90, May: 120 − 120
  });

  test('closing measure = opening + movements to period end, per-month closing trend', () => {
    const payable = spec({ measure: 'closing', conditions: [{ field: 'ledger_name', operator: 'contains', value: 'payable' }] });
    const r = computeLedgerMetric(LEDGERS, payable, ANNUAL);
    expect(r.value).toBe(60); // opening Cr 50 + net 10
    expect(r.trend[0]).toEqual({ label: 'Apr', value: 60 });
    expect(r.trend[11]).toEqual({ label: 'Mar', value: 60 });
  });

  test('invert flips the sign of value, trend and breakdown', () => {
    const r = computeLedgerMetric(LEDGERS, { ...salaryExpense, sign: 'invert' }, ANNUAL);
    expect(r.value).toBe(-360);
    expect(r.trend[0].value).toBe(-110);
    expect(r.breakdown[0].value).toBe(-330);
  });

  test('breakdown lists every matched ledger by magnitude, largest first', () => {
    const r = computeLedgerMetric(LEDGERS, spec({ conditions: [{ field: 'ledger_name', operator: 'contains', value: 'salar' }] }), ANNUAL);
    expect(r.breakdown).toEqual([
      { label: 'Salaries and Employee Wages', value: 330 },
      { label: 'Office Maid & Driver salaries', value: 30 },
      { label: 'Arun Salary Payable', value: 10 },
    ]);
  });

  test('two matched ledgers with the same name are told apart by their code', () => {
    const dupes = [ledger('Bank Charges', 'Dr', { code: 'A1', months: [[5, 0]] }), ledger('Bank Charges', 'Dr', { code: 'A2', months: [[7, 0]] })];
    const r = computeLedgerMetric(dupes, spec({ conditions: [{ field: 'ledger_name', operator: 'equals', value: 'bank charges' }] }), ANNUAL);
    expect(r.breakdown.map((b) => b.label)).toEqual(['Bank Charges (A2)', 'Bank Charges (A1)']);
  });

  test('no match yields an honest zero with matchedCount 0 (the preview/bundle report it as "no ledger matched")', () => {
    const r = computeLedgerMetric(LEDGERS, spec({ conditions: [{ field: 'ledger_name', operator: 'contains', value: 'zzz' }] }), ANNUAL);
    expect(r).toMatchObject({ value: 0, matchedCount: 0, breakdown: [] });
  });
});

describe('number-based conditions', () => {
  const names = (s: LedgerMetricSpec) => LEDGERS.filter((l) => ledgerMatchesSpec(l, s)).map((l) => l.ledger_name);

  test('greater than / at most / between on the note number compare as numbers', () => {
    expect(names(spec({ conditions: [{ field: 'note_no', operator: 'gt', value: '20' }] })))
      .toEqual(['Salaries and Employee Wages', 'Office Maid & Driver salaries', 'Rent']);
    expect(names(spec({ conditions: [{ field: 'note_no', operator: 'lte', value: '17' }] }))).toEqual(['Arun Salary Payable']);
    expect(names(spec({ conditions: [{ field: 'note_no', operator: 'between', value: ['20', '25'] }] })))
      .toEqual(['Salaries and Employee Wages', 'Office Maid & Driver salaries']);
  });

  test('is empty / is not empty', () => {
    const rows = [...LEDGERS, ledger('Suspense', 'Dr', { months: [[1, 0]] })];
    const pick = (s: LedgerMetricSpec) => rows.filter((l) => ledgerMatchesSpec(l, s)).map((l) => l.ledger_name);
    expect(pick(spec({ conditions: [{ field: 'note_no', operator: 'is_empty', value: '' }] }))).toEqual(['Suspense']);
    expect(pick(spec({ conditions: [{ field: 'note_no', operator: 'is_not_empty', value: '' }] }))).toHaveLength(4);
  });

  test('an amount condition needs the period figure — without it nothing matches (never a guess)', () => {
    expect(names(spec({ conditions: [{ field: 'amount', operator: 'gt', value: '0' }] }))).toEqual([]);
  });

  test('amount = each ledger\'s own figure for the period being computed', () => {
    const big = computeLedgerMetric(LEDGERS, spec({ conditions: [{ field: 'ledger_name', operator: 'contains', value: 'salar' }, { field: 'amount', operator: 'gte', value: '20' }] }), ANNUAL);
    expect(big.breakdown.map((b) => b.label)).toEqual(['Salaries and Employee Wages', 'Office Maid & Driver salaries']);
    expect(big.value).toBe(360);
    const mid = computeLedgerMetric(LEDGERS, spec({ conditions: [{ field: 'amount', operator: 'between', value: ['25', '35'] }] }), ANNUAL);
    expect(mid.breakdown.map((b) => b.label).sort()).toEqual(['Office Maid & Driver salaries', 'Rent']);
    // Q1 only: Salaries = 330 there too, but the payable nets to 10 over Apr-May.
    const q1 = computeLedgerMetric(LEDGERS, spec({ conditions: [{ field: 'amount', operator: 'lt', value: '15' }] }), Q1);
    expect(q1.breakdown.map((b) => b.label)).toEqual(['Arun Salary Payable']);
  });

  test('amount "is empty" means no activity in the period', () => {
    const rows = [...LEDGERS, ledger('Dormant salary advance', 'Dr', { note_no: 23 })];
    const r = computeLedgerMetric(rows, spec({ conditions: [{ field: 'amount', operator: 'is_empty', value: '' }] }), ANNUAL);
    expect(r.breakdown.map((b) => b.label)).toEqual(['Dormant salary advance']);
  });
});

describe('aggregations', () => {
  const salar = (aggregation: LedgerMetricSpec['aggregation']) => spec({ aggregation, conditions: [{ field: 'ledger_name', operator: 'contains', value: 'salar' }] });
  // Matched: Salaries 330, Office 30, Payable 10 (+ a dormant ledger below).
  const rows = [...LEDGERS, ledger('Dormant salary advance', 'Dr', { note_no: 23 })];

  test('sum counts every matched ledger (the default)', () => {
    expect(computeLedgerMetric(rows, salar(undefined), ANNUAL).value).toBe(370);
    expect(computeLedgerMetric(rows, salar('sum'), ANNUAL).value).toBe(370);
  });
  test('average / count / smallest / largest use only ledgers with activity', () => {
    expect(computeLedgerMetric(rows, salar('avg'), ANNUAL).value).toBeCloseTo(370 / 3, 10);
    expect(computeLedgerMetric(rows, salar('count'), ANNUAL).value).toBe(3);
    expect(computeLedgerMetric(rows, salar('min'), ANNUAL).value).toBe(10);
    expect(computeLedgerMetric(rows, salar('max'), ANNUAL).value).toBe(330);
    // All four ledgers still MATCHED — the breakdown lists what the filter picked.
    expect(computeLedgerMetric(rows, salar('avg'), ANNUAL).matchedCount).toBe(4);
  });
  test('the trend aggregates each month the same way', () => {
    const r = computeLedgerMetric(rows, salar('avg'), ANNUAL);
    expect(r.trend[0].value).toBeCloseTo((100 + 10 + 10) / 3, 10); // Apr: Salaries 100, Office 10, Payable 100 - 90
    expect(computeLedgerMetric(rows, salar('count'), ANNUAL).trend[2].value).toBe(2); // Jun: Salaries, Office
  });
  test('with nothing active, average/smallest/largest are honestly null and count is 0', () => {
    const none = (aggregation: LedgerMetricSpec['aggregation']) => spec({ aggregation, conditions: [{ field: 'ledger_name', operator: 'contains', value: 'zzz' }] });
    expect(computeLedgerMetric(LEDGERS, none('avg'), ANNUAL).value).toBeNull();
    expect(computeLedgerMetric(LEDGERS, none('max'), ANNUAL).value).toBeNull();
    expect(computeLedgerMetric(LEDGERS, none('count'), ANNUAL).value).toBe(0);
  });
  test('invert applies before combining, so the smallest inverted figure is the largest cost', () => {
    expect(computeLedgerMetric(rows, { ...salar('min'), sign: 'invert' }, ANNUAL).value).toBe(-330);
  });
});

describe('priorPeriodOf', () => {
  test('FY quarters and halves step back within the year, and Q1/H1/annual reach into the previous year', () => {
    expect(priorPeriodOf({ periodType: 'quarterly', period: 'Q3', yearType: 'FY' })).toEqual({ params: { periodType: 'quarterly', period: 'Q2', yearType: 'FY' }, source: 'same' });
    expect(priorPeriodOf({ periodType: 'quarterly', period: 'Q1', yearType: 'FY' })).toEqual({ params: { periodType: 'quarterly', period: 'Q4', yearType: 'FY' }, source: 'previous' });
    expect(priorPeriodOf({ periodType: 'halfyear', period: 'H2', yearType: 'FY' })).toEqual({ params: { periodType: 'halfyear', period: 'H1', yearType: 'FY' }, source: 'same' });
    expect(priorPeriodOf({ periodType: 'halfyear', period: 'H1', yearType: 'FY' })).toEqual({ params: { periodType: 'halfyear', period: 'H2', yearType: 'FY' }, source: 'previous' });
    expect(priorPeriodOf({ periodType: 'annual', period: null, yearType: 'FY' })).toMatchObject({ source: 'previous' });
  });
  test('calendar-year mode has no previous year in the bundle — only within-year steps', () => {
    expect(priorPeriodOf({ periodType: 'quarterly', period: 'Q2', yearType: 'CY' })).toMatchObject({ source: 'same', params: { period: 'Q1' } });
    expect(priorPeriodOf({ periodType: 'quarterly', period: 'Q1', yearType: 'CY' })).toBeNull();
    expect(priorPeriodOf({ periodType: 'annual', period: null, yearType: 'CY' })).toBeNull();
  });
});
