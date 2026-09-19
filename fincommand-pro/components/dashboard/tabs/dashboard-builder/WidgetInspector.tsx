'use client';

/** Right-side settings panel for the currently selected widget — title/subtitle, widget type, metric series bindings, per-type display options, and a non-drag numeric alternative to dragging for grid position/size. */
import { METRIC_CATALOG, WIDGET_KINDS, WIDGET_MIN_SERIES, WIDGET_MAX_SERIES, type DashboardWidget, type WidgetKind } from '@/lib/financial/dashboard-builder-engine';
import { customMetricCapabilities, type CustomMetricDefinition } from '@/lib/financial/custom-metric-engine';
import { WIDGET_TYPE_META, isFixedContentType, metricFitsWidget, RATIO_ROLES } from './WidgetPicker';

export function WidgetInspector({
  widget, onChange, onClose, customMetrics = [],
}: {
  widget: DashboardWidget;
  onChange: (patch: Partial<DashboardWidget>) => void;
  onClose: () => void;
  /** This company's custom metrics — offered wherever they can really fill the widget (see customMetricCapabilities()), same rule as WidgetPicker. */
  customMetrics?: CustomMetricDefinition[];
}) {
  const meta = WIDGET_TYPE_META[widget.widgetType];
  const maxSeries = WIDGET_MAX_SERIES[widget.widgetType];
  const isMulti = maxSeries > 1;
  const isChart = widget.widgetType === 'line_chart' || widget.widgetType === 'bar_chart';
  const hasCompare = widget.widgetType === 'stat_card' || widget.widgetType === 'ratio_card' || widget.widgetType === 'kpi_group';

  function updateSeries(index: number, patch: Partial<DashboardWidget['series'][number]>) {
    onChange({ series: widget.series.map((s, i) => (i === index ? { ...s, ...patch } : s)) });
  }
  /** Switching type keeps the bound metrics, trimmed to what the new type can show (the server rejects more than that for the newer types). */
  function changeType(t: WidgetKind) {
    const max = WIDGET_MAX_SERIES[t];
    onChange(max >= 1 && widget.series.length > max
      ? { widgetType: t, series: widget.series.slice(0, max) }
      : { widgetType: t });
  }
  function addSeries() {
    if (widget.series.length >= maxSeries) return;
    const first = seriesEligible[0];
    if (!first) return;
    onChange({ series: [...widget.series, { metricKey: first.key }] });
  }
  function removeSeries(index: number) {
    onChange({ series: widget.series.filter((_, i) => i !== index) });
  }
  /** Series order drives chart/legend order directly (renderWidget iterates widget.series as-is) — this is the only way to reorder without deleting and re-adding. */
  function moveSeries(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= widget.series.length) return;
    const next = [...widget.series];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange({ series: next });
  }
  function updateVizConfig(patch: Record<string, unknown>) {
    onChange({ vizConfig: { ...widget.vizConfig, ...patch } });
  }

  const eligible = (supportsSeries: boolean, supportsBreakdown: boolean) =>
    metricFitsWidget(widget.widgetType, supportsSeries, supportsBreakdown);
  const seriesEligible: { key: string; label: string; group: string }[] = [
    ...METRIC_CATALOG.filter((m) => eligible(m.supportsSeries, m.supportsBreakdown)),
    ...customMetrics
      .filter((m) => { const c = customMetricCapabilities(m, customMetrics); return eligible(c.supportsSeries, c.supportsBreakdown); })
      .map((m) => ({ key: m.key, label: m.label, group: 'Custom Metrics' })),
  ];
  // Grouped like the picker, so identically-named metrics from different
  // sources (e.g. "Total Income" from MIS vs the statutory P&L) are told apart.
  const eligibleGroups = seriesEligible.reduce<Map<string, { key: string; label: string }[]>>((acc, m) => {
    if (!acc.has(m.group)) acc.set(m.group, []);
    acc.get(m.group)!.push(m);
    return acc;
  }, new Map());

  return (
    <div className="card" style={{ marginBottom: 0 }}>
      <div className="card-hdr">
        <span className="ct">Widget settings</span>
        <button className="btn btn-se btn-sm" onClick={onClose}>Close</button>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <FieldLabel>Widget type</FieldLabel>
          <select value={widget.widgetType} onChange={(e) => changeType(e.target.value as WidgetKind)} style={selectStyle}>
            {WIDGET_KINDS.map((k) => <option key={k} value={k}>{WIDGET_TYPE_META[k].icon} {WIDGET_TYPE_META[k].label}</option>)}
          </select>
        </div>

        <div>
          <FieldLabel>Title</FieldLabel>
          <input value={widget.title ?? ''} onChange={(e) => onChange({ title: e.target.value || null })} style={inputStyle} placeholder="Defaults to the metric's own name" />
        </div>
        <div>
          <FieldLabel>Subtitle</FieldLabel>
          <input value={widget.subtitle ?? ''} onChange={(e) => onChange({ subtitle: e.target.value || null })} style={inputStyle} />
        </div>

        {widget.widgetType === 'text_block' ? (
          <div>
            <FieldLabel>Text</FieldLabel>
            <textarea
              value={typeof widget.vizConfig.text === 'string' ? widget.vizConfig.text : ''}
              onChange={(e) => updateVizConfig({ text: e.target.value })}
              rows={4}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>
        ) : isFixedContentType(widget.widgetType) ? (
          <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
            {meta.description} No metrics to bind.
          </div>
        ) : (
          <div>
            <FieldLabel>Metric series ({widget.series.length}/{maxSeries})</FieldLabel>
            {widget.series.map((s, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
              {widget.widgetType === 'ratio_card' && RATIO_ROLES[i] && (
                <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 2 }}>{RATIO_ROLES[i]}</div>
              )}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {isMulti && widget.series.length > 1 && (
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <IconMoveBtn title="Move up" disabled={i === 0} onClick={() => moveSeries(i, -1)}>▲</IconMoveBtn>
                    <IconMoveBtn title="Move down" disabled={i === widget.series.length - 1} onClick={() => moveSeries(i, 1)}>▼</IconMoveBtn>
                  </div>
                )}
                <select value={s.metricKey} onChange={(e) => updateSeries(i, { metricKey: e.target.value })} style={{ ...selectStyle, flex: 1 }} aria-label={`Series ${i + 1} metric`}>
                  {[...eligibleGroups.entries()].map(([group, opts]) => (
                    <optgroup key={group} label={group}>
                      {opts.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                    </optgroup>
                  ))}
                </select>
                {isMulti && (
                  <input
                    value={s.label ?? ''} onChange={(e) => updateSeries(i, { label: e.target.value || undefined })}
                    placeholder="Label" style={{ ...inputStyle, width: 90 }}
                  />
                )}
                {widget.series.length > WIDGET_MIN_SERIES[widget.widgetType] && (
                  <button type="button" className="btn btn-se btn-sm" onClick={() => removeSeries(i)}>✕</button>
                )}
              </div>
              {isChart && (
                <div style={{ display: 'flex', gap: 6, marginTop: 4, paddingLeft: widget.series.length > 1 ? 24 : 0 }}>
                  <select
                    value={s.renderAs ?? (widget.widgetType === 'bar_chart' ? 'bar' : 'line')}
                    onChange={(e) => updateSeries(i, { renderAs: e.target.value as 'bar' | 'line' })}
                    style={{ ...selectStyle, padding: '4px 6px', fontSize: 11 }} aria-label={`Series ${i + 1} drawn as`}
                  >
                    <option value="bar">Bars</option>
                    <option value="line">Line</option>
                  </select>
                  <select
                    value={s.axis ?? 'left'}
                    onChange={(e) => updateSeries(i, { axis: e.target.value as 'left' | 'right' })}
                    style={{ ...selectStyle, padding: '4px 6px', fontSize: 11 }} aria-label={`Series ${i + 1} axis`}
                  >
                    <option value="left">Left axis</option>
                    <option value="right">Right axis</option>
                  </select>
                </div>
              )}
              </div>
            ))}
            {/* Not just meta.multiSeries — a single-series widget switched to
                from a series-less type (e.g. text_block -> stat_card via the
                Widget type select above) can genuinely have 0 series, and
                still needs a way back to its own max of 1, not just widgets
                that allow up to 4. */}
            {widget.series.length < maxSeries && (
              <button type="button" className="btn btn-se btn-sm" onClick={addSeries}>+ Add series</button>
            )}
          </div>
        )}

        {hasCompare && (
          <ToggleField label="Show change vs comparison period" checked={widget.vizConfig.compare !== false} onChange={(v) => updateVizConfig({ compare: v })} />
        )}
        {widget.widgetType === 'ratio_card' && (
          <div>
            <FieldLabel>Show the ratio as</FieldLabel>
            <select value={widget.vizConfig.ratio_format === 'multiple' ? 'multiple' : 'percent'} onChange={(e) => updateVizConfig({ ratio_format: e.target.value })} style={selectStyle}>
              <option value="percent">Percentage (e.g. 32.5%)</option>
              <option value="multiple">Multiple (e.g. 1.85x)</option>
            </select>
          </div>
        )}
        {widget.widgetType === 'stat_card_sparkline' && (
          <div>
            <FieldLabel>Sparkline style</FieldLabel>
            <select value={widget.vizConfig.spark_type === 'bar' ? 'bar' : 'line'} onChange={(e) => updateVizConfig({ spark_type: e.target.value })} style={selectStyle}>
              <option value="line">Line</option>
              <option value="bar">Bar</option>
            </select>
          </div>
        )}
        {isChart && (
          <ToggleField label="Show legend" checked={widget.vizConfig.legend !== false} onChange={(v) => updateVizConfig({ legend: v })} />
        )}
        {widget.widgetType === 'bar_chart' && (
          <ToggleField label="Stack bar series (lines are never stacked)" checked={widget.vizConfig.stacked === true} onChange={(v) => updateVizConfig({ stacked: v })} />
        )}
        {widget.widgetType === 'hbar_chart' && (
          <div>
            <FieldLabel>Bars to show</FieldLabel>
            <input
              type="number" min={1} max={25}
              value={typeof widget.vizConfig.limit === 'number' ? widget.vizConfig.limit : 8}
              onChange={(e) => updateVizConfig({ limit: Math.max(1, Math.min(25, Number(e.target.value) || 8)) })}
              style={inputStyle}
            />
          </div>
        )}
        {widget.widgetType === 'data_table' && (
          <div>
            <FieldLabel>Row limit</FieldLabel>
            <input
              type="number" min={1} max={50}
              value={typeof widget.vizConfig.limit === 'number' ? widget.vizConfig.limit : 5}
              onChange={(e) => updateVizConfig({ limit: Math.max(1, Math.min(50, Number(e.target.value) || 5)) })}
              style={inputStyle}
            />
          </div>
        )}

        <div>
          <FieldLabel>Position &amp; size (grid columns / rows)</FieldLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
            <NumField label="X" value={widget.gridX} onChange={(v) => onChange({ gridX: v })} min={0} />
            <NumField label="Y" value={widget.gridY} onChange={(v) => onChange({ gridY: v })} min={0} />
            <NumField label="W" value={widget.gridW} onChange={(v) => onChange({ gridW: v })} min={2} />
            <NumField label="H" value={widget.gridH} onChange={(v) => onChange({ gridH: v })} min={3} />
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 500, display: 'block', marginBottom: 4 }}>{children}</label>;
}
function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
function IconMoveBtn({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button" title={title} disabled={disabled} onClick={onClick}
      style={{
        width: 18, height: 15, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', background: 'transparent', borderRadius: 3, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.3 : 1, color: 'var(--text3)', fontSize: 8, padding: 0,
      }}
    >
      {children}
    </button>
  );
}
function NumField({ label, value, onChange, min }: { label: string; value: number; onChange: (v: number) => void; min: number }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--text3)', marginBottom: 2 }}>{label}</div>
      <input type="number" min={min} value={value} onChange={(e) => onChange(Math.max(min, Number(e.target.value) || min))} style={{ ...inputStyle, padding: '5px 7px' }} />
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 9px', fontSize: 12, border: '1px solid var(--border2)',
  borderRadius: 'var(--radius-sm)', color: 'var(--text)', background: 'var(--bg)', outline: 'none',
};
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' };
