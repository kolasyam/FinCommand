import {
  evaluateExpr, resolveCustomMetric, resolveAnyMetric, validateExpr, validateLedgerSpec,
  validateCustomMetricDefinition, customMetricCapabilities, findDependencyCycle, customNestingDepth,
  findDependents, toSnapshot, fromSnapshot, diffSnapshots, buildChainExpr, flattenChain,
  describeExpr, describeLedgerSpec, MAX_CUSTOM_NESTING,
  type FormulaExpr, type CustomMetricDefinition, type ChainStep,
} from '@/lib/financial/custom-metric-engine';
import { isKnownMetricKey } from '@/lib/financial/dashboard-builder-engine';
import type { ReportBundle } from '@/lib/dashboard/types';
import type { MISColumn } from '@/lib/financial/tb-engine';

function col(rev: number, emp: number): MISColumn {
  return { rev, oth: 0, totInc: rev, cos: 0, emp, fin: 0, dep: 0, oex: 0, totExp: emp, pbt: rev - emp, tax: 0, pat: rev - emp, ebitda: rev - emp, gm: 100, em: 0, pm: 0 };
}

/** Q1 bundle: 3 monthly columns, revenue 100/110/120 (330), employee cost 30 each (90); prior year revenue 300, employee 80; one server-computed ledger metric. */
function makeBundle(): ReportBundle {
  return {
    period_params: { periodType: 'quarterly', period: 'Q1', yearType: 'FY' },
    mis: { columns: ['Apr', 'May', 'Jun'], data: [col(100, 30), col(110, 30), col(120, 30)], totals: col(330, 90) },
    prev_mis: { columns: ['Apr', 'May', 'Jun'], data: [], totals: col(300, 80) },
    bs: {
      equity_liabilities: { equity: [], non_current_liab: [], current_liab: [], total_equity: 1000, total_ncl: 200, total_cl: 300, total: 1500 },
      assets: { non_current: [], current: [], total_nca: 900, total_ca: 600, total: 1500 },
      balanced: true, difference: 0,
    },
    prev_bs: null,
    custom_metric_values: {
      salary_ledger: {
        value: 90, previous: 80,
        trend: [{ label: 'Apr', value: 30 }, { label: 'May', value: 30 }, { label: 'Jun', value: 30 }],
        breakdown: [{ label: 'Salaries and Employee Wages', value: 90 }],
        matchedCount: 1,
      },
    },
  } as unknown as ReportBundle;
}

const m = (key: string): FormulaExpr => ({ type: 'metric', key });
const c = (value: number): FormulaExpr => ({ type: 'const', value });
const op = (o: string, ...args: FormulaExpr[]): FormulaExpr => ({ type: 'op', op: o, args } as FormulaExpr);

function formula(key: string, expression: FormulaExpr, extra: Partial<CustomMetricDefinition> = {}): CustomMetricDefinition {
  return { key, label: key.replace(/_/g, ' '), kind: 'formula', valueType: 'percent', decimals: 1, expression, thresholds: null, ...extra };
}
const LEDGER_DEF: CustomMetricDefinition = {
  key: 'salary_ledger', label: 'Salary (ledgers)', kind: 'ledger', valueType: 'currency', decimals: 2, expression: null, thresholds: null,
  ledgerSpec: { match: 'all', measure: 'movement', sign: 'natural', conditions: [{ field: 'ledger_name', operator: 'contains', value: 'salar' }] },
};

describe('new functions', () => {
  const b = makeBundle();
  test('abs drops the sign', () => expect(evaluateExpr(op('abs', op('subtract', c(10), c(30))), b)).toBe(20));
  test('round to N decimal places', () => expect(evaluateExpr(op('round', op('divide', c(10), c(3)), c(2)), b)).toBe(3.33));
  test('coalesce returns the first real value (skips unresolvable)', () => {
    expect(evaluateExpr(op('coalesce', m('not_a_metric'), c(5)), b)).toBe(5);
    expect(evaluateExpr(op('coalesce', m('revenue'), c(5)), b)).toBe(330);
  });
  test('percent_change = growth vs the real prior-year value; its own previous is honestly null', () => {
    expect(evaluateExpr(op('percent_change', m('revenue')), b)).toBeCloseTo(10, 6);
    expect(evaluateExpr(op('percent_change', m('revenue')), b, 'previous')).toBeNull();
  });
  test('avg_per_month divides by the months in the selected period (Q1 = 3)', () => {
    expect(evaluateExpr(op('avg_per_month', m('revenue')), b)).toBe(110);
  });
});

