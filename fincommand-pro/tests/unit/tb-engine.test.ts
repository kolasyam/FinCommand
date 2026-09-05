import {
  resolvePeriod, monthNet, periodNet, closingBalance, computeMIS, computeBS, computePL, computeTreasury, computeCashFlow, computeRatios,
  computeVendorExpense, computeCustomerMargin,
  type TbLedgerRow, type VendorExpenseInput, type CustomerRevenueInput,
} from '@/lib/financial/tb-engine';

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

describe('resolvePeriod', () => {
  test('annual FY returns 12 columns', () => {
    const r = resolvePeriod({ periodType: 'annual', yearType: 'FY' });
    expect(r.colLabels).toHaveLength(12);
    expect(r.bsLastIdx).toBe(11);
    expect(r.label).toBe('FY Annual');
  });

  test('quarterly Q1 (FY) resolves to Apr-Jun, bsLastIdx 2', () => {
    const r = resolvePeriod({ periodType: 'quarterly', period: 'Q1', yearType: 'FY' });
    expect(r.plIndices).toEqual([0, 1, 2]);
    expect(r.bsLastIdx).toBe(2);
    expect(r.isSingleCol).toBe(true);
  });

  test('halfyear H2 (FY) resolves to Oct-Mar', () => {
    const r = resolvePeriod({ periodType: 'halfyear', period: 'H2', yearType: 'FY' });
    expect(r.plIndices).toEqual([6, 7, 8, 9, 10, 11]);
    expect(r.bsLastIdx).toBe(11);
  });

  test('invalid quarter throws', () => {
    expect(() => resolvePeriod({ periodType: 'quarterly', period: 'Q9' as never })).toThrow();
  });
});

describe('monthNet / periodNet / closingBalance', () => {
  test('Dr-normal ledger: net = Dr - Cr', () => {
    const row = makeLedger({ normal_bal: 'Dr', m1_dr: 100, m1_cr: 30 });
    expect(monthNet(row, 0)).toBe(70);
  });

  test('Cr-normal ledger: net = Cr - Dr', () => {
    const row = makeLedger({ normal_bal: 'Cr', m1_dr: 30, m1_cr: 100 });
    expect(monthNet(row, 0)).toBe(70);
  });

  test('periodNet sums across month indices', () => {
    const row = makeLedger({ normal_bal: 'Dr', m1_dr: 10, m2_dr: 20, m3_dr: 30 });
    expect(periodNet(row, [0, 1, 2])).toBe(60);
  });

  test('closingBalance = opening + cumulative movement', () => {
    const row = makeLedger({ normal_bal: 'Dr', op_dr: 1000, m1_dr: 50, m2_dr: 25 });
    expect(closingBalance(row, 1)).toBe(1075); // opening + m1 + m2
    expect(closingBalance(row, 0)).toBe(1050); // opening + m1 only
  });
});

describe('computeBS', () => {
  test('balances when assets = equity + liabilities', () => {
    const ledgers: TbLedgerRow[] = [
      makeLedger({ ledger_name: 'PPE', note_no: 10, note_name: 'PPE', section: 'anc', normal_bal: 'Dr', op_dr: 1000 }),
      makeLedger({ ledger_name: 'Cash', note_no: 19, note_name: 'Cash & CE', section: 'ac', treasury_type: 'cash', normal_bal: 'Dr', op_dr: 500 }),
      makeLedger({ ledger_name: 'Share Capital', note_no: 1, note_name: 'Share Capital', section: 'eq', normal_bal: 'Cr', op_cr: 1200 }),
      makeLedger({ ledger_name: 'Trade Payables', note_no: 7, note_name: 'Trade Payables', section: 'lc', normal_bal: 'Cr', op_cr: 300 }),
    ];
    const bs = computeBS(ledgers, { periodType: 'annual', yearType: 'FY' });
    expect(bs.assets.total).toBe(1500);
    expect(bs.equity_liabilities.total).toBe(1500);
    expect(bs.balanced).toBe(true);
  });

  test('flags an out-of-balance sheet', () => {
    const ledgers: TbLedgerRow[] = [
      makeLedger({ ledger_name: 'PPE', note_no: 10, section: 'anc', normal_bal: 'Dr', op_dr: 1000 }),
      makeLedger({ ledger_name: 'Share Capital', note_no: 1, section: 'eq', normal_bal: 'Cr', op_cr: 500 }),
    ];
    const bs = computeBS(ledgers, { periodType: 'annual', yearType: 'FY' });
    expect(bs.balanced).toBe(false);
    expect(bs.difference).toBe(-500);
  });
});

