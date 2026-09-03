'use client';

import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { fn, getFyLabel, unitSuffix } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { DownloadBar } from '../DownloadBar';
import { ThreeYearBanner } from '../ThreeYearFrame';

type Level = 'critical' | 'warning' | 'info-a' | 'success-a';
type Dot = 'dot-cr' | 'dot-wa' | 'dot-in' | 'dot-ok';
interface Alert { level: Level; dot: Dot; text: string }

function buildAlerts(y: { ratios?: { liquidity: { current_ratio: number }; leverage: { debt_equity: number }; efficiency: { dso: number }; profitability: { ebitda_margin: number } }; bs_summary?: { balanced: boolean } }, fyLabel: string): Alert[] {
  const alerts: Alert[] = [];
  if (y.bs_summary) {
    if (!y.bs_summary.balanced) {
      alerts.push({ level: 'critical', dot: 'dot-cr', text: `BS out of balance — review ledger mappings for ${fyLabel}.` });
    } else {
      alerts.push({ level: 'success-a', dot: 'dot-ok', text: `Balance Sheet tallies for ${fyLabel}.` });
    }
  }
  if (y.ratios) {
    if (y.ratios.liquidity.current_ratio < 1.5)
      alerts.push({ level: 'warning', dot: 'dot-wa', text: `Current ratio (${y.ratios.liquidity.current_ratio}x) below 1.5x benchmark.` });
    if (y.ratios.leverage.debt_equity > 1)
      alerts.push({ level: 'warning', dot: 'dot-wa', text: `Debt/Equity (${y.ratios.leverage.debt_equity}x) exceeds 1.0x benchmark.` });
    if (y.ratios.efficiency.dso > 60)
      alerts.push({ level: 'warning', dot: 'dot-wa', text: `DSO (${y.ratios.efficiency.dso}d) exceeds 60-day benchmark.` });
    if (y.ratios.profitability.ebitda_margin < 10)
      alerts.push({ level: 'critical', dot: 'dot-cr', text: `EBITDA margin (${y.ratios.profitability.ebitda_margin}%) below 10% benchmark.` });
    else
      alerts.push({ level: 'success-a', dot: 'dot-ok', text: `EBITDA margin (${y.ratios.profitability.ebitda_margin}%) is healthy.` });
  }
  return alerts;
}

export function AlertsTab() {
  const { bundle, granularity, threeYear, dataMode, yearType, displayUnit, presentationCurrency } = useDashboard();
  const symbol = getCurrencyMeta(presentationCurrency).symbol;

  // ── 3-Year mode ────────────────────────────────────────────────────────────
  if (granularity === '3year' && threeYear) {
    const { years } = threeYear;
    return (
      <div>
        <ThreeYearBanner years={years} />
        <div className="grid3">
          {years.map(y => (
            <div key={y.financial_year.id} className="card">
              <div className="card-hdr">
                <span className="ct">{y.financial_year.short_label || y.financial_year.label}</span>
                {y.no_data && <span className="cbadge cb-amber">No data</span>}
              </div>
              <div className="card-body">
                {y.no_data ? (
                  <div className="alert-item info-a">
                    <span className="alert-dot dot-in" />
                    <span>No Trial Balance uploaded for this year. Upload TB to see alerts.</span>
                  </div>
                ) : (
                  buildAlerts(y, y.financial_year.label).map((a, i) => (
                    <div key={i} className={`alert-item ${a.level}`}>
                      <span className={`alert-dot ${a.dot}`} />
                      <span>{a.text}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
          {/* Ghost cards for missing years */}
          {Array.from({ length: Math.max(0, 3 - years.length) }).map((_, i) => (
            <div key={`ghost-${i}`} className="card">
              <div className="card-hdr">
                <span className="ct" style={{ color: 'var(--text3)', fontStyle: 'italic' }}>Upload TB</span>
              </div>
              <div className="card-body">
                <div className="alert-item info-a">
                  <span className="alert-dot dot-in" />
                  <span>Upload a Trial Balance for this year to see alerts.</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Single-year mode ───────────────────────────────────────────────────────
  if (!bundle) return null;
  const { bs, ratios, financial_year } = bundle;

  const alerts: Alert[] = [];
  if (!bs.balanced) {
    alerts.push({ level: 'critical', dot: 'dot-cr', text: `Balance Sheet is out of balance by ${symbol}${fn(bs.difference, 2, displayUnit)}${unitSuffix(displayUnit)} — review ledger mappings for ${financial_year.label}.` });
  } else {
    alerts.push({ level: 'success-a', dot: 'dot-ok', text: `Balance Sheet tallies for ${financial_year.label} (Assets = Equity + Liabilities).` });
  }
  if (ratios.liquidity.current_ratio < 1.5)
    alerts.push({ level: 'warning', dot: 'dot-wa', text: `Current ratio (${ratios.liquidity.current_ratio}x) is below the 1.5x benchmark — monitor short-term liquidity.` });
  if (ratios.leverage.debt_equity > 1)
    alerts.push({ level: 'warning', dot: 'dot-wa', text: `Debt/Equity (${ratios.leverage.debt_equity}x) exceeds the 1.0x benchmark.` });
  if (ratios.efficiency.dso > 60)
    alerts.push({ level: 'warning', dot: 'dot-wa', text: `DSO (${ratios.efficiency.dso} days) exceeds the 60-day benchmark — receivables collection may be slowing.` });
  if (ratios.profitability.ebitda_margin < 10)
    alerts.push({ level: 'critical', dot: 'dot-cr', text: `EBITDA margin (${ratios.profitability.ebitda_margin}%) is below the 10% benchmark.` });
  else
    alerts.push({ level: 'success-a', dot: 'dot-ok', text: `EBITDA margin (${ratios.profitability.ebitda_margin}%) is healthy against the 10% benchmark.` });
  if (financial_year.is_locked)
    alerts.push({ level: 'info-a', dot: 'dot-in', text: `${financial_year.label} is locked (post-audit) — uploads are disabled for this year.` });
  if (dataMode === 'sample')
    alerts.push({ level: 'info-a', dot: 'dot-in', text: 'Viewing sample data — sign in and upload a Trial Balance to see alerts for your real financials.' });

  const fyLabel = getFyLabel(financial_year, yearType);

  return (
    <div>
      <DownloadBar title={`Smart Alerts & Audit Triggers · ${fyLabel}`} subtitle={`Risk indicators & compliance checks`} section="alerts" />
      <div className="card">
        <div className="card-hdr"><span className="ct">Smart Alerts — {fyLabel}</span><span className="cbadge cb-blue">{alerts.length} items</span></div>
        <div className="card-body">
          {alerts.map((a, i) => (
            <div key={i} className={`alert-item ${a.level}`}>
              <span className={`alert-dot ${a.dot}`} />
              <span>{a.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
