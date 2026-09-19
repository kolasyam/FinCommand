'use client';

import { useState } from 'react';
import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { Kpi } from '../Kpi';
import { DownloadBar } from '../DownloadBar';
import { fn as fnRaw, numTone, kpiTone, getFyLabel, getFyShortLabel, getUnitHeader } from '@/lib/utils/format';
import { cfLabel } from '@/lib/financial/cashflow-labels';
import { ThreeYearBanner, ThreeYearHeader, ThreeYearRow } from '../ThreeYearFrame';
import { WaterfallChart, type WaterfallStep } from '@/components/charts/WaterfallChart';
import { CustomizableTabPanel } from './dashboard-builder/CustomizableTabPanel';
import { CASHFLOW_DEFAULT_WIDGETS } from '@/lib/dashboard-builder/default-layout';

export function CashFlowTab() {
  const { bundle, granularity, threeYear, yearType, displayUnit, presentationCurrency } = useDashboard();
  const [showComparison, setShowComparison] = useState(true);
  // Shadow fn() with the currently-selected table unit (Lakhs/Thousands/
  // Crores) bound in — every existing fn(v) call below stays unchanged.
  const fn = (n: number | null | undefined, d?: number) => fnRaw(n, d, displayUnit);
  const unitLabel = getUnitHeader(displayUnit, presentationCurrency);

  // ── 3-Year mode ────────────────────────────────────────────────────────────
  if (granularity === '3year' && threeYear) {
    const { years } = threeYear;
    const x = (n: number | undefined | null) => n != null ? `${n.toFixed(2)}x` : null;

    const rows: { label: string; get: (y: typeof years[0]) => number | undefined | null; bold?: boolean; grand?: boolean; isX?: boolean }[] = [
      { label: 'Operating Cash Flow (OCF)',  get: y => y.cashflow?.ocf,          bold: true },
      { label: 'Investing Cash Flow (ICF)',  get: y => y.cashflow?.icf },
      { label: 'Free Cash Flow (OCF − Capex)', get: y => y.cashflow?.fcf,        bold: true },
      { label: 'Net Change in Cash',         get: y => y.cashflow?.net_change },
      { label: 'Opening Cash & Bank',        get: y => y.cashflow?.opening_cash },
      { label: 'Closing Cash & Bank',        get: y => y.cashflow?.closing_cash,  grand: true },
      { label: 'OCF / PAT',                  get: y => y.cashflow?.ocf_to_pat,    isX: true },
    ];

    const latestWithData = [...years].reverse().find(y => !y.no_data);

    return (
      <div>
        <ThreeYearBanner years={years} />
        {latestWithData && (
          <div className="grid4" style={{ marginBottom: 16 }}>
            <Kpi label={`OCF (${latestWithData.financial_year.short_label})`} value={fn(latestWithData.cashflow?.ocf)} tone={kpiTone(latestWithData.cashflow?.ocf)} />
            <Kpi label="Investing CF" value={fn(latestWithData.cashflow?.icf)} tone={kpiTone(latestWithData.cashflow?.icf)} />
            <Kpi label="Net Change in Cash" value={fn(latestWithData.cashflow?.net_change)} tone={kpiTone(latestWithData.cashflow?.net_change)} />
            <Kpi label="Closing Cash" value={fn(latestWithData.cashflow?.closing_cash)} tone={kpiTone(latestWithData.cashflow?.closing_cash)} />
          </div>
        )}
        <div className="card">
          <div className="card-hdr">
            <span className="ct">Statement of Cash Flows — 3-Year Comparison <span className="cbadge cb-blue">IND AS 7 · Indirect</span></span>
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
                    values={years.map(y => y.no_data ? null : (r.isX ? x(r.get(y)) : (r.get(y) != null ? fn(r.get(y)) : null)))}
                    tones={r.isX ? undefined : years.map(y => { const v = r.get(y); return v == null ? '' : numTone(v); })}
                    bold={r.bold}
                    grand={r.grand}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="info-bar" style={{ marginTop: 10, fontSize: 11 }}>
          For the full Indirect Method Cash Flow statement, select Annual, H1/H2, or Quarterly view.
        </div>
      </div>
    );
  }

  // ── Single-year mode ───────────────────────────────────────────────────────
  if (!bundle) return null;
  const {
    cashflow: cf,
    prev_cashflow: prevCf,
    financial_year,
    prev_financial_year: prevFy,
    period_label,
  } = bundle;

  const hasPrev = !!(prevCf && prevFy);
  const compare = hasPrev && showComparison;

  const op = cf.operating as Record<string, unknown>;
  const inv = cf.investing as Record<string, unknown>;
  const fin = cf.financing as Record<string, unknown>;
  const adj = op.adjustments as Record<string, number>;
  const wc = op.wc_changes as Record<string, number>;

  const prevOp = prevCf ? (prevCf.operating as Record<string, unknown>) : null;
  const prevInv = prevCf ? (prevCf.investing as Record<string, unknown>) : null;
  const prevFin = prevCf ? (prevCf.financing as Record<string, unknown>) : null;
  const prevAdj = prevOp ? (prevOp.adjustments as Record<string, number>) : null;
  const prevWc = prevOp ? (prevOp.wc_changes as Record<string, number>) : null;

  // Cash Flow lines are inherently signed (cash in vs. cash out) so every
  // numeric cell here — not just subtotals — gets tone coloring, unlike a
  // P&L expense line where the raw amount's sign alone isn't meaningful.
  const cell = (v: number | undefined | null, bold = false) => (
    <td className={`num ${bold ? 'bold' : ''} ${numTone(v)}`}>{fn(v)}</td>
  );
  const colSpan = compare ? 3 : 2;

  const fyFullLabel = getFyLabel(financial_year, yearType);
  const fyShort = getFyShortLabel(financial_year, yearType);
  const prevFyShort = getFyShortLabel(prevFy, yearType);

  const ocfTotal = op.total as number;
  const icfTotal = inv.total as number;
  const financingTotal = fin.total as number;
  // Real, already-computed by computeCashFlow() — shown in 3-Year mode's own
  // summary table but previously missing entirely from this single-year
  // view, even though it's one of the first things a CFO asks for.
  const hasMaterialGap = Math.abs(cf.reconciling_gap) >= 1000;
  const cashBridgeSteps: WaterfallStep[] = [
    { label: 'Opening Cash', value: cf.opening_cash, isTotal: true },
    { label: 'Operating CF', value: ocfTotal },
    { label: 'Investing CF', value: icfTotal },
    { label: 'Financing CF', value: financingTotal },
    // Included only when material (same >=1000 threshold the statement table
    // below already uses) so the bridge lands exactly on the real Closing
    // Cash figure rather than a small, unexplained visual gap.
    ...(hasMaterialGap ? [{ label: 'Reconciling Diff.', value: cf.reconciling_gap }] : []),
    { label: 'Closing Cash', value: cf.closing_cash, isTotal: true },
  ];

  // Split in two, per BalanceSheetTab.tsx/PLTab.tsx's own already-corrected
  // architecture (see their doc comments / dashboard-builder-engine.ts's
  // TabKey doc comment for why this shape, not a single CustomizableTabPanel
  // wrap, is mandatory for an IND AS 7 statutory statement): only the real
  // supplementary content already added to this tab this engagement — the
  // 3-KPI strip (Free Cash Flow, Opening Cash & Bank, Closing Cash & Bank)
  // and the Cash Bridge waterfall — goes inside CustomizableTabPanel's
  // fixedView. The Operating/Investing/Financing/Net-Change KPI strip and
  // the statutory Statement of Cash Flows both render directly in this
  // component, unconditionally, and are never passed to CustomizableTabPanel
  // at all — so neither can ever be swapped out for the widget grid.

  // ── Supplementary zone (customizable) — 3-KPI strip + Cash Bridge ──
  const supplementaryView = (
    <div>
      <div className="grid3">
        <Kpi label="Free Cash Flow" value={fn(cf.free_cash_flow)} change="Operating CF − Capex" tone={kpiTone(cf.free_cash_flow)} />
        <Kpi label="Opening Cash & Bank" value={fn(cf.opening_cash)} change={`As at start of ${period_label}`} tone="neu" />
        <Kpi label="Closing Cash & Bank" value={fn(cf.closing_cash)} change={`As at end of ${period_label}`} tone="neu" />
      </div>
      <div className="card">
        <div className="card-hdr">
          <span className="ct">Cash Bridge — Opening to Closing</span>
          <span className="cbadge cb-blue">{unitLabel}</span>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--text2)', marginBottom: 8 }}>
            <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#1E3A8A', marginRight: 4, verticalAlign: 'middle' }} />Opening / Closing</span>
            <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#1D9E75', marginRight: 4, verticalAlign: 'middle' }} />Inflow</span>
            <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#D85A30', marginRight: 4, verticalAlign: 'middle' }} />Outflow</span>
          </div>
          <div style={{ position: 'relative', height: 220 }}><WaterfallChart steps={cashBridgeSteps} unit={displayUnit} /></div>
        </div>
      </div>
    </div>
  );

  return (
    <div>
      <DownloadBar title={`Statement of Cash Flows · ${fyFullLabel}`} subtitle={`Indirect Method · IND AS 7 · ${unitLabel} · ${period_label}`} section="cashflow" compareEnabled={showComparison} />

      {/* ── Fixed zone (never a widget, never wrapped, never swapped out) ──
          The Operating/Investing/Financing/Net-Change KPI strip, restating
          the statutory statement's own A/B/C totals at a glance. */}
      <div className="grid4">
        <Kpi label="Operating Cash Flow" value={fn(ocfTotal)} change={cf.ocf_to_pat != null ? `OCF/PAT = ${cf.ocf_to_pat.toFixed(2)}x` : 'OCF/PAT: n/a (loss-making period)'} tone={kpiTone(ocfTotal)} />
        <Kpi label="Investing Cash Flow" value={fn(icfTotal)} change="Capex + FD/MF movements" tone={kpiTone(icfTotal)} />
        <Kpi label="Financing Cash Flow" value={fn(financingTotal)} change="Debt repayment + dividend" tone={kpiTone(financingTotal)} />
        <Kpi label="Net Change in Cash" value={fn(cf.net_change)} change={`Closing: ${fn(cf.closing_cash)} ${displayUnit}`} tone={kpiTone(cf.net_change)} />
      </div>

      <CustomizableTabPanel tabKey="cashflow" defaultWidgets={CASHFLOW_DEFAULT_WIDGETS} fixedView={supplementaryView} />

      {/* ── Fixed zone continued ── The mandated IND AS 7 Statement of Cash
          Flows — every line, byte-identical to how it always rendered,
          whether or not the supplementary zone above is being customized
          right now. */}
      <div className="card">
        <div className="card-hdr">
          <div>
            <span className="ct">Statement of Cash Flows — Indirect Method <span className="cbadge cb-blue">IND AS 7</span></span>
            <span style={{ fontSize: 10, color: 'var(--text2)', marginLeft: 8 }}>{fyFullLabel}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="cbadge cb-blue">{unitLabel}</span>
            {hasPrev && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button className={`pbp ${!showComparison ? 'on' : ''}`} onClick={() => setShowComparison(false)}>
                  {fyShort} Only
                </button>
                <button className={`pbp ${showComparison ? 'on' : ''}`} onClick={() => setShowComparison(true)}>
                  vs {prevFyShort}
                </button>
              </div>
            )}
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="fc-table">
            <thead>
              <tr>
                <th style={{ width: compare ? '50%' : '70%' }}>Particulars</th>
                {compare && <th className="num" style={{ color: 'var(--text2)', fontSize: 10 }}>{prevFyShort}</th>}
                <th className="num">{fyShort}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="sec-row"><td colSpan={colSpan}>A. Cash Flow from Operating Activities</td></tr>
              <tr className="tot-row"><td className="ind1 bold">Profit Before Tax</td>{compare && cell(prevOp?.pbt as number, true)}{cell(op.pbt as number, true)}</tr>
              <tr className="sec-row"><td className="ind2" colSpan={colSpan}>Adjustments for non-cash items:</td></tr>
              {adj && Object.entries(adj).map(([k, val]) => (
                <tr key={k}><td className="ind2">{cfLabel(k)}</td>{compare && cell(prevAdj?.[k])}{cell(val)}</tr>
              ))}
              <tr className="sec-row"><td className="ind2" colSpan={colSpan}>Changes in Working Capital:</td></tr>
              {wc && Object.entries(wc).map(([k, val]) => (
                <tr key={k}><td className="ind2">{k}</td>{compare && cell(prevWc?.[k])}{cell(val)}</tr>
              ))}
              <tr className="grand-row"><td className="bold">A. Net Cash from Operating Activities</td>{compare && cell(prevOp?.total as number, true)}{cell(op.total as number, true)}</tr>

              <tr className="blk-sep"><td colSpan={colSpan} /></tr>
              <tr className="sec-row"><td colSpan={colSpan}>B. Cash Flow from Investing Activities</td></tr>
              {inv && Object.entries(inv).filter(([k]) => k !== 'total').map(([k, val]) => (
                <tr key={k}><td className="ind1">{cfLabel(k)}</td>{compare && cell((prevInv as Record<string, number>)?.[k])}{cell(val as number)}</tr>
              ))}
              <tr className="grand-row"><td className="bold">B. Net Cash from Investing Activities</td>{compare && cell(prevInv?.total as number, true)}{cell(inv.total as number, true)}</tr>

              <tr className="blk-sep"><td colSpan={colSpan} /></tr>
              <tr className="sec-row"><td colSpan={colSpan}>C. Cash Flow from Financing Activities</td></tr>
              {fin && Object.entries(fin).filter(([k]) => k !== 'total').map(([k, val]) => (
                <tr key={k}><td className="ind1">{cfLabel(k)}</td>{compare && cell((prevFin as Record<string, number>)?.[k])}{cell(val as number)}</tr>
              ))}
              <tr className="grand-row"><td className="bold">C. Net Cash from Financing Activities</td>{compare && cell(prevFin?.total as number, true)}{cell(fin.total as number, true)}</tr>

              <tr className="blk-sep"><td colSpan={colSpan} /></tr>
              <tr className="grand-row"><td className="bold">Net Change in Cash / Net Increase (Decrease) — (A+B+C)</td>{compare && cell(prevCf?.net_change as number, true)}{cell(cf.net_change as number, true)}</tr>
              <tr><td className="ind1">Opening Cash &amp; Bank Balances</td>{compare && cell(prevCf?.opening_cash as number)}{cell(cf.opening_cash as number)}</tr>
              {Math.abs(cf.reconciling_gap) >= 1000 && (
                <tr>
                  <td className="ind1" style={{ fontStyle: 'italic', color: 'var(--text2)' }}>Reconciling Difference (see note below)</td>
                  {compare && (Math.abs((prevCf?.reconciling_gap as number) ?? 0) >= 1000 ? cell(prevCf?.reconciling_gap as number) : <td className="num" style={{ color: 'var(--text2)' }}>—</td>)}
                  {cell(cf.reconciling_gap)}
                </tr>
              )}
              <tr className="grand-row"><td className="bold">Closing Cash &amp; Bank Balances</td>{compare && cell(prevCf?.closing_cash as number, true)}{cell(cf.closing_cash as number, true)}</tr>
            </tbody>
          </table>
        </div>
      </div>
      {Math.abs(cf.reconciling_gap) >= 1000 && (
        <div className="info-bar" style={{ marginTop: 12, fontSize: 11 }}>
          This statement is derived entirely from real Trial Balance ledger movements — no assumed percentages. The <strong>Reconciling Difference</strong> line ties the statement above to your actual opening and closing cash/bank balances; the most common cause is cash tax paid, which isn&apos;t shown as its own modeled line since no dedicated tax-provision ledger exists in this Chart of Accounts to trace it from (only pass-through TDS/GST/statutory ledgers, already counted above) — plus any Balance Sheet tally difference (see the Balance Sheet tab). Opening + Net Change + this line always equals the real Closing Cash &amp; Bank balance shown on the Balance Sheet.
        </div>
      )}
    </div>
  );
}