describe('computeMIS', () => {
  test('revenue, cost and PAT roll up correctly with a flat 25% tax', () => {
    const ledgers: TbLedgerRow[] = [
      makeLedger({ ledger_name: 'Revenue', note_no: 20, section: 'inc', normal_bal: 'Cr', m1_cr: 1000 }),
      makeLedger({ ledger_name: 'COS', note_no: 22, section: 'exp', normal_bal: 'Dr', m1_dr: 400 }),
    ];
    const mis = computeMIS(ledgers, { periodType: 'annual', yearType: 'FY' });
    expect(mis.totals.rev).toBe(1000);
    expect(mis.totals.cos).toBe(400);
    expect(mis.totals.pbt).toBe(600);
    expect(mis.totals.tax).toBe(150);
    expect(mis.totals.pat).toBe(450);
  });

  test('a loss-making month owes no tax — PAT equals PBT exactly, never a fabricated tax credit', () => {
    // Regression test for a real bug: tax used to be Math.round(pbt * 0.25)
    // unconditionally, so a loss-making month's negative PBT produced a
    // *negative* tax (a fabricated tax credit under IND AS 12 — no company
    // owes current tax on a loss), which shrank the reported loss instead
    // of leaving PAT = PBT.
    const ledgers: TbLedgerRow[] = [
      makeLedger({ ledger_name: 'Revenue', note_no: 20, section: 'inc', normal_bal: 'Cr', m1_cr: 100 }),
      makeLedger({ ledger_name: 'Opex', note_no: 26, section: 'exp', normal_bal: 'Dr', m1_dr: 500 }),
    ];
    const mis = computeMIS(ledgers, { periodType: 'annual', yearType: 'FY' });
    expect(mis.data[0].pbt).toBe(-400);
    expect(mis.data[0].tax).toBe(0);
    expect(mis.data[0].pat).toBe(-400);
    expect(mis.data[0].pat).toBe(mis.data[0].pbt);
  });

  test('a net loss-making YEAR owes no tax even if a few individual months were profitable', () => {
    // Regression test for a subtlety the per-month gate above almost missed:
    // gating each month's tax on *that month's own* PBT sign is not enough
    // by itself — real tax law treats current tax as a whole-period concept
    // (IND AS 34's interim-reporting guidance: an interim period's tax
    // expense uses the whole period's effective rate, not a fresh
    // computation per interim slice), so a year with eleven profitable
    // months and one very bad month must NOT report a nonzero annual Tax
    // total just because eleven individually-profitable months each kept
    // their own share — if the *year* is a net loss, every month's tax must
    // be 0, so the Total row (which is the sum of the monthly cells) comes
    // out to the same 0 a reviewer would expect from "this year lost money".
    const ledgers: TbLedgerRow[] = [
      makeLedger({
        ledger_name: 'Revenue', note_no: 20, section: 'inc', normal_bal: 'Cr',
        m1_cr: 1000, m2_cr: 1000, m3_cr: 1000, m4_cr: 1000, m5_cr: 1000, m6_cr: 1000,
        m7_cr: 1000, m8_cr: 1000, m9_cr: 1000, m10_cr: 1000, m11_cr: 1000, m12_cr: 1000,
      }),
      makeLedger({ ledger_name: 'Opex', note_no: 26, section: 'exp', normal_bal: 'Dr', m1_dr: 400 }), // every month individually profitable (1000-400=600)...
      makeLedger({ ledger_name: 'One-Off Loss', note_no: 26, section: 'exp', normal_bal: 'Dr', m6_dr: 20000 }), // ...except June, which wipes out the whole year
    ];
    const mis = computeMIS(ledgers, { periodType: 'annual', yearType: 'FY' });
    expect(mis.totals.pbt).toBeLessThan(0); // the year, in aggregate, is a loss
    expect(mis.data[5].pbt).toBeLessThan(0); // June itself is deeply negative
    expect(mis.data[0].pbt).toBeGreaterThan(0); // January, standing alone, was profitable
    // Every month's tax is 0 — including January's, even though January
    // alone was profitable — because the YEAR as a whole is a loss.
    mis.data.forEach(d => expect(d.tax).toBe(0));
    expect(mis.totals.tax).toBe(0);
    expect(mis.totals.pat).toBe(mis.totals.pbt);
    // The Total-equals-sum-of-monthly-cells invariant (tested below) still
    // holds trivially here since every monthly cell is 0.
    expect(mis.totals.tax).toBe(mis.data.reduce((s, d) => s + d.tax, 0));
  });

  test('a single bad month can still show its own negative modeled tax share within a net-profitable year', () => {
    // The flip side of the test above: when the YEAR as a whole is
    // profitable, the per-month tax figures are an allocation of that one
    // real annual tax figure across months, not twelve independent
    // computations — so an individual loss-making month within an
    // otherwise-profitable year is allowed to show a negative modeled tax
    // share (which nets against the other months' shares to the correct
    // real annual total), same as before this fix.
    const ledgers: TbLedgerRow[] = [
      makeLedger({
        ledger_name: 'Revenue', note_no: 20, section: 'inc', normal_bal: 'Cr',
        m1_cr: 1000, m2_cr: 1000, m3_cr: 1000, m4_cr: 1000, m5_cr: 1000, m6_cr: 1000,
        m7_cr: 1000, m8_cr: 1000, m9_cr: 1000, m10_cr: 1000, m11_cr: 1000, m12_cr: 1000,
      }),
      makeLedger({ ledger_name: 'Opex', note_no: 26, section: 'exp', normal_bal: 'Dr', m1_dr: 400 }),
      makeLedger({ ledger_name: 'One-Off Loss', note_no: 26, section: 'exp', normal_bal: 'Dr', m6_dr: 1500 }), // June dips negative, but the year stays net profitable
    ];
    const mis = computeMIS(ledgers, { periodType: 'annual', yearType: 'FY' });
    expect(mis.totals.pbt).toBeGreaterThan(0); // the year, in aggregate, is profitable
    expect(mis.data[5].pbt).toBeLessThan(0); // June itself is a loss
    expect(mis.data[5].tax).toBeLessThan(0); // June's own modeled tax share is negative — a valid allocation, not a bug
    expect(mis.totals.tax).toBeGreaterThan(0);
    expect(mis.totals.tax).toBe(mis.data.reduce((s, d) => s + d.tax, 0)); // Total still equals the sum of monthly cells
  });

  test('Total column exactly equals the sum of the monthly columns, even after 25% tax rounding', () => {
    // Regression test for a real bug: the annual Total for Tax (and PAT,
    // since PAT = PBT − Tax) used to be computed by independently rounding
    // 25% of the full-year PBT, while each monthly column independently
    // rounded 25% of that month's own PBT. Math.round() isn't additive, so
    // summing twelve separately-rounded monthly figures can — and, on real
    // data, does — land a rupee or two away from rounding the annual figure
    // once. A finance reviewer manually adding up the twelve monthly Tax
    // cells must get exactly the Total column's figure.
    const ledgers: TbLedgerRow[] = [
      makeLedger({
        ledger_name: 'Revenue', note_no: 20, section: 'inc', normal_bal: 'Cr',
        m1_cr: 101, m2_cr: 103, m3_cr: 107, m4_cr: 109, m5_cr: 111, m6_cr: 113,
        m7_cr: 101, m8_cr: 103, m9_cr: 107, m10_cr: 109, m11_cr: 111, m12_cr: 113,
      }),
    ];
    const mis = computeMIS(ledgers, { periodType: 'annual', yearType: 'FY' });
    const summedTax = mis.data.reduce((s, d) => s + d.tax, 0);
    const summedPat = mis.data.reduce((s, d) => s + d.pat, 0);
    expect(mis.totals.tax).toBe(summedTax);
    expect(mis.totals.pat).toBe(summedPat);
  });
});

