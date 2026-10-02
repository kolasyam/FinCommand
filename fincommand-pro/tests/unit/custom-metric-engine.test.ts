import {
  evaluateExpr, resolveCustomMetric, validateExpr, resolveAnyMetric,
  buildChainExpr, flattenChain, describeExpr,
  type FormulaExpr, type CustomMetricDefinition, type Operand, type ChainStep,
} from '@/lib/financial/custom-metric-engine';
import { isKnownMetricKey, resolveMetric } from '@/lib/financial/dashboard-builder-engine';
import type { ReportBundle } from '@/lib/types/dashboard';
import type { MISColumn } from '@/lib/financial/tb-engine';

function misColumn(rev: number, cos: number, ebitda: number, pat: number): MISColumn {
  return { rev, oth: 0, totInc: rev, cos, emp: 0, fin: 0, dep: 0, oex: 0, totExp: cos, pbt: pat, tax: 0, pat, ebitda, gm: 0, em: 0, pm: 0 };
}

/** Same targeted-fixture convention as dashboard-builder-engine.test.ts — only the ReportBundle paths evaluateExpr/resolveMetric actually read. */
function makeBundle(overrides: Partial<ReportBundle> = {}): ReportBundle {
  const base = {
    mis: {
      columns: ['Apr', 'May', 'Jun'],
      data: [misColumn(100, 40, 60, 45)],
      totals: { ...misColumn(330, 127, 203, 150), rev: 330, emp: 90 },
    },
    prev_mis: null,
    bs: {
      equity_liabilities: { equity: [], non_current_liab: [], current_liab: [], total_equity: 1000, total_ncl: 200, total_cl: 300, total: 1500 },
      assets: { non_current: [], current: [], total_nca: 900, total_ca: 600, total: 1500 },
      balanced: true, difference: 0,
    },
    prev_bs: null,
  } as unknown as ReportBundle;
  return { ...base, ...overrides };
}

