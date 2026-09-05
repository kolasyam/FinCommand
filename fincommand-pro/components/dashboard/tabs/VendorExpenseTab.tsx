'use client';

import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { fl as flRaw, numTone, getFyLabel, getUnitHeader, unitSuffix } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { DownloadBar } from '../DownloadBar';

const STATUS_PILL_CLASS: Record<string, string> = {
  'Concentration Risk': 'pr',
  'Key Vendor': 'pa',
  Healthy: 'pg',
};

/**
 * Vendor-level expense report — real per-vendor spend for the selected
 * period, sourced from Zoho Bills (see lib/services/zoho.ts::syncFromZoho()
 * and lib/financial/tb-engine.ts::computeVendorExpense()). Excel-uploaded
 * Trial Balances carry no vendor dimension, so this is Zoho-only — an empty
 * result is shown honestly, never a placeholder table.
 *
 * No 3-Year view: vendor spend is only stored against the current upload
 * per financial year (same as Top Customers on the Overview tab), not
 * carried into the /reports/threeyear summary bundle.
 */
export function VendorExpenseTab() {
  const { bundle, granularity, yearType, displayUnit, presentationCurrency } = useDashboard();
  const fl = (n: number | null | undefined, d?: number) => flRaw(n, d, displayUnit);
  const unitLabel = getUnitHeader(displayUnit, presentationCurrency);
  const unitSfx = unitSuffix(displayUnit);
  const symbol = getCurrencyMeta(presentationCurrency).symbol;

  if (granularity === '3year') {
    return (
      <div className="notice">
        Vendor Expense Report shows real Zoho Bills data for one period at a time — switch out of 3-Year Compare to view it.
      </div>
    );
  }

  if (!bundle) return null;
  const { financial_year, period_label, vendor_expense } = bundle;
  const fyLabel = getFyLabel(financial_year, yearType);
  const vendors = vendor_expense || [];
  const totalSpend = vendors.reduce((s, v) => s + v.amount, 0);
  const topVendor = vendors[0];
  const concentrationCount = vendors.filter(v => v.status === 'Concentration Risk').length;

  return (
    <div>
      <DownloadBar title={`Vendor Expense Report · ${fyLabel}`} subtitle={`Real per-vendor spend from Zoho Bills · ${period_label}`} section="vendor-expense" compareEnabled={false} />

      {vendors.length === 0 ? (
        <div className="notice">
          No vendor spend data available for {fyLabel}. This report is populated from Zoho Bills — connect Zoho Books and sync
          this financial year (Upload tab) to see real per-vendor spend here. Excel-uploaded Trial Balances carry no vendor dimension.
        </div>
      ) : (
        <>
          <div className="grid3">
            <div className="kpi"><div className="lbl">Total Vendor Spend</div><div className="val">{symbol}{fl(totalSpend)}{unitSfx}</div><div className="chg neu">{vendors.length} vendor{vendors.length === 1 ? '' : 's'} · {period_label}</div></div>
            <div className="kpi"><div className="lbl">Largest Vendor</div><div className="val">{topVendor ? fl(topVendor.amount) : '—'}{unitSfx}</div><div className="chg neu">{topVendor?.vendor || '—'}</div></div>
            <div className="kpi"><div className="lbl">Concentration Risk</div><div className={`val ${concentrationCount > 0 ? 'dn' : ''}`}>{concentrationCount}</div><div className="chg neu">vendor{concentrationCount === 1 ? '' : 's'} &gt; 30% of spend</div></div>
          </div>

          <div className="card">
            <div className="card-hdr">
              <span className="ct">Vendors Ranked by Spend</span>
              <span className="cbadge cb-blue">{unitLabel}</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="fc-table">
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th className="num">Spend ({unitSfx})</th>
                    <th className="num">% of Total</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {vendors.map(v => (
                    <tr key={v.vendor}>
                      <td>{v.vendor}</td>
                      <td className={`num ${numTone(v.amount)}`}>{fl(v.amount)}</td>
                      <td className="num">{v.pct_of_total.toFixed(1)}%</td>
                      <td><span className={`pill ${STATUS_PILL_CLASS[v.status] || 'pgy'}`}>{v.status}</span></td>
                    </tr>
                  ))}
                  <tr className="tot-row">
                    <td>Total</td>
                    <td className="num">{fl(totalSpend)}</td>
                    <td className="num">100.0%</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="info-bar">
            Real data from Zoho Bills — status thresholds: <strong>Concentration Risk</strong> &gt; 30% of total spend, <strong>Key Vendor</strong> &gt; 15%. Bills in a currency other than this company&apos;s base currency are excluded rather than mis-summed (see zoho.ts::extractVendorBills).
          </div>
        </>
      )}
    </div>
  );
}
