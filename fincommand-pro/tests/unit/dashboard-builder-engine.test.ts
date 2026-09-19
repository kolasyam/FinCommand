import {
  resolveMetric, isValidGridBounds, parseWidgetsInput, METRIC_CATALOG, isTabKey, TAB_KEYS,
  thresholdStatus, ratioOf, WIDGET_KINDS, WIDGET_MIN_SERIES, WIDGET_MAX_SERIES,
} from '@/lib/financial/dashboard-builder-engine';
import type { ReportBundle } from '@/lib/dashboard/types';
import type { MISColumn, AggregatedNote } from '@/lib/financial/tb-engine';

function misColumn(rev: number, cos: number, ebitda: number, pat: number): MISColumn {
  return { rev, oth: 0, totInc: rev, cos, emp: 0, fin: 0, dep: 0, oex: 0, totExp: cos, pbt: pat, tax: 0, pat, ebitda, gm: 0, em: 0, pm: 0 };
}

/** Minimal fixture covering every ReportBundle path dashboard-builder-engine.ts actually reads — not a complete, real bundle (see tb-engine.test.ts for that level of fidelity), same targeted-fixture convention as this file's sibling engine tests. */
function makeBundle(overrides: Partial<ReportBundle> = {}): ReportBundle {
  const base = {
    mis: {
      columns: ['Apr', 'May', 'Jun'],
      data: [misColumn(100, 40, 60, 45), misColumn(110, 42, 68, 50), misColumn(120, 45, 75, 55)],
      totals: { ...misColumn(330, 127, 203, 150), rev: 330 },
    },
    prev_mis: null,
    bs: {
      equity_liabilities: { equity: [], non_current_liab: [], current_liab: [], total_equity: 1000, total_ncl: 200, total_cl: 300, total: 1500 },
      assets: { non_current: [], current: [], total_nca: 900, total_ca: 600, total: 1500 },
      balanced: true, difference: 0,
    },
    prev_bs: null,
    pl: {
      revenue: 330, other_income: 5, total_income: 335,
      cos: 127, employee_benefits: 40, finance_costs: 10, depreciation: 8, other_expenses: 20, total_expenses: 205,
      pbt: 130, current_tax: 32, deferred_tax: 1, pat: 97,
      oci_gross: null, oci_tax: null, oci_net: null, total_comprehensive_income: null,
      eps_basic: null, eps_diluted: null, notes: {},
    },
    prev_pl: null,
    notes: [],
    prev_notes: null,
    treasury: {
      cash: [{ name: 'Cash', closing: 10 }], bank_ca: [{ name: 'Bank CA', closing: 40 }], bank_sb: [{ name: 'Bank SB', closing: 20 }],
      fds: [], mfs: [],
      total_cash_and_bank: 70, total_fd: 100, total_mf: 30, total: 200,
    },
    prev_treasury: null,
    cashflow: {
      operating: { total: 55 }, investing: { total: -20 }, financing: { total: -10 },
      net_change: 25, opening_cash: 100, closing_cash: 125, free_cash_flow: 35, ocf_to_pat: 1.1, reconciling_gap: 0,
    },
    prev_cashflow: null,
    ratios: {
      liquidity: { current_ratio: 2, quick_ratio: 1.5, cash_ratio: 0.2 },
      profitability: { gross_margin: 60, ebitda_margin: 15, net_margin: 10, roe: 20, roce: 18 },
      leverage: { debt_equity: 0.5, interest_cover: 8, dscr: null },
      efficiency: { asset_turnover: 1.2, dso: 45, dpo: 30, ccc: 40 },
      cashflow: { free_cash_flow: 35, ocf_to_pat: 1.1 },
      dupont: { net_margin: 10, asset_turnover: 1.2, equity_multiplier: 1.5, roe: 20 },
    },
    top_customers: [{ customer: 'Acme', revenue_cr: 1.2, pct_of_total: 40, status: 'Key Account', source: 'zoho' }],
    vendor_expense: [{ vendor: 'Vendor A', amount: 500, pct_of_total: 50, status: 'Key Vendor' }],
    customer_margin: {
      entries: [{ customer: 'Acme', revenue: 1000, direct_cost: 200, direct_margin: 800, direct_margin_pct: 80 }],
      org_tracks_direct_cost: true,
    },
  } as unknown as ReportBundle;
  return { ...base, ...overrides };
}