describe('evaluateExpr', () => {
  const bundle = makeBundle();

  test('const node returns its literal value', () => {
    expect(evaluateExpr({ type: 'const', value: 42 }, bundle)).toBe(42);
  });

  test('metric node resolves through the built-in catalog', () => {
    expect(evaluateExpr({ type: 'metric', key: 'revenue' }, bundle)).toBe(330);
  });

  test('metric node is honestly null for an unknown key, never fabricated', () => {
    expect(evaluateExpr({ type: 'metric', key: 'not_a_real_metric' }, bundle)).toBeNull();
  });

  test('add sums all args', () => {
    const expr: FormulaExpr = { type: 'op', op: 'add', args: [{ type: 'const', value: 2 }, { type: 'const', value: 3 }, { type: 'const', value: 5 }] };
    expect(evaluateExpr(expr, bundle)).toBe(10);
  });

  test('multiply reduces all args', () => {
    const expr: FormulaExpr = { type: 'op', op: 'multiply', args: [{ type: 'const', value: 2 }, { type: 'const', value: 3 }, { type: 'const', value: 4 }] };
    expect(evaluateExpr(expr, bundle)).toBe(24);
  });

  test('subtract is order-sensitive (a - b, not b - a)', () => {
    const expr: FormulaExpr = { type: 'op', op: 'subtract', args: [{ type: 'const', value: 10 }, { type: 'const', value: 3 }] };
    expect(evaluateExpr(expr, bundle)).toBe(7);
  });

  test('divide computes a / b', () => {
    const expr: FormulaExpr = { type: 'op', op: 'divide', args: [{ type: 'const', value: 10 }, { type: 'const', value: 4 }] };
    expect(evaluateExpr(expr, bundle)).toBe(2.5);
  });

  test('divide by zero is honestly null, never Infinity', () => {
    const expr: FormulaExpr = { type: 'op', op: 'divide', args: [{ type: 'const', value: 10 }, { type: 'const', value: 0 }] };
    expect(evaluateExpr(expr, bundle)).toBeNull();
  });

  test('safe_divide by zero is null, matching divide', () => {
    const expr: FormulaExpr = { type: 'op', op: 'safe_divide', args: [{ type: 'const', value: 10 }, { type: 'const', value: 0 }] };
    expect(evaluateExpr(expr, bundle)).toBeNull();
  });

  test('percent_of computes (a / b) * 100', () => {
    const expr: FormulaExpr = { type: 'op', op: 'percent_of', args: [{ type: 'const', value: 25 }, { type: 'const', value: 200 }] };
    expect(evaluateExpr(expr, bundle)).toBe(12.5);
  });

  test('percent_of by zero is null, never Infinity', () => {
    const expr: FormulaExpr = { type: 'op', op: 'percent_of', args: [{ type: 'const', value: 25 }, { type: 'const', value: 0 }] };
    expect(evaluateExpr(expr, bundle)).toBeNull();
  });

  test('a real composed formula: employee cost as % of revenue', () => {
    const expr: FormulaExpr = {
      type: 'op', op: 'percent_of',
      args: [{ type: 'metric', key: 'employee_cost' }, { type: 'metric', key: 'revenue' }],
    };
    // employee_cost totals.emp = 90, revenue totals.rev = 330
    expect(evaluateExpr(expr, bundle)).toBeCloseTo((90 / 330) * 100, 6);
  });

  test('any unresolvable node anywhere in the tree makes the whole result null', () => {
    const expr: FormulaExpr = {
      type: 'op', op: 'add',
      args: [{ type: 'metric', key: 'revenue' }, { type: 'metric', key: 'not_a_real_metric' }],
    };
    expect(evaluateExpr(expr, bundle)).toBeNull();
  });

  test('depth beyond the hard cap is rejected, not evaluated (no pathological/DoS trees)', () => {
    // Build a 10-level-deep chain of `add(const, add(const, add(...)))`, past MAX_DEPTH (8).
    let expr: FormulaExpr = { type: 'const', value: 1 };
    for (let i = 0; i < 10; i++) {
      expr = { type: 'op', op: 'add', args: [{ type: 'const', value: 1 }, expr] };
    }
    expect(evaluateExpr(expr, bundle)).toBeNull();
  });

  test('previous uses genuine prior-year figures, never derived from the current value', () => {
    const prev = makeBundle();
    const bundle2 = makeBundle({ prev_mis: prev.mis });
    const expr: FormulaExpr = { type: 'metric', key: 'revenue' };
    expect(evaluateExpr(expr, bundle2, 'previous')).toBe(330); // same fixture reused as "prior year"
  });

  test('min returns the smallest of all args', () => {
    const expr: FormulaExpr = { type: 'op', op: 'min', args: [{ type: 'const', value: 7 }, { type: 'const', value: 2 }, { type: 'const', value: 5 }] };
    expect(evaluateExpr(expr, bundle)).toBe(2);
  });

  test('max returns the largest of all args', () => {
    const expr: FormulaExpr = { type: 'op', op: 'max', args: [{ type: 'const', value: 7 }, { type: 'const', value: 2 }, { type: 'const', value: 5 }] };
    expect(evaluateExpr(expr, bundle)).toBe(7);
  });
});

describe('resolveCustomMetric', () => {
  test('wraps evaluateExpr into the standard ResolvedMetric shape with a real YoY delta', () => {
    const prev = makeBundle();
    const bundle = makeBundle({ prev_mis: { ...prev.mis, totals: { ...prev.mis.totals, rev: 300 } } });
    const def: CustomMetricDefinition = {
      key: 'my_custom_metric', label: 'My Custom Metric', valueType: 'currency', decimals: 2,
      expression: { type: 'metric', key: 'revenue' },
      thresholds: null,
    };
    const m = resolveCustomMetric(def, bundle);
    expect(m.value).toBe(330);
    expect(m.previous).toBe(300);
    expect(m.deltaPct).toBeCloseTo(10, 6);
    // v2: a formula whose every input has a real monthly trend carries that
    // trend through (revenue here) — never fabricated, never a breakdown.
    expect(m.trend).toEqual(resolveMetric('revenue', bundle)!.trend);
    expect(m.breakdown).toBeUndefined();
  });

  test('deltaPct is honestly null when there is no prior value', () => {
    const def: CustomMetricDefinition = {
      key: 'my_custom_metric', label: 'My Custom Metric', valueType: 'currency', decimals: 2,
      expression: { type: 'metric', key: 'revenue' },
      thresholds: null,
    };
    const m = resolveCustomMetric(def, makeBundle());
    expect(m.previous).toBeNull();
    expect(m.deltaPct).toBeNull();
  });
});

