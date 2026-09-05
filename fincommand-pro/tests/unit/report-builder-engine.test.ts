import {
  computeStatementReport, validateTemplate, resolvePresetLedgers,
  type ReportLine, type LineLedgerMap, type PresetLine,
} from '@/lib/financial/report-builder-engine';
import type { TbLedgerRow, Section } from '@/lib/financial/tb-engine';

function makeLedger(overrides: Partial<TbLedgerRow>): TbLedgerRow {
  const base: TbLedgerRow = {
    ledger_code: '0000', ledger_name: 'Test Ledger',
    note_no: null, note_name: null,
    section: null, treasury_type: null, normal_bal: 'Dr',
    op_dr: 0, op_cr: 0,
    m1_dr: 0, m1_cr: 0, m2_dr: 0, m2_cr: 0, m3_dr: 0, m3_cr: 0,
    m4_dr: 0, m4_cr: 0, m5_dr: 0, m5_cr: 0, m6_dr: 0, m6_cr: 0,
    m7_dr: 0, m7_cr: 0, m8_dr: 0, m8_cr: 0, m9_dr: 0, m9_cr: 0,
    m10_dr: 0, m10_cr: 0, m11_dr: 0, m11_cr: 0, m12_dr: 0, m12_cr: 0,
  };
  return { ...base, ...overrides };
}

function makeLine(overrides: Partial<ReportLine> & Pick<ReportLine, 'id' | 'label' | 'sequence' | 'lineType'>): ReportLine {
  return {
    templateId: 'tpl_1', parentLineId: null, sign: 1, isPercentBase: false, resetsAfter: false,
    ...overrides,
  };
}

