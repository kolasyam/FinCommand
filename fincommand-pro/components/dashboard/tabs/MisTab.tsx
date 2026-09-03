'use client';

import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { Kpi } from '../Kpi';
import { fl as flRaw, fn as fnRaw, pct, signedPct, numTone, kpiTone, getFyShortLabel, getUnitHeader, unitSuffix } from '@/lib/utils/format';
import { DownloadBar } from '../DownloadBar';
import { ThreeYearBanner, ThreeYearHeader, ThreeYearRow } from '../ThreeYearFrame';

export function MisTab() {
  const { bundle, granularity, threeYear, yearType, displayUnit, presentationCurrency } = useDashboard();
  // Shadow fl()/fn() with the currently-selected table unit (Lakhs/
  // Thousands/Crores) bound in — every existing fl(v)/fn(v) call below
  // stays unchanged.
  const fl = (n: number | null | undefined, d?: number) => flRaw(n, d, displayUnit);
  const fn = (n: number | null | undefined, d?: number) => fnRaw(n, d, displayUnit);
  const unitLabel = getUnitHeader(displayUnit, presentationCurrency);
  const unitSfx = unitSuffix(displayUnit);

  // ── 3-Year mode ────────────────────────────────────────────────────────────
  if (granularity === '3year' && threeYear) {
    const { years } = threeYear;

    const rows: { label: string; get: (y: typeof years[0]) => number | undefined | null; bold?: boolean; grand?: boolean; isPct?: boolean; tone?: boolean }[] = [
      { label: 'Revenue from Operations', get: y => y.mis?.rev, bold: true },
      { label: 'Gross Profit',             get: y => y.mis && (y.mis.rev - y.mis.cos), bold: true, tone: true },
      { label: 'EBITDA',                   get: y => y.mis?.ebitda, bold: true, tone: true },
      { label: 'Profit Before Tax',        get: y => y.mis?.pbt, tone: true },
      { label: 'Profit After Tax',         get: y => y.mis?.pat, grand: true, tone: true },
      { label: 'Gross Margin %',           get: y => y.mis?.gm, isPct: true, tone: true },
      { label: 'EBITDA Margin %',          get: y => y.mis?.em, isPct: true, tone: true },
      { label: 'PAT Margin %',             get: y => y.mis?.pm, isPct: true, tone: true },
    ];

    const latestWithData = [...years].reverse().find(y => !y.no_data);

    return (
      <div>
        <ThreeYearBanner years={years} />
        {latestWithData && (
          <div className="grid3" style={{ marginBottom: 16 }}>
            <Kpi label={`Revenue (${latestWithData.financial_year.short_label})`} value={fl(latestWithData.mis?.rev ?? 0)} tone="neu" />
            <Kpi label="Gross Margin" value={pct(latestWithData.mis?.gm ?? 0)} tone={kpiTone(latestWithData.mis?.gm)} />
            <Kpi label="EBITDA Margin" value={pct(latestWithData.mis?.em ?? 0)} tone={kpiTone(latestWithData.mis?.em)} />
          </div>
        )}
        <div className="card">
          <div className="card-hdr">
            <span className="ct">MIS — 3-Year P&amp;L Comparison <span className="cbadge cb-blue">Annual</span></span>
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
  const { mis, prev_mis: prevMis, prev_financial_year: prevFy, financial_year, period_label } = bundle;
  const t = mis.totals;

  // In CY mode derive a human-readable label like "CY 2026" from the FY end_date
  const displayLabel = yearType === 'CY'
    ? `CY ${financial_year.end_date.slice(0, 4)}`
    : financial_year.label;

  const revYoy = prevMis && prevMis.totals.rev !== 0 ? (t.rev - prevMis.totals.rev) / Math.abs(prevMis.totals.rev) * 100 : null;
  const prevFyShort = getFyShortLabel(prevFy, yearType);

  const rows: { label: string; key: keyof typeof mis.data[number]; bold?: boolean; grand?: boolean; tone?: boolean }[] = [
    { label: 'Revenue from Operations', key: 'rev', bold: true },
    { label: 'Other Income', key: 'oth' },
    { label: 'Total Income', key: 'totInc', bold: true },
    { label: 'Cost of Services', key: 'cos' },
    { label: 'Employee Benefits', key: 'emp' },
    { label: 'Other Expenses', key: 'oex' },
    { label: 'EBITDA (Operating)', key: 'ebitda', bold: true, tone: true },
    { label: 'Finance Costs', key: 'fin' },
    { label: 'Depreciation & Amortisation', key: 'dep' },
    { label: 'Total Expenses', key: 'totExp', bold: true },
    { label: 'Profit Before Tax', key: 'pbt', bold: true, tone: true },
    { label: 'Tax (25%, estimated)', key: 'tax' },
    { label: 'Profit After Tax', key: 'pat', grand: true, tone: true },
  ];

  return (
    <div>
      <DownloadBar
        title={`MIS Report — Monthly P&L · ${displayLabel}`}
        subtitle={`Month-wise Revenue · Gross Profit · EBITDA · PAT · Margins · ${unitLabel}`}
        section="mis"
      />
      <div className="grid3">
        <Kpi
          label="Period Revenue"
          value={fl(t.rev)}
          change={revYoy != null ? `${signedPct(revYoy)} vs ${prevFyShort}` : period_label}
          tone={revYoy != null ? kpiTone(revYoy) : 'neu'}
        />
        <Kpi label="Gross Margin" value={pct(t.gm)} change={`GP ${fl(t.rev - t.cos)}${unitSfx}`} tone={kpiTone(t.gm)} />
        <Kpi label="EBITDA Margin" value={pct(t.em)} change={`EBITDA ${fl(t.ebitda)}${unitSfx}`} tone={kpiTone(t.em)} />
      </div>
      <div className="card">
        <div className="card-hdr">
          <span className="ct">Monthly MIS — P&amp;L</span>
          <span className="cbadge cb-blue">{unitLabel}</span>
          <span className="cbadge cb-blue">{period_label}</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="fc-table">
            <thead>
              <tr>
                <th>Particulars</th>
                {mis.columns.map(c => <th key={c} className="num">{c}</th>)}
                <th className="num bold">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.label} className={r.grand ? 'grand-row' : r.bold ? 'tot-row' : undefined}>
                  <td className={r.bold || r.grand ? 'bold' : undefined}>{r.label}</td>
                  {mis.data.map((d, i) => (
                    <td key={i} className={`num ${r.tone ? numTone(d[r.key] as number) : ''}`}>{fn(d[r.key] as number)}</td>
                  ))}
                  <td className={`num bold ${r.tone ? numTone(t[r.key as keyof typeof t] as number) : ''}`}>{fn(t[r.key as keyof typeof t] as number)}</td>
                </tr>
              ))}
              <tr>
                <td>Gross Margin %</td>
                {mis.data.map((d, i) => <td key={i} className={`num ${numTone(d.gm)}`}>{pct(d.gm)}</td>)}
                <td className={`num bold ${numTone(t.gm)}`}>{pct(t.gm)}</td>
              </tr>
              <tr>
                <td>EBITDA Margin %</td>
                {mis.data.map((d, i) => <td key={i} className={`num ${numTone(d.em)}`}>{pct(d.em)}</td>)}
                <td className={`num bold ${numTone(t.em)}`}>{pct(t.em)}</td>
              </tr>
              <tr>
                <td>PAT Margin %</td>
                {mis.data.map((d, i) => <td key={i} className={`num ${numTone(d.pm)}`}>{pct(d.pm)}</td>)}
                <td className={`num bold ${numTone(t.pm)}`}>{pct(t.pm)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="info-bar" style={{ marginTop: 10, fontSize: 11 }}>
        Revenue, income and expense lines above are computed directly from real Trial Balance ledger movements for each month — no assumed percentages. <strong>Tax</strong> is the one modeled line: this Trial Balance carries no dedicated tax-provision ledger to derive a real figure from, so it&apos;s estimated at a flat 25% of Profit Before Tax in a profitable month (each month independently, matching the annual Total column exactly) — and nil in a loss-making month (PBT ≤ 0), per IND AS 12, since no company owes current tax on a loss. Treat PAT below EBITDA/PBT as indicative for planning, not a substitute for your actual tax computation.
      </div>
    </div>
  );
}