describe('validateExpr', () => {
  test('accepts a well-formed expression referencing only built-in keys', () => {
    const expr: FormulaExpr = { type: 'op', op: 'percent_of', args: [{ type: 'metric', key: 'employee_cost' }, { type: 'metric', key: 'revenue' }] };
    expect(validateExpr(expr, isKnownMetricKey)).toEqual({ ok: true });
  });

  test('rejects a metric node referencing an unknown key', () => {
    const result = validateExpr({ type: 'metric', key: 'not_a_real_metric' }, isKnownMetricKey);
    expect(result.ok).toBe(false);
  });

  test('rejects a key the supplied resolver does not know (a built-in-only resolver rejects a custom key)', () => {
    const result = validateExpr({ type: 'metric', key: 'some_custom_metric' }, isKnownMetricKey);
    expect(result.ok).toBe(false);
  });

  test('accepts a custom key when the resolver includes the company custom keys (v2 custom-on-custom; cycles are checked over the whole graph separately)', () => {
    const known = (k: string) => isKnownMetricKey(k) || k === 'some_custom_metric';
    const expr = { type: 'op', op: 'add', args: [{ type: 'metric', key: 'some_custom_metric' }, { type: 'const', value: 1 }] };
    expect(validateExpr(expr, known).ok).toBe(true);
  });

  test('rejects an unknown operator', () => {
    const result = validateExpr({ type: 'op', op: 'power', args: [{ type: 'const', value: 1 }, { type: 'const', value: 2 }] }, isKnownMetricKey);
    expect(result.ok).toBe(false);
  });

  test('rejects a binary op (subtract/divide/safe_divide/percent_of) with != 2 args', () => {
    const result = validateExpr({ type: 'op', op: 'subtract', args: [{ type: 'const', value: 1 }, { type: 'const', value: 2 }, { type: 'const', value: 3 }] }, isKnownMetricKey);
    expect(result.ok).toBe(false);
  });

  test('rejects nesting beyond MAX_DEPTH', () => {
    let expr: unknown = { type: 'const', value: 1 };
    for (let i = 0; i < 10; i++) {
      expr = { type: 'op', op: 'add', args: [{ type: 'const', value: 1 }, expr] };
    }
    expect(validateExpr(expr, isKnownMetricKey).ok).toBe(false);
  });

  test('rejects a tree with more than MAX_NODES nodes', () => {
    const args = Array.from({ length: 40 }, () => ({ type: 'const', value: 1 }));
    const result = validateExpr({ type: 'op', op: 'add', args }, isKnownMetricKey);
    expect(result.ok).toBe(false);
  });

  test('rejects a non-object node', () => {
    expect(validateExpr('not an object', isKnownMetricKey).ok).toBe(false);
    expect(validateExpr(null, isKnownMetricKey).ok).toBe(false);
  });

  test('accepts min/max with more than 2 args (n-ary, not binary)', () => {
    const args = [{ type: 'const', value: 1 }, { type: 'const', value: 2 }, { type: 'const', value: 3 }];
    expect(validateExpr({ type: 'op', op: 'min', args }, isKnownMetricKey).ok).toBe(true);
    expect(validateExpr({ type: 'op', op: 'max', args }, isKnownMetricKey).ok).toBe(true);
  });

  test('an 8-step left-associative chain (CustomMetricBuilder.tsx MAX_STEPS) sits exactly at the accepted MAX_DEPTH boundary; 9 is rejected', () => {
    // Mirrors buildChainExpr()'s own left-fold shape: (((rev op c) op c) ... op c).
    const chain = (n: number) => {
      let expr: FormulaExpr = { type: 'metric', key: 'revenue' };
      for (let i = 0; i < n; i++) expr = { type: 'op', op: 'add', args: [expr, { type: 'const', value: 1 }] };
      return expr;
    };
    expect(validateExpr(chain(8), isKnownMetricKey).ok).toBe(true);
    expect(validateExpr(chain(9), isKnownMetricKey).ok).toBe(false);
  });
});

