'use client';

import { useState } from 'react';
import { useDashboard } from '@/lib/client/DashboardContext';
import { Kpi } from '../Kpi';
import { DownloadBar } from '../DownloadBar';
import { fn, numTone, getFyLabel, getFyShortLabel, getUnitHeader, unitSuffix, formatDate, cyYearFromFy, formatChg, type DisplayUnit } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { resolvePeriod, type AggregatedNote, type PeriodParams } from '@/lib/financial/tb-engine';
import type { FyLike } from '@/lib/types/dashboard';
import { ThreeYearBanner, ThreeYearHeader, ThreeYearRow } from '../ThreeYearFrame';
import { CustomizableTabPanel } from './dashboard-builder/CustomizableTabPanel';
import { BALANCE_SHEET_DEFAULT_WIDGETS } from '@/lib/dashboard-builder/default-layout';

/**
 * The Balance Sheet is the one statement that's inherently "as at a date",
 * not "for a period" — so unlike MIS/P&L/Cash Flow, showing the wrong "as
 * at" date here isn't cosmetic, it's a real misstatement of what the
 * numbers below actually represent. This used to always show the full FY/
 * CY's own end_date regardless of the selected period — correct for the
 * Annual view (where bsLastIdx really is the last month), but wrong for
 * Quarterly/H1-H2: selecting Q1 (Apr–Jun) correctly computes the BS as at
 * 30 Jun (resolvePeriod's bsLastIdx), while the header kept claiming "As at
 * 31 Mar [next year]" — the fiscal year-end, ~9 months later than the data
 * actually shown. Also wrong for CY mode even in Annual view: `financial_
 * year` there is the underlying Apr–Mar FY record supplying the CY's Jan–
 * Mar (see reports/all/route.ts's `cyLabelFy`), so its own end_date is that
 * FY's 31 Mar — not the real CY period's 31 Dec.
 */
function resolveAsAtDate(financialYear: FyLike, yearType: string, periodParams: PeriodParams): string {
  const resolved = resolvePeriod(periodParams);
  if (yearType === 'CY') {
    const cyYear = cyYearFromFy(financialYear);
    return resolved.periodEnd ? `${resolved.periodEnd} ${cyYear}` : `31 Dec ${cyYear}`;
  }
  if (resolved.periodEnd) {
    // FY quarters/halves crossing into the FY's second calendar year (Jan–Mar, month indices 9–11)
    const fyStartYear = parseInt(financialYear.start_date.slice(0, 4), 10);
    const year = fyStartYear + (resolved.bsLastIdx >= 9 ? 1 : 0);
    return `${resolved.periodEnd} ${year}`;
  }
  return formatDate(financialYear.end_date); // Annual FY view — bsLastIdx is genuinely the fiscal year-end
}

interface CombinedNoteRowsProps {
  notes: AggregatedNote[];
  prevNotes?: AggregatedNote[];
  compare: boolean;
  unit: DisplayUnit;
}