describe('computePL', () => {
  test('PRESERVED QUIRK: ESOP cash-flow note lookup is always null', () => {
    const ledgers: TbLedgerRow[] = [
      makeLedger({ ledger_name: 'ESOP Charge', note_no: 23, section: 'exp', normal_bal: 'Dr', m1_dr: 50 }),
    ];
    const pl = computePL(ledgers, { periodType: 'annual', yearType: 'FY' });
    // notes[23] is always null because aggregateByNote() only produces
    // bs_/pl_-prefixed keys — this documents the original engine's behavior,
    // not a defect introduced by the port.
    expect(pl.notes[23]).toBeNull();
  });

  test('OCI and EPS are left undetermined (null), never fabricated', () => {
    // Regression test for a real bug: OCI used to be modeled as a flat
    // -0.87% of *revenue* (actuarial remeasurement of a gratuity obligation
    // has no real relationship to revenue), and EPS from a hardcoded
    // "2 crore shares at ₹5 face value" — confirmed, on a real synced
    // company, to be off by roughly 4x from that company's actual paid-up
    // Share Capital. Neither is derivable from a Trial Balance (OCI needs
    // an actuarial valuation; EPS needs a real face value and share count
    // from the Register of Members), so both must be null, not guessed.
    const ledgers: TbLedgerRow[] = [
      makeLedger({ ledger_name: 'Revenue', note_no: 20, section: 'inc', normal_bal: 'Cr', m1_cr: 10000 }),
      makeLedger({ ledger_name: 'Opex', note_no: 26, section: 'exp', normal_bal: 'Dr', m1_dr: 4000 }),
    ];
    const pl = computePL(ledgers, { periodType: 'annual', yearType: 'FY' });
    expect(pl.oci_gross).toBeNull();
    expect(pl.oci_tax).toBeNull();
    expect(pl.oci_net).toBeNull();
    expect(pl.total_comprehensive_income).toBeNull();
    expect(pl.eps_basic).toBeNull();
    expect(pl.eps_diluted).toBeNull();
    // Current/deferred tax remain real, disclosed flat-rate estimates
    // (same modeling basis as MIS/Cash Flow) — not affected by this fix.
    expect(pl.current_tax).toBe(Math.round(pl.pbt * 0.25));
  });

  test('a loss-making period owes no Current or Deferred Tax — PAT equals PBT exactly', () => {
    // Regression test for a real bug: Current Tax (25%) and Deferred Tax
    // (1%) used to be Math.round(pbt * rate) unconditionally, regardless of
    // sign. A loss-making period's negative PBT (e.g. a real -₹17.69L)
    // produced *negative* tax figures — a fabricated tax credit — which
    // shrank the reported loss (e.g. to -₹13.09L) instead of correctly
    // leaving PAT = PBT. Under IND AS 12 / the Income Tax Act, a company
    // owes ₹0.00 current tax on a loss, full stop.
    const ledgers: TbLedgerRow[] = [
      makeLedger({ ledger_name: 'Revenue', note_no: 20, section: 'inc', normal_bal: 'Cr', m1_cr: 1000 }),
      makeLedger({ ledger_name: 'Opex', note_no: 26, section: 'exp', normal_bal: 'Dr', m1_dr: 2769 }),
    ];
    const pl = computePL(ledgers, { periodType: 'annual', yearType: 'FY' });
    expect(pl.pbt).toBe(-1769);
    expect(pl.current_tax).toBe(0);
    expect(pl.deferred_tax).toBe(0);
    expect(pl.pat).toBe(pl.pbt);
    expect(pl.pat).toBe(-1769);
  });

  test('a profitable period still applies the real flat-rate tax estimate (this fix only gates loss periods)', () => {
    const ledgers: TbLedgerRow[] = [
      makeLedger({ ledger_name: 'Revenue', note_no: 20, section: 'inc', normal_bal: 'Cr', m1_cr: 1000 }),
      makeLedger({ ledger_name: 'Opex', note_no: 26, section: 'exp', normal_bal: 'Dr', m1_dr: 400 }),
    ];
    const pl = computePL(ledgers, { periodType: 'annual', yearType: 'FY' });
    expect(pl.pbt).toBe(600);
    expect(pl.current_tax).toBe(150); // 25% of 600
    expect(pl.deferred_tax).toBe(6);  // 1% of 600
    expect(pl.pat).toBe(444);         // 600 - 150 - 6
  });

  test('PBT exactly zero owes no tax either (pbt > 0 gate, not >= 0)', () => {
    const ledgers: TbLedgerRow[] = [
      makeLedger({ ledger_name: 'Revenue', note_no: 20, section: 'inc', normal_bal: 'Cr', m1_cr: 1000 }),
      makeLedger({ ledger_name: 'Opex', note_no: 26, section: 'exp', normal_bal: 'Dr', m1_dr: 1000 }),
    ];
    const pl = computePL(ledgers, { periodType: 'annual', yearType: 'FY' });
    expect(pl.pbt).toBe(0);
    expect(pl.current_tax).toBe(0);
    expect(pl.deferred_tax).toBe(0);
    expect(pl.pat).toBe(0);
  });
});

