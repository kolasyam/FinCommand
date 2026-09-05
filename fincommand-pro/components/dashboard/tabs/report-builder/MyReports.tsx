'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@/lib/dashboard/ToastContext';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { ApiClientError } from '@/lib/dashboard/api-client';
import { fetchSavedReports, deleteSavedReport, fetchTemplates, type SavedReportDTO, type TemplateSummary } from '@/lib/dashboard/report-builder-api';
import { formatDate } from '@/lib/utils/format';

export function MyReports({ fyList, onOpen }: { fyList: { id: string; label: string }[]; onOpen: (report: SavedReportDTO) => void }) {
  const toast = useToast();
  const [reports, setReports] = useState<SavedReportDTO[] | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([fetchSavedReports(), fetchTemplates()])
      .then(([r, t]) => { setReports(r.reports); setTemplates(t.templates); })
      .catch((e) => toast(e instanceof ApiClientError ? e.message : 'Failed to load saved reports'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function confirmDelete() {
    if (!deleteId) return;
    setBusy(true);
    try {
      await deleteSavedReport(deleteId);
      setDeleteId(null);
      load();
      toast('Report deleted');
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : 'Failed to delete');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>My Reports</div>
        <div style={{ fontSize: 12, color: 'var(--text2)' }}>Saved runs re-compute against the latest ledger data every time you open them.</div>
      </div>

      {loading && <div className="notice">Loading…</div>}

      {!loading && reports && reports.length === 0 && (
        <div className="notice">No saved reports yet. Open a format, run it, then save the configuration here.</div>
      )}

      {!loading && reports && reports.length > 0 && (
        <div className="grid2" style={{ gap: 12 }}>
          {reports.map((r) => {
            const template = templates.find((t) => t.id === r.template_id);
            const fyTarget = fyList.find((f) => f.id === r.financial_year_id);
            return (
              <div key={r.id} className="card" style={{ marginBottom: 0, padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{r.name}</div>
                  <span className="pill pgy">{fyTarget?.label ?? 'FY'} · {r.month_indices.length} period{r.month_indices.length === 1 ? '' : 's'}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>Format: {template?.name ?? 'Unknown'}</div>
                <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 12 }}>
                  {r.last_run_at ? `Last run ${formatDate(r.last_run_at)}` : 'Never run'} · {r.show_percent ? '% of base on' : '% of base off'}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-se btn-sm" onClick={() => onOpen(r)}>▶ Run</button>
                  <button
                    className="btn btn-se btn-sm" style={{ marginLeft: 'auto', color: 'var(--red, #dc2626)' }}
                    onClick={() => setDeleteId(r.id)} aria-label={`Delete ${r.name}`}
                  >
                    🗑
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmModal
        open={deleteId !== null}
        title="Delete saved report?"
        message="This removes the saved configuration. The underlying format and ledger data are unaffected."
        confirmLabel="Delete report"
        busy={busy}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