describe('custom metrics referencing custom metrics', () => {
  const b = makeBundle();
  const ratio = formula('salary_ratio', op('percent_of', m('employee_cost'), m('revenue')));
  const doubled = formula('doubled_ratio', op('multiply', m('salary_ratio'), c(2)));

  test('a formula resolves another custom formula', () => {
    expect(resolveAnyMetric('doubled_ratio', b, [ratio, doubled])!.value).toBeCloseTo((90 / 330) * 200, 6);
  });

  test('a ledger metric resolves from the server-computed bundle values (value, prior year, trend, breakdown)', () => {
    const r = resolveCustomMetric(LEDGER_DEF, b);
    expect(r).toMatchObject({ value: 90, previous: 80, breakdown: [{ label: 'Salaries and Employee Wages', value: 90 }] });
    expect(r.deltaPct).toBeCloseTo(12.5, 6);
    expect(r.trend).toHaveLength(3);
  });

  test('a formula over a ledger metric gets a real per-month trend', () => {
    const f = formula('ledger_share', op('percent_of', m('salary_ledger'), m('revenue')));
    const r = resolveAnyMetric('ledger_share', b, [LEDGER_DEF, f])!;
    expect(r.value).toBeCloseTo((90 / 330) * 100, 6);
    expect(r.trend!.map((p) => +p.value.toFixed(2))).toEqual([30, 27.27, 25]);
  });

  test('a cycle that somehow reached storage resolves to null instead of recursing forever', () => {
    const a = formula('cyc_a', op('add', m('cyc_b'), c(1)));
    const bb = formula('cyc_b', op('add', m('cyc_a'), c(1)));
    expect(resolveAnyMetric('cyc_a', b, [a, bb])!.value).toBeNull();
  });

  test('nesting deeper than MAX_CUSTOM_NESTING evaluates to null (bounded cost)', () => {
    const chain: CustomMetricDefinition[] = [];
    for (let i = 0; i <= MAX_CUSTOM_NESTING + 1; i++) {
      chain.push(formula(`n_${i}`, i === MAX_CUSTOM_NESTING + 1 ? op('add', m('revenue'), c(0)) : op('add', m(`n_${i + 1}`), c(0))));
    }
    expect(resolveAnyMetric('n_0', b, chain)!.value).toBeNull();
    expect(resolveAnyMetric(`n_${MAX_CUSTOM_NESTING - 1}`, b, chain)!.value).toBe(330);
  });
});

describe('trends', () => {
  const b = makeBundle();
  test('a formula over monthly metrics gets a per-column trend aligned to MIS columns', () => {
    const r = resolveCustomMetric(formula('x', op('percent_of', m('employee_cost'), m('revenue'))), b);
    expect(r.trend!.map((p) => p.label)).toEqual(['Apr', 'May', 'Jun']);
    expect(r.trend!.map((p) => +p.value.toFixed(2))).toEqual([30, 27.27, 25]);
  });
  test('any input without a monthly trend (a Balance Sheet figure) means no trend at all — never partially guessed', () => {
    expect(resolveCustomMetric(formula('x', op('percent_of', m('revenue'), m('total_assets'))), b).trend).toBeUndefined();
  });
  test('percent_change has no honest monthly equivalent — no trend', () => {
    expect(resolveCustomMetric(formula('x', op('percent_change', m('revenue'))), b).trend).toBeUndefined();
  });
});

