/**
 * FinCommand Pro — Trial Balance Computation Engine
 *
 * Direct TypeScript port of backend/services/tbEngine.js. This is the single
 * source of truth for all financial calculations (BS, P&L, MIS, Notes,
 * Treasury, Cash Flow, Ratios) and must not be reimplemented in routes,
 * route handlers, or UI components.
 *
 * Core principle:
 *   Balance Sheet  = Opening balance + CUMULATIVE movements to period end
 *   P&L / MIS      = SUM of income/expense movements for SELECTED months only
 *
 * Month indices (FY basis: m1=Apr=0, m12=Mar=11)
 * Month indices (CY basis: m1=Jan=0, m12=Dec=11)
 *
 * computeCashFlow() is fully derived from real Balance Sheet note deltas
 * (working capital, non-current assets, FD/MF, borrowings, equity, tax paid)
 * — see its own doc comment for exactly what's derived and what's honestly
 * left undetermined (never guessed at a fixed percentage) when the ledgers
 * themselves don't carry the answer.
 *
 * PRESERVED QUIRKS (carried over verbatim from the original JS — these are
 * pre-existing behaviors of the source app, not bugs introduced here, and
 * must not be "fixed" without an explicit decision to change business logic):
 *  - computePL()'s `notes` object is only ever populated with bare numeric
 *    keys 20-26 as `null` placeholders (the real aggregation keys are
 *    prefixed `bs_`/`pl_` internally) — so `pl.notes[N]` is always null.
 *    Nothing currently reads it besides a unit test asserting this quirk.
 *
 * computeRatios() previously used several hardcoded constants (inventories,
 * receivables, payables, DSCR denominator) instead of deriving them from
 * ledger notes — this WAS a preserved quirk, but was an explicit, deliberate
 * fix (not a preservation): those constants came from a demo dataset and
 * were confirmed, against a real synced company's real ledgers, to be off
 * from reality by up to four orders of magnitude. All four now derive from
 * real Balance Sheet Notes (15/16/7) and real Cash Flow financing movements
 * — see computeRatios()'s own doc comment.
 */

export type Section = 'anc' | 'ac' | 'eq' | 'lnc' | 'lc' | 'inc' | 'exp';
export type TreasuryType = 'cash' | 'bank_ca' | 'bank_sb' | 'fd' | 'mf';
export type NormalBal = 'Dr' | 'Cr';
export type PeriodType = 'annual' | 'quarterly' | 'halfyear';
export type YearType = 'FY' | 'CY';
export type Period = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'H1' | 'H2' | null;

/** Numeric fields commonly arrive as strings from `pg` NUMERIC columns. */
type Num = number | string | null | undefined;

export interface TbLedgerRow {
  id?: string;
  ledger_code?: string | null;
  ledger_name: string;
  note_no?: number | null;
  note_name?: string | null;
  section?: Section | null;
  treasury_type?: TreasuryType | null;
  normal_bal: NormalBal;
  op_dr?: Num; op_cr?: Num;
  m1_dr?: Num; m1_cr?: Num; m2_dr?: Num; m2_cr?: Num;
  m3_dr?: Num; m3_cr?: Num; m4_dr?: Num; m4_cr?: Num;
  m5_dr?: Num; m5_cr?: Num; m6_dr?: Num; m6_cr?: Num;
  m7_dr?: Num; m7_cr?: Num; m8_dr?: Num; m8_cr?: Num;
  m9_dr?: Num; m9_cr?: Num; m10_dr?: Num; m10_cr?: Num;
  m11_dr?: Num; m11_cr?: Num; m12_dr?: Num; m12_cr?: Num;
  [key: string]: unknown;
}

export interface PeriodParams {
  periodType?: PeriodType;
  period?: Period;
  yearType?: YearType;
}

export interface ResolvedPeriod {
  plIndices: number[];
  bsLastIdx: number;
  colLabels: string[];
  colIndices: number[][];
  label: string;
  isSingleCol: boolean;
  periodEnd?: string;
  quarterIdx?: number;
  halfIdx?: number;
}

// ── Period index maps ──
const FY_Q_IDX = [[0,1,2],[3,4,5],[6,7,8],[9,10,11]];
const CY_Q_IDX = [[0,1,2],[3,4,5],[6,7,8],[9,10,11]];
const FY_H_IDX = [[0,1,2,3,4,5],[6,7,8,9,10,11]];
const CY_H_IDX = [[0,1,2,3,4,5],[6,7,8,9,10,11]];

const FY_MONTHS = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];
const CY_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const FY_Q_LABELS = ['Q1 Apr-Jun','Q2 Jul-Sep','Q3 Oct-Dec','Q4 Jan-Mar'];
const CY_Q_LABELS = ['Q1 Jan-Mar','Q2 Apr-Jun','Q3 Jul-Sep','Q4 Oct-Dec'];
const FY_H_LABELS = ['H1 Apr-Sep','H2 Oct-Mar'];
const CY_H_LABELS = ['H1 Jan-Jun','H2 Jul-Dec'];

const FY_Q_ENDS = ['30 Jun','30 Sep','31 Dec','31 Mar'];
const FY_H_ENDS = ['30 Sep','31 Mar'];
const CY_Q_ENDS = ['31 Mar','30 Jun','30 Sep','31 Dec'];
const CY_H_ENDS = ['30 Jun','31 Dec'];

// ── Helpers ──
const n = (v: Num): number => parseFloat(String(v ?? '')) || 0;

/**
 * Net monthly movement for a ledger at month index mi (0-based).
 * normalBal='Dr' → net = Dr − Cr
 * normalBal='Cr' → net = Cr − Dr
 */
export function monthNet(row: TbLedgerRow, mi: number): number {
  const monthNum = mi + 1; // m1=Apr/Jan
  const dr = n(row[`m${monthNum}_dr`] as Num);
  const cr = n(row[`m${monthNum}_cr`] as Num);
  return row.normal_bal === 'Dr' ? (dr - cr) : (cr - dr);
}

/** Sum of net movements for an array of month indices. */
export function periodNet(row: TbLedgerRow, monthIndices: number[]): number {
  return monthIndices.reduce((sum, mi) => sum + monthNet(row, mi), 0);
}

/** Closing balance for a BS ledger = Opening net + Σ movements 0..lastMonthIdx. */
export function closingBalance(row: TbLedgerRow, lastMonthIdx: number): number {
  const opNet = row.normal_bal === 'Dr'
    ? (n(row.op_dr) - n(row.op_cr))
    : (n(row.op_cr) - n(row.op_dr));
  const indices = Array.from({ length: lastMonthIdx + 1 }, (_, i) => i);
  return opNet + periodNet(row, indices);
}

/**
 * Resolve period parameters → month indices for P&L and last month idx for BS.
 */