function CombinedNoteRows({ notes, prevNotes = [], compare, unit }: CombinedNoteRowsProps) {
  const { navigateToNote } = useDashboard();
  // Every note this component ever renders is a Balance Sheet note (this
  // function is only ever fed eq/lnc/lc/anc/ac sections), so its identity
  // in Notes to Accounts' combined BS+P&L list is always the `bs_` prefix —
  // never `pl_`, which is the other half of that list's note_no-collision
  // disambiguation (e.g. Note 20 = Revenue on the P&L side, Bank Balances/
  // FDs here).
  const NoteRef = ({ no }: { no: number }) => (
    <button
      type="button"
      className="nref nref-link"
      onClick={() => navigateToNote(`bs_${no}`)}
      title={`Go to Note ${no} in Notes to Accounts`}
    >
      {no}
    </button>
  );

  if (!compare) {
    return (
      <>
        {notes.map(n => (
          <tr key={`${n.note_no}-${n.note_name}`}>
            <td className="ind2">{n.note_name || `Note ${n.note_no}`}</td>
            <td><NoteRef no={n.note_no} /></td>
            <td className="num">{fn(n.total, 2, unit)}</td>
          </tr>
        ))}
      </>
    );
  }

  const allNoteNos = Array.from(
    new Set([...notes.map(n => n.note_no), ...prevNotes.map(n => n.note_no)])
  ).sort((a, b) => a - b);

  return (
    <>
      {allNoteNos.map(no => {
        const curr = notes.find(n => n.note_no === no);
        const prev = prevNotes.find(n => n.note_no === no);
        const name = curr?.note_name || prev?.note_name || `Note ${no}`;
        const cVal = curr?.total ?? 0;
        const pVal = prev?.total ?? 0;
        const chg = cVal - pVal;

        return (
          <tr key={`note-${no}`}>
            <td className="ind2">{name}</td>
            <td><NoteRef no={no} /></td>
            <td className="num">{fn(cVal, 2, unit)}</td>
            <td className="num" style={{ color: 'var(--text2)' }}>{fn(pVal, 2, unit)}</td>
            <td className={`num ${numTone(chg)}`}>
              {formatChg(chg, 2, unit)}
            </td>
          </tr>
        );
      })}
    </>
  );
}

interface TotalRowProps {
  label: string;
  indentClass: string;
  currVal: number;
  prevVal?: number;
  compare: boolean;
  grand?: boolean;
  unit: DisplayUnit;
}

function TotalRow({ label, indentClass, currVal, prevVal = 0, compare, grand, unit }: TotalRowProps) {
  const chg = currVal - prevVal;
  const rowClass = grand ? 'grand-row' : 'tot-row';

  if (!compare) {
    return (
      <tr className={rowClass}>
        <td className={`${indentClass} bold`}>{label}</td>
        <td />
        <td className="num bold">{fn(currVal, 2, unit)}</td>
      </tr>
    );
  }

  return (
    <tr className={rowClass}>
      <td className={`${indentClass} bold`}>{label}</td>
      <td />
      <td className="num bold">{fn(currVal, 2, unit)}</td>
      <td className="num bold" style={{ color: 'var(--text2)' }}>{fn(prevVal, 2, unit)}</td>
      <td className={`num bold ${numTone(chg)}`}>
        {formatChg(chg, 2, unit)}
      </td>
    </tr>
  );
}

interface CompSegment { label: string; value: number; color: string; }

/**
 * Plain-CSS proportional stacked bar — same "no Chart.js needed for a simple
 * composition view" convention WorkingCapitalTab's own wc-bar-inner already
 * follows, extended here to a single stacked bar (multiple segments) rather
 * than one bar per row. Mirrors the bespoke Balance Sheet PDF's own
 * Equity & Liabilities vs. Assets composition chart (lib/exports/bs-pdf.ts),
 * which existed there but had no on-screen equivalent until now.
 */