describe('customMetricCapabilities', () => {
  test('formula over monthly metrics → series; over a BS figure → not; never a breakdown', () => {
    expect(customMetricCapabilities(formula('x', op('percent_of', m('employee_cost'), m('revenue'))))).toEqual({ supportsSeries: true, supportsBreakdown: false });
    expect(customMetricCapabilities(formula('x', op('percent_of', m('revenue'), m('total_assets'))))).toEqual({ supportsSeries: false, supportsBreakdown: false });
  });
  test('ledger metrics support both; a formula over one inherits its series support', () => {
    expect(customMetricCapabilities(LEDGER_DEF)).toEqual({ supportsSeries: true, supportsBreakdown: true });
    expect(customMetricCapabilities(formula('x', op('add', m('salary_ledger'), c(1))), [LEDGER_DEF]).supportsSeries).toBe(true);
  });
});

describe('validation', () => {
  test('unary functions take exactly one argument; round needs 0-6 whole decimal places; coalesce needs 2+', () => {
    expect(validateExpr(op('abs', c(1), c(2)), isKnownMetricKey).ok).toBe(false);
    expect(validateExpr(op('percent_change', m('revenue')), isKnownMetricKey).ok).toBe(true);
    expect(validateExpr(op('round', c(1), c(7)), isKnownMetricKey).ok).toBe(false);
    expect(validateExpr(op('round', c(1), c(1.5)), isKnownMetricKey).ok).toBe(false);
    expect(validateExpr(op('round', c(1), m('revenue')), isKnownMetricKey).ok).toBe(false);
    expect(validateExpr(op('round', c(1), c(2)), isKnownMetricKey).ok).toBe(true);
    expect(validateExpr(op('coalesce', c(1)), isKnownMetricKey).ok).toBe(false);
  });

  test('validateLedgerSpec normalizes a comma list and rejects bad input', () => {
    const ok = validateLedgerSpec({ match: 'any', measure: 'closing', conditions: [{ field: 'note_no', operator: 'in', value: '23, 26 ,' }] });
    expect(ok).toEqual({ ok: true, spec: { match: 'any', measure: 'closing', sign: 'natural', aggregation: 'sum', conditions: [{ field: 'note_no', operator: 'in', value: ['23', '26'] }] } });
    expect(validateLedgerSpec({ match: 'all', measure: 'movement', conditions: [] }).ok).toBe(false);
    expect(validateLedgerSpec({ match: 'all', measure: 'movement', conditions: [{ field: 'nope', operator: 'equals', value: '1' }] }).ok).toBe(false);
    expect(validateLedgerSpec({ match: 'all', measure: 'movement', conditions: [{ field: 'ledger_name', operator: 'regex', value: '.*' }] }).ok).toBe(false);
    expect(validateLedgerSpec({ match: 'all', measure: 'movement', conditions: [{ field: 'ledger_name', operator: 'contains', value: '  ' }] }).ok).toBe(false);
    expect(validateLedgerSpec({ match: 'most', measure: 'movement', conditions: [{ field: 'ledger_name', operator: 'contains', value: 'x' }] }).ok).toBe(false);
  });

  const existing = [formula('base_ratio', op('percent_of', m('employee_cost'), m('revenue')))];

  test('accepts a formula that references an existing custom metric', () => {
    const r = validateCustomMetricDefinition(formula('uses_base', op('multiply', m('base_ratio'), c(2))), existing);
    expect(r.ok).toBe(true);
  });
  test('rejects a change that would create a cycle, naming the path', () => {
    const r = validateCustomMetricDefinition(formula('base_ratio', op('add', m('uses_base'), c(1))), [...existing, formula('uses_base', op('multiply', m('base_ratio'), c(2)))]);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('Circular reference') });
  });
  test('rejects self-reference, reserved and built-in keys, a bare leaf, and an unknown reference', () => {
    expect(validateCustomMetricDefinition(formula('self_ref', op('add', m('self_ref'), c(1))), existing).ok).toBe(false);
    expect(validateCustomMetricDefinition(formula('preview', op('add', m('revenue'), c(1))), existing).ok).toBe(false);
    expect(validateCustomMetricDefinition(formula('revenue', op('add', m('revenue'), c(1))), existing).ok).toBe(false);
    expect(validateCustomMetricDefinition(formula('bare_leaf', m('revenue')), existing).ok).toBe(false);
    expect(validateCustomMetricDefinition(formula('unknown_ref', op('add', m('nope_metric'), c(1))), existing).ok).toBe(false);
  });
  test('rejects nesting beyond MAX_CUSTOM_NESTING', () => {
    const chain: CustomMetricDefinition[] = [];
    for (let i = 1; i <= MAX_CUSTOM_NESTING; i++) {
      chain.push(formula(`lvl_${i}`, i === MAX_CUSTOM_NESTING ? op('add', m('revenue'), c(0)) : op('add', m(`lvl_${i + 1}`), c(0))));
    }
    expect(customNestingDepth('lvl_1', chain)).toBe(MAX_CUSTOM_NESTING);
    expect(validateCustomMetricDefinition(formula('lvl_0', op('add', m('lvl_1'), c(0))), chain).ok).toBe(false);
  });
  test('ledger definitions are validated and normalized; a ledger metric needs conditions', () => {
    const r = validateCustomMetricDefinition(LEDGER_DEF, existing);
    expect(r.ok && r.definition.expression).toBeNull();
    expect(validateCustomMetricDefinition({ ...LEDGER_DEF, ledgerSpec: { ...LEDGER_DEF.ledgerSpec!, conditions: [] } }, existing).ok).toBe(false);
  });
});