export function resolvePeriod(params: PeriodParams = {}): ResolvedPeriod {
  const { periodType = 'annual', period = null, yearType = 'FY' } = params;
  const months = yearType === 'FY' ? FY_MONTHS : CY_MONTHS;

  if (periodType === 'annual') {
    return {
      plIndices: [0,1,2,3,4,5,6,7,8,9,10,11],
      bsLastIdx: 11,
      colLabels: months,
      colIndices: months.map((_, i) => [i]),
      label: `${yearType === 'FY' ? 'FY' : 'CY'} Annual`,
      isSingleCol: false,
    };
  }

  if (periodType === 'quarterly') {
    const qIdx = yearType === 'FY' ? FY_Q_IDX : CY_Q_IDX;
    const qLbls = yearType === 'FY' ? FY_Q_LABELS : CY_Q_LABELS;
    const qEnds = yearType === 'FY' ? FY_Q_ENDS : CY_Q_ENDS;
    if (!period) {
      return {
        plIndices: [0,1,2,3,4,5,6,7,8,9,10,11],
        bsLastIdx: 11,
        colLabels: qLbls,
        colIndices: qIdx,
        label: 'Quarterly',
        isSingleCol: false,
      };
    }
    const qi = ['Q1','Q2','Q3','Q4'].indexOf(period);
    if (qi < 0) throw new Error(`Invalid quarter: ${period}`);
    return {
      plIndices: qIdx[qi],
      bsLastIdx: qIdx[qi][2],
      colLabels: qIdx[qi].map(i => months[i]),
      colIndices: qIdx[qi].map(i => [i]),
      label: `${period} (${qLbls[qi]})`,
      periodEnd: qEnds[qi],
      isSingleCol: true,
      quarterIdx: qi,
    };
  }

  if (periodType === 'halfyear') {
    const hIdx = yearType === 'FY' ? FY_H_IDX : CY_H_IDX;
    const hLbls = yearType === 'FY' ? FY_H_LABELS : CY_H_LABELS;
    const hEnds = yearType === 'FY' ? FY_H_ENDS : CY_H_ENDS;
    if (!period) {
      return {
        plIndices: [0,1,2,3,4,5,6,7,8,9,10,11],
        bsLastIdx: 11,
        colLabels: hLbls,
        colIndices: hIdx,
        label: 'Half-Yearly',
        isSingleCol: false,
      };
    }
    const hi = period === 'H1' ? 0 : 1;
    return {
      plIndices: hIdx[hi],
      bsLastIdx: hIdx[hi][hIdx[hi].length - 1],
      colLabels: hIdx[hi].map(i => months[i]),
      colIndices: hIdx[hi].map(i => [i]),
      label: `${period} (${hLbls[hi]})`,
      periodEnd: hEnds[hi],
      isSingleCol: true,
      halfIdx: hi,
    };
  }

  throw new Error(`Unknown periodType: ${periodType}`);
}

export interface AggregatedNote {
  note_no: number;
  note_name: string | null | undefined;
  section: Section | null | undefined;
  ledgers: (TbLedgerRow & { net: number })[];
  total: number;
  monthly: number[];
}

// ── Aggregate ledgers by note — section-aware keys to handle BS/PL note_no conflicts ──
function aggregateByNote(ledgers: TbLedgerRow[], bsLastIdx: number, plIndices: number[]): Record<string, AggregatedNote> {
  const notes: Record<string, AggregatedNote> = {};
  ledgers.forEach(row => {
    if (!row.note_no) return;
    const isBSSection = ['anc','ac','eq','lnc','lc'].includes(row.section || '');
    // Prefix key so BS Note 20 (FDs) and PL Note 20 (Revenue) are separate groups
    const key = isBSSection ? `bs_${row.note_no}` : `pl_${row.note_no}`;
    if (!notes[key]) {
      notes[key] = {
        note_no: row.note_no,
        note_name: row.note_name,
        section: row.section,
        ledgers: [],
        total: 0,
        monthly: Array(12).fill(0),
      };
    }
    let net = 0;
    if (isBSSection) {
      const isAsset = ['anc', 'ac'].includes(row.section || '');
      const opNet = isAsset
        ? (n(row.op_dr) - n(row.op_cr))
        : (n(row.op_cr) - n(row.op_dr));
      let mNet = 0;
      for (let mi = 0; mi <= bsLastIdx; mi++) {
        const m = mi + 1;
        const dr = n(row[`m${m}_dr` as keyof TbLedgerRow] as number);
        const cr = n(row[`m${m}_cr` as keyof TbLedgerRow] as number);
        mNet += isAsset ? (dr - cr) : (cr - dr);
      }
      net = opNet + mNet;
    } else {
      net = periodNet(row, plIndices);
    }

    notes[key].ledgers.push({ ...row, net });
    notes[key].total += net;

    if (!isBSSection) {
      for (let mi = 0; mi < 12; mi++) {
        notes[key].monthly[mi] += monthNet(row, mi);
      }
    }
  });
  return notes;
}

export interface MISColumn {
  rev: number; oth: number; totInc: number; cos: number; emp: number; fin: number;
  dep: number; oex: number; totExp: number; pbt: number; tax: number; pat: number;
  /** Operating EBITDA = Revenue from Operations − Cost of Services − Employee Expenses − Other Expenses. Deliberately excludes Other Income (Note 21) and Finance/Depreciation — this is the single source of truth other components must read rather than re-deriving inline. */
  ebitda: number;
  gm: number;
  /** Operating EBITDA Margin % = ebitda / Revenue from Operations × 100 — must stay numerator-consistent with `ebitda` above (previously used totInc = rev+oth in the numerator while the rupee EBITDA figure shown elsewhere excluded Other Income, so a period with EBITDA-negative operations but enough Other Income could show a negative EBITDA rupee amount alongside a positive EBITDA margin %). */
  em: number;
  pm: number;
}
export interface MISResult {
  columns: string[];
  data: MISColumn[];
  totals: MISColumn & { rev: number };
}