describe('computeStatementReport', () => {
  test('cascades a waterfall: each subtotal (resetsAfter=false, the default) includes everything before it, not just the block since the last subtotal', () => {
    // Regression test for a real bug confirmed in the reference prototype
    // this engine was ported from: its subtotal rollup reset an accumulator
    // to zero after EVERY subtotal unconditionally, so a cascading waterfall
    // (Total Income -> Gross Profit -> EBITDA, its own worked example) could
    // never actually cascade — Gross Profit would show only -COGS, not
    // Total Income - COGS.
    const ledgers = [
      makeLedger({ ledger_name: 'Revenue', section: 'inc', normal_bal: 'Cr', m1_cr: 1000 }),
      makeLedger({ ledger_name: 'COGS', section: 'exp', normal_bal: 'Dr', m1_dr: 300 }),
      makeLedger({ ledger_name: 'Opex', section: 'exp', normal_bal: 'Dr', m1_dr: 200 }),
    ];
    const ledgersByName = new Map(ledgers.map((l) => [l.ledger_name, l]));
    const lines: ReportLine[] = [
      makeLine({ id: 'l_hdr', label: 'Revenue Section', sequence: 5, lineType: 'header' }),
      makeLine({ id: 'l_rev', label: 'Revenue', sequence: 10, lineType: 'detail', sign: 1 }),
      makeLine({ id: 'l_ti', label: 'Total Income', sequence: 20, lineType: 'subtotal' }),
      makeLine({ id: 'l_cogs', label: 'COGS', sequence: 30, lineType: 'detail', sign: -1 }),
      makeLine({ id: 'l_gp', label: 'Gross Profit', sequence: 40, lineType: 'subtotal' }),
      makeLine({ id: 'l_opex', label: 'Opex', sequence: 50, lineType: 'detail', sign: -1 }),
      makeLine({ id: 'l_ebitda', label: 'EBITDA', sequence: 60, lineType: 'subtotal' }),
    ];
    const map: LineLedgerMap = { l_rev: ['Revenue'], l_cogs: ['COGS'], l_opex: ['Opex'] };

    const rows = computeStatementReport(lines, map, ledgersByName, [0]);
    const byId = Object.fromEntries(rows.map((r) => [r.line.id, r.values[0]]));

    expect(byId.l_hdr).toBe(0); // header has no value
    expect(byId.l_rev).toBe(1000);
    expect(byId.l_ti).toBe(1000); // Total Income
    expect(byId.l_cogs).toBe(-300);
    expect(byId.l_gp).toBe(700); // Gross Profit = Total Income(1000) - COGS(300), NOT just -300
    expect(byId.l_opex).toBe(-200);
    expect(byId.l_ebitda).toBe(500); // EBITDA cascades from Gross Profit, not reset to -200
  });

  test('resetsAfter=true correctly isolates two unrelated statement blocks in one template (e.g. a combined P&L-then-Balance-Sheet layout)', () => {
    const ledgers = [
      makeLedger({ ledger_name: 'Income', section: 'inc', normal_bal: 'Cr', m1_cr: 1000 }),
      makeLedger({ ledger_name: 'Expenses', section: 'exp', normal_bal: 'Dr', m1_dr: 400 }),
      // BS-side: op_dr=5000 plus a real m1 movement of 500 — closingBalance
      // (5500) must be used, not monthNet (which would show only 500).
      makeLedger({ ledger_name: 'NCA', section: 'anc', normal_bal: 'Dr', op_dr: 5000, m1_dr: 500 }),
      makeLedger({ ledger_name: 'CA', section: 'ac', normal_bal: 'Dr', op_dr: 2000 }),
    ];
    const ledgersByName = new Map(ledgers.map((l) => [l.ledger_name, l]));
    const lines: ReportLine[] = [
      makeLine({ id: 'l_inc', label: 'Income', sequence: 10, lineType: 'detail', sign: 1 }),
      makeLine({ id: 'l_exp', label: 'Expenses', sequence: 20, lineType: 'detail', sign: -1 }),
      makeLine({ id: 'l_pbt', label: 'PBT', sequence: 30, lineType: 'subtotal', resetsAfter: true }),
      makeLine({ id: 'l_nca', label: 'NCA', sequence: 40, lineType: 'detail', sign: 1 }),
      makeLine({ id: 'l_ca', label: 'CA', sequence: 50, lineType: 'detail', sign: 1 }),
      makeLine({ id: 'l_ta', label: 'Total Assets', sequence: 60, lineType: 'subtotal' }),
    ];
    const map: LineLedgerMap = { l_inc: ['Income'], l_exp: ['Expenses'], l_nca: ['NCA'], l_ca: ['CA'] };

    const rows = computeStatementReport(lines, map, ledgersByName, [0]);
    const byId = Object.fromEntries(rows.map((r) => [r.line.id, r.values[0]]));

    expect(byId.l_pbt).toBe(600); // 1000 - 400
    expect(byId.l_nca).toBe(5500); // closingBalance: opening 5000 + m1 movement 500 (NOT monthNet's 500 alone)
    expect(byId.l_ta).toBe(7500); // 5500 + 2000, correctly NOT including PBT(600) — the reset worked
  });

  test('% of base line is computed per period, and never assigned to header rows', () => {
    const ledgers = [
      makeLedger({ ledger_name: 'Revenue', section: 'inc', normal_bal: 'Cr', m1_cr: 1000 }),
      makeLedger({ ledger_name: 'COGS', section: 'exp', normal_bal: 'Dr', m1_dr: 300 }),
    ];
    const ledgersByName = new Map(ledgers.map((l) => [l.ledger_name, l]));
    const lines: ReportLine[] = [
      makeLine({ id: 'l_hdr', label: 'Section', sequence: 5, lineType: 'header' }),
      makeLine({ id: 'l_rev', label: 'Revenue', sequence: 10, lineType: 'detail', sign: 1 }),
      makeLine({ id: 'l_ti', label: 'Total Income', sequence: 20, lineType: 'subtotal', isPercentBase: true }),
      makeLine({ id: 'l_cogs', label: 'COGS', sequence: 30, lineType: 'detail', sign: -1 }),
      makeLine({ id: 'l_gp', label: 'Gross Profit', sequence: 40, lineType: 'subtotal' }),
    ];
    const map: LineLedgerMap = { l_rev: ['Revenue'], l_cogs: ['COGS'] };

    const rows = computeStatementReport(lines, map, ledgersByName, [0]);
    const byId = Object.fromEntries(rows.map((r) => [r.line.id, r]));

    expect(byId.l_gp!.percents?.[0]).toBe(70); // 700 / 1000 * 100
    expect(byId.l_ti!.percents?.[0]).toBe(100); // base against itself
    expect(byId.l_hdr!.percents).toBeUndefined(); // headers never get a percent value
  });

  test('an unmapped detail line contributes zero, not an error or a guess', () => {
    const lines: ReportLine[] = [makeLine({ id: 'l_1', label: 'Orphan', sequence: 10, lineType: 'detail' })];
    const rows = computeStatementReport(lines, {}, new Map(), [0, 1]);
    expect(rows[0]!.values).toEqual([0, 0]);
  });
});

