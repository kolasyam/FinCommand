'use client';

import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { DownloadBar } from '../DownloadBar';
import { pct, fx, getFyLabel } from '@/lib/utils/format';
import { ThreeYearBanner, ThreeYearHeader, ThreeYearRow } from '../ThreeYearFrame';

interface RatioRow { label: string; value: string; benchmark: string; pct: number; tone: 'g-green' | 'g-amber' | 'g-red' | 'g-blue' }

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
          <div style={{ fontSize: 9, color: 'var(--text3)', textAlign: 'right' }}>Benchmark {r.benchmark}</div>
        </div>
      ))}
    </div>
  );
}

export function RatiosTab() {
  const { bundle, granularity, threeYear, yearType } = useDashboard();

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
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // ── Single-year mode ───────────────────────────────────────────────────────
  if (!bundle) return null;
  const { ratios: r, financial_year, period_label } = bundle;

  return (
    <div>
      <DownloadBar title={`Key Financial Ratios · ${getFyLabel(financial_year, yearType)}`} subtitle={`Liquidity · Profitability · Leverage · Efficiency · ${period_label}`} section="ratios" />
      <div className="grid2">
        <RatioCard title="Liquidity" rows={[
          { label: 'Current Ratio', value: fx(r.liquidity.current_ratio), benchmark: '> 1.5x', pct: r.liquidity.current_ratio / 1.5 * 100, tone: r.liquidity.current_ratio >= 1.5 ? 'g-green' : 'g-amber' },
          { label: 'Quick Ratio', value: fx(r.liquidity.quick_ratio), benchmark: '> 1.0x', pct: r.liquidity.quick_ratio / 1.0 * 100, tone: r.liquidity.quick_ratio >= 1 ? 'g-green' : 'g-amber' },
          { label: 'Cash Ratio', value: fx(r.liquidity.cash_ratio), benchmark: 'n/a', pct: 50, tone: 'g-blue' },
        ]} />
        <RatioCard title="Profitability" rows={[
          { label: 'Gross Margin', value: pct(r.profitability.gross_margin), benchmark: '> 45%', pct: r.profitability.gross_margin / 45 * 100, tone: r.profitability.gross_margin >= 45 ? 'g-green' : r.profitability.gross_margin < 0 ? 'g-red' : 'g-amber' },
          { label: 'EBITDA Margin', value: pct(r.profitability.ebitda_margin), benchmark: '> 10%', pct: r.profitability.ebitda_margin / 10 * 100, tone: r.profitability.ebitda_margin >= 10 ? 'g-green' : 'g-red' },
          { label: 'Net Margin', value: pct(r.profitability.net_margin), benchmark: '> 8%', pct: r.profitability.net_margin / 8 * 100, tone: r.profitability.net_margin >= 8 ? 'g-green' : 'g-red' },
          { label: 'ROE', value: pct(r.profitability.roe), benchmark: '> 15%', pct: r.profitability.roe / 15 * 100, tone: r.profitability.roe >= 15 ? 'g-green' : r.profitability.roe < 0 ? 'g-red' : 'g-amber' },
          { label: 'ROCE', value: pct(r.profitability.roce), benchmark: '> 15%', pct: r.profitability.roce / 15 * 100, tone: r.profitability.roce >= 15 ? 'g-green' : r.profitability.roce < 0 ? 'g-red' : 'g-amber' },
        ]} />
        <RatioCard title="Leverage" rows={[
          { label: 'Debt / Equity', value: fx(r.leverage.debt_equity), benchmark: '< 1.0x', pct: (1 / Math.max(r.leverage.debt_equity, 0.01)) * 100, tone: r.leverage.debt_equity <= 1 ? 'g-green' : 'g-red' },
          { label: 'Interest Cover', value: fx(r.leverage.interest_cover), benchmark: '> 3.0x', pct: r.leverage.interest_cover / 3 * 100, tone: r.leverage.interest_cover >= 3 ? 'g-green' : 'g-amber' },
          { label: 'DSCR', value: fx(r.leverage.dscr), benchmark: 'n/a', pct: 50, tone: 'g-blue' },
        ]} />
        <RatioCard title="Efficiency" rows={[
          { label: 'Asset Turnover', value: fx(r.efficiency.asset_turnover), benchmark: 'n/a', pct: 50, tone: 'g-blue' },
          { label: 'DSO', value: `${r.efficiency.dso} days`, benchmark: '< 60 days', pct: (60 / Math.max(r.efficiency.dso, 1)) * 100, tone: r.efficiency.dso <= 60 ? 'g-green' : 'g-red' },
          { label: 'DPO', value: `${r.efficiency.dpo} days`, benchmark: '30–45 days', pct: 60, tone: 'g-blue' },
          { label: 'Cash Conversion Cycle', value: `${r.efficiency.ccc} days`, benchmark: 'n/a', pct: 50, tone: 'g-blue' },
        ]} />
      </div>
      <div className="card">
        <div className="card-hdr"><span className="ct">DuPont Analysis</span></div>
        <div className="card-body so-grid" style={{ marginBottom: 0 }}>
          <div className="so-item"><div className="so-lbl">Net Margin</div><div className="so-val">{pct(r.dupont.net_margin)}</div></div>
          <div className="so-item"><div className="so-lbl">Asset Turnover</div><div className="so-val">{fx(r.dupont.asset_turnover)}</div></div>
          <div className="so-item"><div className="so-lbl">Equity Multiplier</div><div className="so-val">{fx(r.dupont.equity_multiplier)}</div></div>
          <div className="so-item" style={{ gridColumn: '1 / -1' }}><div className="so-lbl">Return on Equity (Net Margin × Turnover × Multiplier)</div><div className="so-val">{pct(r.dupont.roe)}</div></div>
        </div>
      </div>
    </div>
  );
}
