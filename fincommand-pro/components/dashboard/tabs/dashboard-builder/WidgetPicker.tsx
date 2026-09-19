'use client';

/**
 * Add-widget modal — two steps: pick a widget type, then pick which real
 * metric(s) from METRIC_CATALOG feed it (skipped for text_block, which
 * takes free text instead). Mirrors the modal chrome already established by
 * report-builder's TemplateList.tsx (OVERLAY_STYLE/PANEL_STYLE) so this
 * looks native to the app rather than a bolted-on new pattern.
 */
import { useMemo, useState } from 'react';
import { METRIC_CATALOG, WIDGET_KINDS, WIDGET_MIN_SERIES, WIDGET_MAX_SERIES, type WidgetKind } from '@/lib/financial/dashboard-builder-engine';
import { customMetricCapabilities, type CustomMetricDefinition } from '@/lib/financial/custom-metric-engine';

export interface NewWidgetSpec {
  widgetType: WidgetKind;
  metricKeys: string[];
  text?: string;
}

interface WidgetTypeMeta { label: string; description: string; icon: string; multiSeries?: boolean; defaultSize: { w: number; h: number }; }

export const WIDGET_TYPE_META: Record<WidgetKind, WidgetTypeMeta> = {
  stat_card: { label: 'Stat card', description: 'A single KPI number with its YoY change.', icon: '🔢', defaultSize: { w: 3, h: 4 } },
  stat_card_sparkline: { label: 'Stat + sparkline', description: 'A KPI number with a mini monthly trend line.', icon: '📈', defaultSize: { w: 4, h: 6 } },
  line_chart: { label: 'Line chart', description: 'Compare up to 4 metrics over the period’s months — any series can be drawn as bars or put on a second axis.', icon: '📉', multiSeries: true, defaultSize: { w: 6, h: 7 } },
  bar_chart: { label: 'Bar chart', description: 'Compare up to 4 metrics as monthly bars — mix in a line (e.g. a margin %) on a second axis.', icon: '📊', multiSeries: true, defaultSize: { w: 6, h: 7 } },
  hbar_chart: { label: 'Horizontal bar', description: 'What makes up a figure, as ranked horizontal bars (e.g. expense ledgers, vendors).', icon: '📶', defaultSize: { w: 6, h: 7 } },
  ratio_card: { label: 'Ratio card', description: 'One metric divided by another, as a % or a multiple, with its change.', icon: '➗', defaultSize: { w: 4, h: 5 } },
  kpi_group: { label: 'KPI group', description: '2–6 headline figures side by side in one card.', icon: '🧩', multiSeries: true, defaultSize: { w: 12, h: 4 } },
  donut_chart: { label: 'Donut chart', description: 'A composition breakdown (e.g. Treasury mix).', icon: '🍩', defaultSize: { w: 5, h: 7 } },
  gauge: { label: 'Gauge', description: 'A ratio measured against its real benchmark.', icon: '🎯', defaultSize: { w: 4, h: 5 } },
  data_table: { label: 'Data table', description: 'A ranked list (e.g. Top Customers).', icon: '📋', defaultSize: { w: 6, h: 7 } },
  metric_table: { label: 'Metric table', description: 'A month-by-month table of up to 4 metrics.', icon: '🧮', multiSeries: true, defaultSize: { w: 8, h: 7 } },
  period_summary: { label: 'Period summary table', description: 'The real Revenue → Gross Profit → EBITDA → PBT → PAT waterfall with % of Revenue — fixed content, nothing to configure.', icon: '📑', defaultSize: { w: 12, h: 7 } },
  yoy_variance: { label: 'YoY variance table', description: 'Up to 4 metrics vs. their real prior-year figure, with a favorable/unfavorable badge.', icon: '📐', multiSeries: true, defaultSize: { w: 8, h: 6 } },
  financial_health: { label: 'Financial Health & Solvency', description: '4 key solvency indicators: Current Ratio, Net Working Capital, ROE, Debt/Equity — fixed content, nothing to configure.', icon: '🛡️', defaultSize: { w: 12, h: 5 } },
  top_customers: { label: 'Top Customers table', description: 'The real Top 5 Customers by Revenue — name, revenue, % of Revenue, GM% and status — fixed content, nothing to configure.', icon: '🏆', defaultSize: { w: 12, h: 6 } },
  profit_bridge: { label: 'Profit Bridge', description: 'The real Revenue → PBT → PAT waterfall, IND AS Schedule III P&L — fixed content, nothing to configure.', icon: '🌉', defaultSize: { w: 12, h: 9 } },
  cash_bridge: { label: 'Cash Bridge', description: 'The real Opening → Operating → Investing → Financing → Closing cash waterfall, IND AS 7 — fixed content, nothing to configure.', icon: '🌊', defaultSize: { w: 12, h: 9 } },
  note_index: { label: 'Note Index', description: 'The real Notes contents-page table — every Schedule III note, click a row to jump to its detail — fixed content, nothing to configure.', icon: '📇', defaultSize: { w: 12, h: 8 } },
  text_block: { label: 'Text note', description: 'Free text — a heading or a note, no data.', icon: '📝', defaultSize: { w: 4, h: 4 } },
};

