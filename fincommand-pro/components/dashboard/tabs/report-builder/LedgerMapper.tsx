'use client';

import { useEffect, useMemo, useState } from 'react';
import { useToast } from '@/lib/dashboard/ToastContext';
import { ApiClientError } from '@/lib/dashboard/api-client';
import {
  fetchTemplateStructure, fetchLedgerOptions, setLineLedgers,
  type RealLedgerOption,
} from '@/lib/dashboard/report-builder-api';
import type { ReportLine, LineLedgerMap, ReportTemplate } from '@/lib/financial/report-builder-engine';

export function LedgerMapper({
  templateId, currentFyId, onBack,
}: {
  templateId: string;
  currentFyId: string | null;
  onBack: () => void;
}) {
  const toast = useToast();
  const [template, setTemplate] = useState<ReportTemplate | null>(null);
  const [lines, setLines] = useState<ReportLine[]>([]);
  const [lineLedgerMap, setLineLedgerMapState] = useState<LineLedgerMap>({});
  const [ledgers, setLedgers] = useState<RealLedgerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchTemplateStructure(templateId),
      currentFyId ? fetchLedgerOptions(currentFyId) : Promise.resolve({ ledgers: [] }),
    ])
      .then(([structure, ledgerRes]) => {
        if (cancelled) return;
        setTemplate(structure.template);
        setLines(structure.lines);
        setLineLedgerMapState(structure.lineLedgerMap);
        setLedgers(ledgerRes.ledgers);
        const firstDetail = structure.lines.find((l) => l.lineType === 'detail');
        setActiveLineId(firstDetail?.id ?? null);
      })
      .catch((e) => toast(e instanceof ApiClientError ? e.message : 'Failed to load'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, currentFyId]);

  const detailLines = useMemo(() => lines.filter((l) => l.lineType === 'detail'), [lines]);
  const usedElsewhere = useMemo(() => {
    const map = new Map<string, string[]>();
    detailLines.forEach((line) => {
      (lineLedgerMap[line.id] ?? []).forEach((name) => map.set(name, [...(map.get(name) ?? []), line.label]));
    });
    return map;
  }, [detailLines, lineLedgerMap]);

  const selected = activeLineId ? (lineLedgerMap[activeLineId] ?? []) : [];
  const filtered = ledgers.filter(
    (l) => l.name.toLowerCase().includes(query.toLowerCase()) || (l.noteName ?? '').toLowerCase().includes(query.toLowerCase())
  );

  async function toggle(ledgerName: string) {
    if (!activeLineId) return;
    const next = selected.includes(ledgerName) ? selected.filter((n) => n !== ledgerName) : [...selected, ledgerName];
    setLineLedgerMapState((prev) => ({ ...prev, [activeLineId]: next }));
    try {
      await setLineLedgers(activeLineId, next);
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : 'Failed to save mapping');
      setLineLedgerMapState((prev) => ({ ...prev, [activeLineId]: selected })); // revert on failure
    }
  }

  if (loading) return <div className="notice">Loading…</div>;
  if (!template) return null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button className="btn btn-se btn-sm" onClick={onBack}>← Structure</button>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Map ledgers — {template.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text2)' }}>Pick which real synced ledgers feed each detail line. Saved immediately as you check/uncheck.</div>
        </div>
      </div>

      {!currentFyId && <div className="warn-bar" style={{ marginBottom: 12 }}>No financial year selected — pick one from the top bar to see real ledgers.</div>}
      {currentFyId && ledgers.length === 0 && <div className="warn-bar" style={{ marginBottom: 12 }}>No ledgers found for the selected financial year — upload or sync a Trial Balance first.</div>}

      {detailLines.length === 0 ? (
        <div className="notice">This format has no detail lines yet — add some in Structure first.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '20rem 1fr', gap: 14 }}>
          <div className="card" style={{ marginBottom: 0, maxHeight: 480, overflowY: 'auto' }}>
            <div style={{ padding: '9px 14px', borderBottom: '1px solid var(--border)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .5, color: 'var(--text3)' }}>
              Detail lines
            </div>
            {detailLines.map((line) => {
              const count = lineLedgerMap[line.id]?.length ?? 0;
              return (
                <button
                  key={line.id}
                  onClick={() => setActiveLineId(line.id)}
                  style={{
                    width: '100%', display: 'flex', justifyContent: 'space-between', gap: 8, textAlign: 'left',
                    padding: '9px 14px', fontSize: 12, border: 'none', borderBottom: '1px solid var(--border)',
                    background: activeLineId === line.id ? 'var(--blue-l)' : 'transparent', cursor: 'pointer',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{line.label}</span>
                  <span style={{ flexShrink: 0, fontFamily: 'var(--mono)', fontSize: 10, color: count ? 'var(--text3)' : 'var(--amber, #d97706)' }}>{count || '0'}</span>
                </button>
              );
            })}
          </div>

          <div className="card" style={{ marginBottom: 0, maxHeight: 480, overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
              <input
                value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search real synced ledgers…"
                style={{ flex: 1, border: 'none', outline: 'none', fontSize: 12, background: 'transparent' }}
              />
              <span className="pill pb">{selected.length} selected</span>
            </div>
            {filtered.map((l) => {
              const others = (usedElsewhere.get(l.name) ?? []).filter((label) => label !== detailLines.find((d) => d.id === activeLineId)?.label);
              const checked = selected.includes(l.name);
              return (
                <label
                  key={l.name}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid var(--border)', fontSize: 12, cursor: activeLineId ? 'pointer' : 'not-allowed' }}
                >
                  <input type="checkbox" checked={checked} disabled={!activeLineId} onChange={() => toggle(l.name)} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.name}
                    {others.length > 0 && <span style={{ display: 'block', fontSize: 10, color: 'var(--text3)' }}>also on: {others.join(', ')}</span>}
                  </span>
                  {l.noteName && <span className="pill pgy" style={{ flexShrink: 0 }}>{l.noteName}</span>}
                </label>
              );
            })}
            {filtered.length === 0 && <div className="notice" style={{ padding: 20, textAlign: 'center' }}>No ledgers match.</div>}
          </div>
        </div>
      )}

      <p className="notice">
        Mappings are per format — the same ledger can sit on different lines in different formats. This never touches the
        existing Note-based Balance Sheet/P&amp;L classification.
      </p>
    </div>
  );
}
