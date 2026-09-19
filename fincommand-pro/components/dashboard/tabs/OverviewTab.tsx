'use client';

import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { Kpi } from '../Kpi';
import { RevenueEbitdaChart } from '@/components/charts/RevenueEbitdaChart';
import { MarginTrendChart } from '@/components/charts/MarginTrendChart';
import { fl as flRaw, fn as fnRaw, frRaw, pct, fx, signedPct, numTone, kpiTone, benchmarkTone, getFyLabel, getFyShortLabel, getUnitHeader } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { DownloadBar } from '../DownloadBar';
import { CustomizableTabPanel } from './dashboard-builder/CustomizableTabPanel';
import { OVERVIEW_DEFAULT_WIDGETS } from '@/lib/dashboard-builder/default-layout';
import { findMetricCatalogEntry } from '@/lib/financial/dashboard-builder-engine';

export function OverviewTab() {
  const { bundle, threeYear, granularity, yearType, dataMode, displayUnit, presentationCurrency } = useDashboard();
  // Shadow fl()/fn() with the currently-selected table unit (Lakhs/
  // Thousands/Crores) bound in — every existing fl(v)/fn(v) call below
  // stays unchanged. frRaw() (Top Customers' already-Crores figures) is
  // deliberately left untouched — see format.ts's doc comments for why.
  // Every KPI value here now goes through fl()/fn() rather than fc() — see
  // fc()'s own doc comment: it auto-scales to Lakh/Crore regardless of the
  // topbar Unit Selector, which used to leave every card on this tab (and,
  // when Revenue's YoY% caption replaced its old unit-scaled fallback text,
  // the Revenue card specifically) with NO text that tracked the Unit
  // Selector at all — unlike every other tab (BalanceSheetTab, MisTab,
  // PLTab, TreasuryTab, CashFlowTab, ...), whose own KPI cards already use
  // fl()/fn() as their primary value.
  const fl = (n: number | null | undefined, d?: number) => flRaw(n, d, displayUnit);
  const fn = (n: number | null | undefined, d?: number) => fnRaw(n, d, displayUnit);
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
                value={y.mis ? fl(y.mis.rev) : '—'}
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
              value={y.mis ? fl(y.mis.pat) : '—'}
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

  const { mis, treasury, ratios } = bundle;
  const t = mis.totals;
  const labels = mis.columns;
  const revenue = mis.data.map(d => d.rev);
  const ebitda = mis.data.map(d => d.ebitda);
  const gm = mis.data.map(d => d.gm);
  const em = mis.data.map(d => d.em);
  const pm = mis.data.map(d => d.pm);

  // Real, already-computed cash flow/ratio/balance-sheet figures — same
  // fields BoardPackTab/TreasuryTab/RatiosTab/WorkingCapitalTab already read,
  // just surfaced here too so Executive Overview covers profitability,
  // liquidity, solvency AND cash position on one landing page.
  const ocfTotal = (bundle.cashflow.operating as Record<string, unknown>).total as number;
  // Free Cash Flow (Operating CF − Capex) — real, already-computed
  // (computeCashFlow()'s own field, identical to what CashFlowTab.tsx's own
  // fixed zone and the Cash Flow tab's `free_cash_flow` METRIC_CATALOG entry
  // both read), previously computed but never surfaced anywhere on this
  // tab despite being a headline cash metric any CFO would expect next to
  // Operating Cash Flow — added per this build's own gap audit.
  const fcfTotal = bundle.cashflow.free_cash_flow;
  const netWorkingCapital = bundle.bs.assets.total_ca - bundle.bs.equity_liabilities.total_cl;
  // Real benchmarks — read from METRIC_CATALOG's own current_ratio/roe_pct/
  // debt_equity entries rather than retyped a third time (previously Current
  // Ratio and Debt/Equity carried no tone at all, and ROE used plain
  // sign-based numTone() instead of comparing against its real 15% target —
  // a positive-but-below-benchmark ROE would have shown green/favorable).
  const crThresholds = findMetricCatalogEntry('current_ratio')!.thresholds!;
  const roeThresholds = findMetricCatalogEntry('roe_pct')!.thresholds!;
  const deThresholds = findMetricCatalogEntry('debt_equity')!.thresholds!;
  // Real YoY% (same prev_mis-derived figure the customized ov-revenue stat
  // card already shows via its own deltaPct) — this card previously showed
  // the identical Revenue number restated in the selected unit instead,
  // which carried no real information the primary value above it didn't
  // already show, and left the Fixed and Customized views displaying two
  // genuinely different pieces of context for the same KPI.
  const revYoy = bundle.prev_mis && bundle.prev_mis.totals.rev !== 0
    ? ((t.rev - bundle.prev_mis.totals.rev) / Math.abs(bundle.prev_mis.totals.rev)) * 100
    : null;

  const supplementaryView = (
    <div>
      <div className="grid4">
        <Kpi label="Revenue" value={fl(t.rev)} change={revYoy != null ? `${signedPct(revYoy)} YoY` : `${fl(t.rev)} ${displayUnit}`} tone={revYoy != null ? kpiTone(revYoy) : 'neu'} />
        <Kpi label="Gross Profit" value={fl(t.rev - t.cos)} change={`GM ${pct(t.gm)}`} tone={kpiTone(t.rev - t.cos)} />
        <Kpi label="EBITDA" value={fl(t.ebitda)} change={`Margin ${pct(t.em)}`} tone={kpiTone(t.ebitda)} />
        <Kpi label="PAT" value={fl(t.pat)} change={`Net ${pct(t.pm)}`} tone={kpiTone(t.pat)} />
      </div>
      <div className="grid3">
        <Kpi
          label="Total Treasury" value={fl(treasury.total)}
          change={`Cash & Bank ${fl(treasury.total_cash_and_bank)} | FDs ${fl(treasury.total_fd)}${treasury.total_mf > 0 ? ` | MFs ${fl(treasury.total_mf)}` : ''}`}
          tone="neu"
        />
        <Kpi
          label="Operating Cash Flow" value={fl(ocfTotal)}
          change={`OCF/PAT ${ratios.cashflow.ocf_to_pat != null ? fx(ratios.cashflow.ocf_to_pat) : 'n/a'}`}
          tone={kpiTone(ocfTotal)}
        />
        <Kpi
          label="Free Cash Flow" value={fl(fcfTotal)}
          change="Operating CF − Capex"
          tone={kpiTone(fcfTotal)}
        />
      </div>

      <div className="card">
        <div className="card-hdr">
          <span className="ct">Financial Health &amp; Solvency</span>
          <span className="cbadge cb-blue">Liquidity · Profitability · Leverage</span>
        </div>
        <div className="card-body grid4" style={{ marginBottom: 0 }}>
          <div className="so-item">
            <div className="so-lbl">Current Ratio</div>
            <div className={`so-val ${benchmarkTone(ratios.liquidity.current_ratio, crThresholds.target, crThresholds.direction)}`}>{fx(ratios.liquidity.current_ratio)}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)' }}>Benchmark &gt; 1.5x</div>
          </div>
          <div className="so-item">
            <div className="so-lbl">Net Working Capital</div>
            <div className={`so-val ${numTone(netWorkingCapital)}`}>{fn(netWorkingCapital)}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)' }}>Current Assets − Current Liabilities</div>
          </div>
          <div className="so-item">
            <div className="so-lbl">Return on Equity</div>
            <div className={`so-val ${benchmarkTone(ratios.profitability.roe, roeThresholds.target, roeThresholds.direction)}`}>{pct(ratios.profitability.roe)}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)' }}>Benchmark &gt; 15%</div>
          </div>
          <div className="so-item">
            <div className="so-lbl">Debt / Equity</div>
            <div className={`so-val ${benchmarkTone(ratios.leverage.debt_equity, deThresholds.target, deThresholds.direction)}`}>{fx(ratios.leverage.debt_equity)}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)' }}>Benchmark &lt; 1.0x</div>
          </div>
        </div>
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
    </div>
  );

  return (
    <div>
      <DownloadBar title={`Executive Overview · ${getFyLabel(bundle.financial_year, yearType)}`} subtitle={`KPIs, Treasury, Cash Flow, Ratios & Margin Trends · ${unitLabel}`} section="overview" />

      <CustomizableTabPanel tabKey="overview" defaultWidgets={OVERVIEW_DEFAULT_WIDGETS} fixedView={supplementaryView} />

      <div className="card" style={{ marginTop: 16 }}>
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
                    <th className="num">GM %</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {bundle.top_customers.map((c, i) => {
                    const marginEntry = bundle.customer_margin?.entries.find((e) => e.customer === c.customer);
                    const gm = marginEntry && marginEntry.direct_cost > 0 ? marginEntry.direct_margin_pct : null;
                    const gmTone = gm == null ? '' : gm >= 25 ? 'up' : gm < 15 ? 'dn' : '';
                    return (
                      <tr key={i}>
                        <td>{c.customer}</td>
                        <td className="num">{frRaw(c.revenue_cr, 2)}</td>
                        <td className="num">{pct(c.pct_of_total)}</td>
                        <td className={`num ${gmTone}`} title={gm == null ? 'No direct cost tagged for this customer in Zoho' : undefined}>
                          {gm != null ? pct(gm) : '—'}
                        </td>
                        <td>
                          <span className={`pill ${c.status === 'Healthy' ? 'pg' : c.status === 'Key Account' ? 'pa' : 'pr'}`}>
                            {c.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
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
            <span className="ct">Year-on-Year Variance — {getFyShortLabel(bundle.financial_year, yearType)} vs {getFyShortLabel(bundle.prev_financial_year, yearType) || 'Prior Year'}</span>
            <span className="cbadge cb-blue">{unitLabel}</span>
          </div>
          <div className="card-body" style={{ overflowX: 'auto' }}>
            {bundle.prev_mis ? (
              <table className="fc-table">
                <thead>
                  <tr>
                    <th>Head</th>
                    <th className="num">{getFyShortLabel(bundle.financial_year, yearType)}</th>
                    <th className="num" style={{ color: 'var(--text2)' }}>{getFyShortLabel(bundle.prev_financial_year, yearType)}</th>
                    <th className="num">Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {([
                    { label: 'Revenue', curr: t.rev, prev: bundle.prev_mis.totals.rev, tone: true },
                    { label: 'Gross Profit', curr: t.rev - t.cos, prev: bundle.prev_mis.totals.rev - bundle.prev_mis.totals.cos, tone: true },
                    { label: 'EBITDA', curr: t.ebitda, prev: bundle.prev_mis.totals.ebitda, tone: true },
                    { label: 'PBT', curr: t.pbt, prev: bundle.prev_mis.totals.pbt, tone: true },
                    { label: 'PAT', curr: t.pat, prev: bundle.prev_mis.totals.pat, tone: true, bold: true },
                    { label: 'Employee Cost', curr: t.emp, prev: bundle.prev_mis.totals.emp, tone: false },
                  ] as { label: string; curr: number; prev: number; tone: boolean; bold?: boolean }[]).map((row) => {
                    const chgPct = row.prev !== 0 ? ((row.curr - row.prev) / Math.abs(row.prev)) * 100 : null;
                    const valTone = row.tone ? numTone(row.curr) : '';
                    const prevTone = row.tone ? numTone(row.prev) : '';
                    const badgeClass = chgPct == null ? 'pgy' : !row.tone ? 'pgy' : chgPct >= 0 ? 'pg' : 'pr';
                    return (
                      <tr key={row.label} className={row.bold ? 'tot-row' : undefined}>
                        <td className={row.bold ? 'bold' : undefined}>{row.label}</td>
                        <td className={`num ${row.bold ? 'bold' : ''} ${valTone}`}>{fn(row.curr)}</td>
                        <td className={`num ${prevTone}`} style={!prevTone ? { color: 'var(--text2)' } : undefined}>{fn(row.prev)}</td>
                        <td className="num">
                          <span className={`pill ${badgeClass}`}>{chgPct === null ? 'n/a' : signedPct(chgPct)}</span>
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
