'use client';

import { useState } from 'react';
import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { DownloadBar } from '../DownloadBar';
import { fn, frRaw, pct, numTone, getFyLabel, getFyShortLabel, getUnitHeader, type DisplayUnit } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { ThreeYearBanner, ThreeYearHeader, ThreeYearRow } from '../ThreeYearFrame';

interface PlRowProps {
  label: string;
  noteNo?: number;
  currVal?: number | string | null;
  prevVal?: number | string | null;
  compare: boolean;
  bold?: boolean;
  grand?: boolean;
  indentClass?: string;
  secRow?: boolean;
  isEps?: boolean;
  /** Apply red/green tone to this row's own value cells (not just the YoY change column) — for profit subtotals (PBT, PAT, Total Comprehensive Income) where the sign is meaningful, not plain revenue/expense line items. */
  tone?: boolean;
  unit: DisplayUnit;
}

function PlRow({
  label,
  noteNo,
  currVal,
  prevVal,
  compare,
  bold,
  grand,
  indentClass = 'ind1',
  secRow,
  isEps,
  tone,
  unit,
}: PlRowProps) {
  const { navigateToNote } = useDashboard();
  const colSpan = compare ? 5 : 3;
  if (secRow) {
    return <tr className="sec-row"><td colSpan={colSpan}>{label}</td></tr>;
  }

  // Every note this component ever renders is a P&L note (income/expense
  // sections only), so its identity in Notes to Accounts' combined BS+P&L
  // list is always the `pl_` prefix — see BalanceSheetTab.tsx's matching
  // `bs_` comment for why that prefix matters (note_no collisions like
  // Note 20 = Revenue here vs. Bank Balances/FDs on the Balance Sheet).
  const noteRef = noteNo ? (
    <button
      type="button"
      className="nref nref-link"
      onClick={() => navigateToNote(`pl_${noteNo}`)}
      title={`Go to Note ${noteNo} in Notes to Accounts`}
    >
      {noteNo}
    </button>
  ) : null;

  const cNum = typeof currVal === 'number' ? currVal : null;
  const pNum = typeof prevVal === 'number' ? prevVal : null;
  // `currVal === null` (the field itself, before the typeof-narrowing above)
  // means computePL() couldn't determine this figure at all (OCI, EPS) — a
  // genuinely different case from a real, computed 0.00, and must read as
  // "n/a", never as "—" (which this app's formatters use for negligible/
  // zero and would misleadingly suggest a real, near-zero result).
  const cNotDerivable = currVal === null;
  const pNotDerivable = compare && prevVal === null;

  // EPS is a ₹-per-share figure, not a table amount — the Lakhs/Thousands/
  // Crores selector has no meaning for it, so it always goes through
  // frRaw() (no conversion) regardless of the selected table unit, same
  // accounting-parentheses formatting as everything else.
  const cDisplay = cNotDerivable ? 'n/a' : (isEps ? frRaw(cNum) : fn(cNum, 2, unit));
  const pDisplay = pNotDerivable ? 'n/a' : (isEps ? frRaw(pNum) : fn(pNum, 2, unit));
  const cTone = tone && !cNotDerivable ? numTone(cNum) : '';
  const pTone = tone && !pNotDerivable ? numTone(pNum) : '';

  const chg = cNum != null && pNum != null ? cNum - pNum : null;
  const chgDisplay = isEps ? frRaw(chg) : fn(chg, 2, unit);
  const rowClass = grand ? 'grand-row' : (bold ? 'tot-row' : '');
  const textClass = bold || grand ? 'bold' : '';

  if (!compare) {
    return (
      <tr className={rowClass}>
        <td className={`${indentClass} ${textClass}`}>{label}</td>
        <td>{noteRef}</td>
        <td className={`num ${textClass} ${cTone}`}>{cDisplay}</td>
      </tr>
    );
  }

  return (
    <tr className={rowClass}>
      <td className={`${indentClass} ${textClass}`}>{label}</td>
      <td>{noteRef}</td>
      <td className={`num ${textClass} ${cTone}`}>{cDisplay}</td>
      <td className={`num ${textClass} ${pTone}`} style={!pTone ? { color: 'var(--text2)' } : undefined}>{pDisplay}</td>
      <td className={`num ${textClass} ${chg != null ? numTone(chg) : ''}`}>
        {/* chgDisplay can itself round to '—' (a tiny float residual still satisfies chg > 0) — guard against '+—' the same way formatChg() does. */}
        {chg != null ? (chgDisplay === '—' ? '—' : (chg > 0 ? `+${chgDisplay}` : chgDisplay)) : (cNotDerivable || pNotDerivable ? 'n/a' : '—')}
      </td>
    </tr>
  );
}