describe('validateTemplate', () => {
  const sections = new Map<string, Section | null>([
    ['Revenue', 'inc'], ['COGS', 'exp'], ['Rent', 'exp'],
  ]);

  test('flags a detail line with no mapped ledgers as a blocking error', () => {
    const lines: ReportLine[] = [
      makeLine({ id: 'l_1', label: 'Revenue', sequence: 10, lineType: 'detail' }),
      makeLine({ id: 'l_2', label: 'Total', sequence: 20, lineType: 'subtotal' }),
    ];
    const result = validateTemplate(lines, {}, sections);
    expect(result.ok).toBe(false);
    expect(result.errors.some((i) => i.code === 'unmapped_detail')).toBe(true);
  });

  test('flags an expense-section line set to Add (+1) as a sign mismatch error', () => {
    const lines: ReportLine[] = [
      makeLine({ id: 'l_1', label: 'Rent', sequence: 10, lineType: 'detail', sign: 1 }), // wrong: expense should be -1
      makeLine({ id: 'l_2', label: 'Total', sequence: 20, lineType: 'subtotal' }),
    ];
    const result = validateTemplate(lines, { l_1: ['Rent'] }, sections);
    expect(result.errors.some((i) => i.code === 'sign_mismatch')).toBe(true);
  });

  test('a correctly-signed expense line raises no sign_mismatch', () => {
    const lines: ReportLine[] = [
      makeLine({ id: 'l_1', label: 'Rent', sequence: 10, lineType: 'detail', sign: -1 }),
      makeLine({ id: 'l_2', label: 'Total', sequence: 20, lineType: 'subtotal' }),
    ];
    const result = validateTemplate(lines, { l_1: ['Rent'] }, sections);
    expect(result.issues.some((i) => i.code === 'sign_mismatch')).toBe(false);
  });

  test('requires at least one subtotal when detail lines exist', () => {
    const lines: ReportLine[] = [makeLine({ id: 'l_1', label: 'Revenue', sequence: 10, lineType: 'detail' })];
    const result = validateTemplate(lines, { l_1: ['Revenue'] }, sections);
    expect(result.errors.some((i) => i.code === 'no_subtotal')).toBe(true);
  });

  test('flags a subtotal with no detail rows above it', () => {
    const lines: ReportLine[] = [
      makeLine({ id: 'l_1', label: 'Header', sequence: 10, lineType: 'header' }),
      makeLine({ id: 'l_2', label: 'Empty Total', sequence: 20, lineType: 'subtotal' }),
    ];
    const result = validateTemplate(lines, {}, sections);
    expect(result.errors.some((i) => i.code === 'empty_subtotal')).toBe(true);
  });

  test('warns (not errors) when no % base line is marked', () => {
    const lines: ReportLine[] = [
      makeLine({ id: 'l_1', label: 'Revenue', sequence: 10, lineType: 'detail' }),
      makeLine({ id: 'l_2', label: 'Total', sequence: 20, lineType: 'subtotal' }),
    ];
    const result = validateTemplate(lines, { l_1: ['Revenue'] }, sections);
    expect(result.warnings.some((i) => i.code === 'no_percent_base')).toBe(true);
    expect(result.ok).toBe(true); // warnings alone don't block saving
  });

  test('a fully valid template has zero issues', () => {
    const lines: ReportLine[] = [
      makeLine({ id: 'l_1', label: 'Revenue', sequence: 10, lineType: 'detail', sign: 1, isPercentBase: true }),
      makeLine({ id: 'l_2', label: 'COGS', sequence: 20, lineType: 'detail', sign: -1 }),
      makeLine({ id: 'l_3', label: 'Gross Profit', sequence: 30, lineType: 'subtotal' }),
    ];
    const result = validateTemplate(lines, { l_1: ['Revenue'], l_2: ['COGS'] }, sections);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('resolvePresetLedgers', () => {
  const ledgers = [
    makeLedger({ ledger_name: 'IT Services Revenue', section: 'inc' }),
    makeLedger({ ledger_name: 'Salaries & Wages', section: 'exp' }),
    makeLedger({ ledger_name: 'Rent - Office', section: 'exp' }),
    makeLedger({ ledger_name: 'HDFC Bank — Current Account', section: 'ac' }),
  ];

  test('matches real ledgers by section', () => {
    const line: PresetLine = { label: 'Income', type: 'detail', sections: ['inc'] };
    expect(resolvePresetLedgers(line, ledgers)).toEqual(['IT Services Revenue']);
  });

  test('matches real ledgers by case-insensitive keyword', () => {
    const line: PresetLine = { label: 'People Cost', type: 'detail', match: ['salar'] };
    expect(resolvePresetLedgers(line, ledgers)).toEqual(['Salaries & Wages']);
  });

  test('a header preset line never resolves ledgers', () => {
    const line: PresetLine = { label: 'Section', type: 'header', sections: ['inc'] };
    expect(resolvePresetLedgers(line, ledgers)).toEqual([]);
  });

  test('returns [] when nothing in the real ledger list matches', () => {
    const line: PresetLine = { label: 'Raw Material', type: 'detail', match: ['raw material consumed'] };
    expect(resolvePresetLedgers(line, ledgers)).toEqual([]);
  });
});
