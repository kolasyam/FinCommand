'use client';

import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { DownloadBar } from '../DownloadBar';
import { getFyLabel } from '@/lib/utils/format';
import { ThreeYearBanner } from '../ThreeYearFrame';

type ComplianceStatus = 'ok' | 'warn' | 'na';
interface ComplianceItem { label: string; status: ComplianceStatus; note: string }

const complianceIconStyle = (s: ComplianceStatus) => ({
  ok:   { background: 'var(--green-l)', color: 'var(--green)' },
  warn: { background: 'var(--amber-l)', color: 'var(--amber)' },
  na:   { background: 'var(--bg2)',     color: 'var(--text3)' },
}[s]);
const compliancePillClass = (s: ComplianceStatus) => ({ ok: 'pg', warn: 'pa', na: 'pgy' }[s]);
const complianceIconLabel = (s: ComplianceStatus) => ({ ok: '✓', warn: '!', na: '—' }[s]);

export function ComplianceTab() {
  const { bundle, granularity, threeYear, dataMode, yearType } = useDashboard();

  // ── 3-Year mode ────────────────────────────────────────────────────────────
  if (granularity === '3year' && threeYear) {
    const { years } = threeYear;

    type Status = ComplianceStatus;
    const getStatus = (y: typeof years[0]): { label: string; status: Status }[] => [
      { label: 'TB Loaded',     status: y.no_data ? 'warn' : 'ok' },
      { label: 'BS Balanced',   status: y.no_data ? 'na' : (y.bs_summary?.balanced ? 'ok' : 'warn') },
      { label: 'Cash Flow',     status: y.no_data ? 'na' : (y.cashflow ? 'ok' : 'warn') },
      { label: 'Ratios',        status: y.no_data ? 'na' : (y.ratios ? 'ok' : 'warn') },
    ];

    const statusStyle = complianceIconStyle;
    const statusLabel = complianceIconLabel;

    return (
      <div>
        <ThreeYearBanner years={years} />
        <div className="card">
          <div className="card-hdr"><span className="ct">Compliance Checklist — 3-Year View</span></div>
          <div style={{ overflowX: 'auto' }}>
            <table className="fc-table">
              <thead>
                <tr>
                  <th>Check</th>
                  {years.map(y => (
                    <th key={y.financial_year.id} className="num">
                      {y.financial_year.short_label || y.financial_year.label}
                      {y.no_data && <div style={{ fontSize: 9, fontWeight: 400, color: 'var(--text3)' }}>(No TB)</div>}
                    </th>
                  ))}
                  {Array.from({ length: Math.max(0, 3 - years.length) }).map((_, i) => (
                    <th key={`g${i}`} className="num" style={{ color: 'var(--text3)', fontStyle: 'italic', fontSize: 10 }}>Upload TB</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {['TB Loaded', 'BS Balanced', 'Cash Flow', 'Ratios'].map(label => (
                  <tr key={label}>
                    <td>{label}</td>
                    {years.map(y => {
                      const item = getStatus(y).find(s => s.label === label)!;
                      return (
                        <td key={y.financial_year.id} className="num">
                          <span className="comp-icon" style={{ ...statusStyle(item.status), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 6, fontSize: 11 }}>
                            {statusLabel(item.status)}
                          </span>
                        </td>
                      );
                    })}
                    {Array.from({ length: Math.max(0, 3 - years.length) }).map((_, i) => (
                      <td key={`g${i}`} className="num">
                        <span className="comp-icon" style={{ ...statusStyle('na'), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 6, fontSize: 11 }}>—</span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {/* Invariant items */}
        <div className="card" style={{ marginTop: 12 }}>
          <div className="card-hdr"><span className="ct">System-wide Compliance</span></div>
          <div>
            {([
              { label: 'Data source', status: dataMode === 'api' ? 'ok' : 'warn', note: dataMode === 'api' ? 'Live API / uploaded TB' : 'Sample data — connect a real company' },
              { label: 'Audit trail enabled', status: 'ok', note: 'Every write action is logged to audit_trail' },
              { label: 'IND AS 7 Cash Flow (Indirect Method)', status: 'ok', note: 'Generated per year' },
              // Genuinely 'na', not 'ok': computePL() always leaves OCI null —
              // an actuarial valuation of a defined benefit obligation isn't
              // derivable from Trial Balance ledger balances alone, so it was
              // never computed, let alone "included in P&L". Claiming this
              // standard was met when the engine explicitly and deliberately
              // never attempts it is exactly the false-compliance-status
              // problem this checklist exists to prevent, not commit.
              { label: 'IND AS 19 — Employee Benefits (OCI)', status: 'na', note: 'n/a — requires an actuarial valuation not derivable from a Trial Balance' },
            ] as ComplianceItem[]).map(item => (
              <div key={item.label} className="comp-row">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="comp-icon" style={{ ...complianceIconStyle(item.status), display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                    {complianceIconLabel(item.status)}
                  </span>
                  <span style={{ fontSize: 12 }}>{item.label}</span>
                </div>
                <span className={`pill ${compliancePillClass(item.status)}`}>{item.note}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Single-year mode ───────────────────────────────────────────────────────
  // 'na' (not a warning) whenever there's genuinely no report loaded yet to
  // check — before this, several items fell back to a `done: false` amber
  // "!" alongside a "n/a" note, which visually read as a problem when there
  // was simply no data yet to evaluate.
  const items: ComplianceItem[] = [
    { label: 'Trial Balance loaded for the period', status: bundle ? 'ok' : 'warn', note: bundle ? 'Loaded' : 'Not loaded' },
    { label: 'Balance Sheet tallies (Schedule III)', status: !bundle ? 'na' : (bundle.bs.balanced ? 'ok' : 'warn'), note: bundle ? (bundle.bs.balanced ? 'Balanced' : 'Out of balance') : 'n/a' },
    { label: 'Financial Year lock status', status: !bundle ? 'na' : 'ok', note: bundle ? (bundle.financial_year.is_locked ? 'Locked (post-audit)' : 'Open for updates') : 'n/a' },
    { label: 'Data source', status: dataMode === 'api' ? 'ok' : 'warn', note: dataMode === 'api' ? 'Live API / uploaded TB' : 'Sample data — connect a real company to track this' },
    { label: 'IND AS 7 Cash Flow (Indirect Method)', status: bundle ? 'ok' : 'na', note: bundle ? 'Generated' : 'n/a' },
    // Genuinely 'na', not 'ok': computePL() always leaves OCI null — an
    // actuarial valuation of a defined benefit obligation isn't derivable
    // from Trial Balance ledger balances alone, so it was never computed,
    // let alone "included in P&L". Claiming this standard was met when the
    // engine explicitly and deliberately never attempts it is exactly the
    // false-compliance-status problem this checklist exists to prevent.
    { label: 'IND AS 19 — Employee Benefits (OCI)', status: 'na', note: 'n/a — requires an actuarial valuation not derivable from a Trial Balance' },
    { label: 'IND AS 116 — Lease Liabilities classified', status: bundle ? 'ok' : 'na', note: bundle ? 'NC/Current split available in Notes' : 'n/a' },
    { label: 'Audit trail enabled', status: 'ok', note: 'Every write action is logged to audit_trail' },
  ];

  return (
    <div>
      <DownloadBar title={`Statutory & Compliance Checklist · ${bundle ? getFyLabel(bundle.financial_year, yearType) : 'FY'}`} subtitle={`IND AS, Audit Trail & Financial Lock Status`} section="compliance" />
      <div className="card">
        <div className="card-hdr"><span className="ct">Compliance Checklist</span></div>
        <div>
          {items.map(item => (
            <div key={item.label} className="comp-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="comp-icon" style={{ ...complianceIconStyle(item.status), display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                  {complianceIconLabel(item.status)}
                </span>
                <span style={{ fontSize: 12 }}>{item.label}</span>
              </div>
              <span className={`pill ${compliancePillClass(item.status)}`}>{item.note}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
