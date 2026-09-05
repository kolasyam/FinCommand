'use client';

import { useEffect, useMemo, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useToast } from '@/lib/dashboard/ToastContext';
import { ApiClientError } from '@/lib/dashboard/api-client';
import {
  fetchTemplateStructure, saveStructure, fetchLedgerOptions, renameTemplate as renameTemplateApi,
  type StructureLinePayload,
} from '@/lib/dashboard/report-builder-api';
import {
  validateTemplate, lineDepth, LINE_TYPE_LABELS,
  type LineType, type ReportTemplate, type LineLedgerMap, type ValidationResult,
} from '@/lib/financial/report-builder-engine';
import type { Section } from '@/lib/financial/tb-engine';
import { ValidationPanel } from './ValidationPanel';

const TYPE_STYLE: Record<LineType, React.CSSProperties> = {
  detail: {},
  subtotal: { background: 'var(--bg2)', fontWeight: 600 },
  header: { background: 'var(--bg3, #eef2f7)', fontWeight: 700, textTransform: 'uppercase', fontSize: 11, letterSpacing: .4 },
};

export function StructureEditor({
  templateId, currentFyId, onBack, onMapLedgers,
}: {
  templateId: string;
  currentFyId: string | null;
  onBack: () => void;
  onMapLedgers: () => void;
}) {
  const toast = useToast();
  const [template, setTemplate] = useState<ReportTemplate | null>(null);
  const [lines, setLines] = useState<StructureLinePayload[] | null>(null);
  const [lineLedgerMap, setLineLedgerMap] = useState<LineLedgerMap>({});
  const [ledgerSectionByName, setLedgerSectionByName] = useState<Map<string, Section | null>>(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const [savedValidation, setSavedValidation] = useState<ValidationResult | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: 'before' | 'after' } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchTemplateStructure(templateId),
      currentFyId ? fetchLedgerOptions(currentFyId).catch(() => ({ ledgers: [] })) : Promise.resolve({ ledgers: [] }),
    ])
      .then(([structure, ledgerRes]) => {
        if (cancelled) return;
        setTemplate(structure.template);
        setLines(structure.lines.map((l) => ({
          id: l.id, parentLineId: l.parentLineId, label: l.label, sequence: l.sequence,
          lineType: l.lineType, sign: l.sign, isPercentBase: l.isPercentBase, resetsAfter: l.resetsAfter,
        })));
        setLineLedgerMap(structure.lineLedgerMap);
        setLedgerSectionByName(new Map(ledgerRes.ledgers.map((led) => [led.name, (led.section as Section) ?? null])));
      })
      .catch((e) => toast(e instanceof ApiClientError ? e.message : 'Failed to load format'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, currentFyId]);

  const liveValidation = useMemo(
    () => (lines ? validateTemplate(lines.map((l) => ({ ...l, templateId })), lineLedgerMap, ledgerSectionByName) : null),
    [lines, lineLedgerMap, ledgerSectionByName, templateId],
  );

  const errorLineIds = useMemo(() => new Set(liveValidation?.errors.flatMap((i) => i.lineIds) ?? []), [liveValidation]);
  const warnLineIds = useMemo(() => new Set(liveValidation?.warnings.flatMap((i) => i.lineIds) ?? []), [liveValidation]);

  if (loading) return <div className="notice">Loading structure…</div>;
  if (!template || !lines) return null;

  function resequence(arr: StructureLinePayload[]): StructureLinePayload[] {
    return arr.map((l, i) => ({ ...l, sequence: (i + 1) * 10 }));
  }

  function addLine(afterId?: string) {
    const anchor = afterId ? lines!.findIndex((l) => l.id === afterId) : lines!.length - 1;
    const newLine: StructureLinePayload = {
      id: uuidv4(), parentLineId: anchor >= 0 ? lines![anchor]!.parentLineId : null,
      label: 'New line', sequence: 0, lineType: 'detail', sign: 1, isPercentBase: false, resetsAfter: false,
    };
    const next = [...lines!];
    next.splice(anchor + 1, 0, newLine);
    setLines(resequence(next));
  }

  function updateLine(id: string, patch: Partial<StructureLinePayload>) {
    setLines((prev) => prev!.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  function deleteLine(id: string) {
    setLines((prev) => prev!.filter((l) => l.id !== id).map((l) => (l.parentLineId === id ? { ...l, parentLineId: null } : l)));
  }

  function handleDrop(target: StructureLinePayload) {
    if (dragId && dropTarget && dragId !== target.id) {
      const arr = [...lines!];
      const fromIdx = arr.findIndex((l) => l.id === dragId);
      const moved = arr.splice(fromIdx, 1)[0]!;
      const toIdx = arr.findIndex((l) => l.id === target.id);
      arr.splice(dropTarget.pos === 'before' ? toIdx : toIdx + 1, 0, moved);
      setLines(resequence(arr));
    }
    setDragId(null);
    setDropTarget(null);
  }

  function indentLine(id: string, direction: 1 | -1) {
    const idx = lines!.findIndex((l) => l.id === id);
    if (idx < 0) return;
    if (direction === 1) {
      const prevLine = lines![idx - 1];
      if (!prevLine) return;
      updateLine(id, { parentLineId: prevLine.id });
    } else {
      const line = lines![idx]!;
      const parent = lines!.find((l) => l.id === line.parentLineId);
      updateLine(id, { parentLineId: parent?.parentLineId ?? null });
    }
  }

  function setPercentBase(id: string) {
    setLines((prev) => prev!.map((l) => ({ ...l, isPercentBase: l.id === id ? !l.isPercentBase : false })));
  }

  async function handleSave() {
    setShowValidation(true);
    if (liveValidation && !liveValidation.ok) {
      toast(`Can't save — ${liveValidation.errors.length} blocking issue${liveValidation.errors.length > 1 ? 's' : ''}: ${liveValidation.errors[0]?.title}`);
      return;
    }
    setSaving(true);
    try {
      const { validation } = await saveStructure(templateId, lines!, currentFyId ?? undefined);
      setSavedValidation(validation);
      toast(validation.warnings.length
        ? `Format saved — ${validation.warnings.length} warning${validation.warnings.length > 1 ? 's' : ''} to review later.`
        : 'Format validated and saved.');
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : 'Failed to save format');
    } finally {
      setSaving(false);
    }
  }

  async function handleRename(newName: string) {
    setTemplate((t) => (t ? { ...t, name: newName } : t));
  }
  async function commitRename() {
    if (!template) return;
    try { await renameTemplateApi(templateId, template.name); } catch { /* best-effort */ }
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn btn-se btn-sm" onClick={onBack}>← Formats</button>
          <input
            value={template.name}
            onChange={(e) => handleRename(e.target.value)}
            onBlur={commitRename}
            style={{ fontSize: 15, fontWeight: 700, border: '1px solid transparent', background: 'transparent', padding: '4px 6px', borderRadius: 6, width: 260 }}
          />
          {liveValidation && (
            liveValidation.errors.length > 0 ? (
              <span className="pill pr">{liveValidation.errors.length} blocking</span>
            ) : liveValidation.warnings.length > 0 ? (
              <span className="pill pa">{liveValidation.warnings.length} warning{liveValidation.warnings.length > 1 ? 's' : ''}</span>
            ) : (
              <span className="pill pg">Valid</span>
            )
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-se" onClick={() => addLine()}>+ Add line</button>
          <button className="btn btn-se" onClick={() => setShowValidation((v) => !v)}>{showValidation ? 'Hide checks' : 'Run checks'}</button>
          <button className="btn btn-se" onClick={onMapLedgers}>Map ledgers</button>
          <button className="btn btn-pr" disabled={saving} onClick={handleSave}>{saving ? 'Saving…' : 'Validate & save'}</button>
        </div>
      </div>

      {showValidation && liveValidation && <ValidationPanel result={savedValidation ?? liveValidation} />}
      {!currentFyId && (
        <div className="warn-bar" style={{ marginBottom: 12 }}>
          No financial year selected — sign-vs-section validation and the ledger picker need one. Pick a financial year from the top bar.
        </div>
      )}

      <div className="card" style={{ marginBottom: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 8rem 7rem 9rem', gap: 10, padding: '9px 14px', borderBottom: '1px solid var(--border)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .5, color: 'var(--text3)' }}>
          <span>Line item</span><span>Type</span><span>Sign</span><span style={{ textAlign: 'right' }}>Actions</span>
        </div>

        {lines.length === 0 && <div className="notice" style={{ padding: '24px 14px', textAlign: 'center' }}>No lines yet. Add your first line to start the structure.</div>}

        {lines.map((line) => {
          const depth = lineDepth({ ...line, templateId }, lines.map((l) => ({ ...l, templateId })));
          const mapped = lineLedgerMap[line.id]?.length ?? 0;
          const isDropBefore = dropTarget?.id === line.id && dropTarget.pos === 'before';
          const isDropAfter = dropTarget?.id === line.id && dropTarget.pos === 'after';
          return (
            <div
              key={line.id}
              draggable
              onDragStart={() => setDragId(line.id)}
              onDragOver={(e) => {
                e.preventDefault();
                if (!dragId) return;
                const rect = e.currentTarget.getBoundingClientRect();
                setDropTarget({ id: line.id, pos: e.clientY - rect.top < rect.height / 2 ? 'before' : 'after' });
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={() => handleDrop(line)}
              onDragEnd={() => { setDragId(null); setDropTarget(null); }}
              className="draggable-row"
              style={{
                display: 'grid', gridTemplateColumns: '1fr 8rem 7rem 9rem', gap: 10, alignItems: 'center',
                padding: '7px 14px', fontSize: 12,
                opacity: dragId === line.id ? 0.4 : 1,
                borderTop: isDropBefore ? '2px solid var(--blue)' : undefined,
                borderBottom: isDropAfter ? '2px solid var(--blue)' : '1px solid var(--border)',
                background: showValidation && errorLineIds.has(line.id) ? 'var(--red-l, #fef2f2)'
                  : showValidation && warnLineIds.has(line.id) ? 'var(--amber-l, #fffbeb)'
                  : undefined,
                ...TYPE_STYLE[line.lineType],
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <span style={{ color: 'var(--text3)', cursor: 'grab' }}>⠿</span>
                <div style={{ paddingLeft: depth * 16, display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                  <input
                    value={line.label}
                    onChange={(e) => updateLine(line.id, { label: e.target.value })}
                    style={{
                      flex: 1, minWidth: 0, border: '1px solid transparent', background: 'transparent',
                      padding: '3px 5px', borderRadius: 5, fontSize: 12, fontWeight: line.lineType !== 'detail' ? 700 : 400,
                    }}
                  />
                  {line.isPercentBase && <span className="pill pb" style={{ flexShrink: 0 }}>🎯 % base</span>}
                  {line.lineType === 'detail' && (
                    <span style={{ flexShrink: 0, fontSize: 10, fontFamily: 'var(--mono)', color: mapped ? 'var(--text3)' : 'var(--amber, #d97706)' }}>
                      {mapped ? `${mapped} ledger${mapped > 1 ? 's' : ''}` : 'unmapped'}
                    </span>
                  )}
                </div>
              </div>

              <select
                value={line.lineType}
                onChange={(e) => updateLine(line.id, { lineType: e.target.value as LineType })}
                style={{ fontSize: 11, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border2)', appearance: 'auto' }}
              >
                {(Object.keys(LINE_TYPE_LABELS) as LineType[]).map((t) => <option key={t} value={t} style={{ backgroundColor: 'var(--bg, #ffffff)', color: 'var(--text, #111827)' }}>{LINE_TYPE_LABELS[t]}</option>)}
              </select>

              {line.lineType === 'header' ? (
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>—</span>
              ) : (
                <button
                  className="btn btn-se btn-sm"
                  onClick={() => updateLine(line.id, { sign: line.sign === 1 ? -1 : 1 })}
                  style={{ justifyContent: 'flex-start' }}
                >
                  {line.sign === 1 ? '➕ Add' : '➖ Subtract'}
                </button>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
                <IconBtn title="Indent under line above" onClick={() => indentLine(line.id, 1)}>⇥</IconBtn>
                <IconBtn title="Outdent" disabled={!line.parentLineId} onClick={() => indentLine(line.id, -1)}>⇤</IconBtn>
                {line.lineType === 'subtotal' && (
                  <IconBtn
                    title={line.resetsAfter ? 'Closes its section (running total resets after this line)' : 'Cascades (running total continues past this line)'}
                    onClick={() => updateLine(line.id, { resetsAfter: !line.resetsAfter })}
                  >
                    {line.resetsAfter ? '⏹' : '⏵'}
                  </IconBtn>
                )}
                <IconBtn title="Mark as % base line" active={line.isPercentBase} onClick={() => setPercentBase(line.id)}>🎯</IconBtn>
                <IconBtn title="Add line below" onClick={() => addLine(line.id)}>➕</IconBtn>
                <IconBtn title="Delete line" danger onClick={() => deleteLine(line.id)}>🗑</IconBtn>
              </div>
            </div>
          );
        })}
      </div>

      <p className="notice">
        Drag rows to reorder. Indent a row to nest it under the line above (display only). A subtotal's running total keeps
        cascading into whatever comes after it — use ⏹ on a subtotal that should close its section instead (e.g. before a
        Balance Sheet block that must not inherit a P&amp;L total above it).
      </p>
    </div>
  );
}

function IconBtn({
  title, onClick, disabled, danger, active, children,
}: {
  title: string; onClick: () => void; disabled?: boolean; danger?: boolean; active?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button" title={title} disabled={disabled} onClick={onClick}
      style={{
        width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', background: active ? 'var(--blue-l)' : 'transparent', borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1, color: danger ? 'var(--red, #dc2626)' : active ? 'var(--blue)' : 'var(--text2)', fontSize: 13,
      }}
    >
      {children}
    </button>
  );
}