describe('METRIC_CATALOG', () => {
  test('has no duplicate keys', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    METRIC_CATALOG.forEach((m) => {
      if (seen.has(m.key)) dupes.push(m.key);
      seen.add(m.key);
    });
    expect(dupes).toEqual([]);
  });

  test('every ratio threshold reuses a real target, never an unset/placeholder value', () => {
    METRIC_CATALOG.filter((m) => m.thresholds).forEach((m) => {
      expect(typeof m.thresholds!.target).toBe('number');
      expect(['higher_is_better', 'lower_is_better']).toContain(m.thresholds!.direction);
    });
  });
});

describe('resolveMetric', () => {
  test('returns null for an unrecognized key — never guesses', () => {
    expect(resolveMetric('not_a_real_metric', makeBundle())).toBeNull();
  });

  test('a stat metric (revenue) resolves value, trend, and deltaPct from a real prior-year bundle', () => {
    const prev = makeBundle();
    const bundle = makeBundle({ prev_mis: prev.mis });
    const m = resolveMetric('revenue', bundle)!;
    expect(m.value).toBe(330);
    expect(m.previous).toBe(330); // same fixture reused as "prior year"
    expect(m.deltaPct).toBe(0);
    expect(m.trend).toEqual([
      { label: 'Apr', value: 100 }, { label: 'May', value: 110 }, { label: 'Jun', value: 120 },
    ]);
    expect(m.valueType).toBe('currency');
  });

  test('previous is honestly null (not fabricated) when there is no prior-year bundle', () => {
    const m = resolveMetric('ebitda', makeBundle())!;
    expect(m.previous).toBeNull();
    expect(m.deltaPct).toBeNull();
  });

  test('a computed metric (gross profit) derives from rev-cos on both totals and the monthly trend', () => {
    const m = resolveMetric('gross_profit', makeBundle())!;
    expect(m.value).toBe(330 - 127);
    expect(m.trend).toEqual([
      { label: 'Apr', value: 60 }, { label: 'May', value: 68 }, { label: 'Jun', value: 75 },
    ]);
  });

  test('a point-in-time Balance Sheet metric has no monthly trend — honestly undefined, not a fabricated flat line', () => {
    const m = resolveMetric('total_assets', makeBundle())!;
    expect(m.value).toBe(1500);
    expect(m.trend).toBeUndefined();
  });

  test('a ratio metric carries its real benchmark threshold and no monthly trend', () => {
    const m = resolveMetric('current_ratio', makeBundle())!;
    expect(m.value).toBe(2);
    expect(m.valueType).toBe('ratio');
    expect(m.thresholds).toEqual({ direction: 'higher_is_better', target: 1.5 });
    expect(m.previous).toBeNull(); // ReportBundle carries no prior-year ratios anywhere
  });

  test('a nullable ratio (DSCR) stays null, never coerced to 0 or Infinity', () => {
    const m = resolveMetric('dscr', makeBundle())!;
    expect(m.value).toBeNull();
    expect(m.deltaPct).toBeNull();
  });

  test('treasury_composition resolves a real breakdown from real treasury entries/totals', () => {
    const m = resolveMetric('treasury_composition', makeBundle())!;
    expect(m.value).toBe(200);
    expect(m.breakdown).toEqual([
      { label: 'Cash in Hand', value: 10 },
      { label: 'Bank — Current', value: 40 },
      { label: 'Bank — Savings', value: 20 },
      { label: 'Fixed Deposits', value: 100 },
      { label: 'Mutual Funds', value: 30 },
    ]);
  });

  test('top_customers_revenue is Crore-unit and breakdown-only — no fabricated single "value"', () => {
    const m = resolveMetric('top_customers_revenue', makeBundle())!;
    expect(m.rawUnit).toBe('crore');
    expect(m.value).toBeNull();
    expect(m.breakdown).toEqual([{ label: 'Acme', value: 1.2 }]);
  });

  test('vendor_expense_by_vendor and customer_direct_margin resolve real breakdowns', () => {
    const vendors = resolveMetric('vendor_expense_by_vendor', makeBundle())!;
    expect(vendors.breakdown).toEqual([{ label: 'Vendor A', value: 500 }]);
    const margin = resolveMetric('customer_direct_margin', makeBundle())!;
    expect(margin.breakdown).toEqual([{ label: 'Acme', value: 800 }]);
  });

  test('net_working_capital derives from CA - CL on both current and prior-year balance sheets', () => {
    const prev = makeBundle();
    const bundle = makeBundle({ prev_bs: prev.bs });
    const m = resolveMetric('net_working_capital', bundle)!;
    expect(m.value).toBe(600 - 300); // total_ca - total_cl
    expect(m.previous).toBe(600 - 300);
  });

  // P&L-zone metrics (Phase 1 of the P&L customization build) — sourced from
  // bundle.pl directly, NOT bundle.mis.totals, specifically so they can never
  // drift from PLTab.tsx's own fixed statutory table the way mis.totals.pat
  // can from pl.pat in a profitable period (see plMetric()'s own doc comment
  // in dashboard-builder-engine.ts for the real ₹-level discrepancy that
  // rounding-methodology difference already caused once this engagement).
  test('pl_total_income / pl_total_expenses read straight off bundle.pl, not mis.totals', () => {
    const income = resolveMetric('pl_total_income', makeBundle())!;
    expect(income.value).toBe(335); // pl.total_income, not mis.totals.totInc (330)
    const expenses = resolveMetric('pl_total_expenses', makeBundle())!;
    expect(expenses.value).toBe(205);
  });

  // Regression: PL_DEFAULT_WIDGETS previously bound pl_pbt_margin_pct/
  // pl_pat_margin_pct as its PBT/PAT starter KPIs — a real, reconciled %
  // figure, but a different KIND of number under a different label than
  // PLTab.tsx's own fixed-view KPI strip (which shows "Profit Before Tax"/
  // "Profit After Tax" as currency amounts) — a real user reported this as
  // "different widgets, different numbers" after clicking Customize. pl_pbt/
  // pl_pat exist so the starter grid can bind the exact same currency figure
  // under the exact same label instead.
  test('pl_pbt / pl_pat read straight off bundle.pl as raw currency — the same value PLTab.tsx\'s own fixed KPI strip shows, not a margin %', () => {
    const pbt = resolveMetric('pl_pbt', makeBundle())!;
    expect(pbt.value).toBe(130); // pl.pbt, verbatim
    expect(pbt.valueType).toBe('currency');
    const pat = resolveMetric('pl_pat', makeBundle())!;
    expect(pat.value).toBe(97); // pl.pat, verbatim
    expect(pat.valueType).toBe('currency');
  });

  test('pl_pbt_margin_pct / pl_pat_margin_pct compute from pl.pbt/pl.pat over pl.revenue exactly', () => {
    const pbtMargin = resolveMetric('pl_pbt_margin_pct', makeBundle())!;
    expect(pbtMargin.value).toBeCloseTo((130 / 330) * 100, 10);
    expect(pbtMargin.valueType).toBe('percent');
    const patMargin = resolveMetric('pl_pat_margin_pct', makeBundle())!;
    expect(patMargin.value).toBeCloseTo((97 / 330) * 100, 10);
  });

  test('pl-zone margins are honestly null, never a fabricated 0/Infinity, when revenue is 0', () => {
    const bundle = makeBundle({
      pl: { ...makeBundle().pl, revenue: 0 } as ReportBundle['pl'],
    });
    expect(resolveMetric('pl_pbt_margin_pct', bundle)!.value).toBeNull();
    expect(resolveMetric('pl_pat_margin_pct', bundle)!.value).toBeNull();
  });

  test('pl-zone metrics carry a real prior-year figure from prev_pl when one exists, honestly null otherwise', () => {
    const prev = makeBundle();
    const withPrev = resolveMetric('pl_total_income', makeBundle({ prev_pl: prev.pl }))!;
    expect(withPrev.previous).toBe(335);
    const withoutPrev = resolveMetric('pl_total_income', makeBundle())!;
    expect(withoutPrev.previous).toBeNull();
  });

  // Cash Flow-zone metrics (Phase 1 of the Cash Flow customization build) —
  // cfMetric() reads straight off bundle.cashflow, the identical object
  // CashFlowTab.tsx's own fixed KPI strip and Cash Bridge chart read, so
  // these are thin accessors with no separate computation to drift from
  // (confirmed against real Acme Technologies ledger data in this build's
  // own Phase 1 diagnostic, since deleted).
  test('free_cash_flow / opening_cash / closing_cash read straight off bundle.cashflow', () => {
    expect(resolveMetric('free_cash_flow', makeBundle())!.value).toBe(35);
    expect(resolveMetric('opening_cash', makeBundle())!.value).toBe(100);
    expect(resolveMetric('closing_cash', makeBundle())!.value).toBe(125);
  });

  test('cash-flow-zone metrics carry a real prior-year figure from prev_cashflow when one exists, honestly null otherwise', () => {
    const prev = makeBundle();
    const withPrev = resolveMetric('closing_cash', makeBundle({ prev_cashflow: prev.cashflow }))!;
    expect(withPrev.previous).toBe(125);
    const withoutPrev = resolveMetric('closing_cash', makeBundle())!;
    expect(withoutPrev.previous).toBeNull();
  });

  // Notes to Accounts-zone metrics (Phase 4 of the Notes customization build)
  // — aggregateNoteTotals()/noteUnionKey() are the exact same per-section-
  // group formulas NotesTab.tsx's own fixed KPI strip computes over
  // AggregatedNote[], so these fixtures exercise real section codes (eq/lnc/
  // lc/anc/ac/inc/exp) rather than a synthetic shape.
  function note(note_no: number, section: string, total: number): AggregatedNote {
    return { note_no, note_name: `Note ${note_no}`, section: section as AggregatedNote['section'], ledgers: [], total, monthly: [] };
  }
  const currNotes: AggregatedNote[] = [
    note(1, 'eq', 500), note(5, 'lnc', 150), note(8, 'lc', 100), // eqLiab: 750
    note(10, 'anc', 400), note(13, 'ac', 300), // assets: 700
    note(20, 'inc', 330), note(21, 'exp', -233), // plGroup: |330| + |-233| = 563
  ];
  const prevNotes: AggregatedNote[] = [
    note(1, 'eq', 450), note(5, 'lnc', 140), // eqLiab: 590 (Note 8 absent this year)
    note(10, 'anc', 380), note(13, 'ac', 280), // assets: 660
    note(20, 'inc', 300), note(21, 'exp', -210), // plGroup: 510
  ];

  test('notes_eq_liab_total / notes_assets_total / notes_pl_total sum exactly the eq+lnc+lc / anc+ac / |inc|+|exp| section groups', () => {
    const bundle = makeBundle({ notes: currNotes });
    expect(resolveMetric('notes_eq_liab_total', bundle)!.value).toBe(750);
    expect(resolveMetric('notes_assets_total', bundle)!.value).toBe(700);
    expect(resolveMetric('notes_pl_total', bundle)!.value).toBe(563);
  });

  test('notes_total_count is the union of current + prior note keys (bs_/pl_-prefixed), never a raw current-year length that would double-count or drop a prior-only note', () => {
    // currNotes has 7 keys, prevNotes has 6, all but Note 8 (lc) overlap ->
    // union = 7 (Note 8 is current-only, no prior-only key here) since every
    // prevNotes note_no/section pair also appears in currNotes.
    const bundle = makeBundle({ notes: currNotes, prev_notes: prevNotes });
    expect(resolveMetric('notes_total_count', bundle)!.value).toBe(7);
  });

  test('notes_total_count counts a prior-only note (one absent from the current year) into the union, not just current-year notes', () => {
    const priorOnly = [...prevNotes, note(99, 'lc', 50)]; // note_no 99 never appears in currNotes
    const bundle = makeBundle({ notes: currNotes, prev_notes: priorOnly });
    expect(resolveMetric('notes_total_count', bundle)!.value).toBe(8);
  });

  test('notes_total_count.previous is the honest standalone prior-year count (prev_notes.length), not a second union computation', () => {
    const withPrev = resolveMetric('notes_total_count', makeBundle({ notes: currNotes, prev_notes: prevNotes }))!;
    expect(withPrev.previous).toBe(prevNotes.length); // 6, not the 7-key union
    const withoutPrev = resolveMetric('notes_total_count', makeBundle({ notes: currNotes }))!;
    expect(withoutPrev.previous).toBeNull();
  });

  test('notes_eq_liab_total / notes_assets_total / notes_pl_total carry a real prior-year figure from prev_notes when one exists, honestly null otherwise', () => {
    const withPrev = resolveMetric('notes_eq_liab_total', makeBundle({ notes: currNotes, prev_notes: prevNotes }))!;
    expect(withPrev.previous).toBe(590);
    const withoutPrev = resolveMetric('notes_eq_liab_total', makeBundle({ notes: currNotes }))!;
    expect(withoutPrev.previous).toBeNull();
  });

  test('notes-zone metrics are honestly 0 (an empty note set), not null/NaN, when bundle.notes is empty', () => {
    expect(resolveMetric('notes_total_count', makeBundle())!.value).toBe(0);
    expect(resolveMetric('notes_eq_liab_total', makeBundle())!.value).toBe(0);
    expect(resolveMetric('notes_assets_total', makeBundle())!.value).toBe(0);
    expect(resolveMetric('notes_pl_total', makeBundle())!.value).toBe(0);
  });
});