/** period_summary/financial_health/top_customers are fixed-content summaries — 0 min series (see WIDGET_MIN_SERIES's own doc comment) and nothing to bind, so step 2 skips the metric picker entirely for them (and WidgetInspector.tsx skips its series editor the same way). text_block is also 0-min-series but gets its own free-text step instead, handled separately below. */
export function isFixedContentType(t: WidgetKind): boolean {
  return WIDGET_MIN_SERIES[t] === 0 && t !== 'text_block';
}

interface PickableMetric { key: string; label: string; group: string; supportsSeries: boolean; supportsBreakdown: boolean; }

/** Whether a metric can really fill this widget type — charts/sparklines/metric tables need a monthly trend, donuts/ranked tables/horizontal bars a breakdown; everything else takes any metric. Shared with WidgetInspector.tsx. */
export function metricFitsWidget(t: WidgetKind, supportsSeries: boolean, supportsBreakdown: boolean): boolean {
  if (t === 'stat_card_sparkline' || t === 'line_chart' || t === 'bar_chart' || t === 'metric_table') return supportsSeries;
  if (t === 'donut_chart' || t === 'data_table' || t === 'hbar_chart') return supportsBreakdown;
  return true;
}

/** ratio_card's two series have fixed roles — shown next to each pick so the order is never a guess. */
export const RATIO_ROLES = ['Numerator', 'Denominator'] as const;