describe('computeCashFlow', () => {
  test('equity movement in Financing reflects real ledger movement, not a plug against modeled PAT', () => {
    // A profitable period, but the books haven't posted a year-end closing
    // entry moving P&L into Retained Earnings yet (the common, normal state
    // for an in-progress fiscal year) — Other Equity shows zero movement.
    // Regression test for a real bug: Financing's equity line used to be
    // computed as (real equity movement − modeled PAT), which fabricated a
    // multi-lakh "financing inflow" out of thin air whenever the books
    // hadn't closed yet. It must now reflect the real (zero) movement.
    const ledgers: TbLedgerRow[] = [
      makeLedger({ ledger_name: 'Revenue', note_no: 20, section: 'inc', normal_bal: 'Cr', m1_cr: 1000 }),
      makeLedger({ ledger_name: 'Other Equity', note_no: 2, note_name: 'Other Equity', section: 'eq', normal_bal: 'Cr', op_cr: 5000 }), // zero movement all year
      makeLedger({ ledger_name: 'Cash', treasury_type: 'cash', section: 'ac', note_no: 19, normal_bal: 'Dr', op_dr: 5000, m1_dr: 1000 }),
    ];
    const cf = computeCashFlow(ledgers, { periodType: 'annual', yearType: 'FY' });
    const fin = cf.financing as { equity_movement_net: number };
    expect(fin.equity_movement_net).toBe(0);
  });

  test('Deferred Tax / Long-Term Provisions movement is a non-cash Operating adjustment, not Financing', () => {
    const ledgers: TbLedgerRow[] = [
      makeLedger({ ledger_name: 'Term Loan', note_no: 3, note_name: 'Long-Term Borrowings', section: 'lnc', normal_bal: 'Cr', op_cr: 5000, m1_cr: 100 }),
      makeLedger({ ledger_name: 'Deferred Tax Liability', note_no: 5, note_name: 'Deferred Tax', section: 'lnc', normal_bal: 'Cr', op_cr: 1000, m1_cr: 200 }),
      makeLedger({ ledger_name: 'Gratuity Liability', note_no: 6, note_name: 'Long-Term Provisions', section: 'lnc', normal_bal: 'Cr', op_cr: 300, m1_cr: 50 }),
    ];
    const cf = computeCashFlow(ledgers, { periodType: 'annual', yearType: 'FY' });
    const fin = cf.financing as { long_term_borrowings_and_leases_movement: number };
    const wc = (cf.operating as { wc_changes: Record<string, number> }).wc_changes;

    expect(fin.long_term_borrowings_and_leases_movement).toBe(100); // only the real borrowing
    expect(wc['Increase/(Decrease) in Deferred Tax']).toBe(200);
    expect(wc['Increase/(Decrease) in Long-Term Provisions']).toBe(50);
  });

  test('ocf_to_pat is null (not a misleading 0.00x) when the period is loss-making', () => {
    const ledgers: TbLedgerRow[] = [
      makeLedger({ ledger_name: 'Revenue', note_no: 20, section: 'inc', normal_bal: 'Cr', m1_cr: 100 }),
      makeLedger({ ledger_name: 'Opex', note_no: 26, section: 'exp', normal_bal: 'Dr', m1_dr: 500 }),
    ];
    const cf = computeCashFlow(ledgers, { periodType: 'annual', yearType: 'FY' });
    const pl = computePL(ledgers, { periodType: 'annual', yearType: 'FY' });
    expect(pl.pat).toBeLessThan(0);
    expect(cf.ocf_to_pat).toBeNull();
  });

  test('tax paid is not fabricated from a fixed percentage — left null, with its real effect landing in reconciling_gap', () => {
    // Regression test for a real bug: Operating cash flow used to subtract a
    // "Tax Paid" line computed as a fixed 85% of the modeled (flat 25% of
    // PBT) current tax — a static, company-agnostic constant presented as if
    // it were a measured figure. No dedicated tax-provision ledger exists in
    // this engine's Chart of Accounts to derive a real cash-tax-paid number
    // from, so it must now be left undetermined rather than guessed.
    const ledgers: TbLedgerRow[] = [
      makeLedger({ ledger_name: 'Revenue', note_no: 20, section: 'inc', normal_bal: 'Cr', m1_cr: 10000 }),
      makeLedger({ ledger_name: 'Cash', treasury_type: 'cash', section: 'ac', note_no: 19, normal_bal: 'Dr', op_dr: 1000, m1_dr: 6000 }),
    ];
    const cf = computeCashFlow(ledgers, { periodType: 'annual', yearType: 'FY' });
    const op = cf.operating as { tax_paid: number | null; total: number; operating_profit: number };
    expect(op.tax_paid).toBeNull();
    // With no tax line subtracted, Operating total = operating profit + WC
    // changes exactly (no residual formula-driven deduction hiding in it).
    expect(op.total).toBe(op.operating_profit);
  });
});