export function PLTab() {
  const { bundle, threeYear, granularity, yearType, displayUnit, presentationCurrency } = useDashboard();
  const [showComparison, setShowComparison] = useState(true);
  const unitLabel = getUnitHeader(displayUnit, presentationCurrency);
  const symbol = getCurrencyMeta(presentationCurrency).symbol;

  // ── 3-Year mode ────────────────────────────────────────────────────────────
  if (granularity === '3year' && threeYear) {
    const { years } = threeYear;
    const v = (n: number | undefined | null) => n != null ? fn(n, 2, displayUnit) : null;

    const rows: {
      label: string;
      get: (y: typeof years[0]) => number | undefined | null;
      bold?: boolean; grand?: boolean; indent?: boolean; sec?: boolean; tone?: boolean;
    }[] = [
      { label: 'I. INCOME',                               get: () => null, sec: true },
      { label: 'Revenue from Operations',                 get: y => y.pl?.revenue, indent: true },
      { label: 'Other Income',                            get: y => y.pl?.other_income, indent: true },
      { label: 'Total Income (I)',                        get: y => y.pl?.total_income, bold: true },
      { label: 'II. EXPENSES',                            get: () => null, sec: true },
      { label: 'Cost of Services / Materials Consumed',   get: y => y.pl?.cos, indent: true },
      { label: 'Employee Benefits Expense',               get: y => y.pl?.employee_benefits, indent: true },
      { label: 'Finance Costs',                           get: y => y.pl?.finance_costs, indent: true },
      { label: 'Depreciation & Amortisation',             get: y => y.pl?.depreciation, indent: true },
      { label: 'Other Expenses',                          get: y => y.pl?.other_expenses, indent: true },
      { label: 'Total Expenses (II)',                     get: y => y.pl?.total_expenses, bold: true },
      { label: 'III. PROFIT',                             get: () => null, sec: true },
      { label: 'Profit Before Tax (I - II)',              get: y => y.pl?.pbt, bold: true, tone: true },
      { label: 'Current Tax (25%, estimated)',            get: y => y.pl?.current_tax, indent: true },
      { label: 'Profit After Tax (PAT)',                  get: y => y.pl?.pat, grand: true, tone: true },
    ];
    // Other Comprehensive Income and EPS (IND AS 1/33) are omitted from
    // this 3-year summary — computePL() leaves them `null` (not derivable
    // from a Trial Balance, see its own doc comment), so a row here would
    // always render blank across every year, adding clutter with no signal.

    return (
      <div>
        <ThreeYearBanner years={years} />
        <div className="card">
          <div className="card-hdr">
            <span className="ct">Statement of Profit &amp; Loss — 3-Year Comparison <span className="cbadge cb-blue">IND AS · Annual</span></span>
            <span className="cbadge cb-blue">{unitLabel}</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="fc-table">
              <ThreeYearHeader years={years} />
              <tbody>
                {rows.map(r => r.sec ? (
                  <tr key={r.label} className="sec-row"><td colSpan={years.length + Math.max(0, 3 - years.length) + 1}>{r.label}</td></tr>
                ) : (
                  <ThreeYearRow
                    key={r.label}
                    label={r.label}
                    years={years}
                    values={years.map(y => y.no_data ? null : v(r.get(y)))}
                    tones={r.tone ? years.map(y => { const val = r.get(y); return y.no_data || val == null ? '' : numTone(val); }) : undefined}
                    bold={r.bold}
                    grand={r.grand}
                    indent={r.indent}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {threeYear.cagr && (
          <div className="info-bar" style={{ marginTop: 12 }}>
            CAGR: Revenue {threeYear.cagr.revenue != null ? pct(threeYear.cagr.revenue) : 'n/a'} · PAT {threeYear.cagr.pat != null ? pct(threeYear.cagr.pat) : 'n/a'}
          </div>
        )}
      </div>
    );
  }

  // ── Single-year mode ───────────────────────────────────────────────────────
  if (!bundle) return null;
  const {
    pl,
    prev_pl: prevPl,
    financial_year,
    prev_financial_year: prevFy,
    period_label,
  } = bundle;

  const fyLabel = getFyLabel(financial_year, yearType);
  const fyShort = getFyShortLabel(financial_year, yearType);
  const prevFyLabel = getFyLabel(prevFy, yearType);
  const prevFyShort = getFyShortLabel(prevFy, yearType);

  const hasPrev = !!(prevPl && prevFy);
  const compare = hasPrev && showComparison;
  const colSpan = compare ? 5 : 3;

  return (
    <div>
      <DownloadBar title={`Statement of Profit & Loss · ${fyLabel}`} subtitle={`Schedule III · IND AS · ${unitLabel} · ${period_label}`} section="pl" compareEnabled={showComparison} />
      <div className="card">
        <div className="card-hdr" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <span className="ct">Statement of Profit &amp; Loss <span className="cbadge cb-blue">Schedule III — IND AS</span></span>
            <span style={{ fontSize: 10, color: 'var(--text2)', marginLeft: 8 }}>{fyLabel} · {period_label}</span>
          </div>

          {hasPrev ? (
            <label style={{ fontSize: 12, color: 'var(--text2)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={showComparison}
                onChange={e => setShowComparison(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              Compare with {prevFyShort}
            </label>
          ) : (
            <span style={{ fontSize: 11, color: 'var(--text2)', fontStyle: 'italic' }}>
              Showing {fyShort} only (Prior year data not available)
            </span>
          )}
        </div>

        {!hasPrev && (
          <div className="info-bar mb-3" style={{ background: 'var(--blue-l, #eff6ff)', border: '1px solid var(--blue-border, #bfdbfe)', color: 'var(--blue-d, #1e40af)', margin: '10px 16px 0 16px', borderRadius: 6, padding: '8px 12px', fontSize: 12 }}>
            ℹ Previous year data is not available. Displaying <strong>{fyLabel}</strong> P&amp;L Statement only. Upload previous year Trial Balance to enable 2-Year prior year comparison.
          </div>
        )}

        <div style={{ overflowX: 'auto' }}>
          <table className="fc-table">
            <thead>
              <tr>
                <th style={{ width: compare ? '40%' : '60%' }}>Particulars</th>
                <th>Note</th>
                <th className="num">{fyShort} ({unitLabel})</th>
                {compare && <th className="num" style={{ color: 'var(--text2)' }}>{prevFyShort} ({unitLabel})</th>}
                {compare && <th className="num">YoY Change ({unitLabel})</th>}
              </tr>
            </thead>
            <tbody>
              {/* I. INCOME */}
              <PlRow label="I. INCOME" compare={compare} secRow unit={displayUnit} />
              <PlRow label="Revenue from Operations" noteNo={20} currVal={pl.revenue} prevVal={prevPl?.revenue} compare={compare} unit={displayUnit} />
              <PlRow label="Other Income" noteNo={21} currVal={pl.other_income} prevVal={prevPl?.other_income} compare={compare} unit={displayUnit} />
              <PlRow label="Total Income (I)" currVal={pl.total_income} prevVal={prevPl?.total_income} compare={compare} bold unit={displayUnit} />

              {/* II. EXPENSES */}
              <tr className="blk-sep"><td colSpan={colSpan} /></tr>
              <PlRow label="II. EXPENSES" compare={compare} secRow unit={displayUnit} />
              <PlRow label="Cost of Services / Materials Consumed" noteNo={22} currVal={pl.cos} prevVal={prevPl?.cos} compare={compare} unit={displayUnit} />
              <PlRow label="Employee Benefits Expense" noteNo={23} currVal={pl.employee_benefits} prevVal={prevPl?.employee_benefits} compare={compare} unit={displayUnit} />
              <PlRow label="Finance Costs" noteNo={24} currVal={pl.finance_costs} prevVal={prevPl?.finance_costs} compare={compare} unit={displayUnit} />
              <PlRow label="Depreciation &amp; Amortisation" noteNo={25} currVal={pl.depreciation} prevVal={prevPl?.depreciation} compare={compare} unit={displayUnit} />
              <PlRow label="Other Expenses" noteNo={26} currVal={pl.other_expenses} prevVal={prevPl?.other_expenses} compare={compare} unit={displayUnit} />
              <PlRow label="Total Expenses (II)" currVal={pl.total_expenses} prevVal={prevPl?.total_expenses} compare={compare} bold unit={displayUnit} />

              {/* III. PROFIT */}
              <tr className="blk-sep"><td colSpan={colSpan} /></tr>
              <PlRow label="III. PROFIT" compare={compare} secRow unit={displayUnit} />
              <PlRow label="Profit Before Tax (I - II)" currVal={pl.pbt} prevVal={prevPl?.pbt} compare={compare} bold tone unit={displayUnit} />
              <PlRow label="Current Tax (25%, estimated)" currVal={pl.current_tax} prevVal={prevPl?.current_tax} compare={compare} unit={displayUnit} />
              <PlRow label="Deferred Tax Charge / (Credit) (1%, estimated)" currVal={pl.deferred_tax} prevVal={prevPl?.deferred_tax} compare={compare} unit={displayUnit} />
              <PlRow label="Profit After Tax (PAT)" currVal={pl.pat} prevVal={prevPl?.pat} compare={compare} grand tone unit={displayUnit} />

              {/* IV. OTHER COMPREHENSIVE INCOME (IND AS 1) */}
              <tr className="blk-sep"><td colSpan={colSpan} /></tr>
              <PlRow label="IV. OTHER COMPREHENSIVE INCOME (IND AS 1)" compare={compare} secRow unit={displayUnit} />
              <PlRow label="Remeasurement of Defined Benefit Obligation (IND AS 19)" currVal={pl.oci_gross} prevVal={prevPl?.oci_gross} compare={compare} unit={displayUnit} />
              <PlRow label="Income Tax on OCI" currVal={pl.oci_tax} prevVal={prevPl?.oci_tax} compare={compare} unit={displayUnit} />
              <PlRow label="Other Comprehensive Income (Net of Tax)" currVal={pl.oci_net} prevVal={prevPl?.oci_net} compare={compare} bold tone unit={displayUnit} />
              <PlRow label="Total Comprehensive Income" currVal={pl.total_comprehensive_income} prevVal={prevPl?.total_comprehensive_income} compare={compare} grand tone unit={displayUnit} />

              {/* V. EARNINGS PER SHARE (IND AS 33) */}
              <tr className="blk-sep"><td colSpan={colSpan} /></tr>
              <PlRow label="V. EARNINGS PER SHARE (IND AS 33)" compare={compare} secRow unit={displayUnit} />
              <PlRow label={`Basic EPS (${symbol})`} currVal={pl.eps_basic} prevVal={prevPl?.eps_basic} compare={compare} isEps tone unit={displayUnit} />
              <PlRow label={`Diluted EPS (${symbol})`} currVal={pl.eps_diluted} prevVal={prevPl?.eps_diluted} compare={compare} isEps tone unit={displayUnit} />
            </tbody>
          </table>
        </div>
      </div>
      <div className="info-bar" style={{ marginTop: 10, fontSize: 11 }}>
        Every line above Section IV is computed directly from real Trial Balance ledger movements — no assumed percentages, except <strong>Current Tax</strong> and <strong>Deferred Tax</strong>, modeled at a flat rate on a profitable period since this Trial Balance carries no dedicated tax-provision ledger to derive real figures from — and nil in a loss-making period (PBT ≤ 0), per IND AS 12, since no company owes current tax on a loss. <strong>Other Comprehensive Income</strong> and <strong>EPS</strong> are marked <strong>n/a</strong> rather than estimated: OCI (IND AS 19 remeasurement of a defined benefit obligation) requires an actuarial valuation a Trial Balance doesn&apos;t carry, and EPS requires the company&apos;s real face value per share and shares outstanding from its Register of Members — neither is derivable from ledger balances alone.
      </div>
    </div>
  );
}