describe('dependency graph helpers', () => {
  const a = formula('g_a', op('add', m('g_b'), m('g_c')));
  const bdef = formula('g_b', op('add', m('g_c'), c(1)));
  const cdef = formula('g_c', op('add', m('revenue'), c(1)));
  test('acyclic graph → no cycle; depth counts the longest custom chain', () => {
    expect(findDependencyCycle([a, bdef, cdef])).toBeNull();
    expect(customNestingDepth('g_a', [a, bdef, cdef])).toBe(3);
  });
  test('cycle path is reported', () => {
    const cyc = findDependencyCycle([formula('x1', op('add', m('x2'), c(0))), formula('x2', op('add', m('x1'), c(0)))]);
    expect(cyc).toEqual(['x1', 'x2', 'x1']);
  });
  test('findDependents lists direct dependents only', () => {
    expect(findDependents('g_c', [a, bdef, cdef]).sort()).toEqual(['g_a', 'g_b']);
    expect(findDependents('g_a', [a, bdef, cdef])).toEqual([]);
  });
});

describe('version snapshots', () => {
  test('toSnapshot/fromSnapshot round-trips a definition', () => {
    const def = formula('snap_me', op('percent_of', m('employee_cost'), m('revenue')), { thresholds: { target: 30, direction: 'lower_is_better' }, description: 'desc' });
    expect(fromSnapshot(toSnapshot(def))).toEqual({ ...def, ledgerSpec: null, comparison: 'prior_year' });
    expect(fromSnapshot(toSnapshot(LEDGER_DEF))).toEqual({ ...LEDGER_DEF, description: null, comparison: 'prior_year' });
  });
  test('diffSnapshots names exactly the changed fields', () => {
    const before = toSnapshot(formula('d', op('add', m('revenue'), c(1))));
    const after = toSnapshot(formula('d', op('add', m('revenue'), c(2)), { label: 'renamed', decimals: 2 }));
    expect(diffSnapshots(before, after).sort()).toEqual(['decimals', 'expression', 'label']);
    expect(diffSnapshots(null, after)).toEqual(['created']);
    expect(diffSnapshots(after, after)).toEqual([]);
  });
});

describe('chains with function steps', () => {
  test('build → flatten round-trips unary and round steps, and evaluates', () => {
    const steps: ChainStep[] = [
      { op: 'subtract', operand: { type: 'metric', key: 'employee_cost' } },
      { op: 'abs' },
      { op: 'round', operand: { type: 'const', value: 1 } },
    ];
    const expr = buildChainExpr({ type: 'metric', key: 'revenue' }, steps);
    expect(flattenChain(expr)).toEqual({ first: { type: 'metric', key: 'revenue' }, steps });
    expect(evaluateExpr(expr, makeBundle())).toBe(240);
  });
  test('describeExpr renders functions and custom-metric labels', () => {
    expect(describeExpr(op('percent_change', m('revenue')))).toBe('% change vs prior year of (Revenue from Operations)');
    expect(describeExpr(op('abs', m('my_custom')), { labelFor: (k) => (k === 'my_custom' ? 'My Custom' : undefined) })).toBe('|My Custom|');
    expect(describeExpr(op('round', m('revenue'), c(2)))).toBe('round(Revenue from Operations, 2)');
  });
  test('describeLedgerSpec reads as plain English', () => {
    expect(describeLedgerSpec(LEDGER_DEF.ledgerSpec!)).toBe('Movement of ledgers where Ledger name contains "salar"');
  });
});