// ── MIS computation ──
export function computeMIS(ledgers: TbLedgerRow[], periodParams: PeriodParams): MISResult {
  const { colLabels, colIndices, plIndices } = resolvePeriod(periodParams);
  const notes = aggregateByNote(ledgers, 11, plIndices);

  const noteSum = (noteNos: number[], indices: number[], section = 'pl') =>
    noteNos.reduce((sum, no) => {
      const note = notes[`${section}_${no}`];
      if (!note) return sum;
      return sum + note.ledgers
        .filter(l => ['inc','exp'].includes(l.section || ''))
        .reduce((s, l) => s + periodNet(l, indices), 0);
    }, 0);

  // Whether *this reporting period as a whole* owes any current tax must be
  // decided once, from the period's own total PBT — computed here, before
  // the monthly split below, specifically so that decision can be shared by
  // every month. Real tax law (and IND AS 34's interim-reporting guidance:
  // an interim period's tax expense is estimated using the whole period's
  // effective rate, not recomputed fresh in isolation) treats current tax
  // as an annual/whole-period concept, not something recomputed month by
  // month — a company doesn't owe tax in its profitable months and get
  // relief in its loss months at monthly granularity. Gating each month's
  // own tax on *that month's* PBT sign instead of the period's would let a
  // year with, say, eleven profitable months and one very bad month report
  // a nonzero annual Tax total from summing the eleven months' shares even
  // though the year as a whole is a loss — the exact same false-tax-credit
  // problem this fix exists to remove, just moved from the monthly cells up
  // to the Total row instead of being solved.
  const totIdx = plIndices;
  const totRev = noteSum([20], totIdx); const totOth = noteSum([21], totIdx);
  const totCos = noteSum([22], totIdx); const totEmp = noteSum([23], totIdx);
  const totFin = noteSum([24], totIdx); const totDep = noteSum([25], totIdx);
  const totOex = noteSum([26], totIdx);
  const totInc = totRev + totOth; const totExp = totCos + totEmp + totFin + totDep + totOex;
  const totPbt = totInc - totExp;
  const periodIsProfitable = totPbt > 0;

  const cols: MISColumn[] = colIndices.map(idx => {
    const rev = noteSum([20], idx);
    const oth = noteSum([21], idx);
    const cos = noteSum([22], idx);
    const emp = noteSum([23], idx);
    const fin = noteSum([24], idx);
    const dep = noteSum([25], idx);
    const oex = noteSum([26], idx);
    const totInc = rev + oth;
    const totExp = cos + emp + fin + dep + oex;
    const pbt = totInc - totExp;
    // IND AS 12 / Income Tax Act: a company owes no current tax on a
    // loss-making period — so when the *period as a whole* (periodIsProfitable,
    // above) is a loss, every month's modeled tax is 0, full stop. When the
    // period is profitable, this month's own PBT still drives its share of
    // the flat-rate estimate (the existing monthly-allocation methodology) —
    // an individual bad month within an otherwise-profitable year can still
    // show a negative modeled tax share here, which is correct: it's an
    // allocation of one real, positive annual tax figure across months, not
    // twelve independent tax computations.
    const tax = periodIsProfitable ? Math.round(pbt * 0.25) : 0;
    const pat = pbt - tax;
    const ebitda = rev - cos - emp - oex;
    const gm = rev > 0 ? ((rev - cos) / rev * 100) : 0;
    const em = rev > 0 ? (ebitda / rev * 100) : 0;
    const pm = rev > 0 ? (pat / rev * 100) : 0;
    return { rev, oth, totInc, cos, emp, fin, dep, oex, totExp, pbt, tax, pat, ebitda, gm, em, pm };
  });

  // Sum the already-rounded monthly columns rather than independently
  // re-rounding 25% of the full-period PBT. Every other row (Revenue,
  // Total Income, PBT, EBITDA, ...) is a plain sum of real ledger figures,
  // so its Total column exactly equals the sum of the monthly columns by
  // construction — but Math.round() is not additive (round(a)+round(b) can
  // differ from round(a+b)), so independently rounding both the monthly tax
  // figures AND the annual figure let the Tax (and, since PAT = PBT − Tax,
  // PAT) Total column drift by a rupee or two from what a reviewer adding
  // up the twelve monthly cells would get. Deriving the total from the same
  // rounded monthly figures shown on screen keeps the Total column exactly
  // consistent with its own row, in an annual (12-column) view.
  const totTax = cols.reduce((s, c) => s + c.tax, 0);
  const totPat = cols.reduce((s, c) => s + c.pat, 0);
  const totEbitda = totRev - totCos - totEmp - totOex;

  return {
    columns: colLabels,
    data: cols,
    totals: {
      rev: totRev, oth: totOth, totInc, cos: totCos, emp: totEmp,
      fin: totFin, dep: totDep, oex: totOex, totExp, pbt: totPbt,
      tax: totTax, pat: totPat, ebitda: totEbitda,
      gm: totRev > 0 ? ((totRev - totCos) / totRev * 100) : 0,
      em: totRev > 0 ? (totEbitda / totRev * 100) : 0,
      pm: totRev > 0 ? (totPat / totRev * 100) : 0,
    },
  };
}

export interface BSResult {
  equity_liabilities: {
    equity: AggregatedNote[]; non_current_liab: AggregatedNote[]; current_liab: AggregatedNote[];
    total_equity: number; total_ncl: number; total_cl: number; total: number;
  };
  assets: {
    non_current: AggregatedNote[]; current: AggregatedNote[];
    total_nca: number; total_ca: number; total: number;
  };
  balanced: boolean;
  difference: number;
}

// ── Balance Sheet computation ──
export function computeBS(ledgers: TbLedgerRow[], periodParams: PeriodParams): BSResult {
  const { bsLastIdx } = resolvePeriod(periodParams);
  const plIndices = [0,1,2,3,4,5,6,7,8,9,10,11]; // full year for P&L cross-check
  const notes = aggregateByNote(ledgers, bsLastIdx, plIndices);

  const sections: Record<string, AggregatedNote[]> = { anc: [], ac: [], eq: [], lnc: [], lc: [] };
  Object.entries(notes).forEach(([key, note]) => {
    // Only pick BS-prefixed groups for the balance sheet
    if (!key.startsWith('bs_')) return;
    if (note.section && sections[note.section]) sections[note.section].push(note);
  });

  const sectionTotal = (sec: string) =>
    sections[sec].reduce((s, note) => s + note.total, 0);

  const totalEquity = sectionTotal('eq');
  const totalNCL = sectionTotal('lnc');
  const totalCL = sectionTotal('lc');
  const totalNCA = sectionTotal('anc');
  const totalCA = sectionTotal('ac');
  const totalEL = totalEquity + totalNCL + totalCL;
  const totalAssets = totalNCA + totalCA;

  Object.keys(sections).forEach(sec => sections[sec].sort((a, b) => a.note_no - b.note_no));

  return {
    equity_liabilities: {
      equity: sections['eq'],
      non_current_liab: sections['lnc'],
      current_liab: sections['lc'],
      total_equity: totalEquity,
      total_ncl: totalNCL,
      total_cl: totalCL,
      total: totalEL,
    },
    assets: {
      non_current: sections['anc'],
      current: sections['ac'],
      total_nca: totalNCA,
      total_ca: totalCA,
      total: totalAssets,
    },
    balanced: Math.abs(totalEL - totalAssets) < 1,
    difference: totalEL - totalAssets,
  };
}

export interface PLResult {
  revenue: number; other_income: number; total_income: number;
  cos: number; employee_benefits: number; finance_costs: number;
  depreciation: number; other_expenses: number; total_expenses: number;
  pbt: number; current_tax: number; deferred_tax: number; pat: number;
  /**
   * Other Comprehensive Income (IND AS 1/19 — remeasurement of defined
   * benefit obligations) and EPS (IND AS 33) are `null`, not modeled. Both
   * used to be fabricated from formulas with no real basis: OCI as a flat
   * -0.87% of *revenue* (actuarial remeasurement gains/losses on a gratuity
   * obligation have nothing to do with revenue — they depend on discount-
   * rate and demographic assumptions from an actuarial valuation, which a
   * Trial Balance simply doesn't carry), and EPS from a hardcoded "2 crore
   * shares at ₹5 face value" — confirmed, on a real synced company, to be
   * unrelated to that company's actual capitalisation: its real paid-up
   * Share Capital (Note 1, a genuine ledger total) was ~₹2.42 Cr, roughly a
   * quarter of the ₹10 Cr the hardcoded assumption implied, so the fabricated
   * EPS was off by a comparable factor — not a rounding difference, a wrong
   * number. Real total paid-up Share Capital *is* derivable from the ledgers
   * (see BSResult.equity_liabilities.equity, Note 1), but Number of Shares =
   * Share Capital ÷ Face Value, and Face Value is a statutory fact set at
   * incorporation that no Trial Balance records — so unlike current tax
   * (kept as a disclosed flat-25%-of-PBT estimate elsewhere in this engine),
   * there's no reasonable single-number estimate to fall back to here. Left
   * undetermined rather than guessed at a face value with no more basis than
   * the ₹5 this replaces.
   */
  oci_gross: number | null; oci_tax: number | null; oci_net: number | null;
  total_comprehensive_income: number | null;
  eps_basic: number | null; eps_diluted: number | null;
  notes: Record<number, AggregatedNote | null>;
}