export function WidgetPicker({
  open, onClose, onAdd, customMetrics = [], canCreateCustomMetric = false, onOpenCustomMetricBuilder,
}: {
  open: boolean; onClose: () => void; onAdd: (spec: NewWidgetSpec) => void;
  /** This company's custom metrics (see custom-metric-engine.ts). They never carry a real trend/breakdown, so they only ever surface for stat_card/gauge below — never charts/tables that need per-month or per-item data. */
  customMetrics?: CustomMetricDefinition[];
  /** ROLE_SETS.canWrite gate, mirrored from the caller (the server re-checks) — same set that may set a company-default layout, since a custom metric is an org-wide definition too. */
  canCreateCustomMetric?: boolean;
  onOpenCustomMetricBuilder?: () => void;
}) {
  const [step, setStep] = useState<'type' | 'metric'>('type');
  const [widgetType, setWidgetType] = useState<WidgetKind | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [text, setText] = useState('');

  const allMetrics: PickableMetric[] = useMemo(() => [
    ...METRIC_CATALOG,
    // A custom metric is offered to exactly the widget types it can really
    // fill: charts/sparklines/metric tables only when every input has a real
    // monthly trend, donuts/ranked tables only for ledger metrics (one slice
    // per matched ledger) — see customMetricCapabilities().
    ...customMetrics.map((m): PickableMetric => {
      const cap = customMetricCapabilities(m, customMetrics);
      return { key: m.key, label: m.label, group: 'Custom Metrics', supportsSeries: cap.supportsSeries, supportsBreakdown: cap.supportsBreakdown };
    }),
  ], [customMetrics]);

  const groups = useMemo(() => {
    const byGroup = new Map<string, PickableMetric[]>();
    allMetrics
      .filter((m) => m.label.toLowerCase().includes(query.toLowerCase()) || m.group.toLowerCase().includes(query.toLowerCase()))
      .filter((m) => !widgetType || metricFitsWidget(widgetType, m.supportsSeries, m.supportsBreakdown))
      .forEach((m) => {
        if (!byGroup.has(m.group)) byGroup.set(m.group, []);
        byGroup.get(m.group)!.push(m);
      });
    return byGroup;
  }, [allMetrics, query, widgetType]);

  function reset() {
    setStep('type'); setWidgetType(null); setSelected([]); setQuery(''); setText('');
    onClose();
  }

  if (!open) return null;

  function pickType(t: WidgetKind) {
    setWidgetType(t);
    setSelected([]);
    setStep('metric');
  }

  function toggleMetric(key: string) {
    if (!widgetType) return;
    const max = WIDGET_MAX_SERIES[widgetType];
    if (max <= 1) { setSelected([key]); return; }
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : prev.length < max ? [...prev, key] : prev));
  }

  function confirm() {
    if (!widgetType) return;
    onAdd({ widgetType, metricKeys: selected, text: widgetType === 'text_block' ? text : undefined });
    reset();
  }

  const minSeries = widgetType ? WIDGET_MIN_SERIES[widgetType] : 0;
  const maxSeries = widgetType ? WIDGET_MAX_SERIES[widgetType] : 0;
  const canConfirm = !!widgetType && selected.length >= minSeries;
  // Any metric-bound widget type can take a custom metric (subject to its capabilities, see the groups filter above).
  const anyMetricWidget = !!widgetType && widgetType !== 'text_block' && !isFixedContentType(widgetType);

  return (
    <div style={OVERLAY_STYLE} onClick={reset}>
      <div style={{ ...PANEL_STYLE, width: 520 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Add a widget</div>
        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16 }}>
          {step === 'type' ? 'Choose a widget type.'
            : widgetType === 'text_block' ? 'Write the note text.'
            : widgetType && isFixedContentType(widgetType) ? 'Fixed content — nothing to configure.'
            : 'Choose what real data it shows.'}
        </div>

        {step === 'type' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {WIDGET_KINDS.map((t) => (
              <button
                key={t} type="button" onClick={() => pickType(t)}
                style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 8, cursor: 'pointer', border: '1px solid rgba(255,255,255,.14)', background: 'transparent', color: '#e5e7eb' }}
              >
                <div style={{ fontSize: 13, fontWeight: 600 }}>{WIDGET_TYPE_META[t].icon} {WIDGET_TYPE_META[t].label}</div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{WIDGET_TYPE_META[t].description}</div>
              </button>
            ))}
          </div>
        )}

        {step === 'metric' && widgetType === 'text_block' && (
          <div>
            <label style={LABEL_STYLE}>Text</label>
            <textarea
              value={text} onChange={(e) => setText(e.target.value)} rows={4}
              style={{ ...INPUT_STYLE, resize: 'vertical' }} placeholder="e.g. Notes for the board…"
            />
          </div>
        )}

        {step === 'metric' && widgetType && isFixedContentType(widgetType) && (
          <div style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.6, padding: '10px 2px' }}>
            {WIDGET_TYPE_META[widgetType].description} Click <strong>Add widget</strong> to place it.
          </div>
        )}

        {step === 'metric' && widgetType && widgetType !== 'text_block' && !isFixedContentType(widgetType) && (
          <>
            {widgetType === 'ratio_card' ? (
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>
                Pick the numerator first, then the denominator ({selected.length}/2 selected).
              </div>
            ) : maxSeries > 1 && (
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>
                Pick {minSeries > 1 ? `${minSeries} to ${maxSeries}` : `up to ${maxSeries}`} metrics ({selected.length}/{maxSeries} selected).
              </div>
            )}
            <input
              value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search metrics…"
              style={{ ...INPUT_STYLE, marginBottom: 10 }}
            />
            <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid rgba(255,255,255,.1)', borderRadius: 8 }}>
              {[...groups.entries()].map(([group, metrics]) => (
                <div key={group}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .4, color: '#6b7280', padding: '8px 12px 4px' }}>{group}</div>
                  {metrics.map((m) => {
                    const isSel = selected.includes(m.key);
                    const role = widgetType === 'ratio_card' && isSel ? RATIO_ROLES[selected.indexOf(m.key)] : null;
                    return (
                      <button
                        key={m.key} type="button" onClick={() => toggleMetric(m.key)}
                        style={{ width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: isSel ? 'rgba(24,95,165,.18)' : 'transparent', color: isSel ? '#5b9fe0' : '#e5e7eb', cursor: 'pointer', fontSize: 12 }}
                      >
                        {isSel ? '✓ ' : ''}{m.label}
                        {role && <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 8 }}>{role}</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
              {groups.size === 0 && <div style={{ padding: 16, fontSize: 12, color: '#6b7280', textAlign: 'center' }}>No metrics match this widget type / search.</div>}
            </div>
            {anyMetricWidget && canCreateCustomMetric && onOpenCustomMetricBuilder && (
              <button
                type="button" onClick={onOpenCustomMetricBuilder}
                style={{ marginTop: 10, background: 'none', border: 'none', color: '#5b9fe0', fontSize: 12, cursor: 'pointer', padding: 0 }}
              >
                + New custom metric…
              </button>
            )}
          </>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', marginTop: 18 }}>
          {step === 'metric' ? <button className="btn btn-cancel-dark" onClick={() => setStep('type')}>← Back</button> : <span />}
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-cancel-dark" onClick={reset}>Cancel</button>
            {step === 'metric' && (
              <button className="btn btn-pr" disabled={!canConfirm} onClick={confirm}>Add widget</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

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
  fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 500,
  display: 'block', marginBottom: 5,
};