describe('number-based ledger conditions and aggregations (validation)', () => {
  const base = { match: 'all', measure: 'movement' };
  const one = (cond: Record<string, unknown>, extra: Record<string, unknown> = {}) => validateLedgerSpec({ ...base, ...extra, conditions: [cond] });

  test('amount takes number operators; a text-only operator on it is rejected, and vice versa', () => {
    expect(one({ field: 'amount', operator: 'gt', value: '1,00,000' }).ok).toBe(true);
    expect(one({ field: 'amount', operator: 'contains', value: '1' }).ok).toBe(false);
    expect(one({ field: 'ledger_name', operator: 'gt', value: '5' }).ok).toBe(false);
    expect(one({ field: 'amount', operator: 'gte', value: 'lots' }).ok).toBe(false);
  });
  test('between needs a lower and an upper number, lower first', () => {
    expect(one({ field: 'note_no', operator: 'between', value: ['20', '25'] })).toMatchObject({ ok: true, spec: { conditions: [{ value: ['20', '25'] }] } });
    expect(one({ field: 'note_no', operator: 'between', value: '20, 25' })).toMatchObject({ ok: true, spec: { conditions: [{ value: ['20', '25'] }] } });
    expect(one({ field: 'note_no', operator: 'between', value: ['25', '20'] }).ok).toBe(false);
    expect(one({ field: 'note_no', operator: 'between', value: ['20'] }).ok).toBe(false);
  });
  test('is empty / is not empty need no value (whatever was sent is dropped)', () => {
    expect(one({ field: 'ledger_code', operator: 'is_empty', value: 'ignored' })).toMatchObject({ ok: true, spec: { conditions: [{ value: '' }] } });
    expect(one({ field: 'note_no', operator: 'is_not_empty' }).ok).toBe(true);
  });
  test('aggregation defaults to sum, keeps a known one, rejects an unknown one', () => {
    expect(one({ field: 'ledger_name', operator: 'contains', value: 'x' })).toMatchObject({ spec: { aggregation: 'sum' } });
    expect(one({ field: 'ledger_name', operator: 'contains', value: 'x' }, { aggregation: 'avg' })).toMatchObject({ spec: { aggregation: 'avg' } });
    expect(one({ field: 'ledger_name', operator: 'contains', value: 'x' }, { aggregation: 'median' }).ok).toBe(false);
  });
  test('describeLedgerSpec reads the new operators and aggregations in plain English', () => {
    const text = describeLedgerSpec({
      match: 'all', measure: 'movement', sign: 'natural', aggregation: 'count',
      conditions: [{ field: 'amount', operator: 'between', value: ['1000', '5000'] }, { field: 'ledger_code', operator: 'is_empty', value: '' }],
    });
    expect(text).toMatch(/Number of ledgers/);
    expect(text).toMatch(/between/);
    expect(text).toMatch(/empty/);
  });
});

