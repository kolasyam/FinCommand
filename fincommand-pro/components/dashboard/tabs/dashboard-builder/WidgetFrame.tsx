'use client';

/**
 * Card wrapper for one dashboard widget — reuses the app's existing
 * `.card`/`.card-hdr`/`.ct` classes (app/globals.css) rather than new
 * Tailwind so a custom widget looks identical in weight/spacing/color to
 * every other card in the app (KPI tiles, report tables, etc.), in both the
 * read-only view and the edit-mode grid.
 *
 * No loading/error variants here (unlike the reference dashboard builder's
 * WidgetFrame): every widget's value is resolved synchronously from the
 * `bundle` DashboardContext already loaded before this tab ever renders
 * (see resolveMetric() in dashboard-builder-engine.ts, which never throws —
 * an unresolvable metric key just yields a "no data" notice inline, handled
 * per-renderer in widget-renderers.tsx), so there is no genuine per-widget
 * async/error state to render here.
 */
export function WidgetFrame({
  title, subtitle, children, headerRight, bare,
}: {
  title?: string | null;
  subtitle?: string | null;
  children: React.ReactNode;
  headerRight?: React.ReactNode;
  bare?: boolean;
}) {
  const hasHeader = !!(title || subtitle || headerRight);
  return (
    <div className="card" style={{ margin: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
      {hasHeader && (
        <div className="card-hdr" style={{ flexShrink: 0 }}>
          <div style={{ minWidth: 0 }}>
            {title && <span className="ct">{title}</span>}
            {subtitle && <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 2 }}>{subtitle}</div>}
          </div>
          {headerRight}
        </div>
      )}
      <div className={bare ? undefined : 'card-body'} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {children}
      </div>
    </div>
  );
}