describe('TAB_KEYS / isTabKey', () => {
  test('every customizable tab key round-trips through isTabKey', () => {
    TAB_KEYS.forEach((k) => expect(isTabKey(k)).toBe(true));
  });
  test('rejects an unrecognized or non-string tab_key — never guesses', () => {
    expect(isTabKey('not-a-real-tab')).toBe(false);
    expect(isTabKey(null)).toBe(false);
    expect(isTabKey(undefined)).toBe(false);
    expect(isTabKey(42)).toBe(false);
  });
});

describe('isValidGridBounds', () => {
  test('accepts a normal in-bounds widget', () => {
    expect(isValidGridBounds({ x: 0, y: 0, w: 3, h: 4 })).toBe(true);
  });
  test('rejects width below the minimum (2)', () => {
    expect(isValidGridBounds({ x: 0, y: 0, w: 1, h: 4 })).toBe(false);
  });
  test('rejects height below the minimum (3)', () => {
    expect(isValidGridBounds({ x: 0, y: 0, w: 3, h: 2 })).toBe(false);
  });
  test('rejects a widget that would overflow past the right edge', () => {
    expect(isValidGridBounds({ x: 11, y: 0, w: 3, h: 4 }, 12)).toBe(false);
  });
  test('rejects negative coordinates', () => {
    expect(isValidGridBounds({ x: -1, y: 0, w: 3, h: 4 })).toBe(false);
  });
  test('rejects non-integer geometry', () => {
    expect(isValidGridBounds({ x: 0.5, y: 0, w: 3, h: 4 })).toBe(false);
  });
});