describe('computeTreasury', () => {
  test('groups by treasury_type and sums closing balances', () => {
    const ledgers: TbLedgerRow[] = [
      makeLedger({ ledger_name: 'Cash in Hand', treasury_type: 'cash', normal_bal: 'Dr', op_dr: 100 }),
      makeLedger({ ledger_name: 'HDFC FD', treasury_type: 'fd', normal_bal: 'Dr', op_dr: 2000 }),
    ];
    const tsy = computeTreasury(ledgers, { periodType: 'annual', yearType: 'FY' });
    expect(tsy.total_cash_and_bank).toBe(100);
    expect(tsy.total_fd).toBe(2000);
    expect(tsy.total).toBe(2100);
  });
});

describe('computeRatios', () => {
  // Regression tests for a real bug: Inventories/Receivables/Payables used
  // to be hardcoded (inv=424, ar=3480, ap=2140) instead of read from the
  // ledgers' own Note 15/16/7 balances, and cash_ratio/asset_turnover carried
  // stray ÷100/×100 scaling — confirmed on a real synced company to be off
  // from reality by up to four orders of magnitude (real Trade Receivables
  // ~₹6.21 Cr vs the old hardcoded ar=3480).
  function makeRatioLedgers(): TbLedgerRow[] {
    return [
      makeLedger({ ledger_name: 'Revenue', note_no: 20, note_name: 'Revenue from Operations', section: 'inc', normal_bal: 'Cr', m1_cr: 100000 }),
      makeLedger({ ledger_name: 'Cost of Services', note_no: 22, note_name: 'Cost of Services', section: 'exp', normal_bal: 'Dr', m1_dr: 50000 }),
      makeLedger({ ledger_name: 'Inventories', note_no: 15, note_name: 'Inventories', section: 'ac', normal_bal: 'Dr', op_dr: 5000 }),
      makeLedger({ ledger_name: 'Trade Receivables', note_no: 16, note_name: 'Trade Receivables', section: 'ac', normal_bal: 'Dr', op_dr: 20000 }),
      makeLedger({ ledger_name: 'Cash', note_no: 19, note_name: 'Cash and Cash Equivalents', section: 'ac', treasury_type: 'cash', normal_bal: 'Dr', op_dr: 3000 }),
      makeLedger({ ledger_name: 'Trade Payables', note_no: 7, note_name: 'Trade Payables', section: 'lc', normal_bal: 'Cr', op_cr: 4000 }),
      makeLedger({ ledger_name: 'PPE', note_no: 10, note_name: 'Property, Plant and Equipment', section: 'anc', normal_bal: 'Dr', op_dr: 50000 }),
      makeLedger({ ledger_name: 'Share Capital', note_no: 1, note_name: 'Share Capital', section: 'eq', normal_bal: 'Cr', op_cr: 74000 }),
    ];
  }

  test('Inventories/Receivables/Payables are read from real Note 15/16/7 ledgers, not hardcoded', () => {
    const ratios = computeRatios(makeRatioLedgers(), { periodType: 'annual', yearType: 'FY' });
    // ca = inv(5000) + ar(20000) + cash(3000) = 28000; cl = ap(4000)
    expect(ratios.liquidity.current_ratio).toBe(7); // 28000 / 4000
    expect(ratios.liquidity.quick_ratio).toBe(5.75); // (28000 - 5000) / 4000 — real inv, not the old hardcoded 424
    // dso = ar/revenue*365 = 20000/100000*365 = 73; dpo = ap/cos*365 = 4000/50000*365 = 29.2 -> 29
    expect(ratios.efficiency.dso).toBe(73);
    expect(ratios.efficiency.dpo).toBe(29);
    // ccc = dio + dso - dpo = 36.5 + 73 - 29.2 = 80.3 -> 80 (dio = inv/cos*365 = 36.5, not exposed separately)
    expect(ratios.efficiency.ccc).toBe(80);
  });

  test('a company with no Inventory ledgers gets inv=0 (honest zero), not the old hardcoded 424', () => {
    const ledgers = makeRatioLedgers().filter(l => l.note_no !== 15);
    const ratios = computeRatios(ledgers, { periodType: 'annual', yearType: 'FY' });
    // ca = ar(20000) + cash(3000) = 23000; with inv=0, quick_ratio must equal current_ratio exactly
    expect(ratios.liquidity.current_ratio).toBe(ratios.liquidity.quick_ratio);
    expect(ratios.liquidity.current_ratio).toBe(5.75); // 23000 / 4000
  });

  test('cash_ratio has no stray ÷100 — Cash / Current Liabilities directly', () => {
    const ratios = computeRatios(makeRatioLedgers(), { periodType: 'annual', yearType: 'FY' });
    expect(ratios.liquidity.cash_ratio).toBe(0.75); // 3000 / 4000, not 0.0075
  });

  test('asset_turnover (efficiency and dupont) has no stray ×100 — Revenue / Total Assets directly', () => {
    const ratios = computeRatios(makeRatioLedgers(), { periodType: 'annual', yearType: 'FY' });
    // total assets = 50000(PPE) + 5000(inv) + 20000(ar) + 3000(cash) = 78000
    const expected = parseFloat((100000 / 78000).toFixed(2));
    expect(ratios.efficiency.asset_turnover).toBe(expected);
    expect(ratios.dupont.asset_turnover).toBe(expected);
    expect(ratios.efficiency.asset_turnover).toBeGreaterThan(1); // sanity: would be ~0.01 under the old ×100 bug
  });

  test('DSCR is null (not 0.00x or Infinity) when there is no real debt service', () => {
    const ratios = computeRatios(makeRatioLedgers(), { periodType: 'annual', yearType: 'FY' });
    expect(ratios.leverage.dscr).toBeNull();
  });

  test('DSCR reflects real interest paid + real net principal repaid, not a hardcoded denominator', () => {
    const ledgers: TbLedgerRow[] = [
      makeLedger({ ledger_name: 'Revenue', note_no: 20, section: 'inc', normal_bal: 'Cr', m1_cr: 100000 }),
      makeLedger({ ledger_name: 'Cost of Services', note_no: 22, section: 'exp', normal_bal: 'Dr', m1_dr: 50000 }),
      makeLedger({ ledger_name: 'Finance Costs', note_no: 24, note_name: 'Finance Costs', section: 'exp', normal_bal: 'Dr', m1_dr: 2000 }),
      // Opening 10000, one month's Dr movement of 3000 against this Cr-normal
      // liability = a real repayment of 3000 during the period.
      makeLedger({ ledger_name: 'Short-Term Borrowings', note_no: 9, note_name: 'Short-Term Borrowings', section: 'lc', normal_bal: 'Cr', op_cr: 10000, m1_dr: 3000 }),
      makeLedger({ ledger_name: 'Share Capital', note_no: 1, section: 'eq', normal_bal: 'Cr', op_cr: 40000 }),
    ];
    const ratios = computeRatios(ledgers, { periodType: 'annual', yearType: 'FY' });
    // operating_profit = pbt(48000) + fin(2000) = 50000 (no WC movement, no depreciation/other income)
    // debt service = finance costs(2000) + principal repaid(3000) = 5000
    expect(ratios.leverage.dscr).toBe(10); // 50000 / 5000
  });
});

