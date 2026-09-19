'use client';

/**
 * Browse, edit (with version history + restore), and delete every custom
 * metric this company has defined — a list with each metric's kind, version,
 * plain-English definition, widget usage, and the other metrics whose
 * formulas depend on it.
 *
 * After ANY change here it refreshes three things, so nothing on screen goes
 * stale: its own list (fresh usage counts), the shared
 * TabCustomizationsContext list every widget/picker reads (previously not
 * refreshed — a new metric was missing from the widget picker and a deleted
 * one kept rendering its old value until a full reload), and the report
 * bundle (ledger metrics are computed server-side inside it).
 */
import { useEffect, useState } from 'react';
import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { useToast } from '@/lib/dashboard/ToastContext';
import { useCustomMetricsList } from '@/lib/dashboard/TabCustomizationsContext';
import { ApiClientError } from '@/lib/dashboard/api-client';
import { fetchCustomMetrics, deleteCustomMetric as apiDeleteCustomMetric } from '@/lib/dashboard/dashboard-builder-api';
import { describeCustomMetric, metricKind, type CustomMetricListItem } from '@/lib/financial/custom-metric-engine';
import { CustomMetricBuilder } from './tabs/dashboard-builder/CustomMetricBuilder';
import { ConfirmModal } from '@/components/ui/ConfirmModal';

// Mirrors ROLE_SETS.canWrite in lib/auth/permissions.ts — the set the
// custom-metrics API routes re-check server-side.
const CAN_MANAGE_CUSTOM_METRICS_ROLES = ['admin', 'cfo', 'manager'];

export function ManageCustomMetricsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, refresh: refreshBundle } = useDashboard();
  const toast = useToast();
  const { refreshCustomMetrics } = useCustomMetricsList();
  const canManage = !!user && CAN_MANAGE_CUSTOM_METRICS_ROLES.includes(user.role);

  const [metrics, setMetrics] = useState<CustomMetricListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<CustomMetricListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomMetricListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function reloadList() {
    try {
      const res = await fetchCustomMetrics();
      setMetrics(res.metrics);
    } catch {
      setMetrics([]); // a network hiccup shouldn't crash the modal
    } finally {
      setLoaded(true);
    }
  }

  /** Everything that must see a metric change — see this file's header. */
  async function propagateChange() {
    await Promise.all([reloadList(), refreshCustomMetrics()]);
    refreshBundle();
  }

  useEffect(() => {
    if (open) reloadList();
  }, [open]);

  if (!open) return null;

  const labelOf = (key: string) => metrics.find((m) => m.key === key)?.label ?? key;

  function requestDelete(m: CustomMetricListItem) {
    if (m.usedByMetrics.length) {
      toast(`"${m.label}" is used in the formula of ${m.usedByMetrics.map((k) => `"${labelOf(k)}"`).join(', ')} — remove it there first.`);
      return;
    }
    setDeleteTarget(m);
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiDeleteCustomMetric(deleteTarget.key);
      toast(`"${deleteTarget.label}" deleted`);
      setDeleteTarget(null);
      await propagateChange();
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : 'Failed to delete this metric');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div style={OVERLAY_STYLE} onClick={onClose}>
      <div style={{ ...PANEL_STYLE, width: 640 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Custom metrics">
        <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Custom metrics</div>
        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16 }}>
          Company KPIs built from existing metrics (formulas) or straight from Trial Balance ledgers — usable on any customizable tab, exactly like a built-in metric. Every change is versioned.
        </div>

        {canManage && (
          <div style={{ marginBottom: 16 }}>
            <button className="btn btn-pr" onClick={() => { setEditing(null); setBuilderOpen(true); }}>+ New custom metric</button>
          </div>
        )}

        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          {loaded && metrics.length === 0 && (
            <div style={{ fontSize: 12, color: '#6b7280', textAlign: 'center', padding: '20px 0' }}>
              {canManage ? 'No custom metrics yet — create one above.' : 'No custom metrics yet.'}
            </div>
          )}
          {metrics.map((m) => (
            <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 4px', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#e5e7eb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
                  <span style={BADGE_STYLE}>{metricKind(m) === 'ledger' ? 'Ledgers' : 'Formula'}</span>
                  {m.version != null && <span style={{ fontSize: 10, color: '#6b7280' }}>v{m.version}</span>}
                </div>
                <div style={{ fontSize: 10, color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={describeCustomMetric(m, metrics)}>
                  {describeCustomMetric(m, metrics)}
                </div>
                <div style={{ fontSize: 10, color: '#6b7280' }}>
                  {m.usageCount} widget{m.usageCount === 1 ? '' : 's'}
                  {m.usedByMetrics.length > 0 && ` · used in ${m.usedByMetrics.map(labelOf).join(', ')}`}
                  {m.description ? ` · ${m.description}` : ''}
                </div>
              </div>
              {canManage ? (
                <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
                  <button className="btn btn-cancel-dark btn-sm" onClick={() => { setEditing(m); setBuilderOpen(true); }} title="Edit / history" aria-label={`Edit ${m.label}`}>✎</button>
                  <button className="btn btn-cancel-dark btn-sm" onClick={() => requestDelete(m)} title="Delete" aria-label={`Delete ${m.label}`}>🗑</button>
                </div>
              ) : (
                <span style={{ fontSize: 10, color: '#6b7280', flex: 'none' }}>{m.key}</span>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-cancel-dark" onClick={onClose}>Close</button>
        </div>
      </div>

      <CustomMetricBuilder
        open={builderOpen}
        editing={editing}
        onClose={() => setBuilderOpen(false)}
        onSaved={() => { void propagateChange(); }}
      />

      <ConfirmModal
        open={!!deleteTarget}
        title={`Delete "${deleteTarget?.label}"?`}
        message={
          deleteTarget && deleteTarget.usageCount > 0
            ? `Used by ${deleteTarget.usageCount} widget${deleteTarget.usageCount === 1 ? '' : 's'} — ${deleteTarget.usageCount === 1 ? 'it' : 'they'}'ll show "no data" after this. Its version history is deleted too. This can't be undone.`
            : "This removes the metric and its version history. This can't be undone."
        }
        confirmLabel="Delete"
        busy={deleting}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(6,10,18,.55)', backdropFilter: 'blur(8px)',
};
const PANEL_STYLE: React.CSSProperties = {
  width: 460, maxWidth: 'calc(100vw - 32px)', background: '#0f1826',
  border: '1px solid rgba(255,255,255,.1)', borderRadius: 14, padding: 24,
  boxShadow: '0 24px 60px rgba(0,0,0,.5)', maxHeight: '85vh', overflowY: 'auto',
};
const BADGE_STYLE: React.CSSProperties = {
  fontSize: 9, padding: '1px 6px', borderRadius: 999, border: '1px solid rgba(91,159,224,.4)', color: '#93c5fd', flex: 'none',
};
