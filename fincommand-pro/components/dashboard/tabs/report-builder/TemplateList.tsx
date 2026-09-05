'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@/lib/dashboard/ToastContext';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import type { FormatPreset } from '@/lib/financial/report-builder-engine';
import {
  fetchTemplates, createBlankTemplate, cloneTemplate, createFromPreset, deleteTemplate,
  type TemplateSummary,
} from '@/lib/dashboard/report-builder-api';
import { ApiClientError } from '@/lib/dashboard/api-client';

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(6,10,18,.55)', backdropFilter: 'blur(8px)',
};
const PANEL_STYLE: React.CSSProperties = {
  width: 460, maxWidth: 'calc(100vw - 32px)', background: '#0f1826',
  border: '1px solid rgba(255,255,255,.1)', borderRadius: 14, padding: 24,
  boxShadow: '0 24px 60px rgba(0,0,0,.5)', maxHeight: '85vh', overflowY: 'auto',
};
const INPUT_STYLE: React.CSSProperties = {
  width: '100%', padding: '9px 11px', fontSize: 12, border: '1px solid rgba(255,255,255,.14)',
  borderRadius: 8, color: '#e5e7eb', background: 'rgba(255,255,255,.04)', outline: 'none',
};
const LABEL_STYLE: React.CSSProperties = {
  fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: .4, fontWeight: 500,
  display: 'block', marginBottom: 5,
};

