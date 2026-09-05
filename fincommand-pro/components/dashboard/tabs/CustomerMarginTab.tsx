'use client';

import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { fl as flRaw, pct, numTone, getFyLabel, getUnitHeader, unitSuffix } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { DownloadBar } from '../DownloadBar';

/**
 * Customer-level margin report — real revenue (Zoho Sales by Customer,
 * already used by the Overview tab's Top Customers) paired with real DIRECT
 * cost (Zoho expenses explicitly marked "Billable" and assigned to a
 * customer — see tb_customer_cost's schema comment and
 * computeCustomerMargin()'s doc comment in tb-engine.ts).
 *
 * This is deliberately NOT a fully-loaded margin: indirect/shared costs
 * (most of a services company's real cost base — salaries, cloud, office,
 * etc.) are never allocated to a customer here, because Zoho doesn't record
 * how to attribute them without guessing. Most Zoho orgs never use the
 * billable-expense-to-customer tagging at all (confirmed empirically: 0 of
 * 780 real expenses for the first company synced with this feature were
 * tagged) — org_tracks_direct_cost surfaces that fact so this tab discloses
 * it prominently instead of quietly implying every customer is 100% margin.
 *
 * No 3-Year view: same reasoning as VendorExpenseTab — this data isn't
 * carried into the /reports/threeyear summary bundle.
 */
export function CustomerMarginTab() {
  const { bundle, granularity, yearType, displayUnit, presentationCurrency } = useDashboard();
  const fl = (n: number | null | undefined, d?: number) => flRaw(n, d, displayUnit);
  const unitLabel = getUnitHeader(displayUnit, presentationCurrency);
  const unitSfx = unitSuffix(displayUnit);
  const symbol = getCurrencyMeta(presentationCurrency).symbol;

  if (granularity === '3year') {
    return (
      <div className="notice">
        Customer Margin Report shows real Zoho revenue/cost data for one period at a time — switch out of 3-Year Compare to view it.
      </div>
    );
  }

  if (!bundle) return null;
  const { financial_year, period_label, customer_margin } = bundle;
  const fyLabel = getFyLabel(financial_year, yearType);
  const entries = customer_margin?.entries || [];
  const tracksCost = customer_margin?.org_tracks_direct_cost ?? false;

  const totalRevenue = entries.reduce((s, e) => s + e.revenue, 0);
  const totalCost = entries.reduce((s, e) => s + e.direct_cost, 0);
  const totalMargin = totalRevenue - totalCost;

  return (
    <div>
      <DownloadBar title={`Customer Margin Report · ${fyLabel}`} subtitle={`Real revenue vs. direct cost by customer · ${period_label}`} section="customer-margin" compareEnabled={false} />

      {entries.length === 0 ? (
        <div className="notice">
          No customer revenue data available for {fyLabel}. This report is populated from Zoho&apos;s Sales by Customer report —
          connect Zoho Books and sync this financial year (Upload tab) to see it here. Excel-uploaded Trial Balances carry no customer dimension.
        </div>
      ) : (
        <>
          {!tracksCost && (
            <div className="warn-bar" style={{ marginBottom: 14, lineHeight: 1.7 }}>
              <strong>Direct cost is not tracked in Zoho for this organization.</strong> Every "Direct Cost" figure below is real —
              it&apos;s ₹0 because no expense has been marked <strong>Billable</strong> and assigned to a customer in Zoho Books, not
              because these customers cost nothing. Margin shown is Revenue only until that changes. To start tracking real direct
              cost per customer: in Zoho Books, mark relevant expenses/bills as <strong>Billable</strong> and assign the
              <strong> Customer</strong> field — this report will pick it up on the next sync. Indirect/shared costs (salaries,
              cloud, rent, etc.) are intentionally never allocated to a customer here — see this tab&apos;s note below.
            </div>
          )}

          <div className="grid3">
            <div className="kpi"><div className="lbl">Total Revenue</div><div className="val">{symbol}{fl(totalRevenue)}{unitSfx}</div><div className="chg neu">{entries.length} customer{entries.length === 1 ? '' : 's'} · {period_label}</div></div>
            <div className="kpi"><div className="lbl">Total Direct Cost</div><div className="val">{symbol}{fl(totalCost)}{unitSfx}</div><div className="chg neu">{tracksCost ? 'Billable expenses tagged in Zoho' : 'Not tracked in Zoho — see notice above'}</div></div>
            <div className="kpi"><div className="lbl">Total Direct Margin</div><div className={`val ${numTone(totalMargin)}`}>{symbol}{fl(totalMargin)}{unitSfx}</div><div className="chg neu">{tracksCost ? 'Revenue − direct cost' : 'Equals Revenue (no direct cost recorded)'}</div></div>
          </div>

          <div className="card">
            <div className="card-hdr">
              <span className="ct">Revenue &amp; Direct Margin by Customer</span>
              <span className="cbadge cb-blue">{unitLabel}</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="fc-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th className="num">Revenue ({unitSfx})</th>
                    <th className="num">Direct Cost ({unitSfx})</th>
                    <th className="num">Direct Margin ({unitSfx})</th>
                    <th className="num">Margin %</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(e => (
                    <tr key={e.customer}>
                      <td>{e.customer}</td>
                      <td className="num">{fl(e.revenue)}</td>
                      <td className="num">{e.direct_cost > 0 ? fl(e.direct_cost) : '—'}</td>
                      <td className={`num ${numTone(e.direct_margin)}`}>{fl(e.direct_margin)}</td>
                      <td className="num">{e.direct_margin_pct !== null ? pct(e.direct_margin_pct) : '—'}</td>
                    </tr>
                  ))}
                  <tr className="tot-row">
                    <td>Total</td>
                    <td className="num">{fl(totalRevenue)}</td>
                    <td className="num">{totalCost > 0 ? fl(totalCost) : '—'}</td>
                    <td className={`num ${numTone(totalMargin)}`}>{fl(totalMargin)}</td>
                    <td className="num">{totalRevenue > 0 ? pct((totalMargin / totalRevenue) * 100) : '—'}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="info-bar">
            &quot;Direct Margin&quot; = real revenue − real direct cost only. It excludes indirect/shared costs (salaries, cloud
            infrastructure, rent, and every other company-wide expense not individually billed to a specific customer in Zoho) —
            it is intentionally not a fully-loaded profitability figure, to avoid presenting an allocated estimate as a measured fact.
          </div>
        </>
      )}
    </div>
  );
}
