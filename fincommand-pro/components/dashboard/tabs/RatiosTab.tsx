'use client';

import { useDashboard } from '@/lib/client/DashboardContext';
import { Kpi } from '../Kpi';
import { DownloadBar } from '../DownloadBar';
import { pct, fx, fl as flRaw, getFyLabel, getFyShortLabel, unitSuffix } from '@/lib/utils/format';
import { ThreeYearBanner, ThreeYearHeader, ThreeYearRow } from '../ThreeYearFrame';
import { CustomizableTabPanel } from './dashboard-builder/CustomizableTabPanel';
import { RATIOS_DEFAULT_WIDGETS } from '@/lib/dashboard-builder/default-layout';
import { RatioComparisonChart } from '@/components/charts/RatioComparisonChart';

interface RatioRow { label: string; value: string; benchmark: string; pct: number; tone: 'g-green' | 'g-amber' | 'g-red' | 'g-blue'; change?: string; changeTone?: 'up' | 'dn' | 'neu' }

function RatioCard({ title, rows }: { title: string; rows: RatioRow[] }) {
  return (
    <div className="ratio-card">
      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8 }}>{title}</div>
      {rows.map(r => (
        <div key={r.label} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
            <span style={{ color: 'var(--text2)' }}>{r.label}</span>
            <span style={{ fontWeight: 600 }}>{r.value}</span>
          </div>
          <div className="gauge-wrap"><div className={`gauge-fill ${r.tone}`} style={{ width: `${Math.min(100, Math.max(4, r.pct))}%` }} /></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text3)' }}>
            <span className={r.change ? r.changeTone : undefined}>{r.change || ''}</span>
            <span>Benchmark {r.benchmark}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function RatiosTab() {
  const { bundle, granularity, threeYear, yearType, displayUnit } = useDashboard();
  const fl = (n: number | null | undefined, d?: number) => flRaw(n, d, displayUnit);
  const unitSfx = unitSuffix(displayUnit);

  // ── 3-Year mode ────────────────────────────────────────────────────────────
  if (granularity === '3year' && threeYear) {
    const { years } = threeYear;

    return (
      <div>
        <ThreeYearBanner years={years} />
        <div className="card">
          <div className="card-hdr">
            <span className="ct">Key Financial Ratios — 3-Year Comparison <span className="cbadge cb-blue">Annual</span></span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="fc-table">
              <ThreeYearHeader years={years} particularHeader="Ratio" />
              <tbody>
                <tr className="sec-row"><td colSpan={years.length + Math.max(0, 3 - years.length) + 1}>Liquidity Ratios</td></tr>
                <ThreeYearRow label="Current Ratio" years={years} values={years.map(y => y.ratios ? fx(y.ratios.liquidity.current_ratio) : null)} />
                <ThreeYearRow label="Quick Ratio" years={years} values={years.map(y => y.ratios ? fx(y.ratios.liquidity.quick_ratio) : null)} />

                <tr className="sec-row"><td colSpan={years.length + Math.max(0, 3 - years.length) + 1}>Profitability Ratios</td></tr>
                <ThreeYearRow label="Gross Margin %" years={years} values={years.map(y => y.ratios ? pct(y.ratios.profitability.gross_margin) : null)} tones={years.map(y => y.ratios ? (y.ratios.profitability.gross_margin < 0 ? 'dn' : 'up') : '')} />
                <ThreeYearRow label="EBITDA Margin %" years={years} values={years.map(y => y.ratios ? pct(y.ratios.profitability.ebitda_margin) : null)} tones={years.map(y => y.ratios ? (y.ratios.profitability.ebitda_margin < 0 ? 'dn' : 'up') : '')} />
                <ThreeYearRow label="Net Margin %" years={years} values={years.map(y => y.ratios ? pct(y.ratios.profitability.net_margin) : null)} tones={years.map(y => y.ratios ? (y.ratios.profitability.net_margin < 0 ? 'dn' : 'up') : '')} />
                <ThreeYearRow label="ROE %" years={years} values={years.map(y => y.ratios ? pct(y.ratios.profitability.roe) : null)} tones={years.map(y => y.ratios ? (y.ratios.profitability.roe < 0 ? 'dn' : 'up') : '')} />
                <ThreeYearRow label="ROCE %" years={years} values={years.map(y => y.ratios ? pct(y.ratios.profitability.roce) : null)} tones={years.map(y => y.ratios ? (y.ratios.profitability.roce < 0 ? 'dn' : 'up') : '')} />

                <tr className="sec-row"><td colSpan={years.length + Math.max(0, 3 - years.length) + 1}>Leverage Ratios</td></tr>
                <ThreeYearRow label="Debt / Equity" years={years} values={years.map(y => y.ratios ? fx(y.ratios.leverage.debt_equity) : null)} />
                <ThreeYearRow label="Interest Coverage" years={years} values={years.map(y => y.ratios ? fx(y.ratios.leverage.interest_cover) : null)} />

                <tr className="sec-row"><td colSpan={years.length + Math.max(0, 3 - years.length) + 1}>Efficiency Ratios</td></tr>
                <ThreeYearRow label="Days Sales Outstanding (DSO)" years={years} values={years.map(y => y.ratios ? `${y.ratios.efficiency.dso}d` : null)} />
                <ThreeYearRow label="Days Payable Outstanding (DPO)" years={years} values={years.map(y => y.ratios ? `${y.ratios.efficiency.dpo}d` : null)} />
                <ThreeYearRow label="Cash Conversion Cycle (CCC)" years={years} values={years.map(y => y.ratios ? `${y.ratios.efficiency.ccc}d` : null)} />

                <tr className="sec-row"><td colSpan={years.length + Math.max(0, 3 - years.length) + 1}>Cash Flow Quality</td></tr>
                <ThreeYearRow label="Operating Cash Flow / PAT" years={years} values={years.map(y => y.ratios ? (y.ratios.cashflow.ocf_to_pat !== null ? fx(y.ratios.cashflow.ocf_to_pat) : 'N/A') : null)} />
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // ── Single-year mode ───────────────────────────────────────────────────────
  if (!bundle) return null;
  const { ratios: r, prev_ratios: p, financial_year, period_label } = bundle;
  const prevFyShort = getFyShortLabel(bundle.prev_financial_year, yearType);

  // Real vs-Prior-Year context for every ratio below — previously this tab
  // showed only the current period's figure with a hand-picked static
  // benchmark and no history at all, even though every other statutory/MIS
  // report in this app already carries a real prev_* comparison. bundle now
  // carries prev_ratios (computeRatios() re-run against the prior FY's own
  // ledgers, same as prev_bs/prev_cashflow/etc.) so this is real data, not
  // an estimate — simply omitted (returns {}) whenever either side is
  // unavailable (first FY on the platform, or a benchmark-only figure).
  function change(cur: number | null | undefined, prev: number | null | undefined, digits: number, suffix: string, opts?: { lowerIsBetter?: boolean; neutral?: boolean }): { change?: string; changeTone?: 'up' | 'dn' | 'neu' } {
    if (cur == null || prev == null || Number.isNaN(cur) || Number.isNaN(prev) || !prevFyShort) return {};
    const delta = parseFloat((cur - prev).toFixed(digits));
    const text = `${delta > 0 ? '+' : ''}${delta}${suffix} vs ${prevFyShort}`;
    if (opts?.neutral || delta === 0) return { change: text, changeTone: 'neu' };
    const improved = opts?.lowerIsBetter ? delta < 0 : delta > 0;
    return { change: text, changeTone: improved ? 'up' : 'dn' };
  }

  // Free Cash Flow is the one Cash Flow Quality figure denominated in real
  // currency rather than a multiple/%/day-count, so its delta is formatted
  // through fl() (unit-scaled, e.g. Lakhs/Crores) instead of the generic
  // change() helper above, which assumes a small x/pp/day suffix.
  const fcfDelta = r.cashflow.free_cash_flow != null && p?.cashflow.free_cash_flow != null
    ? r.cashflow.free_cash_flow - p.cashflow.free_cash_flow : null;
  const fcfChange: { change?: string; changeTone?: 'up' | 'dn' | 'neu' } = fcfDelta != null && prevFyShort
    ? { change: `${fcfDelta > 0 ? '+' : ''}${fl(fcfDelta)}${unitSfx} vs ${prevFyShort}`, changeTone: fcfDelta > 0 ? 'up' : fcfDelta < 0 ? 'dn' : 'neu' }
    : {};

  // Headline KPI-strip deltas — one representative ratio per category.
  const crChg = change(r.liquidity.current_ratio, p?.liquidity.current_ratio, 2, 'x');
  const roeChg = change(r.profitability.roe, p?.profitability.roe, 1, 'pp');
  const deChg = change(r.leverage.debt_equity, p?.leverage.debt_equity, 2, 'x', { lowerIsBetter: true });
  const cccChg = change(r.efficiency.ccc, p?.efficiency.ccc, 0, 'd', { lowerIsBetter: true });

  // Same real prev_ratios feeding the KPI strip and every RatioCard row also
  // drives this chart — Ratio Analysis previously had zero charts despite
  // computing 15+ real figures every period.
  const marginChart = p ? (
    <div className="card">
      <div className="card-hdr">
        <span className="ct">Profitability Margins — Current vs. Prior Year</span>
        <span className="cbadge cb-blue">%</span>
      </div>
      <div className="card-body">
        <div style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--text2)', marginBottom: 8 }}>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#CBD5E1', marginRight: 4, verticalAlign: 'middle' }} />{prevFyShort}</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#1E3A8A', marginRight: 4, verticalAlign: 'middle' }} />{getFyShortLabel(financial_year, yearType)}</span>
        </div>
        <div style={{ position: 'relative', height: 200 }}>
          <RatioComparisonChart
            labels={['Gross Margin', 'EBITDA Margin', 'Net Margin', 'ROE', 'ROCE']}
            current={[r.profitability.gross_margin, r.profitability.ebitda_margin, r.profitability.net_margin, r.profitability.roe, r.profitability.roce]}
            prior={[p.profitability.gross_margin, p.profitability.ebitda_margin, p.profitability.net_margin, p.profitability.roe, p.profitability.roce]}
            currentLabel={getFyShortLabel(financial_year, yearType)}
            priorLabel={prevFyShort}
          />
        </div>
      </div>
    </div>
  ) : null;

  const fixedView = (
    <div>
      <DownloadBar title={`Key Financial Ratios · ${getFyLabel(financial_year, yearType)}`} subtitle={`Liquidity · Profitability · Leverage · Efficiency · Cash Flow Quality · ${period_label}`} section="ratios" />
      <div className="grid4">
        <Kpi label="Current Ratio" value={fx(r.liquidity.current_ratio)} change={crChg.change || 'Benchmark > 1.5x'} tone={crChg.changeTone || 'neu'} />
        <Kpi label="Return on Equity" value={pct(r.profitability.roe)} change={roeChg.change || 'Benchmark > 15%'} tone={roeChg.changeTone || 'neu'} />
        <Kpi label="Debt / Equity" value={fx(r.leverage.debt_equity)} change={deChg.change || 'Benchmark < 1.0x'} tone={deChg.changeTone || 'neu'} />
        <Kpi label="Cash Conversion Cycle" value={`${r.efficiency.ccc} days`} change={cccChg.change || 'Lower is better'} tone={cccChg.changeTone || 'neu'} />
      </div>
      <div className="grid2">
        <RatioCard title="Liquidity" rows={[
          { label: 'Current Ratio', value: fx(r.liquidity.current_ratio), benchmark: '> 1.5x', pct: r.liquidity.current_ratio / 1.5 * 100, tone: r.liquidity.current_ratio >= 1.5 ? 'g-green' : 'g-amber', ...crChg },
          { label: 'Quick Ratio', value: fx(r.liquidity.quick_ratio), benchmark: '> 1.0x', pct: r.liquidity.quick_ratio / 1.0 * 100, tone: r.liquidity.quick_ratio >= 1 ? 'g-green' : 'g-amber', ...change(r.liquidity.quick_ratio, p?.liquidity.quick_ratio, 2, 'x') },
          { label: 'Cash Ratio', value: fx(r.liquidity.cash_ratio), benchmark: 'n/a', pct: 50, tone: 'g-blue', ...change(r.liquidity.cash_ratio, p?.liquidity.cash_ratio, 2, 'x', { neutral: true }) },
        ]} />
        <RatioCard title="Profitability" rows={[
          { label: 'Gross Margin', value: pct(r.profitability.gross_margin), benchmark: '> 45%', pct: r.profitability.gross_margin / 45 * 100, tone: r.profitability.gross_margin >= 45 ? 'g-green' : r.profitability.gross_margin < 0 ? 'g-red' : 'g-amber', ...change(r.profitability.gross_margin, p?.profitability.gross_margin, 1, 'pp') },
          { label: 'EBITDA Margin', value: pct(r.profitability.ebitda_margin), benchmark: '> 10%', pct: r.profitability.ebitda_margin / 10 * 100, tone: r.profitability.ebitda_margin >= 10 ? 'g-green' : 'g-red', ...change(r.profitability.ebitda_margin, p?.profitability.ebitda_margin, 1, 'pp') },
          { label: 'Net Margin', value: pct(r.profitability.net_margin), benchmark: '> 8%', pct: r.profitability.net_margin / 8 * 100, tone: r.profitability.net_margin >= 8 ? 'g-green' : 'g-red', ...change(r.profitability.net_margin, p?.profitability.net_margin, 1, 'pp') },
          { label: 'ROE', value: pct(r.profitability.roe), benchmark: '> 15%', pct: r.profitability.roe / 15 * 100, tone: r.profitability.roe >= 15 ? 'g-green' : r.profitability.roe < 0 ? 'g-red' : 'g-amber', ...roeChg },
          { label: 'ROCE', value: pct(r.profitability.roce), benchmark: '> 15%', pct: r.profitability.roce / 15 * 100, tone: r.profitability.roce >= 15 ? 'g-green' : r.profitability.roce < 0 ? 'g-red' : 'g-amber', ...change(r.profitability.roce, p?.profitability.roce, 1, 'pp') },
        ]} />
        <RatioCard title="Leverage" rows={[
          { label: 'Debt / Equity', value: fx(r.leverage.debt_equity), benchmark: '< 1.0x', pct: (1 / Math.max(r.leverage.debt_equity, 0.01)) * 100, tone: r.leverage.debt_equity <= 1 ? 'g-green' : 'g-red', ...deChg },
          { label: 'Interest Cover', value: fx(r.leverage.interest_cover), benchmark: '> 3.0x', pct: r.leverage.interest_cover / 3 * 100, tone: r.leverage.interest_cover >= 3 ? 'g-green' : 'g-amber', ...change(r.leverage.interest_cover, p?.leverage.interest_cover, 2, 'x') },
          { label: 'DSCR', value: fx(r.leverage.dscr), benchmark: 'n/a', pct: 50, tone: 'g-blue', ...change(r.leverage.dscr, p?.leverage.dscr, 2, 'x') },
        ]} />
        <RatioCard title="Efficiency" rows={[
          { label: 'Asset Turnover', value: fx(r.efficiency.asset_turnover), benchmark: 'n/a', pct: 50, tone: 'g-blue', ...change(r.efficiency.asset_turnover, p?.efficiency.asset_turnover, 2, 'x') },
          { label: 'DSO', value: `${r.efficiency.dso} days`, benchmark: '< 60 days', pct: (60 / Math.max(r.efficiency.dso, 1)) * 100, tone: r.efficiency.dso <= 60 ? 'g-green' : 'g-red', ...change(r.efficiency.dso, p?.efficiency.dso, 0, 'd', { lowerIsBetter: true }) },
          { label: 'DPO', value: `${r.efficiency.dpo} days`, benchmark: '30–45 days', pct: 60, tone: 'g-blue', ...change(r.efficiency.dpo, p?.efficiency.dpo, 0, 'd', { neutral: true }) },
          { label: 'Cash Conversion Cycle', value: `${r.efficiency.ccc} days`, benchmark: 'n/a', pct: 50, tone: 'g-blue', ...cccChg },
        ]} />
        <RatioCard title="Cash Flow Quality" rows={[
          { label: 'Free Cash Flow', value: `${fl(r.cashflow.free_cash_flow)}${unitSfx}`, benchmark: '> 0', pct: r.cashflow.free_cash_flow > 0 ? 75 : 25, tone: r.cashflow.free_cash_flow > 0 ? 'g-green' : 'g-red', ...fcfChange },
          { label: 'Operating Cash Flow / PAT', value: r.cashflow.ocf_to_pat !== null ? fx(r.cashflow.ocf_to_pat) : 'N/A', benchmark: '> 0.8x', pct: r.cashflow.ocf_to_pat !== null ? r.cashflow.ocf_to_pat / 0.8 * 100 : 50, tone: r.cashflow.ocf_to_pat !== null ? (r.cashflow.ocf_to_pat >= 0.8 ? 'g-green' : 'g-amber') : 'g-blue', ...change(r.cashflow.ocf_to_pat, p?.cashflow.ocf_to_pat, 2, 'x') },
        ]} />
      </div>
      {marginChart}
      <div className="card">
        <div className="card-hdr"><span className="ct">DuPont Analysis</span></div>
        <div className="card-body so-grid" style={{ marginBottom: 0 }}>
          <div className="so-item"><div className="so-lbl">Net Margin</div><div className="so-val">{pct(r.dupont.net_margin)}</div></div>
          <div className="so-item"><div className="so-lbl">Asset Turnover</div><div className="so-val">{fx(r.dupont.asset_turnover)}</div></div>
          <div className="so-item"><div className="so-lbl">Equity Multiplier</div><div className="so-val">{fx(r.dupont.equity_multiplier)}</div></div>
          <div className="so-item" style={{ gridColumn: '1 / -1' }}><div className="so-lbl">Return on Equity (Net Margin × Turnover × Multiplier)</div><div className="so-val">{pct(r.dupont.roe)}</div></div>
        </div>
      </div>
      <div className="info-bar" style={{ marginTop: 10, fontSize: 11 }}>
        Every ratio above is computed directly from this period&apos;s real Trial Balance-derived statements (Balance Sheet, P&amp;L, Cash Flow) — nothing here is estimated. {prevFyShort ? `The vs-${prevFyShort} comparisons re-run the identical formulas against the prior year's own ledgers.` : `A prior-year comparison will appear here once a Trial Balance for an earlier financial year is available.`}
      </div>
    </div>
  );

  return <CustomizableTabPanel tabKey="ratios" defaultWidgets={RATIOS_DEFAULT_WIDGETS} fixedView={fixedView} />;
}
