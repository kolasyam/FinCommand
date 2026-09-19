'use client';

/**
 * Generalizes the original MyDashboardTab.tsx orchestration (edit-mode/
 * picker/inspector state, widget add/delete/duplicate/drag handlers) into a
 * reusable panel any customizable tab can wrap.
 *
 * Non-disruption rule: a tab with a real `fixedView` renders it, completely
 * unchanged, whenever there's no saved personal or company-default
 * customization for it — with a small opt-in "Customize this view" button.
 * `fixedView === null` is the one exception ("My Dashboard" itself, which
 * has no prior view to protect) — it always renders the grid.
 *
 * Widget values are resolved client-side from the `bundle` DashboardContext
 * already loaded for every tab, via resolveAnyMetric() (built-in
 * METRIC_CATALOG + this company's own custom metrics) — no separate data
 * fetch, so currency/unit/period changes update instantly.
 */
import { useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { useToast } from '@/lib/dashboard/ToastContext';
import { useTabCustomization } from '@/lib/dashboard/TabCustomizationsContext';
import { ApiClientError } from '@/lib/dashboard/api-client';
import { resolveAnyMetric } from '@/lib/financial/custom-metric-engine';
import { WIDGET_MIN_SERIES, PERIOD_SUMMARY_METRIC_KEYS, findMetricCatalogEntry, type DashboardWidget, type TabKey } from '@/lib/financial/dashboard-builder-engine';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { GridCanvas } from './GridCanvas';
import { renderWidget } from './widget-renderers';
import { WidgetPicker, WIDGET_TYPE_META, type NewWidgetSpec } from './WidgetPicker';
import { WidgetInspector } from './WidgetInspector';
import { CustomMetricBuilder } from './CustomMetricBuilder';
import { getFyLabel, getFyShortLabel } from '@/lib/utils/format';
import {
  buildLayoutExportModel, exportDashboardLayoutPdf, exportDashboardLayoutXlsx, exportDashboardLayoutPptx,
  exportDashboardLayoutCsv, exportDashboardLayoutPng, type LayoutExportMeta,
} from '@/lib/exports/dashboard-layout-export';

// Mirrors ROLE_SETS.canWrite in lib/auth/permissions.ts (server-only — not
// safe to import into a client component; same precedent as NotesTab.tsx's
// own CAN_RECLASSIFY_ROLES). The API route re-checks this itself, so a
// stale copy here would only mean an extra denied request, never a
// bypassed check.
const CAN_SET_COMPANY_DEFAULT_ROLES = ['admin', 'cfo', 'manager'];

/** Export file/PDF title for each fixed tab's customized view — the tab's own sidebar name. Custom tabs pass `title` instead. */
const FIXED_TAB_EXPORT_TITLES: Record<string, string> = {
  'my-dashboard': 'My Dashboard', overview: 'Executive Overview', mis: 'MIS Report', ratios: 'Ratio Analysis',
  funds: 'Treasury', wc: 'Working Capital', 'customer-margin': 'Customer Margin', 'vendor-expense': 'Vendor Expense',
  boardpack: 'Board Pack', bs: 'Balance Sheet', pl: 'P&L Account', cashflow: 'Cash Flow', notes: 'Notes to Accounts',
};

type ExportFormat = 'pdf' | 'pptx' | 'xlsx' | 'csv' | 'png';
const EXPORT_OPTIONS: { format: ExportFormat; label: string; hint: string; done: string }[] = [
  { format: 'pdf', label: 'PDF', hint: 'This view as arranged — KPI cards, charts and tables', done: 'View exported to PDF' },
  { format: 'pptx', label: 'PowerPoint', hint: 'Slides with KPI tiles, editable charts and tables', done: 'View exported to PowerPoint' },
  { format: 'xlsx', label: 'Excel', hint: 'Every figure — values, monthly trends and breakdowns', done: 'View exported to Excel' },
  { format: 'csv', label: 'CSV', hint: 'Every figure as one flat table, for other tools', done: 'View exported to CSV' },
  { format: 'png', label: 'Image (PNG)', hint: 'A picture of this view exactly as on screen', done: 'View exported as an image' },
];

function widgetLabel(w: DashboardWidget): string {
  return w.title || WIDGET_TYPE_META[w.widgetType]?.label || w.widgetType;
}
function findUnderBoundWidget(widgets: DashboardWidget[]): DashboardWidget | undefined {
  return widgets.find((w) => w.series.length < WIDGET_MIN_SERIES[w.widgetType]);
}

export interface CustomizableTabPanelProps {
  tabKey: TabKey;
  /** The starting point the first time a user clicks "Customize this view" on a tab with a fixedView — never a silent replacement of what's already on screen. */
  defaultWidgets: DashboardWidget[];
  /** The tab's real, existing fixed content. `null` only for 'my-dashboard', which has no prior view to protect — every other tab must pass its real single-year JSX here. */
  fixedView: React.ReactNode | null;
  /** Optional heading shown above the grid while customizing/viewing a saved layout. The other 8 tabs already carry their own DownloadBar title inside fixedView, so this is really only for 'my-dashboard' (which has none) — harmless to omit elsewhere. */
  title?: string;
  /** Name used for this view's PDF/Excel export when there's no `title` (e.g. "Executive Overview"). */
  exportTitle?: string;
}

export function CustomizableTabPanel({ tabKey, defaultWidgets, fixedView, title, exportTitle }: CustomizableTabPanelProps) {
  const { bundle, dataMode, granularity, displayUnit, presentationCurrency, user, refresh: refreshBundle } = useDashboard();
  const toast = useToast();
  const { state, loaded, customMetrics, refreshCustomMetrics, save, reset, saveCompanyDefault, ensureLoaded } = useTabCustomization(tabKey);

  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [editing, setEditing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [metricBuilderOpen, setMetricBuilderOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Close the Export menu on an outside click or Escape.
  useEffect(() => {
    if (!exportMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) setExportMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExportMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [exportMenuOpen]);

  const hasFixedView = fixedView !== null;
  const hasSavedCustomization = !!state && state.source !== 'none';
  const showGrid = editing || hasSavedCustomization;

  // Sync local widgets from the shared cache whenever it changes and we're
  // not actively editing — the cache only ever changes here via this same
  // panel's own save()/reset() calls, so this can't clobber an in-progress
  // edit; it's just how "view mode" always reflects the latest saved state.
  useEffect(() => {
    if (!editing) setWidgets(state?.widgets ?? []);
  }, [state, editing]);

  // A tab not in the session's initial batch (e.g. a custom tab created a
  // moment ago from a template) is fetched on first view rather than shown
  // as empty.
  useEffect(() => {
    if (dataMode === 'api' && loaded && state === undefined) ensureLoaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataMode, loaded, state, tabKey]);

  const canSetCompanyDefault = dataMode === 'api' && !!user && CAN_SET_COMPANY_DEFAULT_ROLES.includes(user.role);
  const selected = widgets.find((w) => w.id === selectedId) ?? null;

  function startEditing() {
    setWidgets(hasSavedCustomization && state ? state.widgets : defaultWidgets);
    setDirty(!hasSavedCustomization);
    setEditing(true);
  }

  function handleGridChange(next: DashboardWidget[]) { setWidgets(next); setDirty(true); }
  function updateWidget(id: string, patch: Partial<DashboardWidget>) {
    setWidgets((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)));
    setDirty(true);
  }
  function deleteWidget(id: string) {
    setWidgets((prev) => prev.filter((w) => w.id !== id));
    if (selectedId === id) setSelectedId(null);
    setDirty(true);
  }
  function duplicateWidget(id: string) {
    setWidgets((prev) => {
      const src = prev.find((w) => w.id === id);
      if (!src) return prev;
      return [...prev, { ...src, id: uuidv4(), gridY: src.gridY + src.gridH }];
    });
    setDirty(true);
  }
  function addWidget(spec: NewWidgetSpec) {
    const meta = WIDGET_TYPE_META[spec.widgetType];
    const bottom = widgets.reduce((max, w) => Math.max(max, w.gridY + w.gridH), 0);
    const firstKey = spec.metricKeys[0];
    // A ratio card is named after BOTH its metrics ("A ÷ B") — left unset so
    // the renderer derives it and it stays right if either metric changes.
    const title = spec.widgetType === 'text_block'
      ? 'Note'
      : spec.widgetType === 'period_summary'
      ? 'Period Summary'
      : spec.widgetType === 'ratio_card'
      ? null
      : spec.widgetType === 'kpi_group'
      ? 'Key figures'
      : findMetricCatalogEntry(firstKey ?? '')?.label ?? customMetrics.find((m) => m.key === firstKey)?.label ?? null;
    const newWidget: DashboardWidget = {
      id: uuidv4(),
      widgetType: spec.widgetType,
      title,
      subtitle: null,
      gridX: 0, gridY: bottom, gridW: meta.defaultSize.w, gridH: meta.defaultSize.h,
      series: spec.metricKeys.map((k) => ({ metricKey: k })),
      vizConfig: spec.widgetType === 'text_block' ? { text: spec.text ?? '' } : {},
      sequence: widgets.length,
    };
    setWidgets((prev) => [...prev, newWidget]);
    setSelectedId(newWidget.id);
    setDirty(true);
  }

  async function handleSave() {
    const offending = findUnderBoundWidget(widgets);
    if (offending) {
      const min = WIDGET_MIN_SERIES[offending.widgetType];
      toast(`"${widgetLabel(offending)}" needs at least ${min} metric${min === 1 ? '' : 's'} bound to it before saving.`);
      return;
    }
    setSaving(true);
    try {
      const res = await save(widgets);
      setWidgets(res.widgets);
      setDirty(false);
      toast('View saved');
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : 'Failed to save this view');
    } finally {
      setSaving(false);
    }
  }

  async function handleSetCompanyDefault() {
    const offending = findUnderBoundWidget(widgets);
    if (offending) {
      const min = WIDGET_MIN_SERIES[offending.widgetType];
      toast(`"${widgetLabel(offending)}" needs at least ${min} metric${min === 1 ? '' : 's'} bound to it before saving.`);
      return;
    }
    setSaving(true);
    try {
      await saveCompanyDefault(widgets);
      toast("This view is now the default for teammates who haven't customized their own yet.");
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : 'Failed to set company default');
    } finally {
      setSaving(false);
    }
  }

  async function confirmReset() {
    setSaving(true);
    try {
      await reset();
      setResetConfirmOpen(false);
      setEditing(false);
      setSelectedId(null);
      setDirty(false);
      toast('View reset');
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : 'Failed to reset this view');
    } finally {
      setSaving(false);
    }
  }

  function exitEditing() {
    setEditing(false);
    setSelectedId(null);
    setWidgets(state?.widgets ?? []); // discard unsaved local edits
    setDirty(false);
  }

  /** The single resolver both the grid and the export use — an export can never show a different number than the screen. */
  const resolveWidget = (w: DashboardWidget) => {
    if (!bundle) return [];
    // period_summary is fixed content — always the same real waterfall keys,
    // regardless of widget.series (which stays [] for this type; nothing is
    // user-pickable, see PERIOD_SUMMARY_METRIC_KEYS's own doc comment).
    const keys = w.widgetType === 'period_summary' ? PERIOD_SUMMARY_METRIC_KEYS : w.series.map((s) => s.metricKey);
    return keys.map((k) => resolveAnyMetric(k, bundle, customMetrics));
  };

  const renderContent = (w: DashboardWidget) => {
    if (!bundle) return null;
    return renderWidget({ widget: w, resolved: resolveWidget(w), displayUnit, currency: presentationCurrency });
  };

  async function handleExport(format: ExportFormat) {
    if (!bundle) return;
    setExportMenuOpen(false);
    setExporting(format);
    try {
      const yearType = bundle.period_params?.yearType || 'FY';
      const meta: LayoutExportMeta = {
        // Custom-tab titles lead with their icon emoji — keep only the name for file/PDF titles.
        title: (title ?? exportTitle ?? FIXED_TAB_EXPORT_TITLES[tabKey] ?? 'Dashboard').replace(/^[^\p{L}\p{N}]+/u, '').trim() || 'Dashboard',
        companyName: user?.company_name ?? 'Company',
        fyLabel: getFyLabel(bundle.financial_year, yearType),
        fyShort: getFyShortLabel(bundle.financial_year, yearType),
        periodLabel: bundle.period_label,
        unit: displayUnit,
        currency: presentationCurrency,
      };
      if (format === 'png') {
        if (!gridRef.current) throw new Error('The view is not on screen');
        await exportDashboardLayoutPng(gridRef.current, meta);
      } else {
        const model = buildLayoutExportModel(widgets, resolveWidget, bundle);
        if (format === 'pdf') exportDashboardLayoutPdf(model, meta, gridRef.current);
        else if (format === 'xlsx') exportDashboardLayoutXlsx(model, meta);
        else if (format === 'csv') exportDashboardLayoutCsv(model, meta);
        else await exportDashboardLayoutPptx(model, meta);
      }
      toast(EXPORT_OPTIONS.find((o) => o.format === format)!.done);
    } catch (e) {
      console.error('[dashboard export] failed:', e);
      toast('Export failed — please try again');
    } finally {
      setExporting(null);
    }
  }

  if (dataMode !== 'api') {
    if (hasFixedView) return <>{fixedView}</>;
    return (
      <div className="notice" style={{ padding: 30, textAlign: 'center' }}>
        This view needs a real signed-in company — you&apos;re viewing sample data. Sign in to customize it.
      </div>
    );
  }
  if (granularity === '3year') {
    if (hasFixedView) return <>{fixedView}</>;
    return (
      <div className="notice" style={{ padding: 30, textAlign: 'center' }}>
        This view shows one period at a time — switch out of 3-Year Compare to see it.
      </div>
    );
  }

  // No saved customization (yet) and not editing: show the tab's real fixed
  // view immediately (no spinner, no visible change from today) with an
  // opt-in entry point. 'my-dashboard' (fixedView === null) is the one case
  // with nothing else to fall back to while the initial fetch is in flight.
  if (!showGrid) {
    if (!hasFixedView && (!loaded || state === undefined)) return <div className="notice">Loading your dashboard…</div>;
    if (hasFixedView) {
      return (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button className="btn btn-se btn-sm" onClick={startEditing}>✎ Customize this view</button>
          </div>
          {fixedView}
        </div>
      );
    }
  }
  if (!bundle) return hasFixedView ? <>{fixedView}</> : null;

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div>
          {title && <div style={{ fontSize: 18, fontWeight: 700 }}>{title}</div>}
          <div style={{ fontSize: 12, color: 'var(--text2)' }}>
            {state?.source === 'personal' && 'Your customized view.'}
            {state?.source === 'company_default' && "Your company's default view — customize and Save to make it your own."}
            {state?.source === 'system_default' && 'A starter layout — customize and Save to make it your own.'}
            {(!state || state.source === 'none') && editing && 'Customizing this view — nothing is saved until you click Save.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
          {editing && <button className="btn btn-se" onClick={() => setPickerOpen(true)}>+ Add widget</button>}
          {editing && state?.source === 'personal' && (
            <button className="btn btn-se" disabled={saving} onClick={() => setResetConfirmOpen(true)}>Reset to default</button>
          )}
          {editing && canSetCompanyDefault && (
            <button
              className="btn btn-se" disabled={saving} onClick={handleSetCompanyDefault}
              title="Make this the starting layout for teammates who haven't customized their own yet"
            >
              Set as company default
            </button>
          )}
          {!editing && widgets.length > 0 && (
            <div ref={exportMenuRef} style={{ position: 'relative' }}>
              <button
                className="btn btn-se" disabled={exporting !== null} onClick={() => setExportMenuOpen((o) => !o)}
                aria-haspopup="menu" aria-expanded={exportMenuOpen} title="Download this view"
              >
                {exporting ? `Exporting ${EXPORT_OPTIONS.find((o) => o.format === exporting)!.label}…` : '⬇ Export ▾'}
              </button>
              {exportMenuOpen && (
                <div role="menu" style={EXPORT_MENU_STYLE}>
                  {EXPORT_OPTIONS.map((o) => (
                    <button key={o.format} type="button" role="menuitem" className="export-menu-item" onClick={() => void handleExport(o.format)} style={EXPORT_ITEM_STYLE}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{o.label}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 1 }}>{o.hint}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {editing ? (
            <>
              <button className="btn btn-se" onClick={exitEditing}>{dirty ? 'Discard & exit' : (hasFixedView ? 'Back to standard view' : 'Done editing')}</button>
              <button className="btn btn-pr" disabled={saving || !dirty} onClick={handleSave}>{saving ? 'Saving…' : 'Save'}</button>
            </>
          ) : (
            <button className="btn btn-pr" onClick={startEditing}>✎ Customize</button>
          )}
        </div>
      </div>

      <div ref={gridRef} style={{ display: 'grid', gridTemplateColumns: editing && selected ? 'minmax(0,1fr) 300px' : '1fr', gap: 14, alignItems: 'start' }}>
        <GridCanvas
          widgets={widgets}
          editable={editing}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onChange={handleGridChange}
          onDelete={deleteWidget}
          onDuplicate={duplicateWidget}
          renderContent={renderContent}
        />
        {editing && selected && (
          <WidgetInspector widget={selected} onChange={(patch) => updateWidget(selected.id, patch)} onClose={() => setSelectedId(null)} customMetrics={customMetrics} />
        )}
      </div>

      <WidgetPicker
        open={pickerOpen} onClose={() => setPickerOpen(false)} onAdd={addWidget} customMetrics={customMetrics}
        canCreateCustomMetric={canSetCompanyDefault}
        onOpenCustomMetricBuilder={() => setMetricBuilderOpen(true)}
      />
      <CustomMetricBuilder
        open={metricBuilderOpen}
        onClose={() => setMetricBuilderOpen(false)}
        onSaved={(def) => {
          void refreshCustomMetrics();
          // Ledger metrics are computed server-side inside the report bundle,
          // and so are the previous-period statements a prior-period
          // comparison reads (built only once some metric asks for them).
          if (def.kind === 'ledger' || def.comparison === 'prior_period') refreshBundle();
        }}
      />

      <ConfirmModal
        open={resetConfirmOpen}
        title="Reset this view?"
        message="This removes your personal customization and reverts to your company's default (or the starter) layout. This can't be undone."
        confirmLabel="Reset"
        busy={saving}
        onConfirm={confirmReset}
        onCancel={() => setResetConfirmOpen(false)}
      />
    </div>
  );
}

const EXPORT_MENU_STYLE: React.CSSProperties = {
  position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 50, width: 280, padding: 6,
  background: 'var(--bg)', border: '1px solid var(--border2, var(--border))', borderRadius: 10,
  boxShadow: '0 12px 32px rgba(0,0,0,.18)',
};
const EXPORT_ITEM_STYLE: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', borderRadius: 6,
  background: 'transparent', cursor: 'pointer',
};