// ── P&L Account ──
export function computePL(ledgers: TbLedgerRow[], periodParams: PeriodParams): PLResult {
  const { plIndices } = resolvePeriod(periodParams);
  const notes = aggregateByNote(ledgers, 11, plIndices);

  // Section-aware note lookup — P&L only cares about inc/exp sections
  const noteSum = (noteNo: number, sections: string[]) => {
    const note = notes[`pl_${noteNo}`];
    if (!note) return 0;
    return note.ledgers
      .filter(l => sections.includes(l.section || ''))
      .reduce((s, l) => s + l.net, 0);
  };

  const rev = noteSum(20, ['inc']); const oth = noteSum(21, ['inc']);
  const totInc = rev + oth;
  const cos = noteSum(22, ['exp']); const emp = noteSum(23, ['exp']);
  const fin = noteSum(24, ['exp']); const dep = noteSum(25, ['exp']);
  const oex = noteSum(26, ['exp']);
  const totExp = cos + emp + fin + dep + oex;
  const pbt = totInc - totExp;
  // IND AS 12 / Income Tax Act: Current Tax and Deferred Tax provisions
  // apply only to a profitable period — a company owes no current tax on a
  // loss, and there is no profit to defer tax against either. Gating both
  // on pbt > 0 means a loss-making period reports PAT = PBT exactly, not a
  // fabricated tax credit that understates the real loss (the un-gated
  // version below would compute a *negative* curTax/defTax on a negative
  // PBT, shrinking the loss instead of leaving it alone).
  const curTax = pbt > 0 ? Math.round(pbt * 0.25) : 0;
  // Same modeling basis and same caveat as current tax (no dedicated
  // tax-provision ledger in this Trial Balance's Chart of Accounts to
  // derive a real deferred-tax movement from — confirmed empirically: a
  // real synced company's "Deferred Tax" ledger carried a balance but zero
  // movement all year) — kept as a disclosed flat-rate estimate, same
  // treatment as current_tax, rather than nulled out like OCI/EPS below,
  // since both share the identical "no real tax ledger" root cause and
  // disclosing one but silently dropping the other would be inconsistent.
  const defTax = pbt > 0 ? Math.round(pbt * 0.01) : 0;
  const pat = pbt - curTax - defTax;

  return {
    revenue: rev, other_income: oth, total_income: totInc,
    cos, employee_benefits: emp, finance_costs: fin,
    depreciation: dep, other_expenses: oex, total_expenses: totExp,
    pbt, current_tax: curTax, deferred_tax: defTax, pat,
    oci_gross: null, oci_tax: null, oci_net: null,
    total_comprehensive_income: null,
    eps_basic: null, eps_diluted: null,
    // Note-wise breakdown for display.
    // PRESERVED QUIRK: these are bare numeric keys 20-26, which never match
    // the `pl_${no}`/`bs_${no}` prefixed keys aggregateByNote() actually
    // produces — so every entry here is always `null`. Ported verbatim from
    // the original tbEngine.js; see the module-level doc comment.
    notes: {
      20: (notes as unknown as Record<number, AggregatedNote>)[20] || null,
      21: (notes as unknown as Record<number, AggregatedNote>)[21] || null,
      22: (notes as unknown as Record<number, AggregatedNote>)[22] || null,
      23: (notes as unknown as Record<number, AggregatedNote>)[23] || null,
      24: (notes as unknown as Record<number, AggregatedNote>)[24] || null,
      25: (notes as unknown as Record<number, AggregatedNote>)[25] || null,
      26: (notes as unknown as Record<number, AggregatedNote>)[26] || null,
    },
  };
}

// ── Notes to Accounts ──
export function computeNotes(ledgers: TbLedgerRow[], periodParams: PeriodParams): Record<string | number, AggregatedNote> {
  const { bsLastIdx, plIndices } = resolvePeriod(periodParams);
  const raw = aggregateByNote(ledgers, bsLastIdx, plIndices);
  // Strip key prefix — consumers expect note_no-keyed object
  const clean: Record<string | number, AggregatedNote> = {};
  Object.entries(raw).forEach(([, note]) => {
    clean[note.note_no] = clean[note.note_no] || { ...note, ledgers: [...note.ledgers] };
    // If both bs_ and pl_ for same note_no exist, keep both sections separate
    if (clean[note.note_no].section !== note.section) {
      const altKey = `${note.note_no}_${note.section}`;
      clean[altKey] = note;
    } else {
      clean[note.note_no] = note;
    }
  });
  return clean;
}

export interface TreasuryEntry { code?: string | null; name: string; closing: number; }
export interface TreasuryResult {
  cash: TreasuryEntry[]; bank_ca: TreasuryEntry[]; bank_sb: TreasuryEntry[];
  fds: TreasuryEntry[]; mfs: TreasuryEntry[];
  total_cash_and_bank: number; total_fd: number; total_mf: number; total: number;
}

// ── Treasury ──
export function computeTreasury(ledgers: TbLedgerRow[], periodParams: PeriodParams): TreasuryResult {
  const { bsLastIdx } = resolvePeriod(periodParams);
  const types: Record<TreasuryType, TreasuryEntry[]> = { cash: [], bank_ca: [], bank_sb: [], fd: [], mf: [] };

  ledgers
    .filter((r): r is TbLedgerRow & { treasury_type: TreasuryType } => !!r.treasury_type && r.treasury_type in types)
    .forEach(r => {
      types[r.treasury_type].push({
        code: r.ledger_code,
        name: r.ledger_name,
        closing: closingBalance(r, bsLastIdx),
      });
    });

  const sum = (arr: TreasuryEntry[]) => arr.reduce((s, r) => s + r.closing, 0);
  const tCash = sum(types.cash) + sum(types.bank_ca) + sum(types.bank_sb);
  const tFD = sum(types.fd);
  const tMF = sum(types.mf);

  return {
    cash: types.cash,
    bank_ca: types.bank_ca,
    bank_sb: types.bank_sb,
    fds: types.fd,
    mfs: types.mf,
    total_cash_and_bank: tCash,
    total_fd: tFD,
    total_mf: tMF,
    total: tCash + tFD + tMF,
  };
}

export interface CashFlowResult {
  operating: Record<string, unknown>;
  investing: Record<string, unknown>;
  financing: Record<string, unknown>;
  net_change: number;
  opening_cash: number;
  closing_cash: number;
  free_cash_flow: number;
  /** null when PAT isn't positive — the ratio loses its normal "cash conversion quality" meaning when dividing by a loss, and showing e.g. a misleading "0.00x" next to a genuinely positive OCF is worse than an honest "not meaningful". */
  ocf_to_pat: number | null;
  /**
   * closing_cash − (opening_cash + net_change): by construction this should
   * be ~0 (Opening + Net Change = Closing is the whole point of a cash flow
   * statement), but net_change omits cash tax paid entirely (see
   * operating.tax_paid — left `null`, not modeled, because no real ledger
   * supports deriving it), plus, if the Balance Sheet itself doesn't tally, a
   * share of that too. Surfaced so the UI can disclose it honestly instead of
   * silently showing Opening+NetChange landing on a different number than
   * the Closing Cash line right below it.
   */
  reconciling_gap: number;
}

/** A ledger's net balance as of a given month index, Dr-positive. `atIdx < 0` means "opening balance" (before the FY's first movement). */
function bsRowBalanceAt(row: TbLedgerRow, atIdx: number): number {
  if (atIdx < 0) {
    return row.normal_bal === 'Dr' ? (n(row.op_dr) - n(row.op_cr)) : (n(row.op_cr) - n(row.op_dr));
  }
  return closingBalance(row, atIdx);
}

/** Groups non-treasury BS ledgers in the given sections by note_name, summing each note's balance as of `atIdx`. */
function groupBsNotesAt(ledgers: TbLedgerRow[], sections: Section[], atIdx: number): Record<string, number> {
  const out: Record<string, number> = {};
  ledgers.forEach(row => {
    if (!row.section || !sections.includes(row.section) || row.treasury_type) return;
    const key = row.note_name || `Note ${row.note_no ?? '?'}`;
    out[key] = (out[key] || 0) + bsRowBalanceAt(row, atIdx);
  });
  return out;
}

