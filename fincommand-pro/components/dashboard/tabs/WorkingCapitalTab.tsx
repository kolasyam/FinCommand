'use client';

import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { fl as flRaw, numTone, getFyLabel, getUnitHeader, unitSuffix } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { DownloadBar } from '../DownloadBar';
import { ThreeYearBanner, ThreeYearHeader, ThreeYearRow } from '../ThreeYearFrame';

export function WorkingCapitalTab() {
  const { bundle, granularity, threeYear, yearType, displayUnit, presentationCurrency } = useDashboard();
  // Shadow fl() with the currently-selected table unit — every existing
  // fl(v) call below stays unchanged.
  const fl = (n: number | null | undefined, d?: number) => flRaw(n, d, displayUnit);
  const unitLabel = getUnitHeader(displayUnit, presentationCurrency);
  const unitSfx = unitSuffix(displayUnit);
  const symbol = getCurrencyMeta(presentationCurrency).symbol;

  // ── 3-Year mode ────────────────────────────────────────────────────────────
  if (granularity === '3year' && threeYear) {
    const { years } = threeYear;

    return (
      <div>
        <ThreeYearBanner years={years} />
        <div className="card">
          <div className="card-hdr">
            <span className="ct">Working Capital Metrics — 3-Year Comparison</span>
            <span className="cbadge cb-blue">{unitLabel}, days</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="fc-table">
              <ThreeYearHeader years={years} />
              <tbody>
                <ThreeYearRow label="Days Sales Outstanding (DSO)" years={years} values={years.map(y => y.ratios ? `${y.ratios.efficiency.dso}d` : null)} />
                <ThreeYearRow label="Days Payable Outstanding (DPO)" years={years} values={years.map(y => y.ratios ? `${y.ratios.efficiency.dpo}d` : null)} />
                <ThreeYearRow label="Cash Conversion Cycle (CCC)" years={years} values={years.map(y => y.ratios ? `${y.ratios.efficiency.ccc}d` : null)} bold grand />
                <ThreeYearRow label="Total Current Assets" years={years} values={years.map(y => y.bs_summary ? fl(y.bs_summary.ca) : null)} />
                <ThreeYearRow label="Total Current Liabilities" years={years} values={years.map(y => y.bs_summary ? fl(y.bs_summary.cl) : null)} />
                <ThreeYearRow
                  label="Net Working Capital (CA - CL)"
                  years={years}
                  values={years.map(y => y.bs_summary ? fl(y.bs_summary.ca - y.bs_summary.cl) : null)}
                  tones={years.map(y => y.bs_summary ? numTone(y.bs_summary.ca - y.bs_summary.cl) : '')}
                  bold
                />
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // ── Single-year mode ───────────────────────────────────────────────────────
  if (!bundle) return null;
  const { bs, ratios, financial_year } = bundle;
  const fyLabel = getFyLabel(financial_year, yearType);
  const nwc = bs.assets.total_ca - bs.equity_liabilities.total_cl;

  const rows = [
    { name: 'Trade Receivables', value: bs.assets.current.find(n => n.note_no === 16)?.total || 0, bench: `DSO ${ratios.efficiency.dso}d`, max: bs.assets.total_ca, color: '#378ADD' },
    { name: 'Inventories', value: bs.assets.current.find(n => n.note_no === 15)?.total || 0, bench: 'vs CA', max: bs.assets.total_ca, color: '#EF9F27' },
    { name: 'Trade Payables', value: bs.equity_liabilities.current_liab.find(n => n.note_no === 7)?.total || 0, bench: `DPO ${ratios.efficiency.dpo}d`, max: bs.equity_liabilities.total_cl, color: '#1D9E75' },
    { name: 'Other Current Assets', value: bs.assets.total_ca - (bs.assets.current.find(n => n.note_no === 16)?.total || 0) - (bs.assets.current.find(n => n.note_no === 15)?.total || 0), bench: 'vs CA', max: bs.assets.total_ca, color: '#3C3489' },
  ];

  return (
    <div>
      <DownloadBar title={`Working Capital Analysis · ${fyLabel}`} subtitle={`DSO, DPO, CCC & Current Position · ${unitLabel}`} section="workingcapital" />
      <div className="info-bar">
        Working capital position for {fyLabel} — Cash Conversion Cycle: <strong>{ratios.efficiency.ccc} days</strong> (DSO {ratios.efficiency.dso}d + inventory − DPO {ratios.efficiency.dpo}d). Net Working Capital: <strong className={numTone(nwc)}>{symbol}{fl(nwc)}{unitSfx}</strong>.
      </div>
      <div className="card">
        <div className="card-hdr"><span className="ct">Working Capital Components</span><span className="cbadge cb-blue">{unitLabel}</span></div>
        <div className="card-body">
          {rows.map(r => (
            <div key={r.name} className="wc-row">
              <span className="wc-name">{r.name}</span>
              <div className="wc-bar-outer"><div className="wc-bar-inner" style={{ width: `${Math.min(100, Math.max(2, (r.value / Math.max(r.max, 1)) * 100))}%`, background: r.color }} /></div>
              <span className="wc-val">{fl(r.value)}</span>
              <span className="wc-bench">{r.bench}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="grid3">
        <div className="kpi"><div className="lbl">Current Ratio</div><div className="val">{ratios.liquidity.current_ratio.toFixed(2)}x</div><div className="chg neu">Benchmark &gt; 1.5x</div></div>
        <div className="kpi"><div className="lbl">Quick Ratio</div><div className="val">{ratios.liquidity.quick_ratio.toFixed(2)}x</div><div className="chg neu">Benchmark &gt; 1.0x</div></div>
        <div className="kpi"><div className="lbl">Cash Conversion Cycle</div><div className="val">{ratios.efficiency.ccc}d</div><div className="chg neu">Lower is better</div></div>
      </div>
    </div>
  );
}