describe('computeVendorExpense', () => {
  const annual = { periodType: 'annual' as const, yearType: 'FY' as const };

  test('ranks vendors by real spend and flags concentration risk by the same thresholds as customers', () => {
    const rows: VendorExpenseInput[] = [
      { vendor_name: 'Vendor A', m1: 10000 },
      { vendor_name: 'Vendor B', m1: 30000 },
      { vendor_name: 'Vendor C', m1: 60000 },
    ];
    const result = computeVendorExpense(rows, annual);
    expect(result.map(r => r.vendor)).toEqual(['Vendor C', 'Vendor B', 'Vendor A']); // sorted by spend desc
    expect(result[0]).toMatchObject({ vendor: 'Vendor C', amount: 60000, pct_of_total: 60, status: 'Concentration Risk' }); // > 30%
    expect(result[1]).toMatchObject({ vendor: 'Vendor B', amount: 30000, pct_of_total: 30, status: 'Key Vendor' }); // exactly 30% is not > 30
    expect(result[2]).toMatchObject({ vendor: 'Vendor A', amount: 10000, pct_of_total: 10, status: 'Healthy' });
  });

  test('returns [] (not a fabricated placeholder) when there is no real vendor-bill data', () => {
    expect(computeVendorExpense([], annual)).toEqual([]);
  });

  test('respects the selected period — only sums months within it, real per-month figures', () => {
    const rows: VendorExpenseInput[] = [
      { vendor_name: 'Vendor A', m1: 1000, m2: 2000, m4: 5000 }, // m4 = July, outside Q1
    ];
    const q1 = computeVendorExpense(rows, { periodType: 'quarterly' as const, period: 'Q1' as const, yearType: 'FY' as const });
    expect(q1[0].amount).toBe(3000); // m1 + m2 only, m4 excluded
  });
});

