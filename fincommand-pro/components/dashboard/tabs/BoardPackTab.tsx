'use client';

import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { DownloadBar } from '../DownloadBar';
import { fc as fcRaw, fl as flRaw, fn as fnRaw, pct, numTone, getFyLabel, getUnitHeader, unitSuffix } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { ThreeYearBanner, ThreeYearHeader, ThreeYearRow } from '../ThreeYearFrame';

export function BoardPackTab() {
  const { bundle, granularity, threeYear, yearType, displayUnit, presentationCurrency } = useDashboard();
  // Shadow fl()/fn()/fc() with the currently-selected table unit (Lakhs/
  // Thousands/Crores) / active Presentation Currency bound in — every
  // existing fl(v)/fn(v)/fc(v) call below stays unchanged.
  const fl = (n: number | null | undefined, d?: number) => flRaw(n, d, displayUnit);
  const fn = (n: number | null | undefined, d?: number) => fnRaw(n, d, displayUnit);
  const fc = (n: number | null | undefined) => fcRaw(n, presentationCurrency);
  const unitLabel = getUnitHeader(displayUnit, presentationCurrency);
  const unitSfx = unitSuffix(displayUnit);
  const symbol = getCurrencyMeta(presentationCurrency).symbol;

  // ── 3-Year mode ────────────────────────────────────────────────────────────
  if (granularity === '3year' && threeYear) {
    const { years, cagr } = threeYear;

    const plRows: { label: string; get: (y: typeof years[0]) => number | undefined | null; isPct?: boolean; tone?: boolean; bold?: boolean; grand?: boolean }[] = [
      { label: 'Revenue',          get: y => y.mis?.rev, bold: true },
      { label: 'Gross Profit',     get: y => y.mis && (y.mis.rev - y.mis.cos), tone: true },
      { label: 'EBITDA',           get: y => y.mis?.ebitda, tone: true },
      { label: 'EBITDA Margin',    get: y => y.mis?.em, isPct: true, tone: true },
      { label: 'PAT',              get: y => y.mis?.pat, tone: true, grand: true },
      { label: 'PAT Margin',       get: y => y.mis?.pm, isPct: true, tone: true },
    ];

    const bsRows: { label: string; get: (y: typeof years[0]) => number | undefined | null; bold?: boolean }[] = [
      { label: 'Total Assets',     get: y => y.bs_summary?.total_assets, bold: true },
      { label: 'Equity',           get: y => y.bs_summary?.equity },
      { label: 'Debt (NCL + CL)',  get: y => y.bs_summary ? (y.bs_summary.ncl ?? 0) + (y.bs_summary.cl ?? 0) : null },
    ];

    const cfRows: { label: string; get: (y: typeof years[0]) => number | undefined | null; tone?: boolean; bold?: boolean }[] = [
      { label: 'Operating CF',     get: y => y.cashflow?.ocf, tone: true, bold: true },
      { label: 'Investing CF',     get: y => y.cashflow?.icf, tone: true },
      { label: 'Closing Cash',     get: y => y.cashflow?.closing_cash },
    ];

    const ratioRows: { label: string; get: (y: typeof years[0]) => number | undefined | null; unit: 'pct' | 'x' }[] = [
      { label: 'ROE',              get: y => y.ratios?.profitability.roe, unit: 'pct' },
      { label: 'ROCE',             get: y => y.ratios?.profitability.roce, unit: 'pct' },
      { label: 'Current Ratio',    get: y => y.ratios?.liquidity.current_ratio, unit: 'x' },
      { label: 'Debt / Equity',    get: y => y.ratios?.leverage.debt_equity, unit: 'x' },
    ];

    const renderSection = (
      title: string,
      rows: { label: string; get: (y: typeof years[0]) => number | undefined | null; isPct?: boolean; tone?: boolean; bold?: boolean; grand?: boolean }[],
      unitBadge?: string,
    ) => (
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-hdr">
          <span className="ct">{title}</span>
          {unitBadge && <span className="cbadge cb-blue">{unitBadge}</span>}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="fc-table">
            <ThreeYearHeader years={years} particularHeader="Particulars" />
            <tbody>
              {rows.map(r => (
                <ThreeYearRow
                  key={r.label}
                  label={r.label}
                  years={years}
                  values={years.map(y => y.no_data ? null : (() => {
                    const v = r.get(y);
                    return v == null ? null : (r.isPct ? pct(v) : fn(v));
                  })())}
                  tones={r.tone ? years.map(y => { const v = r.get(y); return v == null ? '' : numTone(v); }) : undefined}
                  bold={r.bold}
                  grand={r.grand}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );

    const renderRatioSection = () => (
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-hdr"><span className="ct">Key Ratios</span></div>
        <div style={{ overflowX: 'auto' }}>
          <table className="fc-table">
            <ThreeYearHeader years={years} particularHeader="Particulars" />
            <tbody>
              {ratioRows.map(r => (
                <ThreeYearRow
                  key={r.label}
                  label={r.label}
                  years={years}
                  values={years.map(y => {
                    if (y.no_data) return null;
                    const v = r.get(y);
                    if (v == null) return null;
                    return r.unit === 'pct' ? pct(v) : `${v.toFixed(2)}x`;
                  })}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );

    return (
      <div>
        <ThreeYearBanner years={years} />
        <div className="bp-section">
          <div className="bp-hdr"><span>3-Year Board Summary</span></div>
        </div>
        {renderSection('Profit & Loss', plRows, unitLabel)}
        {renderSection('Balance Sheet', bsRows, unitLabel)}
        {renderSection('Cash Flow', cfRows, unitLabel)}
        {renderRatioSection()}
        {cagr && (
          <div className="info-bar">
            <strong>CAGR:</strong> Revenue {cagr.revenue != null ? pct(cagr.revenue) : 'n/a'} · PAT {cagr.pat != null ? pct(cagr.pat) : 'n/a'}
            {years.filter(y => !y.no_data).length < 3 && ` (based on ${years.filter(y => !y.no_data).length} year${years.filter(y => !y.no_data).length !== 1 ? 's' : ''})`}
          </div>
        )}
      </div>
    );
  }

  // ── Single-year mode ───────────────────────────────────────────────────────
  if (!bundle) return null;
  const { mis, bs, ratios, cashflow, treasury, financial_year, period_label } = bundle;
  const t = mis.totals;
  const ocfTotal = (cashflow.operating as Record<string, unknown>).total as number;

  const highlights: { tone: 'hl-green' | 'hl-amber' | 'hl-red' | 'hl-blue'; text: string }[] = [
    { tone: numTone(t.rev) === 'dn' ? 'hl-red' : 'hl-green', text: `Revenue of ${fc(t.rev)} with EBITDA margin of ${pct(t.em)} for ${period_label}.` },
    { tone: bs.balanced ? 'hl-blue' : 'hl-red', text: bs.balanced ? 'Balance Sheet tallies — no reconciliation issues flagged.' : `Balance Sheet out of balance by ${symbol}${fl(bs.difference)}${unitSfx} — needs review before board sign-off.` },
    { tone: ratios.liquidity.current_ratio >= 1.5 ? 'hl-green' : 'hl-amber', text: `Current ratio at ${ratios.liquidity.current_ratio.toFixed(2)}x (benchmark 1.5x).` },
    { tone: 'hl-blue', text: `Treasury position of ${symbol}${fl(treasury.total)}${unitSfx} across cash, bank, FDs and MFs.` },
  ];

  return (
    <div>
      <DownloadBar title={`Board Pack · ${getFyLabel(financial_year, yearType)}`} subtitle={`Executive summary · ${period_label}`} section="boardpack" />
      <div className="bp-section">
        <div className="bp-hdr"><span>Financial Highlights</span></div>
        <div className="bp-body">
          <div className="bp-kpi-row">
            <div className="bp-kpi"><div className="bl">Revenue</div><div className="bv">{fc(t.rev)}</div></div>
            <div className="bp-kpi"><div className="bl">EBITDA</div><div className={`bv ${numTone(t.ebitda)}`}>{fc(t.ebitda)}</div></div>
            <div className="bp-kpi"><div className="bl">PAT</div><div className={`bv ${numTone(t.pat)}`}>{fc(t.pat)}</div></div>
            <div className="bp-kpi"><div className="bl">OCF</div><div className={`bv ${numTone(ocfTotal)}`}>{fc(ocfTotal)}</div></div>
          </div>
          {highlights.map((h, i) => <div key={i} className={`hl-row ${h.tone}`}>{h.text}</div>)}
        </div>
      </div>
      <div className="bp-section">
        <div className="bp-hdr"><span>Key Ratios</span></div>
        <div className="bp-body so-grid" style={{ marginBottom: 0 }}>
          <div className="so-item"><div className="so-lbl">ROE</div><div className={`so-val ${numTone(ratios.profitability.roe)}`}>{pct(ratios.profitability.roe)}</div></div>
          <div className="so-item"><div className="so-lbl">ROCE</div><div className={`so-val ${numTone(ratios.profitability.roce)}`}>{pct(ratios.profitability.roce)}</div></div>
          <div className="so-item"><div className="so-lbl">Debt/Equity</div><div className="so-val">{ratios.leverage.debt_equity.toFixed(2)}x</div></div>
        </div>
      </div>
    </div>
  );
}
