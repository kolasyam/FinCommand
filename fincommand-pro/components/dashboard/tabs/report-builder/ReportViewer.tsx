'use client';

import { useEffect, useMemo, useState } from 'react';
import { useToast } from '@/lib/dashboard/ToastContext';
import { ApiClientError } from '@/lib/dashboard/api-client';
import { fl as flRaw, pct } from '@/lib/utils/format';
import {
  fetchTemplateStructure, runReport, createSavedReport, updateSavedReport,
  type SavedReportDTO,
} from '@/lib/dashboard/report-builder-api';
import type { ReportRow, ReportTemplate } from '@/lib/financial/report-builder-engine';
import type { FyLike } from '@/lib/dashboard/types';

function monthLabel(fy: FyLike, index: number): string {
  const start = new Date(fy.start_date);
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1));
  return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

export function ReportViewer({
  templateId, fyList, defaultFyId, savedReport, onBack, onSaved,
}: {
  templateId: string;
  fyList: FyLike[];
  defaultFyId: string | null;
  savedReport?: SavedReportDTO | null;
  onBack: () => void;
  onSaved?: (report: SavedReportDTO) => void;
}) {
  const toast = useToast();
  const fl = (n: number | null | undefined) => flRaw(n, 2, 'Lakhs');
  const [template, setTemplate] = useState<ReportTemplate | null>(null);
  const [fyId, setFyId] = useState(savedReport?.financial_year_id ?? defaultFyId ?? fyList[0]?.id ?? '');
  const [monthIndices, setMonthIndices] = useState<number[]>(savedReport?.month_indices ?? [9, 10, 11]);
  const [showPercent, setShowPercent] = useState(savedReport?.show_percent ?? true);
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState(savedReport?.name ?? '');
  const [saving, setSaving] = useState(false);

  const fy = fyList.find((f) => f.id === fyId) ?? null;

  useEffect(() => {
    if (!savedReport && defaultFyId && fyId !== defaultFyId && fyList.some((f) => f.id === defaultFyId)) {
      setFyId(defaultFyId);
    }
  }, [defaultFyId, savedReport, fyList]);

  useEffect(() => {
    fetchTemplateStructure(templateId)
      .then((s) => setTemplate(s.template))
      .catch((e) => toast(e instanceof ApiClientError ? e.message : 'Failed to load format'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  const run = useMemo(() => async () => {
    if (!fyId || monthIndices.length === 0) { setRows([]); return; }
    setRunning(true);
    try {
      const res = await runReport(templateId, fyId, [...monthIndices].sort((a, b) => a - b));
      setRows(res.rows);
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : 'Failed to run report');
      setRows(null);
    } finally {
      setRunning(false);
    }
  }, [templateId, fyId, monthIndices]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { run(); }, [run]);

  const allZeros = useMemo(() => {
    if (!rows || rows.length === 0) return false;
    return rows.every((r) => r.line.lineType === 'header' || r.values.every((v) => !v || v === 0));
  }, [rows]);

  function toggleMonth(i: number) {
    setMonthIndices((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]).sort((a, b) => a - b));
  }

  async function commitSave() {
    const trimmed = name.trim();
    if (!trimmed || monthIndices.length === 0 || !fyId) return;
    setSaving(true);
    try {
      if (savedReport) {
        await updateSavedReport(savedReport.id, { name: trimmed, monthIndices, showPercent, financialYearId: fyId });
        toast('Saved report updated');
        onSaved?.({ ...savedReport, name: trimmed, month_indices: monthIndices, show_percent: showPercent, financial_year_id: fyId });
      } else {
        const { report } = await createSavedReport({ name: trimmed, templateId, financialYearId: fyId, monthIndices, showPercent });
        toast('Report saved');
        onSaved?.(report);
      }
      setSaveOpen(false);
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : 'Failed to save report');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="notice">Loading…</div>;
  if (!template) return null;

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn btn-se btn-sm" onClick={onBack}>← Back</button>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{savedReport ? savedReport.name : template.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text3)' }}>Format: {template.name} · real ledger data, recomputed on every run</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-se" onClick={run}>⟳ Re-run</button>
          <button className="btn btn-pr" onClick={() => { setName(savedReport?.name ?? `${template.name} — new run`); setSaveOpen(true); }}>
            💾 {savedReport ? 'Save changes' : 'Save report'}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: .4, color: 'var(--text3)', marginBottom: 6 }}>Financial year</div>
            <select value={fyId} onChange={(e) => { setFyId(e.target.value); setMonthIndices([]); }} style={{ fontSize: 12, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border2)', appearance: 'auto' }}>
              {fyList.map((f) => <option key={f.id} value={f.id} style={{ background: '#0f1826', color: '#e5e7eb' }}>{f.label}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: .4, color: 'var(--text3)', marginBottom: 6 }}>Period columns</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {fy && Array.from({ length: 12 }, (_, i) => i).map((i) => (
                <button
                  key={i} type="button" onClick={() => toggleMonth(i)}
                  style={{
                    padding: '4px 9px', fontSize: 11, borderRadius: 6, cursor: 'pointer',
                    border: `1px solid ${monthIndices.includes(i) ? 'var(--blue)' : 'var(--border2)'}`,
                    background: monthIndices.includes(i) ? 'var(--blue-l)' : 'transparent',
                    color: monthIndices.includes(i) ? 'var(--blue-d, var(--blue))' : 'var(--text2)',
                  }}
                >
                  {monthLabel(fy, i)}
                </button>
              ))}
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginLeft: 'auto' }}>
            <input type="checkbox" checked={showPercent} onChange={(e) => setShowPercent(e.target.checked)} />
            Show % of base
          </label>
        </div>
      </div>

      {monthIndices.length === 0 ? (
        <div className="notice" style={{ padding: 30, textAlign: 'center' }}>Pick at least one period to run this format.</div>
      ) : running || !rows ? (
        <div className="notice">Computing…</div>
      ) : (
        <>
          {allZeros && (
            <div className="warn-bar" style={{ marginBottom: 12 }}>
              ℹ No Trial Balance ledger data found for <strong>{fy?.label ?? 'this financial year'}</strong>. Figures below are zero.
              {fyList.length > 1 && ' Switch to a financial year with uploaded data (e.g. FY 2025-26) in the dropdown above.'}
            </div>
          )}
          <div className="card" style={{ overflowX: 'auto' }}>
          <table className="fc-table">
            <thead>
              <tr>
                <th>Line</th>
                {monthIndices.map((i) => <th key={i} className="num">{fy && monthLabel(fy, i)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.line.id} className={row.line.lineType === 'header' ? 'sec-row' : row.line.lineType === 'subtotal' ? 'tot-row' : undefined}>
                  <td>
                    <span style={{ paddingLeft: row.depth * 16, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {row.line.label}
                      {row.line.isPercentBase && <span className="pill pb">base</span>}
                    </span>
                  </td>
                  {row.line.lineType === 'header'
                    ? monthIndices.map((_, i) => <td key={i} className="num" />)
                    : row.values.map((v, i) => (
                      <td key={i} className="num">
                        {fl(v)}
                        {showPercent && row.percents && (
                          <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--text3)' }}>{pct(row.percents[i] ?? null)}</span>
                        )}
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}

      {saveOpen && (
        <div
          onClick={() => setSaveOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(6,10,18,.55)', backdropFilter: 'blur(8px)' }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ width: 400, background: '#0f1826', border: '1px solid rgba(255,255,255,.1)', borderRadius: 14, padding: 24 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 4 }}>{savedReport ? 'Save changes' : 'Save report'}</div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16 }}>Only the configuration is saved — reopening it always re-runs against the latest ledger data.</div>
            <input
              value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && commitSave()}
              style={{ width: '100%', padding: '9px 11px', fontSize: 12, border: '1px solid rgba(255,255,255,.14)', borderRadius: 8, color: '#e5e7eb', background: 'rgba(255,255,255,.04)', outline: 'none', marginBottom: 18 }}
            />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-cancel-dark" onClick={() => setSaveOpen(false)}>Cancel</button>
              <button className="btn btn-pr" disabled={saving || !name.trim()} onClick={commitSave}>{saving ? 'Saving…' : (savedReport ? 'Save changes' : 'Save report')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