describe('parseWidgetsInput', () => {
  test('accepts a well-formed widgets array', () => {
    const result = parseWidgetsInput([
      { widgetType: 'stat_card', title: 'Revenue', gridX: 0, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'revenue' }], vizConfig: {} },
    ]);
    expect('widgets' in result).toBe(true);
    if ('widgets' in result) {
      expect(result.widgets).toHaveLength(1);
      expect(result.widgets[0].widgetType).toBe('stat_card');
      expect(result.widgets[0].series).toEqual([{ metricKey: 'revenue', label: undefined, color: undefined, renderAs: undefined }]);
    }
  });

  test('rejects an input that is not an array', () => {
    const result = parseWidgetsInput({ not: 'an array' });
    expect('error' in result).toBe(true);
  });

  test('rejects an unrecognized widget_type — never trusted from the client as-is', () => {
    const result = parseWidgetsInput([{ widgetType: 'evil_widget', gridX: 0, gridY: 0, gridW: 3, gridH: 4, series: [] }]);
    expect('error' in result).toBe(true);
  });

  test('rejects a reference to an unknown metric key', () => {
    const result = parseWidgetsInput([
      { widgetType: 'stat_card', gridX: 0, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'totally_made_up' }] },
    ]);
    expect('error' in result).toBe(true);
  });

  test('rejects invalid grid geometry even if everything else is valid', () => {
    const result = parseWidgetsInput([
      { widgetType: 'stat_card', gridX: 0, gridY: 0, gridW: 1, gridH: 4, series: [{ metricKey: 'revenue' }] },
    ]);
    expect('error' in result).toBe(true);
  });

  test('a stat_card with zero series is rejected (needs at least 1)', () => {
    const result = parseWidgetsInput([{ widgetType: 'stat_card', gridX: 0, gridY: 0, gridW: 3, gridH: 4, series: [] }]);
    expect('error' in result).toBe(true);
  });

  test('a text_block with zero series is accepted (needs none)', () => {
    const result = parseWidgetsInput([{ widgetType: 'text_block', gridX: 0, gridY: 0, gridW: 4, gridH: 4, series: [], vizConfig: { text: 'Hello' } }]);
    expect('widgets' in result).toBe(true);
  });

  test('rejects more than 60 widgets on one dashboard', () => {
    const many = Array.from({ length: 61 }, () => ({ widgetType: 'text_block', gridX: 0, gridY: 0, gridW: 4, gridH: 4, series: [] }));
    const result = parseWidgetsInput(many);
    expect('error' in result).toBe(true);
  });

  test('a custom metric key is rejected without extraKnownKeys, accepted with it', () => {
    const widgets = [{ widgetType: 'stat_card', gridX: 0, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'salary_pct_of_revenue' }] }];
    expect('error' in parseWidgetsInput(widgets)).toBe(true);
    const withCustom = parseWidgetsInput(widgets, 12, new Set(['salary_pct_of_revenue']));
    expect('widgets' in withCustom).toBe(true);
  });

  test('a built-in metric key is unaffected by an unrelated extraKnownKeys set', () => {
    const widgets = [{ widgetType: 'stat_card', gridX: 0, gridY: 0, gridW: 3, gridH: 4, series: [{ metricKey: 'revenue' }] }];
    const result = parseWidgetsInput(widgets, 12, new Set(['some_other_custom_metric']));
    expect('widgets' in result).toBe(true);
  });
});