describe('buildChainExpr / flattenChain', () => {
  const first: Operand = { type: 'metric', key: 'revenue' };
  const steps: ChainStep[] = [
    { op: 'subtract', operand: { type: 'metric', key: 'employee_cost' } },
    { op: 'percent_of', operand: { type: 'metric', key: 'revenue' } },
  ];

  test('builds a left-associative nested op tree', () => {
    const expr = buildChainExpr(first, steps);
    expect(expr).toEqual({
      type: 'op', op: 'percent_of',
      args: [
        { type: 'op', op: 'subtract', args: [{ type: 'metric', key: 'revenue' }, { type: 'metric', key: 'employee_cost' }] },
        { type: 'metric', key: 'revenue' },
      ],
    });
  });

  test('every step still enforces exactly 2 args for a binary op (validateExpr accepts the built tree)', () => {
    const expr = buildChainExpr(first, steps);
    expect(validateExpr(expr, isKnownMetricKey)).toEqual({ ok: true });
  });

  test('a built chain evaluates correctly end to end', () => {
    const bundle = makeBundle();
    const expr = buildChainExpr(first, steps);
    // (revenue - employee_cost) / revenue * 100 = (330 - 90) / 330 * 100
    expect(evaluateExpr(expr, bundle)).toBeCloseTo(((330 - 90) / 330) * 100, 6);
  });

  test('flattenChain reverses buildChainExpr exactly', () => {
    const expr = buildChainExpr(first, steps);
    expect(flattenChain(expr)).toEqual({ first, steps });
  });

  test('flattenChain returns null for a shape it never wrote (not left-associative)', () => {
    const notAChain: FormulaExpr = {
      type: 'op', op: 'add',
      args: [{ type: 'metric', key: 'revenue' }, { type: 'op', op: 'add', args: [{ type: 'const', value: 1 }, { type: 'const', value: 2 }] }],
    };
    expect(flattenChain(notAChain)).toBeNull();
  });

  test('flattenChain returns null for a bare leaf (no steps)', () => {
    expect(flattenChain({ type: 'metric', key: 'revenue' })).toBeNull();
  });
});

describe('describeExpr', () => {
  test('describes a simple percent_of formula with the implicit x100', () => {
    const expr: FormulaExpr = { type: 'op', op: 'percent_of', args: [{ type: 'metric', key: 'employee_cost' }, { type: 'metric', key: 'revenue' }] };
    expect(describeExpr(expr)).toBe('(Employee Benefits ÷ Revenue from Operations) × 100');
  });

  test('describes a chained formula with nested parens around each sub-op', () => {
    const expr = buildChainExpr(
      { type: 'metric', key: 'revenue' },
      [{ op: 'subtract', operand: { type: 'metric', key: 'employee_cost' } }, { op: 'divide', operand: { type: 'const', value: 2 } }],
    );
    expect(describeExpr(expr)).toBe('(Revenue from Operations − Employee Benefits) ÷ 2');
  });

  test('describes min/max as a function call', () => {
    const expr: FormulaExpr = { type: 'op', op: 'min', args: [{ type: 'metric', key: 'revenue' }, { type: 'const', value: 100 }] };
    expect(describeExpr(expr)).toBe('min(Revenue from Operations, 100)');
  });
});

describe('resolveAnyMetric', () => {
  const bundle = makeBundle();
  const customMetrics: CustomMetricDefinition[] = [{
    key: 'salary_pct_of_revenue', label: 'Salary % of Revenue', valueType: 'percent', decimals: 1,
    expression: { type: 'op', op: 'percent_of', args: [{ type: 'metric', key: 'employee_cost' }, { type: 'metric', key: 'revenue' }] },
    thresholds: null,
  }];

  test('resolves a built-in key exactly like resolveMetric', () => {
    const m = resolveAnyMetric('revenue', bundle, customMetrics);
    expect(m?.value).toBe(330);
  });

  test('falls back to a matching custom metric definition', () => {
    const m = resolveAnyMetric('salary_pct_of_revenue', bundle, customMetrics);
    expect(m?.value).toBeCloseTo((90 / 330) * 100, 6);
    expect(m?.label).toBe('Salary % of Revenue');
  });

  test('returns null for a key that is neither built-in nor custom', () => {
    expect(resolveAnyMetric('totally_unknown', bundle, customMetrics)).toBeNull();
  });
});
