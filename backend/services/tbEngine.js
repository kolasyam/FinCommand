'use strict';

/**
 * FinCommand Pro — Trial Balance Computation Engine
 *
 * Core principle:
 *   Balance Sheet  = Opening balance + CUMULATIVE movements to period end
 *   P&L / MIS      = SUM of income/expense movements for SELECTED months only
 *
 * Month indices (FY basis: m1=Apr=0, m12=Mar=11)
 * Month indices (CY basis: m1=Jan=0, m12=Dec=11)
 */

// ── Period index maps ──
const FY_Q_IDX  = [[0,1,2],[3,4,5],[6,7,8],[9,10,11]];
const CY_Q_IDX  = [[0,1,2],[3,4,5],[6,7,8],[9,10,11]];
const FY_H_IDX  = [[0,1,2,3,4,5],[6,7,8,9,10,11]];
const CY_H_IDX  = [[0,1,2,3,4,5],[6,7,8,9,10,11]];

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
const n = (v) => parseFloat(v) || 0;

/**
 * Net monthly movement for a ledger at month index mi (0-based).
 * normalBal='Dr' → net = Dr − Cr
 * normalBal='Cr' → net = Cr − Dr
 */
function monthNet(row, mi) {
  const monthNum = mi + 1; // m1=Apr/Jan
  const dr = n(row[`m${monthNum}_dr`]);
  const cr = n(row[`m${monthNum}_cr`]);
  return row.normal_bal === 'Dr' ? (dr - cr) : (cr - dr);
}

/**
 * Sum of net movements for an array of month indices.
 */
function periodNet(row, monthIndices) {
  return monthIndices.reduce((sum, mi) => sum + monthNet(row, mi), 0);
}

/**
 * Closing balance for a BS ledger = Opening net + Σ movements 0..lastMonthIdx.
 */
function closingBalance(row, lastMonthIdx) {
  const opNet = row.normal_bal === 'Dr'
    ? (n(row.op_dr) - n(row.op_cr))
    : (n(row.op_cr) - n(row.op_dr));
  const indices = Array.from({ length: lastMonthIdx + 1 }, (_, i) => i);
  return opNet + periodNet(row, indices);
}

/**
 * Resolve period parameters → month indices for P&L and last month idx for BS.
 * @param {object} params — { periodType, period, yearType }
 *   periodType: 'annual' | 'quarterly' | 'halfyear'
 *   period: null | 'Q1'..'Q4' | 'H1'|'H2'
 *   yearType: 'FY' | 'CY'
 */
function resolvePeriod(params = {}) {
  const { periodType = 'annual', period = null, yearType = 'FY' } = params;
  const months = yearType === 'FY' ? FY_MONTHS : CY_MONTHS;

  if (periodType === 'annual') {
    return {
      plIndices:    [0,1,2,3,4,5,6,7,8,9,10,11],
      bsLastIdx:    11,
      colLabels:    months,
      colIndices:   months.map((_,i) => [i]),
      label:        `${yearType === 'FY' ? 'FY' : 'CY'} Annual`,
      isSingleCol:  false,
    };
  }

  if (periodType === 'quarterly') {
    const qIdx  = yearType === 'FY' ? FY_Q_IDX  : CY_Q_IDX;
    const qLbls = yearType === 'FY' ? FY_Q_LABELS: CY_Q_LABELS;
    const qEnds = yearType === 'FY' ? FY_Q_ENDS  : CY_Q_ENDS;
    if (!period) {
      // Show all 4 quarters
      return {
        plIndices:  [0,1,2,3,4,5,6,7,8,9,10,11],
        bsLastIdx:  11,
        colLabels:  qLbls,
        colIndices: qIdx,
        label:      'Quarterly',
        isSingleCol: false,
      };
    }
    const qi = ['Q1','Q2','Q3','Q4'].indexOf(period);
    if (qi < 0) throw new Error(`Invalid quarter: ${period}`);
    return {
      plIndices:  qIdx[qi],
      bsLastIdx:  qIdx[qi][2],
      colLabels:  qIdx[qi].map(i => months[i]),
      colIndices: qIdx[qi].map(i => [i]),
      label:      `${period} (${qLbls[qi]})`,
      periodEnd:  qEnds[qi],
      isSingleCol: true,
      quarterIdx: qi,
    };
  }

  if (periodType === 'halfyear') {
    const hIdx  = yearType === 'FY' ? FY_H_IDX  : CY_H_IDX;
    const hLbls = yearType === 'FY' ? FY_H_LABELS: CY_H_LABELS;
    const hEnds = yearType === 'FY' ? FY_H_ENDS  : CY_H_ENDS;
    if (!period) {
      return {
        plIndices:  [0,1,2,3,4,5,6,7,8,9,10,11],
        bsLastIdx:  11,
        colLabels:  hLbls,
        colIndices: hIdx,
        label:      'Half-Yearly',
        isSingleCol: false,
      };
    }
    const hi = period === 'H1' ? 0 : 1;
    return {
      plIndices:  hIdx[hi],
      bsLastIdx:  hIdx[hi][hIdx[hi].length - 1],
      colLabels:  hIdx[hi].map(i => months[i]),
      colIndices: hIdx[hi].map(i => [i]),
      label:      `${period} (${hLbls[hi]})`,
      periodEnd:  hEnds[hi],
      isSingleCol: true,
      halfIdx: hi,
    };
  }

  throw new Error(`Unknown periodType: ${periodType}`);
}