export function TemplateList({
  fyList, currentFyId, onOpen, onRun,
}: {
  fyList: { id: string; label: string }[];
  currentFyId: string | null;
  onOpen: (id: string) => void;
  onRun: (id: string) => void;
}) {
  const toast = useToast();
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [presets, setPresets] = useState<FormatPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newOpen, setNewOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [name, setName] = useState('');
  const [cloneFrom, setCloneFrom] = useState('blank');
  const [presetId, setPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const [presetFyId, setPresetFyId] = useState(currentFyId ?? '');
  const [busy, setBusy] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchTemplates()
      .then(({ templates: t, presets: p }) => {
        setTemplates(t);
        setPresets(p);
        if (!presetId && p[0]) { setPresetId(p[0].id); setPresetName(p[0].name); }
      })
      .catch((e) => setError(e instanceof ApiClientError ? e.message : 'Failed to load formats'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const { template } = cloneFrom === 'blank'
        ? await createBlankTemplate(trimmed)
        : await cloneTemplate(trimmed, cloneFrom);
      setNewOpen(false);
      setName('');
      setCloneFrom('blank');
      onOpen(template.id);
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : 'Failed to create format');
    } finally {
      setBusy(false);
    }
  }

  async function createQuick() {
    const trimmed = presetName.trim();
    if (!trimmed || !presetId || !presetFyId) return;
    setBusy(true);
    try {
      const { template } = await createFromPreset(trimmed, presetId, presetFyId);
      setPresetOpen(false);
      onOpen(template.id);
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : 'Failed to create format');
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleteId) return;
    setBusy(true);
    try {
      await deleteTemplate(deleteId);
      setDeleteId(null);
      load();
      toast('Format deleted');
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : 'Failed to delete');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Report formats</div>
          <div style={{ fontSize: 12, color: 'var(--text2)' }}>Define a row structure once, then run it against any period — real Zoho-synced ledgers, not a mock.</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-se" onClick={() => setPresetOpen(true)}>✨ Quick build</button>
          <button className="btn btn-pr" onClick={() => setNewOpen(true)}>+ New format</button>
        </div>
      </div>

      {loading && <div className="notice">Loading formats…</div>}
      {error && <div className="warn-bar">⚠ {error}</div>}

      {!loading && !error && templates && templates.length === 0 && (
        <div className="notice">No formats yet. Use "Quick build" for an auto-mapped starting point, or "New format" for a blank canvas.</div>
      )}

      {!loading && templates && templates.length > 0 && (
        <div className="grid2" style={{ gap: 12 }}>
          {templates.map((t) => (
            <div key={t.id} className="card" style={{ marginBottom: 0, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{t.name}</div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>
                {t.lineCount} lines · {t.detailCount} detail
              </div>
              <div style={{ fontSize: 11, marginBottom: 12 }}>
                {t.errorCount > 0 ? (
                  <span style={{ color: 'var(--red, #dc2626)' }}>⛔ {t.errorCount} blocking issue{t.errorCount > 1 ? 's' : ''}</span>
                ) : t.warningCount > 0 ? (
                  <span style={{ color: 'var(--amber, #d97706)' }}>⚠ {t.warningCount} warning{t.warningCount > 1 ? 's' : ''}</span>
                ) : (
                  <span style={{ color: 'var(--green, #16a34a)' }}>✓ Validated</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-se btn-sm" onClick={() => onOpen(t.id)}>Edit format</button>
                <button className="btn btn-se btn-sm" onClick={() => onRun(t.id)}>▶ Run</button>
                <button
                  className="btn btn-se btn-sm"
                  style={{ marginLeft: 'auto', color: 'var(--red, #dc2626)' }}
                  onClick={() => setDeleteId(t.id)}
                  aria-label={`Delete ${t.name}`}
                >
                  🗑
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {newOpen && (
        <div style={OVERLAY_STYLE} onClick={() => setNewOpen(false)}>
          <div style={PANEL_STYLE} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 4 }}>New report format</div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 18 }}>Start blank or clone an existing structure, including its ledger mappings.</div>
            <label style={LABEL_STYLE}>Format name</label>
            <input style={{ ...INPUT_STYLE, marginBottom: 14 }} value={name} placeholder="e.g. Management P&L" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
            <label style={LABEL_STYLE}>Start from</label>
            <select style={{ ...INPUT_STYLE, marginBottom: 18, appearance: 'auto' }} value={cloneFrom} onChange={(e) => setCloneFrom(e.target.value)}>
              <option value="blank" style={{ background: '#0f1826', color: '#e5e7eb' }}>Blank canvas</option>
              {(templates ?? []).map((t) => <option key={t.id} value={t.id} style={{ background: '#0f1826', color: '#e5e7eb' }}>Clone from {t.name}</option>)}
            </select>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-cancel-dark" onClick={() => setNewOpen(false)}>Cancel</button>
              <button className="btn btn-pr" disabled={busy || !name.trim()} onClick={create}>{busy ? 'Creating…' : 'Create format'}</button>
            </div>
          </div>
        </div>
      )}

      {presetOpen && (
        <div style={OVERLAY_STYLE} onClick={() => setPresetOpen(false)}>
          <div style={PANEL_STYLE} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Quick-build format</div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 18 }}>Starts from a pre-built structure, auto-mapped against your real synced ledgers. Edit mappings afterwards.</div>
            <label style={LABEL_STYLE}>Format name</label>
            <input style={{ ...INPUT_STYLE, marginBottom: 14 }} value={presetName} placeholder="e.g. Board P&L" onChange={(e) => setPresetName(e.target.value)} />
            <label style={LABEL_STYLE}>Financial year to map ledgers against</label>
            <select style={{ ...INPUT_STYLE, marginBottom: 14, appearance: 'auto' }} value={presetFyId} onChange={(e) => setPresetFyId(e.target.value)}>
              <option value="" style={{ background: '#0f1826', color: '#e5e7eb' }}>Select a financial year…</option>
              {fyList.map((fy) => <option key={fy.id} value={fy.id} style={{ background: '#0f1826', color: '#e5e7eb' }}>{fy.label}</option>)}
            </select>
            <label style={LABEL_STYLE}>Starting structure</label>
            <div style={{ display: 'grid', gap: 6, marginBottom: 18 }}>
              {presets.map((p) => (
                <button
                  key={p.id} type="button"
                  onClick={() => { setPresetId(p.id); setPresetName(p.name); }}
                  style={{
                    textAlign: 'left', padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                    border: `1px solid ${presetId === p.id ? '#185fa5' : 'rgba(255,255,255,.14)'}`,
                    background: presetId === p.id ? 'rgba(24,95,165,.15)' : 'transparent', color: '#e5e7eb',
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{p.summary}</div>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-cancel-dark" onClick={() => setPresetOpen(false)}>Cancel</button>
              <button className="btn btn-pr" disabled={busy || !presetName.trim() || !presetFyId} onClick={createQuick}>{busy ? 'Creating…' : 'Create format'}</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={deleteId !== null}
        title="Delete format?"
        message="This permanently deletes the format's structure, ledger mappings, and any saved reports built from it. This can't be undone."
        confirmLabel="Delete format"
        busy={busy}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
