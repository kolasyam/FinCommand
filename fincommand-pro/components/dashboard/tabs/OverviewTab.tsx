'use client';

import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { Kpi } from '../Kpi';
import { RevenueEbitdaChart } from '@/components/charts/RevenueEbitdaChart';
import { MarginTrendChart } from '@/components/charts/MarginTrendChart';
import { fc as fcRaw, fl as flRaw, fn as fnRaw, frRaw, pct, signedPct, numTone, kpiTone, getFyLabel, getFyShortLabel, getUnitHeader } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { DownloadBar } from '../DownloadBar';

export function OverviewTab() {
  const { bundle, threeYear, granularity, yearType, dataMode, displayUnit, presentationCurrency } = useDashboard();
  // Shadow fl()/fn()/fc() with the currently-selected table unit (Lakhs/
  // Thousands/Crores) / active Presentation Currency bound in — every
  // existing fl(v)/fn(v)/fc(v) call below stays unchanged. frRaw() (Top
  // Customers' already-Crores figures) is deliberately left untouched — see
  // format.ts's doc comments for why.
  const fl = (n: number | null | undefined, d?: number) => flRaw(n, d, displayUnit);
  const fn = (n: number | null | undefined, d?: number) => fnRaw(n, d, displayUnit);
  const fc = (n: number | null | undefined) => fcRaw(n, presentationCurrency);
  const unitLabel = getUnitHeader(displayUnit, presentationCurrency);
  const symbol = getCurrencyMeta(presentationCurrency).symbol;

  if (granularity === '3year' && threeYear) {
    return (
      <div>
        <div className="grid3">
          {threeYear.years.map((y, i) => {
            const prev = i > 0 ? threeYear.years[i - 1] : null;
            const growth = prev?.mis && y.mis && prev.mis.rev > 0 ? ((y.mis.rev - prev.mis.rev) / prev.mis.rev * 100) : null;
            return (
              <Kpi
                key={y.financial_year.id}
                label={y.financial_year.label}
                value={y.mis ? fc(y.mis.rev) : '—'}
                tone={growth === null ? 'neu' : kpiTone(growth)}
                change={y.mis ? `${growth !== null ? `Rev ${signedPct(growth)} YoY | ` : 'Base year | '}EBITDA ${pct(y.mis.em)}` : 'No data'}
              />
            );
          })}
        </div>
        <div className="grid3">
          {threeYear.years.map(y => (
            <Kpi
              key={`pat-${y.financial_year.id}`}
              label={`PAT — ${y.financial_year.short_label}`}
              value={y.mis ? fc(y.mis.pat) : '—'}
              tone={y.mis ? kpiTone(y.mis.pat) : 'neu'}
              change={y.mis ? `Net ${pct(y.mis.pm)} | GM ${pct(y.mis.gm)}` : undefined}
            />
          ))}
        </div>
        {threeYear.cagr && (
          <div className="info-bar">
            3-Year CAGR: Revenue {threeYear.cagr.revenue !== null ? signedPct(threeYear.cagr.revenue) : 'n/a'} · PAT {threeYear.cagr.pat !== null ? signedPct(threeYear.cagr.pat) : 'n/a'}
          </div>
        )}
      </div>
    );
  }

  if (!bundle) return null;

  const { mis } = bundle;
  const t = mis.totals;
  const labels = mis.columns;
  const revenue = mis.data.map(d => d.rev);
  const ebitda = mis.data.map(d => d.ebitda);
  const gm = mis.data.map(d => d.gm);
  const em = mis.data.map(d => d.em);
  const pm = mis.data.map(d => d.pm);

  return (
    <div>
      <DownloadBar title={`Executive Overview · ${getFyLabel(bundle.financial_year, yearType)}`} subtitle={`KPIs, Revenue, EBITDA, PAT & Margin Trends · ${unitLabel}`} section="overview" />
      <div className="grid4">
        <Kpi label="Revenue" value={fc(t.rev)} change={`${fl(t.rev)} ${displayUnit}`} tone="neu" />
        <Kpi label="Gross Profit" value={fc(t.rev - t.cos)} change={`GM ${pct(t.gm)}`} tone={kpiTone(t.rev - t.cos)} />
        <Kpi label="EBITDA" value={fc(t.ebitda)} change={`Margin ${pct(t.em)}`} tone={kpiTone(t.ebitda)} />
        <Kpi label="PAT" value={fc(t.pat)} change={`Net ${pct(t.pm)}`} tone={kpiTone(t.pat)} />
      </div>
      <div className="grid2">
        <div className="card">
          <div className="card-hdr">
            <span className="ct">Revenue &amp; EBITDA — {bundle.period_label}</span>
            <span className="cbadge cb-blue">{granularity === 'quarterly' ? 'Quarterly' : granularity === 'halfyear' ? 'Half-Year' : 'Annual'}</span>
          </div>
          <div className="card-body">
            <div style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--text2)', marginBottom: 8 }}>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#B5D4F4', marginRight: 4, verticalAlign: 'middle' }} />Revenue</span>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#5DCAA5', marginRight: 4, verticalAlign: 'middle' }} />EBITDA</span>
              <span style={{ marginLeft: 'auto', fontStyle: 'italic' }}>{unitLabel}</span>
            </div>
            <div style={{ position: 'relative', height: 200 }}><RevenueEbitdaChart labels={labels} revenue={revenue} ebitda={ebitda} unit={displayUnit} /></div>
          </div>
        </div>
        <div className="card">
          <div className="card-hdr"><span className="ct">Margin Trends</span><span className="cbadge cb-green">%</span></div>
          <div className="card-body">
            <div style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--text2)', marginBottom: 8 }}>
              <span><span style={{ display: 'inline-block', width: 10, height: 2, background: '#378ADD', marginRight: 4, verticalAlign: 'middle' }} />Gross %</span>
              <span><span style={{ display: 'inline-block', width: 10, height: 2, background: '#1D9E75', marginRight: 4, verticalAlign: 'middle' }} />EBITDA %</span>
              <span><span style={{ display: 'inline-block', width: 10, height: 2, background: '#EF9F27', marginRight: 4, verticalAlign: 'middle' }} />PAT %</span>
            </div>
            <div style={{ position: 'relative', height: 200 }}><MarginTrendChart labels={labels} gm={gm} em={em} pm={pm} /></div>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-hdr">
          <span className="ct">Period Summary · {bundle.financial_year.short_label} · {bundle.period_label}</span>
          <span className="cbadge cb-blue">{unitLabel}</span>
        </div>
        <div className="card-body" style={{ overflowX: 'auto' }}>
          <table className="fc-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th className="num">Value</th>
                <th className="num">% of Revenue</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Revenue</td>
                <td className="num">{fl(t.rev)}</td>
                <td className="num">100.0%</td>
              </tr>
              <tr>
                <td>Gross Profit</td>
                <td className={`num ${numTone(t.rev - t.cos)}`}>{fl(t.rev - t.cos)}</td>
                <td className={`num ${numTone(t.gm)}`}>{pct(t.gm)}</td>
              </tr>
              <tr>
                <td>EBITDA</td>
                <td className={`num ${numTone(t.ebitda)}`}>{fl(t.ebitda)}</td>
                <td className={`num ${numTone(t.em)}`}>{pct(t.em)}</td>
              </tr>
              <tr>
                <td>PBT</td>
                <td className={`num ${numTone(t.pbt)}`}>{fl(t.pbt)}</td>
                <td className={`num ${numTone(t.pbt)}`}>{t.rev > 0 ? pct(t.pbt / t.rev * 100) : '—'}</td>
              </tr>
              <tr className="tot-row">
                <td className="bold">PAT</td>
                <td className={`num bold ${numTone(t.pat)}`}>{fl(t.pat)}</td>
                <td className={`num bold ${numTone(t.pm)}`}>{pct(t.pm)}</td>
              </tr>
              <tr>
                <td>Employee Cost</td>
                <td className="num">{fl(t.emp)}</td>
                <td className="num">{t.rev > 0 ? pct(t.emp / t.rev * 100) : '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="grid2">
        <div className="card">
          <div className="card-hdr">
            <span className="ct">Top 5 Customers by Revenue</span>
            {bundle.top_customers?.[0]?.source === 'zoho' && <span className="cbadge cb-blue">Zoho — Sales by Customer</span>}
            {bundle.top_customers?.[0]?.source === 'ledger_estimate' && (
              <span className="cbadge cb-amber" title="No Zoho customer data yet — split from the current Trial Balance's own revenue ledgers instead.">
                Estimated — Revenue Ledger Split
              </span>
            )}
          </div>
          <div className="card-body" style={{ overflowX: 'auto' }}>
            {(bundle.top_customers && bundle.top_customers.length > 0) ? (
              <table className="fc-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th className="num">Revenue ({symbol}Cr)</th>
                    <th className="num">% of Revenue</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {bundle.top_customers.map((c, i) => (
                    <tr key={i}>
                      <td>{c.customer}</td>
                      <td className="num">{frRaw(c.revenue_cr, 2)}</td>
                      <td className="num">{pct(c.pct_of_total)}</td>
                      <td>
                        <span className={`pill ${c.status === 'Healthy' ? 'pg' : c.status === 'Key Account' ? 'pa' : 'pr'}`}>
                          {c.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="notice" style={{ fontSize: 12, lineHeight: 1.6 }}>
                Customer-level revenue isn&apos;t available for this Trial Balance.{' '}
                {dataMode === 'api'
                  ? 'This shows real Zoho Sales-by-Customer data when available, or a split across revenue ledgers otherwise — but your Chart of Accounts has a single aggregate revenue ledger and Zoho hasn’t returned customer-level data yet. Re-sync from the Upload tab to try pulling it from Zoho again, or split revenue into per-customer ledgers in Zoho Books.'
                  : 'Excel-uploaded Trial Balances carry ledger totals only, with no per-customer breakdown.'}
              </div>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-hdr">
            <span className="ct">Year-on-Year — {getFyShortLabel(bundle.financial_year, yearType)} vs {getFyShortLabel(bundle.prev_financial_year, yearType) || 'Prior Year'}</span>
            <span className="cbadge cb-blue">{unitLabel}</span>
          </div>
          <div className="card-body" style={{ overflowX: 'auto' }}>
            {bundle.prev_mis ? (
              <table className="fc-table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th className="num">{getFyShortLabel(bundle.financial_year, yearType)}</th>
                    <th className="num" style={{ color: 'var(--text2)' }}>{getFyShortLabel(bundle.prev_financial_year, yearType)}</th>
                    <th className="num">YoY</th>
                  </tr>
                </thead>
                <tbody>
                  {([
                    { label: 'Revenue', curr: t.rev, prev: bundle.prev_mis.totals.rev, tone: false },
                    { label: 'EBITDA', curr: t.ebitda, prev: bundle.prev_mis.totals.ebitda, tone: true },
                    { label: 'PAT', curr: t.pat, prev: bundle.prev_mis.totals.pat, tone: true, bold: true },
                    { label: 'Employee Cost', curr: t.emp, prev: bundle.prev_mis.totals.emp, tone: false },
                  ] as { label: string; curr: number; prev: number; tone: boolean; bold?: boolean }[]).map((row) => {
                    const chgPct = row.prev !== 0 ? ((row.curr - row.prev) / Math.abs(row.prev)) * 100 : null;
                    const valTone = row.tone ? numTone(row.curr) : '';
                    const prevTone = row.tone ? numTone(row.prev) : '';
                    return (
                      <tr key={row.label} className={row.bold ? 'tot-row' : undefined}>
                        <td className={row.bold ? 'bold' : undefined}>{row.label}</td>
                        <td className={`num ${row.bold ? 'bold' : ''} ${valTone}`}>{fn(row.curr)}</td>
                        <td className={`num ${prevTone}`} style={!prevTone ? { color: 'var(--text2)' } : undefined}>{fn(row.prev)}</td>
                        <td className={`num ${row.bold ? 'bold' : ''} ${chgPct === null ? '' : numTone(chgPct)}`}>
                          {chgPct === null ? '—' : signedPct(chgPct)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="notice" style={{ fontSize: 12, lineHeight: 1.6 }}>
                Prior year data is not available for {getFyShortLabel(bundle.financial_year, yearType)}
                {yearType === 'CY'
                  ? ' — Year-on-Year comparison is currently FY-only.'
                  : '. Upload or sync the previous financial year’s Trial Balance to enable Year-on-Year comparison.'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