describe('thresholdStatus (target + optional warn level)', () => {
  const hi = { direction: 'higher_is_better' as const, target: 15, warn: 10 };
  const lo = { direction: 'lower_is_better' as const, target: 1, warn: 1.5 };
  test('higher is better: at/above target good, between warn and target warn, below warn bad', () => {
    expect(thresholdStatus(15, hi)).toBe('good');
    expect(thresholdStatus(12, hi)).toBe('warn');
    expect(thresholdStatus(10, hi)).toBe('warn');
    expect(thresholdStatus(9.99, hi)).toBe('bad');
  });
  test('lower is better mirrors it', () => {
    expect(thresholdStatus(0.8, lo)).toBe('good');
    expect(thresholdStatus(1.2, lo)).toBe('warn');
    expect(thresholdStatus(1.6, lo)).toBe('bad');
  });
  test('no warn level = the old two-state rule; no target or no value = no judgement', () => {
    expect(thresholdStatus(12, { direction: 'higher_is_better', target: 15 })).toBe('bad');
    expect(thresholdStatus(12, null)).toBeNull();
    expect(thresholdStatus(null, hi)).toBeNull();
    expect(thresholdStatus(Number.NaN, hi)).toBeNull();
  });
});

describe('ratioOf', () => {
  test('divides, and is null rather than infinite or guessed', () => {
    expect(ratioOf(30, 120)).toBe(0.25);
    expect(ratioOf(30, 0)).toBeNull();
    expect(ratioOf(null, 10)).toBeNull();
    expect(ratioOf(10, undefined)).toBeNull();
  });
});

