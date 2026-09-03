'use client';

import { useState } from 'react';
import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { Kpi } from '../Kpi';
import { DownloadBar } from '../DownloadBar';
import { TreasuryCompositionChart } from '@/components/charts/TreasuryCompositionChart';
import { fn, fl, pct, numTone, kpiTone, signedPct, getFyLabel, getFyShortLabel, getUnitHeader, unitSuffix, formatChg, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import type { TreasuryEntry, TreasuryResult } from '@/lib/financial/tb-engine';
import { ThreeYearBanner, ThreeYearHeader, ThreeYearRow } from '../ThreeYearFrame';

/** Match a current-year entry to its prior-year counterpart by ledger code (reliable) or, failing that, by name (best-effort — same approach as Notes to Accounts' YoY ledger matching). */
function matchPrev(entry: TreasuryEntry, prevEntries: TreasuryEntry[]): TreasuryEntry | undefined {
  return prevEntries.find(p => (entry.code && p.code === entry.code) || p.name.toLowerCase() === entry.name.toLowerCase());
}

function EntryTable({ title, entries, prevEntries, compare, unit, currency }: { title: string; entries: TreasuryEntry[]; prevEntries: TreasuryEntry[]; compare: boolean; unit: DisplayUnit; currency: CurrencyCode }) {
  if (!entries.length && !(compare && prevEntries.length)) return null;
  const subtotal = entries.reduce((s, e) => s + e.closing, 0);
  const prevSubtotal = prevEntries.reduce((s, e) => s + e.closing, 0);

  if (!compare) {
    return (
      <div className="card">
        <div className="card-hdr"><span className="ct">{title}</span><span className="cbadge cb-blue">{getUnitHeader(unit, currency)}</span></div>
        <table className="fc-table">
          <thead><tr><th>Instrument</th><th className="num">Closing Balance</th></tr></thead>
          <tbody>
            {entries.map((e, i) => <tr key={i}><td>{e.name}</td><td className={`num ${numTone(e.closing)}`}>{fn(e.closing, 2, unit)}</td></tr>)}
            <tr className="tot-row"><td className="bold">Subtotal</td><td className={`num bold ${numTone(subtotal)}`}>{fn(subtotal, 2, unit)}</td></tr>
          </tbody>
        </table>
      </div>
    );
  }

  // Compare mode: union of current + prior-year entries, YoY column
  const seen = new Set<string>();
  const rows: { name: string; cVal: number; pVal: number }[] = [];
  entries.forEach(e => {
    const match = matchPrev(e, prevEntries);
    seen.add(e.code ? `code_${e.code}` : `name_${e.name.toLowerCase()}`);
    rows.push({ name: e.name, cVal: e.closing, pVal: match?.closing ?? 0 });
  });
  prevEntries.forEach(p => {
    const key = p.code ? `code_${p.code}` : `name_${p.name.toLowerCase()}`;
    if (!seen.has(key)) rows.push({ name: p.name, cVal: 0, pVal: p.closing });
  });

  return (
    <div className="card">
      <div className="card-hdr"><span className="ct">{title}</span><span className="cbadge cb-blue">{getUnitHeader(unit, currency)}</span></div>
      <table className="fc-table">
        <thead><tr><th>Instrument</th><th className="num">Current</th><th className="num" style={{ color: 'var(--text2)' }}>Prior Year</th><th className="num">YoY</th></tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const chg = r.cVal - r.pVal;
            return (
              <tr key={i}>
                <td>{r.name}</td>
                <td className={`num ${numTone(r.cVal)}`}>{fn(r.cVal, 2, unit)}</td>
                <td className="num" style={{ color: 'var(--text2)' }}>{fn(r.pVal, 2, unit)}</td>
                <td className={`num ${numTone(chg)}`}>{formatChg(chg, 2, unit)}</td>
              </tr>
            );
          })}
          <tr className="tot-row">
            <td className="bold">Subtotal</td>
            <td className={`num bold ${numTone(subtotal)}`}>{fn(subtotal, 2, unit)}</td>
            <td className="num bold" style={{ color: 'var(--text2)' }}>{fn(prevSubtotal, 2, unit)}</td>
            <td className={`num bold ${numTone(subtotal - prevSubtotal)}`}>{formatChg(subtotal - prevSubtotal, 2, unit)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Every real named entry across all five instrument types, for composition/concentration analysis. */
function allEntries(t: TreasuryResult): TreasuryEntry[] {
  return [...t.cash, ...t.bank_ca, ...t.bank_sb, ...t.fds, ...t.mfs];
}

export function TreasuryTab() {
  const { bundle, granularity, threeYear, yearType, displayUnit, presentationCurrency } = useDashboard();
  const symbol = getCurrencyMeta(presentationCurrency).symbol;
  const [showComparison, setShowComparison] = useState(true);
  const unitLabel = getUnitHeader(displayUnit, presentationCurrency);
  const unitSfx = unitSuffix(displayUnit);

  // ── 3-Year mode ────────────────────────────────────────────────────────────
  if (granularity === '3year' && threeYear) {
    const { years } = threeYear;
    const liquidPct = (y: typeof years[0]) => y.treasury && y.treasury.total > 0 ? (y.treasury.cash / y.treasury.total) * 100 : null;

    return (
      <div>
        <ThreeYearBanner years={years} />
        <div className="card">
          <div className="card-hdr">
            <span className="ct">Treasury Position — 3-Year Comparison</span>
            <span className="cbadge cb-blue">{unitLabel}</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="fc-table">
              <ThreeYearHeader years={years} />
              <tbody>
                <ThreeYearRow label="Cash & Bank Balances" years={years} values={years.map(y => y.treasury ? fn(y.treasury.cash, 2, displayUnit) : null)} tones={years.map(y => y.treasury ? numTone(y.treasury.cash) : '')} />
                <ThreeYearRow label="Fixed Deposits" years={years} values={years.map(y => y.treasury ? fn(y.treasury.fd, 2, displayUnit) : null)} tones={years.map(y => y.treasury ? numTone(y.treasury.fd) : '')} />
                <ThreeYearRow label="Mutual Funds" years={years} values={years.map(y => y.treasury ? fn(y.treasury.mf, 2, displayUnit) : null)} tones={years.map(y => y.treasury ? numTone(y.treasury.mf) : '')} />
                <ThreeYearRow label="TOTAL TREASURY" years={years} values={years.map(y => y.treasury ? fn(y.treasury.total, 2, displayUnit) : null)} tones={years.map(y => y.treasury ? numTone(y.treasury.total) : '')} bold grand />
                <ThreeYearRow label="Liquid % (Cash+Bank of Total)" years={years} values={years.map(y => { const p = liquidPct(y); return p == null ? null : pct(p); })} />
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // ── Single-year mode ───────────────────────────────────────────────────────
  if (!bundle) return null;
  const { treasury, prev_treasury: prevTreasury, financial_year, period_label } = bundle;
  const hasPrev = !!prevTreasury;
  const compare = hasPrev && showComparison;
  const fyShort = getFyShortLabel(financial_year, yearType);
  const prevFyShort = getFyShortLabel(bundle.prev_financial_year, yearType);

  const yoy = (curr: number, prev: number) => (prev !== 0 ? (curr - prev) / Math.abs(prev) : null);
  const cashYoy = hasPrev ? yoy(treasury.total_cash_and_bank, prevTreasury.total_cash_and_bank) : null;
  const fdYoy = hasPrev ? yoy(treasury.total_fd, prevTreasury.total_fd) : null;
  const mfYoy = hasPrev ? yoy(treasury.total_mf, prevTreasury.total_mf) : null;
  const totalYoy = hasPrev ? yoy(treasury.total, prevTreasury.total) : null;

  // Real composition/concentration insight — computed directly from the
  // ledger-level entries already returned by computeTreasury(), no
  // fabricated figures.
  const liquidPct = treasury.total > 0 ? (treasury.total_cash_and_bank / treasury.total) * 100 : null;
  const investedPct = treasury.total > 0 ? ((treasury.total_fd + treasury.total_mf) / treasury.total) * 100 : null;
  const entries = allEntries(treasury);
  const largest = entries.reduce((max, e) => (Math.abs(e.closing) > Math.abs(max?.closing ?? 0) ? e : max), undefined as TreasuryEntry | undefined);
  const largestPct = largest && treasury.total > 0 ? (largest.closing / treasury.total) * 100 : null;

  const compositionLabels = ['Cash in Hand', 'Bank — Current', 'Bank — Savings/Sweep', 'Fixed Deposits', 'Mutual Funds'];
  const compositionValues = [
    treasury.cash.reduce((s, e) => s + e.closing, 0),
    treasury.bank_ca.reduce((s, e) => s + e.closing, 0),
    treasury.bank_sb.reduce((s, e) => s + e.closing, 0),
    treasury.total_fd,
    treasury.total_mf,
  ];

  return (
    <div>
      <DownloadBar title={`Treasury · ${getFyLabel(financial_year, yearType)}`} subtitle={`Cash, Bank, FDs & MFs · ${unitLabel} · ${period_label}`} section="treasury" compareEnabled={showComparison} />
      <div className="grid4">
        <Kpi label="Cash & Bank" value={fn(treasury.total_cash_and_bank, 2, displayUnit)} change={cashYoy != null ? `${signedPct(cashYoy * 100)} vs ${prevFyShort}` : undefined} tone={kpiTone(treasury.total_cash_and_bank)} />
        <Kpi label="Fixed Deposits" value={fn(treasury.total_fd, 2, displayUnit)} change={fdYoy != null ? `${signedPct(fdYoy * 100)} vs ${prevFyShort}` : undefined} tone={kpiTone(treasury.total_fd)} />
        <Kpi label="Mutual Funds" value={fn(treasury.total_mf, 2, displayUnit)} change={mfYoy != null ? `${signedPct(mfYoy * 100)} vs ${prevFyShort}` : undefined} tone={kpiTone(treasury.total_mf)} />
        <Kpi label="Total Treasury" value={fn(treasury.total, 2, displayUnit)} change={totalYoy != null ? `${signedPct(totalYoy * 100)} vs ${prevFyShort}` : undefined} tone={kpiTone(treasury.total)} />
      </div>

      <div className="grid2">
        <div className="card">
          <div className="card-hdr"><span className="ct">Treasury Composition</span><span className="cbadge cb-blue">{unitLabel}</span></div>
          <div className="card-body" style={{ height: 220, position: 'relative' }}>
            <TreasuryCompositionChart labels={compositionLabels} values={compositionValues} />
          </div>
        </div>
        <div className="card">
          <div className="card-hdr"><span className="ct">Liquidity &amp; Concentration</span></div>
          <div className="card-body so-grid">
            <div className="so-item">
              <div className="so-lbl">Liquid (Cash + Bank)</div>
              <div className="so-val">{liquidPct != null ? pct(liquidPct) : '—'}</div>
            </div>
            <div className="so-item">
              <div className="so-lbl">Invested (FD + MF)</div>
              <div className="so-val">{investedPct != null ? pct(investedPct) : '—'}</div>
            </div>
            <div className="so-item" style={{ gridColumn: '1 / -1' }}>
              <div className="so-lbl">Largest Single Holding</div>
              <div className="so-val" style={{ fontSize: 14 }}>
                {largest ? `${largest.name} — ${fl(largest.closing, 2, displayUnit)}${unitSfx} (${largestPct != null ? pct(Math.abs(largestPct)) : '—'} of treasury)` : '—'}
              </div>
            </div>
          </div>
          {largestPct != null && Math.abs(largestPct) >= 40 && (
            <div className="info-bar" style={{ margin: '0 16px 16px 16px', fontSize: 11 }}>
              ⚠ {pct(Math.abs(largestPct))} of total treasury sits in a single instrument (&quot;{largest?.name}&quot;) — a real concentration risk worth reviewing for counterparty/liquidity diversification.
            </div>
          )}
        </div>
      </div>

      {hasPrev && (
        <div className="card" style={{ padding: '10px 16px', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>Instrument-Level Detail</div>
          <label style={{ fontSize: 12, color: 'var(--text2)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, userSelect: 'none' }}>
            <input type="checkbox" checked={showComparison} onChange={e => setShowComparison(e.target.checked)} style={{ cursor: 'pointer' }} />
            Compare with {prevFyShort}
          </label>
        </div>
      )}

      <div className="info-bar">Total Treasury: {symbol}{fn(treasury.total, 2, displayUnit)} {displayUnit} — auto-extracted from TB ledgers tagged with treasury_type in Ledger Master.</div>
      <div className="grid2">
        <EntryTable title="Cash in Hand" entries={treasury.cash} prevEntries={prevTreasury?.cash || []} compare={compare} unit={displayUnit} currency={presentationCurrency} />
        <EntryTable title="Bank — Current Accounts" entries={treasury.bank_ca} prevEntries={prevTreasury?.bank_ca || []} compare={compare} unit={displayUnit} currency={presentationCurrency} />
        <EntryTable title="Bank — Savings / Sweep" entries={treasury.bank_sb} prevEntries={prevTreasury?.bank_sb || []} compare={compare} unit={displayUnit} currency={presentationCurrency} />
        <EntryTable title="Fixed Deposits" entries={treasury.fds} prevEntries={prevTreasury?.fds || []} compare={compare} unit={displayUnit} currency={presentationCurrency} />
        <EntryTable title="Mutual Funds" entries={treasury.mfs} prevEntries={prevTreasury?.mfs || []} compare={compare} unit={displayUnit} currency={presentationCurrency} />
      </div>
      {!hasPrev && (
        <div className="info-bar" style={{ fontSize: 11 }}>
          Previous year data is not available for comparison. Upload the prior financial year&apos;s Trial Balance to enable Year-on-Year Treasury comparison.
        </div>
      )}
    </div>
  );
}