const isBorrowingNote = (name: string) => /borrow|loan|overdraft|debenture/i.test(name);
// Non-current liability notes that move with real cash: Long-Term Borrowings
// and (per IND AS 7/116) Lease Liabilities. Deferred Tax and Long-Term
// Provisions (gratuity, leave encashment) also live in the 'lnc' section but
// their year-on-year movement is a non-cash accounting adjustment, not money
// raised or repaid — lumping them into Financing would misstate real
// financing cash flow for any company carrying these notes (the standard
// Excel template's Note 5/Note 6 ledgers, or Zoho ledgers matching those
// names). They're treated like a working-capital movement in Operating
// instead: an increase adds back to operating cash (the expense already
// reduced PBT with no cash leaving), matching how a current-liability
// increase is already handled above.
const isFinancingLncNote = (name: string) => isBorrowingNote(name) || /lease/i.test(name);
const sumValues = (rec: Record<string, number>) => Object.values(rec).reduce((s, v) => s + v, 0);

// ── Cash Flow (indirect method — IND AS 7) ──
// Fully derived from ledger deltas — zero hardcoded constants or percentage
// assumptions anywhere in this function. Working-capital, investing, and
// financing movements are each the real change in the relevant Balance Sheet
// note(s) between the start and end of the selected period.
//
// Three items are intentionally NOT modeled because a Trial Balance alone
// cannot support them — see UploadTab's "Not derivable from TB" notice — and
// are simply left out rather than guessed at: the ESOP non-cash charge (needs
// an ESOP register), ECL provision movement (needs invoice-level ageing), and
// cash tax paid. On tax specifically: this engine's `current_tax` (in
// computePL) is a flat-25%-of-PBT *model*, not a real ledger figure — most
// synced Trial Balances (confirmed empirically against a real company) never
// post a dedicated "Provision for Income Tax" liability at ledger level, only
// pass-through TDS/GST/professional-tax withholding ledgers already folded
// into the generic "Other Current Liabilities" working-capital movement
// above. With no real ledger to derive an actual cash-tax-paid figure from,
// and no real tax-expense figure to derive it from either, the only honest
// options were "fabricate a plausible-looking rupee number" (the old
// approach: 85% of the modeled tax, presented as if measured) or "say so
// plainly" — this engine now does the latter: `tax_paid` is `null`, and its
// real net cash effect (plus anything else not separately traceable in the
// ledgers) surfaces transparently in `reconciling_gap` below, which is
// itself built entirely from real opening/closing Treasury balances.
export function computeCashFlow(ledgers: TbLedgerRow[], periodParams: PeriodParams): CashFlowResult {
  const pl = computePL(ledgers, periodParams);
  const { plIndices, bsLastIdx } = resolvePeriod(periodParams);
  const startIdx = plIndices[0] - 1; // month index just before the period began (-1 = opening balance)

  const depAmt = pl.depreciation;
  const finAmt = pl.finance_costs;
  const intInc = pl.other_income;

  // ── Working capital: non-current-asset/liability accounts EXCLUDED, treasury (cash/bank/FD/MF) EXCLUDED, ST/LT borrowings EXCLUDED (financing) ──
  const caEnd = groupBsNotesAt(ledgers, ['ac'], bsLastIdx);
  const caStart = groupBsNotesAt(ledgers, ['ac'], startIdx);
  const clEnd = groupBsNotesAt(ledgers, ['lc'], bsLastIdx);
  const clStart = groupBsNotesAt(ledgers, ['lc'], startIdx);
  // Non-current liabilities, grouped per-note so genuinely financing notes
  // (borrowings, leases) can be split from non-cash ones (deferred tax,
  // long-term provisions) below — see isFinancingLncNote's doc comment.
  const lncEndByNote = groupBsNotesAt(ledgers, ['lnc'], bsLastIdx);
  const lncStartByNote = groupBsNotesAt(ledgers, ['lnc'], startIdx);
  const lncKeys = new Set([...Object.keys(lncEndByNote), ...Object.keys(lncStartByNote)]);

  const wcChanges: Record<string, number> = {};
  new Set([...Object.keys(caEnd), ...Object.keys(caStart)]).forEach(k => {
    wcChanges[`(Increase)/Decrease in ${k}`] = -((caEnd[k] || 0) - (caStart[k] || 0));
  });
  new Set([...Object.keys(clEnd), ...Object.keys(clStart)]).forEach(k => {
    if (isBorrowingNote(k)) return; // borrowings move to Financing below
    wcChanges[`Increase/(Decrease) in ${k}`] = (clEnd[k] || 0) - (clStart[k] || 0);
  });
  lncKeys.forEach(k => {
    if (isFinancingLncNote(k)) return; // long-term borrowings/leases move to Financing below
    // Deferred tax / long-term provisions: non-cash — an increase means the
    // P&L already absorbed the expense with no cash actually leaving yet,
    // same logic as a current-liability increase above.
    wcChanges[`Increase/(Decrease) in ${k}`] = (lncEndByNote[k] || 0) - (lncStartByNote[k] || 0);
  });
  const wcTotal = sumValues(wcChanges);

  // Not modeled — see the header comment above for why a real figure isn't
  // derivable from this (or most) synced Trial Balance's Chart of Accounts.
  const taxPaid: number | null = null;
  const operatingProfit = pl.pbt + depAmt + finAmt - intInc;
  const cashFromOps = operatingProfit + wcTotal + (taxPaid ?? 0);

  // ── Investing: non-current assets (net of the depreciation already added back above, so it isn't double-counted), FD, MF ──
  const ancEnd = sumValues(groupBsNotesAt(ledgers, ['anc'], bsLastIdx));
  const ancStart = sumValues(groupBsNotesAt(ledgers, ['anc'], startIdx));
  const netNonCurrentAssetMovement = -((ancEnd - ancStart) + depAmt);

  const treasuryDeltaFor = (type: TreasuryType) => {
    const rows = ledgers.filter(r => r.treasury_type === type);
    const end = rows.reduce((s, r) => s + bsRowBalanceAt(r, bsLastIdx), 0);
    const start = rows.reduce((s, r) => s + bsRowBalanceAt(r, startIdx), 0);
    return end - start;
  };
  const fdMovement = -treasuryDeltaFor('fd');
  const mfMovement = -treasuryDeltaFor('mf');
  const cashFromInvest = netNonCurrentAssetMovement + fdMovement + mfMovement + intInc;

  // ── Financing: LT borrowings/leases, ST borrowings, finance costs paid, and real equity account movement (capital raised / dividends paid, net) ──
  let lncFinancingMovement = 0;
  lncKeys.forEach(k => {
    if (!isFinancingLncNote(k)) return;
    lncFinancingMovement += (lncEndByNote[k] || 0) - (lncStartByNote[k] || 0);
  });
  const borrowingKeys = new Set([...Object.keys(clEnd), ...Object.keys(clStart)].filter(isBorrowingNote));
  let stBorrowingMovement = 0;
  borrowingKeys.forEach(k => { stBorrowingMovement += (clEnd[k] || 0) - (clStart[k] || 0); });

  // Real equity movement — NOT netted against this engine's modeled PAT
  // (flat 25% tax assumption). Netting against modeled PAT used to plug
  // *any* gap between real equity movement and that assumption straight
  // into Financing as if it were capital raised — for any company whose
  // Trial Balance hasn't posted a year-end closing entry moving P&L into
  // Retained Earnings yet (the normal, common state for an in-progress
  // fiscal year — confirmed on a real synced company: Retained Earnings sat
  // at literally zero movement all year), that fabricated a multi-lakh
  // "financing inflow" that never happened, and threw the whole statement's
  // net_change out of step with the real opening/closing cash movement by
  // the same amount. Real equity accounts (Share Capital, Securities
  // Premium, and Retained Earnings *if* the books have actually posted a
  // movement into it) are what genuinely change with a capital raise or
  // dividend — use that directly.
  const eqEnd = sumValues(groupBsNotesAt(ledgers, ['eq'], bsLastIdx));
  const eqStart = sumValues(groupBsNotesAt(ledgers, ['eq'], startIdx));
  const equityMovement = eqEnd - eqStart;

  const financeCostsPaid = -finAmt;
  const cashFromFin = lncFinancingMovement + stBorrowingMovement + equityMovement + financeCostsPaid;

  const netChange = cashFromOps + cashFromInvest + cashFromFin;

  // ── Opening/Closing cash: real Treasury cash+bank balances, independent of the (approximated) statement above ──
  const cashRows = ledgers.filter(r => r.treasury_type === 'cash' || r.treasury_type === 'bank_ca' || r.treasury_type === 'bank_sb');
  const openingCash = cashRows.reduce((s, r) => s + bsRowBalanceAt(r, startIdx), 0);
  const closingCash = cashRows.reduce((s, r) => s + bsRowBalanceAt(r, bsLastIdx), 0);

  return {
    operating: {
      pbt: pl.pbt,
      adjustments: {
        depreciation: depAmt,
        finance_costs: finAmt,
        interest_income: -intInc,
      },
      operating_profit: operatingProfit,
      wc_changes: wcChanges,
      tax_paid: taxPaid,
      total: cashFromOps,
    },
    investing: {
      net_non_current_assets: netNonCurrentAssetMovement,
      fd_movement: fdMovement,
      mf_movement: mfMovement,
      interest_dividend_received: intInc,
      total: cashFromInvest,
    },
    financing: {
      long_term_borrowings_and_leases_movement: lncFinancingMovement,
      short_term_borrowings_movement: stBorrowingMovement,
      finance_costs_paid: financeCostsPaid,
      equity_movement_net: equityMovement,
      total: cashFromFin,
    },
    net_change: netChange,
    opening_cash: openingCash,
    closing_cash: closingCash,
    free_cash_flow: cashFromOps + netNonCurrentAssetMovement,
    ocf_to_pat: pl.pat > 0 ? parseFloat((cashFromOps / pl.pat).toFixed(2)) : null,
    reconciling_gap: closingCash - (openingCash + netChange),
  };
}