describe('new widget types: horizontal bar, ratio card, KPI group', () => {
  const widget = (widgetType: string, keys: string[], extra: Record<string, unknown> = {}) =>
    ({ widgetType, gridX: 0, gridY: 0, gridW: 4, gridH: 4, series: keys.map((metricKey) => ({ metricKey })), vizConfig: {}, ...extra });

  test('are registered with sensible series limits', () => {
    expect(WIDGET_KINDS).toEqual(expect.arrayContaining(['hbar_chart', 'ratio_card', 'kpi_group']));
    expect([WIDGET_MIN_SERIES.hbar_chart, WIDGET_MAX_SERIES.hbar_chart]).toEqual([1, 1]);
    expect([WIDGET_MIN_SERIES.ratio_card, WIDGET_MAX_SERIES.ratio_card]).toEqual([2, 2]);
    expect([WIDGET_MIN_SERIES.kpi_group, WIDGET_MAX_SERIES.kpi_group]).toEqual([2, 6]);
  });
  test('accept a valid binding', () => {
    expect('widgets' in parseWidgetsInput([widget('ratio_card', ['employee_cost', 'revenue'])])).toBe(true);
    expect('widgets' in parseWidgetsInput([widget('kpi_group', ['revenue', 'ebitda', 'pat'])])).toBe(true);
  });
  test('refuse more metrics than they can show, and fewer than they need', () => {
    expect('error' in parseWidgetsInput([widget('ratio_card', ['employee_cost', 'revenue', 'pat'])])).toBe(true);
    expect('error' in parseWidgetsInput([widget('ratio_card', ['revenue'])])).toBe(true);
    expect('error' in parseWidgetsInput([widget('kpi_group', ['revenue', 'ebitda', 'pat', 'pbt', 'gross_profit', 'employee_cost', 'revenue'])])).toBe(true);
    expect('error' in parseWidgetsInput([widget('hbar_chart', ['revenue', 'pat'])])).toBe(true);
  });
});

describe('mixed bar + line series bindings', () => {
  test('renderAs and axis are kept; anything else is dropped', () => {
    const result = parseWidgetsInput([{
      widgetType: 'bar_chart', gridX: 0, gridY: 0, gridW: 6, gridH: 6, vizConfig: {},
      series: [{ metricKey: 'revenue', renderAs: 'bar' }, { metricKey: 'ebitda_margin_pct', renderAs: 'line', axis: 'right' }, { metricKey: 'pat', renderAs: 'pie', axis: 'up' }],
    }]);
    expect('widgets' in result && result.widgets[0].series.map((x) => [x.renderAs, x.axis])).toEqual([['bar', undefined], ['line', 'right'], [undefined, undefined]]);
  });
});