describe('warn level and comparison choice', () => {
  const ratio = op('percent_of', m('employee_cost'), m('revenue'));

  test('a warn level must sit on the bad side of the target', () => {
    const higher = (warn: number) => validateCustomMetricDefinition(formula('warn_hi', ratio, { thresholds: { target: 30, direction: 'higher_is_better', warn } }), []);
    expect(higher(20).ok).toBe(true);
    expect(higher(30).ok).toBe(false);
    expect(higher(40).ok).toBe(false);
    const lower = (warn: number) => validateCustomMetricDefinition(formula('warn_lo', ratio, { thresholds: { target: 30, direction: 'lower_is_better', warn } }), []);
    expect(lower(35).ok).toBe(true);
    expect(lower(25).ok).toBe(false);
  });
  test('the warn level is kept on the saved definition; comparison defaults to prior_year and rejects unknown values', () => {
    const r = validateCustomMetricDefinition(formula('warn_keep', ratio, { thresholds: { target: 30, direction: 'lower_is_better', warn: 35 } }), []);
    expect(r.ok && r.definition.thresholds).toEqual({ target: 30, direction: 'lower_is_better', warn: 35 });
    expect(r.ok && r.definition.comparison).toBe('prior_year');
    expect(validateCustomMetricDefinition(formula('cmp_bad', ratio, { comparison: 'last_week' as never }), []).ok).toBe(false);
  });

  test('comparison "none" drops the change figure entirely', () => {
    const r = resolveCustomMetric(formula('cmp_none', ratio, { comparison: 'none' }), makeBundle());
    expect(r.value).toBeCloseTo((90 / 330) * 100, 6);
    expect(r.previous).toBeNull();
    expect(r.deltaPct).toBeNull();
    expect(r.comparisonLabel).toBeUndefined();
  });
  test('comparison "prior_year" is the default and labelled YoY', () => {
    const r = resolveCustomMetric(formula('cmp_py', ratio), makeBundle());
    expect(r.previous).toBeCloseTo((80 / 300) * 100, 6);
    expect(r.comparisonLabel).toBe('YoY');
  });
  test('comparison "prior_period" evaluates the same formula against the previous period statements', () => {
    const b = makeBundle();
    b.prior_period = {
      label: 'Q4', financial_year_label: 'FY 2024-25',
      mis: { columns: ['Jan', 'Feb', 'Mar'], data: [], totals: col(400, 100) },
      bs: b.bs, pl: b.pl, cashflow: b.cashflow, treasury: b.treasury, ratios: b.ratios, notes: [],
      custom_metric_values: { salary_ledger: { value: 70, previous: null, trend: [], breakdown: [], matchedCount: 1 } },
    } as unknown as ReportBundle['prior_period'];
    const f = resolveCustomMetric(formula('cmp_pp', ratio, { comparison: 'prior_period' }), b);
    expect(f.previous).toBeCloseTo(25, 6); // 100 / 400
    expect(f.deltaPct).toBeCloseTo((((90 / 330) * 100 - 25) / 25) * 100, 6);
    expect(f.comparisonLabel).toBe('vs prior period');
    const l = resolveCustomMetric({ ...LEDGER_DEF, comparison: 'prior_period' }, b);
    expect(l.value).toBe(90);
    expect(l.previous).toBe(70);
  });
  test('without previous-period statements in the bundle a prior-period comparison is honestly null', () => {
    const r = resolveCustomMetric(formula('cmp_pp_none', ratio, { comparison: 'prior_period' }), makeBundle());
    expect(r.previous).toBeNull();
    expect(r.deltaPct).toBeNull();
  });
  test('snapshots carry warn and comparison; an old snapshot without them reads as no warn + prior_year', () => {
    const def = formula('snap_cmp', ratio, { thresholds: { target: 30, direction: 'lower_is_better', warn: 35 }, comparison: 'prior_period' });
    const snap = toSnapshot(def);
    expect(snap).toMatchObject({ warnValue: 35, comparison: 'prior_period' });
    expect(fromSnapshot(snap)).toMatchObject({ thresholds: { warn: 35 }, comparison: 'prior_period' });
    const legacy = { ...toSnapshot(formula('snap_old', ratio)) } as Record<string, unknown>;
    delete legacy.warnValue;
    delete legacy.comparison;
    expect(fromSnapshot(legacy as never).comparison).toBe('prior_year');
    expect(diffSnapshots(legacy as never, toSnapshot(formula('snap_old', ratio)))).toEqual([]);
    expect(diffSnapshots(toSnapshot(formula('snap_old', ratio)), toSnapshot(formula('snap_old', ratio, { comparison: 'none' })))).toEqual(['comparison']);
  });
});