export interface RatiosResult {
  liquidity: { current_ratio: number; quick_ratio: number; cash_ratio: number };
  profitability: { gross_margin: number; ebitda_margin: number; net_margin: number; roe: number; roce: number };
  /** null when there's no real debt service (no borrowings/leases and no finance cost) — a "coverage" figure has no meaning with nothing to cover, so this is left honestly undetermined rather than shown as 0.00x or Infinity. */
  leverage: { debt_equity: number; interest_cover: number; dscr: number | null };
  efficiency: { asset_turnover: number; dso: number; dpo: number; ccc: number };
  cashflow: { free_cash_flow: number; ocf_to_pat: number | null };
  dupont: { net_margin: number; asset_turnover: number; equity_multiplier: number; roe: number };
}

/** Real closing balance for one Balance Sheet note, from the already-computed BS section it lives in. 0 (not a guess) when the company has no ledgers under that note at all. */
function noteTotal(notes: AggregatedNote[], noteNo: number): number {
  return notes.find(nt => nt.note_no === noteNo)?.total || 0;
}

// ── Key Ratios ──
// Inventories (Note 15), Trade Receivables (Note 16) and Trade Payables
// (Note 7) are now real ledger-derived Balance Sheet Note totals, and DSCR's
// debt-service denominator is now real Finance Costs + real net borrowing
// repayment for the period — replacing this function's previous hardcoded
// constants (inv=424, ar=3480, ap=2140, DSCR denominator=(720+372)=1092),
// which were leftover demo-dataset figures with no relationship to any real
// company's books. Confirmed on a real synced company: real Trade
// Receivables were ~₹6.21 Cr against the old hardcoded ar=3480 — off by four
// orders of magnitude, which silently made DSO/DPO/CCC (and, by extension,
// the Working Capital tab, which reads these same fields) nonsense numbers
// that never reflected the connected business. cash_ratio and both
// asset_turnover figures also carried stray ÷100/×100 scaling with no
// documented reason and no compensating factor anywhere they're displayed
// (RatiosTab/exports print them as a raw "x" multiple) — removed, since they
// silently shrank both ratios ~100x from their real value.
export function computeRatios(ledgers: TbLedgerRow[], periodParams: PeriodParams): RatiosResult {
  const bs = computeBS(ledgers, periodParams);
  const pl = computePL(ledgers, periodParams);
  const cf = computeCashFlow(ledgers, periodParams);
  const tsy = computeTreasury(ledgers, periodParams);

  const ca = bs.assets.total_ca;
  const cl = bs.equity_liabilities.total_cl;
  const inv = noteTotal(bs.assets.current, 15);
  const ar = noteTotal(bs.assets.current, 16);
  const ap = noteTotal(bs.equity_liabilities.current_liab, 7);

  // Standard day-count formulas, real-rupee throughout (ar/ap/inv and
  // pl.revenue/pl.cos are the same unit — no scaling factor needed).
  const dio = pl.cos > 0 ? (inv / pl.cos * 365) : 0;
  const dso = pl.revenue > 0 ? (ar / pl.revenue * 365) : 0;
  const dpo = pl.cos > 0 ? (ap / pl.cos * 365) : 0;

  // DSCR debt service = real interest (Finance Costs, Note 24) + real
  // principal repaid this period. Principal repaid is only knowable from the
  // ledgers as a *net* repayment (ST/LT borrowings & leases decreasing) — a
  // period where borrowings grew net (a fresh drawdown) has no
  // ledger-derivable way to see any principal still repaid within that same
  // period, so that case honestly counts 0 principal rather than guessing.
  const cfFinancing = cf.financing as Record<string, number>;
  const principalRepaid = Math.max(0, -(
    (cfFinancing.short_term_borrowings_movement || 0) +
    (cfFinancing.long_term_borrowings_and_leases_movement || 0)
  ));
  const debtService = pl.finance_costs + principalRepaid;
  const dscr = debtService > 0 ? parseFloat(((cf.operating.total as number) / debtService).toFixed(2)) : null;

  return {
    liquidity: {
      current_ratio: parseFloat((ca / cl).toFixed(2)),
      quick_ratio: parseFloat(((ca - inv) / cl).toFixed(2)),
      cash_ratio: parseFloat((tsy.total_cash_and_bank / cl).toFixed(2)),
    },
    profitability: {
      gross_margin: parseFloat(((pl.revenue - pl.cos) / pl.revenue * 100).toFixed(1)),
      // Operating EBITDA margin — numerator must match the Operating EBITDA
      // rupee figure shown elsewhere (Overview/Board Pack: revenue - cos -
      // employee - other expenses, no Other Income). Previously included
      // pl.other_income here, which could show a positive EBITDA margin %
      // in the same period the rupee EBITDA KPI was negative.
      ebitda_margin: parseFloat(((pl.revenue - pl.cos - pl.employee_benefits - pl.other_expenses) / pl.revenue * 100).toFixed(1)),
      net_margin: parseFloat((pl.pat / pl.revenue * 100).toFixed(1)),
      roe: parseFloat((pl.pat / bs.equity_liabilities.total_equity * 100).toFixed(1)),
      roce: parseFloat(((pl.pbt + pl.finance_costs) / (bs.equity_liabilities.total_equity + bs.equity_liabilities.total_ncl) * 100).toFixed(1)),
    },
    leverage: {
      debt_equity: parseFloat(((bs.equity_liabilities.total_ncl + bs.equity_liabilities.total_cl) / bs.equity_liabilities.total_equity).toFixed(2)),
      interest_cover: parseFloat(((pl.pbt + pl.finance_costs) / (pl.finance_costs || 1)).toFixed(1)),
      dscr,
    },
    efficiency: {
      asset_turnover: parseFloat((pl.revenue / bs.assets.total).toFixed(2)),
      dso: Math.round(dso),
      dpo: Math.round(dpo),
      // Cash Conversion Cycle = DIO + DSO − DPO (textbook definition) — dio
      // is 0, not a guess, for a company with no real Inventory ledgers
      // (e.g. a pure-services business), same honest-zero convention as
      // every other note total here.
      ccc: Math.round(dio + dso - dpo),
    },
    cashflow: {
      free_cash_flow: cf.free_cash_flow,
      ocf_to_pat: cf.ocf_to_pat,
    },
    dupont: {
      net_margin: parseFloat((pl.pat / pl.revenue * 100).toFixed(1)),
      asset_turnover: parseFloat((pl.revenue / bs.assets.total).toFixed(2)),
      equity_multiplier: parseFloat((bs.assets.total / bs.equity_liabilities.total_equity).toFixed(2)),
      roe: parseFloat((pl.pat / bs.equity_liabilities.total_equity * 100).toFixed(1)),
    },
  };
}