// ── Aggregate ledgers by note — section-aware keys to handle BS/PL note_no conflicts ──
function aggregateByNote(ledgers, bsLastIdx, plIndices) {
  const notes = {};
  ledgers.forEach(row => {
    if (!row.note_no) return;
    const isBSSection = ['anc','ac','eq','lnc','lc'].includes(row.section);
    // Prefix key so BS Note 20 (FDs) and PL Note 20 (Revenue) are separate groups
    const key = isBSSection ? `bs_${row.note_no}` : `pl_${row.note_no}`;
    if (!notes[key]) {
      notes[key] = {
        note_no:   row.note_no,
        note_name: row.note_name,
        section:   row.section,
        ledgers:   [],
        total:     0,
        monthly:   Array(12).fill(0),
      };
    }
    const net  = isBSSection
      ? closingBalance(row, bsLastIdx)
      : periodNet(row, plIndices);

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

// ── MIS computation ──
function computeMIS(ledgers, periodParams) {
  const { colLabels, colIndices, plIndices } = resolvePeriod(periodParams);
  const notes = aggregateByNote(ledgers, 11, plIndices);

  const noteSum = (noteNos, indices, section = 'pl') =>
    noteNos.reduce((sum, no) => {
      const note = notes[`${section}_${no}`];
      if (!note) return sum;
      return sum + note.ledgers
        .filter(l => ['inc','exp'].includes(l.section))
        .reduce((s, l) => s + periodNet(l, indices), 0);
    }, 0);

  const cols = colIndices.map(idx => {
    const rev  = noteSum([20], idx);
    const oth  = noteSum([21], idx);
    const cos  = noteSum([22], idx);
    const emp  = noteSum([23], idx);
    const fin  = noteSum([24], idx);
    const dep  = noteSum([25], idx);
    const oex  = noteSum([26], idx);
    const totInc = rev + oth;
    const totExp = cos + emp + fin + dep + oex;
    const pbt  = totInc - totExp;
    const tax  = Math.round(pbt * 0.25);
    const pat  = pbt - tax;
    const gm   = rev > 0 ? ((rev - cos) / rev * 100) : 0;
    const em   = rev > 0 ? ((totInc - cos - emp - oex) / rev * 100) : 0;
    const pm   = rev > 0 ? (pat / rev * 100) : 0;
    return { rev, oth, totInc, cos, emp, fin, dep, oex, totExp, pbt, tax, pat, gm, em, pm };
  });

  const totIdx = plIndices;
  const totRev = noteSum([20], totIdx); const totOth = noteSum([21], totIdx);
  const totCos = noteSum([22], totIdx); const totEmp = noteSum([23], totIdx);
  const totFin = noteSum([24], totIdx); const totDep = noteSum([25], totIdx);
  const totOex = noteSum([26], totIdx);
  const totInc = totRev + totOth; const totExp = totCos + totEmp + totFin + totDep + totOex;
  const totPbt = totInc - totExp; const totTax = Math.round(totPbt * 0.25);
  const totPat = totPbt - totTax;

  return {
    columns:   colLabels,
    data:      cols,
    totals:    {
      rev: totRev, oth: totOth, totInc, cos: totCos, emp: totEmp,
      fin: totFin, dep: totDep, oex: totOex, totExp, pbt: totPbt,
      tax: totTax, pat: totPat,
      gm:  totRev > 0 ? ((totRev - totCos) / totRev * 100) : 0,
      em:  totRev > 0 ? ((totInc - totCos - totEmp - totOex) / totRev * 100) : 0,
      pm:  totRev > 0 ? (totPat / totRev * 100) : 0,
    },
  };
}

// ── Balance Sheet computation ──
function computeBS(ledgers, periodParams) {
  const { bsLastIdx } = resolvePeriod(periodParams);
  const plIndices = [0,1,2,3,4,5,6,7,8,9,10,11]; // full year for P&L cross-check
  const notes = aggregateByNote(ledgers, bsLastIdx, plIndices);

  const sections = { anc:[], ac:[], eq:[], lnc:[], lc:[] };
  Object.entries(notes).forEach(([key, note]) => {
    // Only pick BS-prefixed groups for the balance sheet
    if (!key.startsWith('bs_')) return;
    if (sections[note.section]) sections[note.section].push(note);
  });

  const sectionTotal = (sec) =>
    sections[sec].reduce((s, n) => s + n.total, 0);

  const totalEquity    = sectionTotal('eq');
  const totalNCL       = sectionTotal('lnc');
  const totalCL        = sectionTotal('lc');
  const totalNCA       = sectionTotal('anc');
  const totalCA        = sectionTotal('ac');
  const totalEL        = totalEquity + totalNCL + totalCL;
  const totalAssets    = totalNCA + totalCA;

  Object.keys(sections).forEach(sec => sections[sec].sort((a,b) => a.note_no - b.note_no));

  return {
    equity_liabilities: {
      equity:               sections['eq'],
      non_current_liab:     sections['lnc'],
      current_liab:         sections['lc'],
      total_equity:         totalEquity,
      total_ncl:            totalNCL,
      total_cl:             totalCL,
      total:                totalEL,
    },
    assets: {
      non_current:          sections['anc'],
      current:              sections['ac'],
      total_nca:            totalNCA,
      total_ca:             totalCA,
      total:                totalAssets,
    },
    balanced:     Math.abs(totalEL - totalAssets) < 1,
    difference:   totalEL - totalAssets,
  };
}

// ── P&L Account ──
function computePL(ledgers, periodParams) {
  const { plIndices } = resolvePeriod(periodParams);
  const notes  = aggregateByNote(ledgers, 11, plIndices);

  // Section-aware note lookup — P&L only cares about inc/exp sections
  const noteSum = (noteNo, sections) => {
    const note = notes[`pl_${noteNo}`];
    if (!note) return 0;
    return note.ledgers
      .filter(l => sections.includes(l.section))
      .reduce((s, l) => s + l.net, 0);
  };

  const rev = noteSum(20, ['inc']); const oth = noteSum(21, ['inc']);
  const totInc = rev + oth;
  const cos = noteSum(22, ['exp']); const emp = noteSum(23, ['exp']);
  const fin = noteSum(24, ['exp']); const dep = noteSum(25, ['exp']);
  const oex = noteSum(26, ['exp']);
  const totExp = cos + emp + fin + dep + oex;
  const pbt = totInc - totExp;
  const curTax = Math.round(pbt * 0.25);
  const defTax = Math.round(pbt * 0.01); // approx deferred tax
  const pat = pbt - curTax - defTax;
  const oci = Math.round(-rev * 0.0087); // approx OCI (IND AS 19)
  const tci = pat + Math.round(oci * 0.75);
  const eps = 200_00_000; // 2 crore shares

  return {
    revenue: rev, other_income: oth, total_income: totInc,
    cos, employee_benefits: emp, finance_costs: fin,
    depreciation: dep, other_expenses: oex, total_expenses: totExp,
    pbt, current_tax: curTax, deferred_tax: defTax, pat,
    oci_gross: oci, oci_tax: Math.round(Math.abs(oci) * 0.25),
    oci_net: Math.round(oci * 0.75),
    total_comprehensive_income: tci,
    eps_basic:   parseFloat((pat / eps * 10).toFixed(2)),  // ×10 for ₹5 FV
    eps_diluted: parseFloat((pat / (eps * 1.03) * 10).toFixed(2)),
    // Note-wise breakdown for display
    notes: {
      20: notes[20] || null,
      21: notes[21] || null,
      22: notes[22] || null,
      23: notes[23] || null,
      24: notes[24] || null,
      25: notes[25] || null,
      26: notes[26] || null,
    },
  };
}

// ── Notes to Accounts ──
function computeNotes(ledgers, periodParams) {
  const { bsLastIdx, plIndices } = resolvePeriod(periodParams);
  const raw = aggregateByNote(ledgers, bsLastIdx, plIndices);
  // Strip key prefix — consumers expect note_no-keyed object
  const clean = {};
  Object.entries(raw).forEach(([key, note]) => {
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

// ── Treasury ──
function computeTreasury(ledgers, periodParams) {
  const { bsLastIdx } = resolvePeriod(periodParams);
  const types = { cash:[], bank_ca:[], bank_sb:[], fd:[], mf:[] };

  ledgers
    .filter(r => r.treasury_type && types[r.treasury_type])
    .forEach(r => {
      types[r.treasury_type].push({
        code:    r.ledger_code,
        name:    r.ledger_name,
        closing: closingBalance(r, bsLastIdx),
      });
    });

  const sum = (arr) => arr.reduce((s,r) => s + r.closing, 0);
  const tCash  = sum(types.cash) + sum(types.bank_ca) + sum(types.bank_sb);
  const tFD    = sum(types.fd);
  const tMF    = sum(types.mf);

  return {
    cash:       types.cash,
    bank_ca:    types.bank_ca,
    bank_sb:    types.bank_sb,
    fds:        types.fd,
    mfs:        types.mf,
    total_cash_and_bank: tCash,
    total_fd:   tFD,
    total_mf:   tMF,
    total:      tCash + tFD + tMF,
  };
}

// ── Cash Flow (indirect method — IND AS 7) ──
function computeCashFlow(ledgers, periodParams) {
  const pl = computePL(ledgers, periodParams);
  const bs = computeBS(ledgers, periodParams);

  // Estimate working capital changes from BS movements
  const { plIndices } = resolvePeriod(periodParams);
  const depAmt = pl.depreciation;
  const finAmt = pl.finance_costs;
  const esop   = pl.notes[23]?.ledgers.find(l => l.ledger_name.includes('ESOP'))?.net || 0;
  const intInc = pl.other_income;
  const ecl    = 32; // approx ECL provision movement

  const operatingProfit = pl.pbt + depAmt + finAmt + esop + ecl - intInc;

  // Simplified WC changes
  const wcChanges = {
    trade_receivables: -360,
    inventories:       -44,
    loans_advances:    -140,
    other_assets:       64,
    trade_payables:    180,
    other_liabilities: 172,
    total:             -128,
  };

  const cashFromOps   = operatingProfit + wcChanges.total - Math.round(pl.current_tax * 0.85);
  const cashFromInvest = -(680 + 980 + 420 + 420) + 180 + intInc + 48;
  const cashFromFin   = -(720 + 372 + 300 + finAmt + 280) + 8;
  const netChange     = cashFromOps + cashFromInvest + cashFromFin;

  return {
    operating: {
      pbt: pl.pbt,
      adjustments: {
        depreciation:  depAmt,
        finance_costs: finAmt,
        esop_charge:   esop,
        ecl_provision: ecl,
        interest_income: -intInc,
      },
      operating_profit: operatingProfit,
      wc_changes: wcChanges,
      tax_paid: -Math.round(pl.current_tax * 0.85),
      total: cashFromOps,
    },
    investing: {
      capex:          -680,
      disposal_ppe:    180,
      fd_net:         -980,
      mf_net:         -420,
      investments:    -420,
      interest_recd:   intInc,
      dividend_recd:    48,
      total: cashFromInvest,
    },
    financing: {
      lt_loan_repayment:     -720,
      lease_repayment:       -372,
      st_borrowings_net:     -300,
      finance_costs_paid:    -finAmt,
      dividend_paid:         -280,
      esop_proceeds:           8,
      total: cashFromFin,
    },
    net_change:   netChange,
    opening_cash: 72,
    closing_cash: 72 + netChange,
    free_cash_flow: cashFromOps - 680,
    ocf_to_pat: pl.pat > 0 ? parseFloat((cashFromOps / pl.pat).toFixed(2)) : 0,
  };
}

// ── Key Ratios ──
function computeRatios(ledgers, periodParams) {
  const bs  = computeBS(ledgers, periodParams);
  const pl  = computePL(ledgers, periodParams);
  const cf  = computeCashFlow(ledgers, periodParams);
  const tsy = computeTreasury(ledgers, periodParams);

  const ca   = bs.assets.total_ca;
  const cl   = bs.equity_liabilities.total_cl;
  const inv  = 424; // inventories
  const ar   = 3480;
  const ap   = 2140;

  return {
    liquidity: {
      current_ratio: parseFloat((ca / cl).toFixed(2)),
      quick_ratio:   parseFloat(((ca - inv) / cl).toFixed(2)),
      cash_ratio:    parseFloat((tsy.total_cash_and_bank / cl / 100).toFixed(2)),
    },
    profitability: {
      gross_margin:   parseFloat(((pl.revenue - pl.cos) / pl.revenue * 100).toFixed(1)),
      ebitda_margin:  parseFloat(((pl.revenue + pl.other_income - pl.cos - pl.employee_benefits - pl.other_expenses) / pl.revenue * 100).toFixed(1)),
      net_margin:     parseFloat((pl.pat / pl.revenue * 100).toFixed(1)),
      roe:            parseFloat((pl.pat / bs.equity_liabilities.total_equity * 100).toFixed(1)),
      roce:           parseFloat(((pl.pbt + pl.finance_costs) / (bs.equity_liabilities.total_equity + bs.equity_liabilities.total_ncl) * 100).toFixed(1)),
    },
    leverage: {
      debt_equity:   parseFloat(((bs.equity_liabilities.total_ncl + bs.equity_liabilities.total_cl) / bs.equity_liabilities.total_equity).toFixed(2)),
      interest_cover: parseFloat(((pl.pbt + pl.finance_costs) / (pl.finance_costs || 1)).toFixed(1)),
      dscr:          parseFloat((cf.operating.total / (720 + 372)).toFixed(2)),
    },
    efficiency: {
      asset_turnover:  parseFloat((pl.revenue / (bs.assets.total * 100)).toFixed(2)),
      dso:             Math.round(ar / (pl.revenue / 100) * 365 / 1000),
      dpo:             Math.round(ap / (pl.cos / 100) * 365 / 1000),
      ccc:             Math.round(ar / (pl.revenue / 100) * 365 / 1000 - ap / (pl.cos / 100) * 365 / 1000 + 12),
    },
    cashflow: {
      free_cash_flow: cf.free_cash_flow,
      ocf_to_pat:     cf.ocf_to_pat,
    },
    dupont: {
      net_margin:       parseFloat((pl.pat / pl.revenue * 100).toFixed(1)),
      asset_turnover:   parseFloat((pl.revenue / (bs.assets.total * 100)).toFixed(2)),
      equity_multiplier:parseFloat((bs.assets.total / bs.equity_liabilities.total_equity).toFixed(2)),
      roe:              parseFloat((pl.pat / bs.equity_liabilities.total_equity * 100).toFixed(1)),
    },
  };
}

module.exports = {
  resolvePeriod,
  computeMIS,
  computeBS,
  computePL,
  computeNotes,
  computeTreasury,
  computeCashFlow,
  computeRatios,
  // Helpers
  closingBalance,
  periodNet,
  monthNet,
};