describe('computeCustomerMargin', () => {
  const annual = { periodType: 'annual' as const, yearType: 'FY' as const };

  test('merges real revenue and real direct cost per customer, honestly, even when one side is missing', () => {
    const revenueRows: CustomerRevenueInput[] = [
      { customer_name: 'Customer X', m1: 50000 }, // revenue only — no billable expense ever tagged to them
      { customer_name: 'Customer Y', m1: 20000 },
    ];
    const costRows: CustomerRevenueInput[] = [
      { customer_name: 'Customer Y', m1: 5000 }, // real direct cost tagged in Zoho
      { customer_name: 'Customer Z', m1: 1000 }, // billable expense with no matching revenue this period
    ];
    const result = computeCustomerMargin(revenueRows, costRows, annual);
    expect(result.org_tracks_direct_cost).toBe(true); // at least one real nonzero direct cost exists

    const byName = Object.fromEntries(result.entries.map(e => [e.customer, e]));
    expect(byName['Customer X']).toMatchObject({ revenue: 50000, direct_cost: 0, direct_margin: 50000, direct_margin_pct: 100 });
    expect(byName['Customer Y']).toMatchObject({ revenue: 20000, direct_cost: 5000, direct_margin: 15000, direct_margin_pct: 75 });
    // Customer Z has cost but no revenue this period — real numbers, not hidden
    expect(byName['Customer Z']).toMatchObject({ revenue: 0, direct_cost: 1000, direct_margin: -1000 });
    expect(byName['Customer Z'].direct_margin_pct).toBeNull(); // nothing to divide by — not a fabricated 0%/Infinity
    // Sorted by revenue descending
    expect(result.entries.map(e => e.customer)).toEqual(['Customer X', 'Customer Y', 'Customer Z']);
  });

  test('org_tracks_direct_cost is false — not a fabricated 100% margin claim — when Zoho has no billable-to-customer tagging at all', () => {
    // Regression test for the real finding this feature was built around:
    // confirmed empirically that a real synced company had 0 of 780 Zoho
    // expenses tagged billable-to-customer. computeCustomerMargin() must
    // surface that as a flag the UI can disclose, not silently show every
    // customer at 100% margin as if cost were genuinely zero.
    const revenueRows: CustomerRevenueInput[] = [{ customer_name: 'Customer X', m1: 50000 }];
    const costRows: CustomerRevenueInput[] = []; // this org's real state today
    const result = computeCustomerMargin(revenueRows, costRows, annual);
    expect(result.org_tracks_direct_cost).toBe(false);
    expect(result.entries[0]).toMatchObject({ revenue: 50000, direct_cost: 0, direct_margin: 50000, direct_margin_pct: 100 });
  });

  test('returns empty entries and org_tracks_direct_cost=false when there is no real data at all', () => {
    const result = computeCustomerMargin([], [], annual);
    expect(result.entries).toEqual([]);
    expect(result.org_tracks_direct_cost).toBe(false);
  });
});