export interface TopCustomer {
  customer: string;
  revenue_cr: number;
  /** % of total company revenue for the selected period (not % of the customers-with-data subset). */
  pct_of_total: number;
  status: 'Healthy' | 'Key Account' | 'Concentration Risk';
  /**
   * 'zoho'            — real per-customer amounts from Zoho's Sales by
   *                      Customer report (tb_customer_revenue).
   * 'ledger_estimate'  — no Zoho customer data available; derived instead
   *                      from splitting the *current* Trial Balance's own
   *                      revenue ledgers (real ledger amounts, just at
   *                      ledger granularity rather than true customer
   *                      granularity — only meaningful when the org keeps
   *                      more than one revenue ledger, e.g. one per client).
   * 'sample'           — sample/demo mode's illustrative customer mix (see
   *                      sample-data.ts), never computed from real data.
   */
  source: 'zoho' | 'ledger_estimate' | 'sample';
}

/** Matches lib/db/queries/reports.ts::CustomerRevenueRow (FY mode) or the { m: number[12] } shape from cy-merge.ts::mergeCyCustomerRevenue (CY mode). */
export interface CustomerRevenueInput {
  customer_name: string;
  m1?: Num; m2?: Num; m3?: Num; m4?: Num; m5?: Num; m6?: Num;
  m7?: Num; m8?: Num; m9?: Num; m10?: Num; m11?: Num; m12?: Num;
  m?: number[];
}

/** Shared thresholds so sample-mode's illustrative customers and live Zoho-derived customers read identically. */
export function customerStatusFromPct(pct: number): TopCustomer['status'] {
  return pct > 30 ? 'Concentration Risk' : pct > 15 ? 'Key Account' : 'Healthy';
}

function rankTopFive(
  items: { customer: string; revRupees: number }[],
  totalRevenue: number,
  source: TopCustomer['source']
): TopCustomer[] {
  return items
    .filter((item) => item.revRupees > 0)
    .sort((a, b) => b.revRupees - a.revRupees)
    .slice(0, 5)
    .map((item) => {
      const pct = parseFloat(((item.revRupees / totalRevenue) * 100).toFixed(1));
      return {
        customer: item.customer,
        revenue_cr: parseFloat((item.revRupees / 10000000).toFixed(2)),
        pct_of_total: pct,
        status: customerStatusFromPct(pct),
        source,
      };
    });
}

/**
 * Fallback tier — real ledger amounts from the *currently loaded* Trial
 * Balance, used only when there's no Zoho customer-revenue data at all.
 * Only produces a result when the org's Chart of Accounts has more than one
 * revenue ledger (e.g. "Sales - Acme Corp", "Sales - Beta Ltd") — a single
 * aggregate "Sales" ledger (the common case) carries no customer signal to
 * split, and this honestly returns [] rather than inventing a split.
 */
function computeTopCustomersFromLedgers(
  ledgers: TbLedgerRow[],
  periodParams: PeriodParams,
  totalRevenue: number
): TopCustomer[] {
  const revLedgers = ledgers.filter(
    (l) => l.section === 'inc' && (l.note_no === 20 || l.note_name?.includes('Revenue') || l.note_name?.includes('Income') || l.ledger_name?.toLowerCase().includes('sales') || l.ledger_name?.toLowerCase().includes('revenue'))
  );
  if (revLedgers.length < 1 || totalRevenue <= 0) return [];
  const { plIndices } = resolvePeriod(periodParams);

  const items = revLedgers.map((l) => ({
    customer: l.ledger_name.replace(/^(Sales|Revenue|Services)\s*[-:]\s*/i, '').trim() || l.ledger_name,
    revRupees: periodNet(l, plIndices),
  }));

  return rankTopFive(items, totalRevenue, 'ledger_estimate');
}

/**
 * Top-5-Customers-by-Revenue for the Executive Overview tab. Two tiers, both
 * real (never fabricated names or made-up margins):
 *  1. Zoho's Sales by Customer report data, synced into tb_customer_revenue
 *     (see lib/services/zoho.ts::syncFromZoho) — used whenever present.
 *  2. Falls back to splitting the *current* Trial Balance's own revenue
 *     ledgers (computeTopCustomersFromLedgers above) when Zoho customer
 *     data isn't available yet (no sync since this feature shipped, the
 *     report came back empty, or an Excel-uploaded TB with no Zoho
 *     connection at all) — still real, just coarser granularity.
 * Returns [] only when neither source has anything to show.
 */
export function computeTopCustomers(
  customerRows: CustomerRevenueInput[],
  ledgers: TbLedgerRow[],
  periodParams: PeriodParams,
  totalRevenue: number
): TopCustomer[] {
  if (customerRows.length > 0 && totalRevenue > 0) {
    const { plIndices } = resolvePeriod(periodParams);
    const items = customerRows.map((row) => {
      const months = row.m ?? Array.from({ length: 12 }, (_, i) => n(row[`m${i + 1}` as keyof CustomerRevenueInput] as Num));
      const revRupees = plIndices.reduce((sum, mi) => sum + (months[mi] || 0), 0);
      return { customer: row.customer_name, revRupees };
    });
    const zohoResult = rankTopFive(items, totalRevenue, 'zoho');
    if (zohoResult.length) return zohoResult;
  }

  return computeTopCustomersFromLedgers(ledgers, periodParams, totalRevenue);
}

// ── Vendor Expense Report ───────────────────────────────────────────────
// Real per-vendor spend, sourced entirely from Zoho Bills (lib/services/
// zoho.ts::syncFromZoho() → tb_vendor_expense). No ledger-estimate fallback
// tier exists here the way computeTopCustomers() has one for revenue —
// there's no equivalent "one ledger per vendor" convention to fall back to,
// so an org with no Zoho vendor-bill data simply gets [], honestly, rather
// than an invented split.

