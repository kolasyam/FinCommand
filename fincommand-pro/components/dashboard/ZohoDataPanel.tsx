'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, ApiClientError, getStoredUser } from '@/lib/client/api-client';

/**
 * "Zoho data coverage": which of Zoho Books' individual records (invoices, bills,
 * journals, payments ...) have been read into FinCommand, and a button to read them.
 * Reading is read-only - nothing is ever written to Zoho.
 */

interface ModuleStatus {
  key: string; label: string; phase: string; detail_mode: 'lines' | 'optional' | 'none'; detail_enabled: boolean;
  records: number; removed: number; with_detail: number; detail_pending: number; detail_failed: number;
  last_full_at: string | null; last_incremental_at: string | null; reading: boolean; last_error: string | null;
}
interface StatusResponse {
  connected: boolean;
  modules: ModuleStatus[];
  usage: { used: number; dailyLimit: number; moduleCap: number; blockedUntil: string | null };
  statement_sync: { frequency: string | null; projected_daily_calls: number; consecutive_failures: number; next_attempt_at: string | null; needs_attention: boolean };
}
interface SliceResult {
  done: boolean; stopped: string; callsMade: number; runStartedAt: string; errors: string[];
  modules: Array<{ module: string; listing: string; error: string | null }>;
}

const VIEW_ROLES = ['admin', 'cfo', 'ceo', 'auditor'];
const START_ROLES = ['admin', 'cfo'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (n: number) => n.toLocaleString('en-IN');
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

const STOP_TEXT: Record<string, string> = {
  daily_budget: 'Paused: today\'s share of the Zoho API allowance is used. It continues tomorrow, or raise the plan limit.',
  daily_limit: 'Paused: Zoho says its daily API limit is used up. It resumes automatically in about an hour.',
  auth: 'Stopped: the Zoho connection needs to be re-authorised. Click "Reconnect Zoho" above.',
  rate_limited: 'Zoho asked us to slow down; waiting a moment.',
};

export default function ZohoDataPanel() {
  const [role] = useState(() => getStoredUser()?.role ?? '');
  const canView = VIEW_ROLES.includes(role);
  const canStart = START_ROLES.includes(role);

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<{ calls: number; slices: number; note: string | null; errors: string[] } | null>(null);
  const [withExpenseDetail, setWithExpenseDetail] = useState(false);
  const [open, setOpen] = useState(true);
  const cancel = useRef(false);

  const load = useCallback(async () => {
    try {
      setStatus(await apiFetch<StatusResponse>('/zoho/modules/status'));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof ApiClientError ? e.message : 'Could not load Zoho data status');
    }
  }, []);

  useEffect(() => { if (canView) void load(); }, [canView, load]);

  async function savePlan(limit: number) {
    try {
      await apiFetch('/zoho/config', { method: 'PUT', body: JSON.stringify({ api_daily_limit: limit }) });
      await load();
    } catch (e) {
      setLoadError(e instanceof ApiClientError ? e.message : 'Could not save the Zoho plan');
    }
  }

  async function readAll(mode: 'incremental' | 'full') {
    cancel.current = false;
    setReading(true);
    setProgress({ calls: 0, slices: 0, note: null, errors: [] });
    let runStartedAt: string | undefined;
    let calls = 0;
    let rateWaits = 0;
    let appLimitWaits = 0;
    let transientRetries = 0;
    try {
      for (let slice = 1; slice <= 600 && !cancel.current; slice++) {
        let r: SliceResult;
        try {
          r = await apiFetch<SliceResult>('/zoho/modules/sync', {
            method: 'POST',
            body: JSON.stringify({ mode, run_started_at: runStartedAt, enable_detail: withExpenseDetail ? ['expenses'] : undefined }),
          });
        } catch (e) {
          // This app's own request limiter (per IP) - wait it out rather than abandon a long read. Progress is saved.
          if (e instanceof ApiClientError && e.status === 429 && ++appLimitWaits <= 8) {
            setProgress({ calls, slices: slice - 1, note: 'Too many requests from this network; waiting a moment, then carrying on.', errors: [] });
            await sleep(60_000);
            slice--;
            continue;
          }
          // A server error or a dropped connection mid-read: every step is safe to repeat, so try again shortly.
          const transient = !(e instanceof ApiClientError) || (e.status ?? 0) >= 500;
          if (transient && ++transientRetries <= 5) {
            setProgress({ calls, slices: slice - 1, note: 'A step failed; trying it again in a few seconds.', errors: [] });
            await sleep(5_000);
            slice--;
            continue;
          }
          throw e;
        }
        runStartedAt = r.runStartedAt;
        calls += r.callsMade;
        setProgress({ calls, slices: slice, note: STOP_TEXT[r.stopped] ?? null, errors: r.errors });
        // The counts table is refreshed every third step: each request counts against the app's per-IP limit.
        if (slice % 3 === 0 || r.done) await load();
        if (r.done) break;
        if (r.stopped === 'daily_budget' || r.stopped === 'daily_limit' || r.stopped === 'auth') break;
        if (r.stopped === 'rate_limited') { if (++rateWaits > 3) break; await sleep(20_000); }
      }
    } catch (e) {
      setProgress((p) => ({ calls: p?.calls ?? 0, slices: p?.slices ?? 0, note: null, errors: [e instanceof ApiClientError ? e.message : 'Reading stopped unexpectedly'] }));
    } finally {
      setReading(false);
      await load();
    }
  }

  if (!canView) return null;
  const totalRecords = status?.modules.reduce((n, m) => n + m.records, 0) ?? 0;
  const pending = status?.modules.reduce((n, m) => n + (m.detail_mode === 'lines' || m.detail_enabled ? m.detail_pending : 0), 0) ?? 0;
  const usagePct = status && status.usage.dailyLimit ? Math.min(100, Math.round((status.usage.used / status.usage.dailyLimit) * 100)) : 0;
  const capPct = status && status.usage.dailyLimit ? Math.round((status.usage.moduleCap / status.usage.dailyLimit) * 100) : 80;
  const projectedPct = status && status.usage.dailyLimit ? Math.round((status.statement_sync.projected_daily_calls / status.usage.dailyLimit) * 100) : 0;
  const expenses = status?.modules.find((m) => m.key === 'expenses');

  return (
    <div style={{ marginTop: 14, border: '1px solid var(--border2)', borderRadius: 'var(--radius-sm)' }}>
      <button type="button" className="btn btn-se btn-sm" onClick={() => setOpen((o) => !o)} style={{ width: '100%', justifyContent: 'space-between', border: 'none' }}>
        <span>🗂 Zoho data coverage — individual records ({fmt(totalRecords)} read)</span>
        <span>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: 12, fontSize: 11, lineHeight: 1.6 }}>
          <div style={{ color: 'var(--text3)', marginBottom: 10 }}>
            Reads the documents behind your statements (invoices, bills, journals, payments, expenses ...) from Zoho Books, read-only. Nothing is ever written back to Zoho.
          </div>

          {loadError && <div style={{ color: '#dc2626', marginBottom: 8 }}>⚠ {loadError}</div>}

          {status && (
            <>
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span><strong>Zoho API calls today:</strong> {fmt(status.usage.used)} of {fmt(status.usage.dailyLimit)}</span>
                  <span style={{ color: 'var(--text3)' }}>record reads may use up to {fmt(status.usage.moduleCap)} ({capPct}%)</span>
                </div>
                <div style={{ height: 6, background: 'var(--bg2, #f1f5f9)', borderRadius: 3, position: 'relative', overflow: 'hidden' }}>
                  <div style={{ width: `${usagePct}%`, height: '100%', background: usagePct >= capPct ? '#dc2626' : '#16a34a' }} />
                  <div style={{ position: 'absolute', left: `${capPct}%`, top: 0, bottom: 0, width: 1, background: '#64748b' }} />
                </div>
                {canStart && (
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, color: 'var(--text2)' }}>
                    Your Zoho Books plan allows
                    <select
                      value={status.usage.dailyLimit}
                      onChange={(e) => void savePlan(Number(e.target.value))}
                      disabled={reading}
                      style={{ fontSize: 11, padding: '2px 4px', border: '1px solid var(--border2)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)' }}
                    >
                      <option value={1000}>1,000 calls/day (Free)</option>
                      <option value={2000}>2,000 calls/day (Standard)</option>
                      <option value={5000}>5,000 calls/day (Professional)</option>
                      <option value={10000}>10,000 calls/day (Premium, Elite, Ultimate)</option>
                    </select>
                  </label>
                )}
                {status.usage.blockedUntil && new Date(status.usage.blockedUntil) > new Date() && (
                  <div style={{ color: '#b45309', marginTop: 4 }}>⏸ Zoho&apos;s daily limit was reached. Reading resumes after {when(status.usage.blockedUntil)}.</div>
                )}
              </div>

              {status.statement_sync.needs_attention && (
                <div style={{ color: '#991b1b', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '6px 8px', marginBottom: 10 }}>
                  ⚠ The trial-balance sync has failed {status.statement_sync.consecutive_failures} times in a row. Automatic retries are paused{status.statement_sync.next_attempt_at ? ` until ${when(status.statement_sync.next_attempt_at)}` : ''} so they don&apos;t use up your Zoho API allowance. Fix the problem, then use &quot;Sync Trial Balance&quot;.
                </div>
              )}
              {status.statement_sync.frequency && projectedPct >= 50 && (
                <div style={{ color: '#b45309', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 6, padding: '6px 8px', marginBottom: 10 }}>
                  ⚠ Trial-balance sync every {status.statement_sync.frequency === '15min' ? '15 minutes' : status.statement_sync.frequency} would use about {fmt(status.statement_sync.projected_daily_calls)} Zoho calls a day ({projectedPct}% of your allowance). Hourly or daily leaves room for reading records.
                </div>
              )}

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10.5 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg2)' }}>
                      <th style={{ textAlign: 'left', padding: '5px 8px', color: 'var(--text3)' }}>Module</th>
                      <th style={{ textAlign: 'right', padding: '5px 8px', color: 'var(--text3)' }}>Records</th>
                      <th style={{ textAlign: 'right', padding: '5px 8px', color: 'var(--text3)' }} title="Line items, GST and applied documents">With lines</th>
                      <th style={{ textAlign: 'left', padding: '5px 8px', color: 'var(--text3)' }}>Last read</th>
                      <th style={{ textAlign: 'left', padding: '5px 8px', color: 'var(--text3)' }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.modules.map((m) => {
                      const lines = m.detail_mode === 'none' ? '—' : (!m.detail_enabled ? 'off' : `${fmt(m.with_detail)}${m.detail_pending ? ` (+${fmt(m.detail_pending)} to read)` : ''}`);
                      const last = m.last_incremental_at && m.last_full_at ? (m.last_incremental_at > m.last_full_at ? m.last_incremental_at : m.last_full_at) : (m.last_full_at ?? m.last_incremental_at);
                      return (
                        <tr key={m.key} style={{ borderTop: '1px solid var(--border)' }} title={m.last_error || undefined}>
                          <td style={{ padding: '5px 8px' }}>{m.label}</td>
                          <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmt(m.records)}</td>
                          <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text3)' }}>{lines}</td>
                          <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>{when(last)}</td>
                          <td style={{ padding: '5px 8px', color: m.last_error ? '#dc2626' : m.reading ? '#b45309' : 'var(--text3)' }}>
                            {m.last_error ? `✗ ${m.last_error.slice(0, 40)}` : m.reading ? 'reading…' : last ? (m.records === 0 ? 'none in Zoho' : '✓') : 'not read yet'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {canStart ? (
            <div style={{ marginTop: 12 }}>
              {expenses && expenses.detail_mode === 'optional' && (
                <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 8, color: 'var(--text2)' }}>
                  <input type="checkbox" checked={withExpenseDetail || expenses.detail_enabled} disabled={reading || expenses.detail_enabled} onChange={(e) => setWithExpenseDetail(e.target.checked)} style={{ marginTop: 2 }} />
                  <span>Also read each expense&apos;s line detail (GST and input-credit per line). One Zoho call per expense{expenses.records ? `, about ${fmt(expenses.records)}` : ''}.</span>
                </label>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-pr" disabled={reading || !status?.connected} onClick={() => void readAll('incremental')}>
                  {reading ? 'Reading from Zoho…' : totalRecords === 0 ? '⬇ Read all Zoho data' : '⬇ Read new & changed'}
                </button>
                {totalRecords > 0 && (
                  <button className="btn btn-se" disabled={reading || !status?.connected} onClick={() => void readAll('full')} title="Reads every record again and marks any that Zoho no longer has">
                    Re-read everything
                  </button>
                )}
                {reading && <button className="btn btn-se" onClick={() => { cancel.current = true; }}>Stop</button>}
              </div>
              {progress && (
                <div style={{ marginTop: 8, color: 'var(--text2)' }}>
                  {reading ? 'Working…' : 'Finished this run.'} {fmt(progress.calls)} Zoho calls in {progress.slices} step{progress.slices === 1 ? '' : 's'}
                  {pending > 0 ? ` · ${fmt(pending)} records still need their line detail` : ''}.
                  {progress.note && <div style={{ color: '#b45309' }}>{progress.note}</div>}
                  {progress.errors.map((e, i) => <div key={i} style={{ color: '#dc2626' }}>⚠ {e}</div>)}
                </div>
              )}
            </div>
          ) : (
            <div style={{ marginTop: 10, color: 'var(--text3)' }}>Only an admin or CFO can start a read.</div>
          )}
        </div>
      )}
    </div>
  );
}