function CompositionBar({ segments, unit }: { segments: CompSegment[]; unit: DisplayUnit }) {
  const total = segments.reduce((s, x) => s + Math.max(x.value, 0), 0);
  return (
    <div style={{ display: 'flex', height: 28, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
      {segments.filter(s => s.value > 0).map((s) => (
        <div
          key={s.label}
          style={{ flex: `${total > 0 ? s.value / total : 1} 0 0%`, background: s.color, display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 2 }}
          title={`${s.label}: ${fn(s.value, 2, unit)}`}
        >
          {total > 0 && s.value / total > 0.12 && <span style={{ fontSize: 10, fontWeight: 600, color: '#fff' }}>{fn(s.value, 1, unit)}</span>}
        </div>
      ))}
    </div>
  );
}
function CompLegend({ segments }: { segments: { label: string; color: string }[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 10, color: 'var(--text2)', marginTop: 6 }}>
      {segments.map(s => (
        <span key={s.label}>
          <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: s.color, marginRight: 4, verticalAlign: 'middle' }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

export function BalanceSheetTab() {
  const { bundle, threeYear, granularity, yearType, displayUnit, presentationCurrency } = useDashboard();
  const [showComparison, setShowComparison] = useState(true);
  // Shadow fn() with the currently-selected table unit for this component's
  // own direct calls; TotalRow/CombinedNoteRows (module-scope, so outside
  // this closure) take `unit` as an explicit prop instead — see below.
  const fn2 = (n: number | null | undefined, d?: number) => fn(n, d, displayUnit);
  const unitLabel = getUnitHeader(displayUnit, presentationCurrency);
  const unitSfx = unitSuffix(displayUnit);
  const symbol = getCurrencyMeta(presentationCurrency).symbol;

  // ── 3-Year mode ────────────────────────────────────────────────────────────
  if (granularity === '3year' && threeYear) {
    const { years } = threeYear;
    const v = (n: number | undefined | null) => n != null ? fn2(n) : null;

    const rows: { label: string; get: (y: typeof years[0]) => number | undefined | null; bold?: boolean; grand?: boolean; indent?: boolean }[] = [
      { label: 'Total Assets',          get: y => y.bs_summary?.total_assets, grand: true },
      { label: 'Non-Current Assets',    get: y => y.bs_summary?.nca, bold: true },
      { label: 'Current Assets',        get: y => y.bs_summary?.ca, bold: true },
      { label: 'Equity',               get: y => y.bs_summary?.equity, bold: true },
      { label: 'Non-Current Liabilities', get: y => y.bs_summary?.ncl, indent: true },
      { label: 'Current Liabilities',  get: y => y.bs_summary?.cl, indent: true },
    ];

    return (
      <div>
        <ThreeYearBanner years={years} />
        <div className="card">
          <div className="card-hdr">
            <span className="ct">Balance Sheet Summary — 3-Year Comparison <span className="cbadge cb-blue">Annual</span></span>
            <span className="cbadge cb-blue">{unitLabel}</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="fc-table">
              <ThreeYearHeader years={years} />
              <tbody>
                {rows.map(r => (
                  <ThreeYearRow
                    key={r.label}
                    label={r.label}
                    years={years}
                    values={years.map(y => y.no_data ? null : v(r.get(y)))}
                    bold={r.bold}
                    grand={r.grand}
                    indent={r.indent}
                  />
                ))}
                <ThreeYearRow
                  label="BS Balanced?"
                  years={years}
                  values={years.map(y => y.no_data ? null : (y.bs_summary?.balanced ? '✓ Yes' : '✗ No'))}
                  tones={years.map(y => y.no_data ? '' : (y.bs_summary?.balanced ? 'up' : 'dn'))}
                />
              </tbody>
            </table>
          </div>
        </div>
        <div className="info-bar" style={{ marginTop: 10, fontSize: 11 }}>
          For the full Balance Sheet with Notes, select Annual, H1/H2, or Quarterly view.
        </div>
      </div>
    );
  }

  // ── Single-year mode ───────────────────────────────────────────────────────
  if (!bundle) return null;
  const {
    bs,
    prev_bs: prevBs,
    financial_year,
    prev_financial_year: prevFy,
    period_label,
  } = bundle;

  const eq = bs.equity_liabilities;
  const as = bs.assets;
  const periodEnd = resolveAsAtDate(financial_year, yearType, bundle.period_params);

  const prevEq = prevBs?.equity_liabilities;
  const prevAs = prevBs?.assets;

  const fyLabel = getFyLabel(financial_year, yearType);
  const fyShort = getFyShortLabel(financial_year, yearType);
  const prevFyLabel = getFyLabel(prevFy, yearType);
  const prevFyShort = getFyShortLabel(prevFy, yearType);

  const hasPrev = !!(prevBs && prevFy);
  const compare = hasPrev && showComparison;
  const colSpan = compare ? 5 : 3;

  const totalLiabilities = eq.total_ncl + eq.total_cl;
  const prevTotalLiabilities = prevEq ? prevEq.total_ncl + prevEq.total_cl : undefined;
  const liabChg = prevTotalLiabilities != null && prevTotalLiabilities !== 0 ? ((totalLiabilities - prevTotalLiabilities) / Math.abs(prevTotalLiabilities)) * 100 : null;
  const eqChg = prevEq && prevEq.total_equity !== 0 ? ((eq.total_equity - prevEq.total_equity) / Math.abs(prevEq.total_equity)) * 100 : null;
  const assetsChg = prevAs && prevAs.total !== 0 ? ((as.total - prevAs.total) / Math.abs(prevAs.total)) * 100 : null;

  // Split in two, per the architecture fix below — NOT one fixedView for the
  // whole tab (see git history / CustomizableTabPanel.tsx's own doc comment
  // for why that shape is fine for Overview/MIS/Ratios but was a real bug
  // here): CustomizableTabPanel's showGrid branch renders ONLY its fixedView
  // OR ONLY the grid, never both — an acceptable approximation for a
  // KPI/chart-shaped tab, but not for Balance Sheet, whose fixedView held
  // the mandated Schedule III statutory table. Clicking "Customize" made the
  // actual Balance Sheet disappear entirely, replaced by a handful of
  // unrelated stat cards. Fix: only the real supplementary content (the KPI
  // strip + composition visual) goes inside CustomizableTabPanel's
  // fixedView now; the statutory table renders directly in this component,
  // unconditionally, and is never passed to CustomizableTabPanel at all —
  // so it can never be swapped out for the grid, no matter what.

  // ── Supplementary zone (customizable) — KPI strip + composition visual ──
  const supplementaryView = (
    <div>
      {/* Balance Sheet at a Glance — real KPI summary + composition visual,
          mirroring the bespoke PDF export's own front page, previously only
          available on download. The statutory statement below is untouched. */}
      <div className="grid4">
        <Kpi label="Total Assets" value={fn2(as.total)} change={assetsChg != null ? `${assetsChg >= 0 ? '+' : ''}${assetsChg.toFixed(1)}% vs ${prevFyShort}` : `NCA + CA · ${unitLabel}`} tone={assetsChg == null ? 'neu' : assetsChg >= 0 ? 'up' : 'dn'} />
        <Kpi label="Total Equity" value={fn2(eq.total_equity)} change={eqChg != null ? `${eqChg >= 0 ? '+' : ''}${eqChg.toFixed(1)}% vs ${prevFyShort}` : 'Shareholders’ funds'} tone={eqChg == null ? 'neu' : eqChg >= 0 ? 'up' : 'dn'} />
        <Kpi label="Total Liabilities" value={fn2(totalLiabilities)} change={liabChg != null ? `${liabChg >= 0 ? '+' : ''}${liabChg.toFixed(1)}% vs ${prevFyShort}` : `NCL + CL · ${unitLabel}`} tone="neu" />
        <Kpi
          label="Balance Check" value={bs.balanced ? 'Balanced' : 'Out of Balance'}
          change={bs.balanced ? 'Assets = Equity + Liabilities' : `Diff ${symbol}${fn2(bs.difference)}${unitSfx}`}
          tone={bs.balanced ? 'up' : 'dn'}
        />
      </div>

      <div className="card">
        <div className="card-hdr">
          <span className="ct">Equity &amp; Liabilities vs. Assets — Composition</span>
          <span className="cbadge cb-blue">{unitLabel}</span>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4 }}>Equity &amp; Liabilities — {fn2(eq.total)}{unitSfx}</div>
            <CompositionBar
              unit={displayUnit}
              segments={[
                { label: 'Equity', value: eq.total_equity, color: '#378ADD' },
                { label: 'Non-Current Liabilities', value: eq.total_ncl, color: '#3C3489' },
                { label: 'Current Liabilities', value: eq.total_cl, color: '#B5D4F4' },
              ]}
            />
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4 }}>Assets — {fn2(as.total)}{unitSfx}</div>
            <CompositionBar
              unit={displayUnit}
              segments={[
                { label: 'Non-Current Assets', value: as.total_nca, color: '#1D9E75' },
                { label: 'Current Assets', value: as.total_ca, color: '#5DCAA5' },
              ]}
            />
          </div>
          <CompLegend segments={[
            { label: 'Equity', color: '#378ADD' },
            { label: 'Non-Current Liabilities', color: '#3C3489' },
            { label: 'Current Liabilities', color: '#B5D4F4' },
            { label: 'Non-Current Assets', color: '#1D9E75' },
            { label: 'Current Assets', color: '#5DCAA5' },
          ]} />
        </div>
      </div>
    </div>
  );

  return (
    <div>
      <DownloadBar title={`Balance Sheet · ${fyLabel}`} subtitle={`Schedule III · IND AS · As at ${periodEnd} · ${unitLabel}`} section="bs" compareEnabled={showComparison} />

      <CustomizableTabPanel tabKey="bs" defaultWidgets={BALANCE_SHEET_DEFAULT_WIDGETS} fixedView={supplementaryView} />

      {/* ── Fixed zone (never a widget, never wrapped, never swapped out) ──
          The mandated Schedule III statutory table — every line, every note
          reference, the balance-check row, byte-identical to how it always
          rendered, in every mode, whether or not the supplementary zone
          above is being customized right now. */}
      <div className="card">
        <div className="card-hdr" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <span className="ct">Balance Sheet <span className="cbadge cb-blue">Schedule III — IND AS</span></span>
            <span style={{ fontSize: 10, color: 'var(--text2)', marginLeft: 8 }}>As at {periodEnd} · {period_label}</span>
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
            ℹ Previous year data is not available. Displaying <strong>{fyLabel}</strong> balance sheet only. Upload previous year Trial Balance to enable 2-Year prior year comparison.
          </div>
        )}

        {!bs.balanced && (
          <div className="info-bar" style={{ color: 'var(--red)', border: '1px solid var(--red-l)', background: 'var(--red-l)', margin: '10px 16px 0 16px' }}>
            ⚠ Balance Sheet is out of balance by {symbol}{fn2(bs.difference)}{unitSfx} — review ledger section mappings.
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
              {/* Equity & Liabilities */}
              <tr className="sec-row"><td colSpan={colSpan}>Equity &amp; Liabilities</td></tr>

              <TotalRow label="Shareholders' Equity" indentClass="ind1" currVal={eq.total_equity} prevVal={prevEq?.total_equity} compare={compare} unit={displayUnit} />
              <CombinedNoteRows notes={eq.equity} prevNotes={prevEq?.equity} compare={compare} unit={displayUnit} />

              <TotalRow label="Non-Current Liabilities" indentClass="ind1" currVal={eq.total_ncl} prevVal={prevEq?.total_ncl} compare={compare} unit={displayUnit} />
              <CombinedNoteRows notes={eq.non_current_liab} prevNotes={prevEq?.non_current_liab} compare={compare} unit={displayUnit} />

              <TotalRow label="Current Liabilities" indentClass="ind1" currVal={eq.total_cl} prevVal={prevEq?.total_cl} compare={compare} unit={displayUnit} />
              <CombinedNoteRows notes={eq.current_liab} prevNotes={prevEq?.current_liab} compare={compare} unit={displayUnit} />

              <TotalRow label="Total Equity &amp; Liabilities" indentClass="" currVal={eq.total} prevVal={prevEq?.total} compare={compare} grand unit={displayUnit} />

              {/* Assets */}
              <tr className="blk-sep"><td colSpan={colSpan} /></tr>
              <tr className="sec-row"><td colSpan={colSpan}>Assets</td></tr>

              <TotalRow label="Non-Current Assets" indentClass="ind1" currVal={as.total_nca} prevVal={prevAs?.total_nca} compare={compare} unit={displayUnit} />
              <CombinedNoteRows notes={as.non_current} prevNotes={prevAs?.non_current} compare={compare} unit={displayUnit} />

              <TotalRow label="Current Assets" indentClass="ind1" currVal={as.total_ca} prevVal={prevAs?.total_ca} compare={compare} unit={displayUnit} />
              <CombinedNoteRows notes={as.current} prevNotes={prevAs?.current} compare={compare} unit={displayUnit} />

              <TotalRow label="Total Assets" indentClass="" currVal={as.total} prevVal={prevAs?.total} compare={compare} grand unit={displayUnit} />
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