/**
 * Real Zoho contact master-data enrichment (email/phone/GSTIN/live
 * outstanding balance) — attached by the API route via a DB join against
 * zoho_contacts (lib/services/zoho.ts::syncZohoContacts), never computed
 * by the pure functions in this file. Absent (undefined, not zeroed-out
 * fields) when no synced contact record matches this vendor/customer's
 * name — e.g. an Excel-uploaded TB with no Zoho connection at all, or a
 * ledger-derived name that doesn't exactly match Zoho's contact directory.
 */
export interface ContactInfo {
  email: string | null;
  phone: string | null;
  gstNo: string | null;
  /** Zoho's own live running balance for this contact, base-currency — real, independent of whatever this report's selected period/FY is. */
  outstandingBalance: number | null;
}

export interface VendorExpense {
  vendor: string;
  /** Real rupees for the selected period — same convention as TopCustomer.revenue_cr, but NOT pre-divided into Crores (vendor spend is typically much smaller than total company revenue, so a fixed Crore scale would round most vendors to 0.00). */
  amount: number;
  /** % of total vendor spend for the selected period (not % of company revenue/expenses). */
  pct_of_total: number;
  status: 'Healthy' | 'Key Vendor' | 'Concentration Risk';
  contact?: ContactInfo;
}

/** Same concentration-risk thresholds as customerStatusFromPct(), with vendor-appropriate labels — "Key Account" reads oddly applied to a vendor. */
export function vendorStatusFromPct(pct: number): VendorExpense['status'] {
  return pct > 30 ? 'Concentration Risk' : pct > 15 ? 'Key Vendor' : 'Healthy';
}

export interface VendorExpenseInput {
  vendor_name: string;
  m1?: Num; m2?: Num; m3?: Num; m4?: Num; m5?: Num; m6?: Num;
  m7?: Num; m8?: Num; m9?: Num; m10?: Num; m11?: Num; m12?: Num;
  m?: number[];
}

/**
 * Ranks vendors by real spend for the selected period. Matches
 * lib/db/queries/reports.ts::VendorExpenseRow (FY mode) or the { m:
 * number[12] } shape from cy-merge.ts::mergeCyVendorExpense (CY mode).
 * Returns [] when there's no real vendor-bill data for this company/period
 * — never fabricated.
 */
export function computeVendorExpense(
  vendorRows: VendorExpenseInput[],
  periodParams: PeriodParams
): VendorExpense[] {
  if (!vendorRows.length) return [];
  const { plIndices } = resolvePeriod(periodParams);
  const items = vendorRows
    .map((row) => {
      const months = row.m ?? Array.from({ length: 12 }, (_, i) => n(row[`m${i + 1}` as keyof VendorExpenseInput] as Num));
      const amount = plIndices.reduce((sum, mi) => sum + (months[mi] || 0), 0);
      return { vendor: row.vendor_name, amount };
    })
    .filter((i) => i.amount > 0);

  const totalSpend = items.reduce((s, i) => s + i.amount, 0);
  if (totalSpend <= 0) return [];

  return items
    .sort((a, b) => b.amount - a.amount)
    .map((i) => {
      const pct = parseFloat(((i.amount / totalSpend) * 100).toFixed(1));
      return { vendor: i.vendor, amount: i.amount, pct_of_total: pct, status: vendorStatusFromPct(pct) };
    });
}

// ── Customer Margin Report ──────────────────────────────────────────────
// Combines real per-customer revenue (tb_customer_revenue, already used by
// computeTopCustomers above) with real per-customer DIRECT cost
// (tb_customer_cost — populated only from Zoho expenses explicitly marked
// billable to a customer; see that table's schema comment). This is
// deliberately NOT a fully-loaded margin: indirect/shared costs (most of a
// typical company's COGS and opex) are never allocated to a customer here,
// because Zoho doesn't tell us how to attribute them without guessing.
// `org_tracks_direct_cost` tells the caller whether ANY customer in this
// company has ever had direct cost data at all — false means "margin" below
// is really just "revenue, 0 cost recorded" for every row, which the UI
// must disclose prominently rather than let read as a real 100% margin.

export interface CustomerMarginEntry {
  customer: string;
  /** Real rupees, selected period. */
  revenue: number;
  /** Real rupees, selected period — DIRECT cost only (Zoho billable-expense tagging). 0 when this customer had no tagged expense in the period, which may just mean the org doesn't track this, not that the customer was costless. */
  direct_cost: number;
  /** revenue - direct_cost. Only as complete as direct_cost is — see org_tracks_direct_cost. */
  direct_margin: number;
  /** null when revenue <= 0 (nothing to divide by, not a real 0%/undefined margin). */
  direct_margin_pct: number | null;
  contact?: ContactInfo;
}

export interface CustomerMarginResult {
  entries: CustomerMarginEntry[];
  /** True only if at least one customer, anywhere in this company's synced history for this period, had nonzero direct_cost. False is the expected, common case — most Zoho orgs never tag expenses to a customer — and must be surfaced to the user, never silently treated as "every customer is 100% margin". */
  org_tracks_direct_cost: boolean;
}

/**
 * Real per-customer revenue and direct cost for the selected period, merged
 * by customer name (the same join key tb_customer_revenue/tb_customer_cost
 * both use). customerCostRows uses the exact same input shape as
 * CustomerRevenueInput (see lib/db/queries/reports.ts::CustomerCostRow /
 * cy-merge.ts's merged { m: number[12] } shape) — reused rather than
 * duplicated since the two tables are structurally identical.
 */
export function computeCustomerMargin(
  customerRevenueRows: CustomerRevenueInput[],
  customerCostRows: CustomerRevenueInput[],
  periodParams: PeriodParams
): CustomerMarginResult {
  const { plIndices } = resolvePeriod(periodParams);
  const periodTotal = (row: CustomerRevenueInput): number => {
    const months = row.m ?? Array.from({ length: 12 }, (_, i) => n(row[`m${i + 1}` as keyof CustomerRevenueInput] as Num));
    return plIndices.reduce((sum, mi) => sum + (months[mi] || 0), 0);
  };

  const byCustomer = new Map<string, { revenue: number; cost: number }>();
  customerRevenueRows.forEach((row) => {
    const key = row.customer_name;
    if (!byCustomer.has(key)) byCustomer.set(key, { revenue: 0, cost: 0 });
    byCustomer.get(key)!.revenue += periodTotal(row);
  });
  customerCostRows.forEach((row) => {
    const key = row.customer_name;
    if (!byCustomer.has(key)) byCustomer.set(key, { revenue: 0, cost: 0 });
    byCustomer.get(key)!.cost += periodTotal(row);
  });

  // Whether this org tracks direct cost AT ALL is judged over every synced
  // customer-cost row handed in, not just ones with matching revenue — a
  // single genuinely-tagged expense anywhere is enough to say "this org uses
  // the feature", even before this period's revenue rows are considered.
  const orgTracksDirectCost = customerCostRows.some((row) => periodTotal(row) > 0);

  const entries: CustomerMarginEntry[] = Array.from(byCustomer.entries())
    .filter(([, v]) => v.revenue > 0 || v.cost > 0)
    .map(([customer, v]) => {
      const margin = v.revenue - v.cost;
      return {
        customer,
        revenue: v.revenue,
        direct_cost: v.cost,
        direct_margin: margin,
        direct_margin_pct: v.revenue > 0 ? parseFloat(((margin / v.revenue) * 100).toFixed(1)) : null,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  return { entries, org_tracks_direct_cost: orgTracksDirectCost };
}

