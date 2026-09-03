'use client';

/**
 * Explicit loading/error UI for the report data pipeline. Per the migration
 * requirement, an API failure must never be silently masked by sample data
 * — this is the visible surface for that: a real error banner with retry,
 * shown instead of any fallback render.
 */

/**
 * Viewport-centered overlay loader — deliberately not a top-left inline bar,
 * so a report/data refresh reads as "the whole panel is working" rather
 * than an easy-to-miss corner spinner. `minHeight` lets callers reserve
 * enough vertical space to center within (defaults to a full dashboard pane).
 */
export function LoadingBar({ label = 'Loading report data…', minHeight = '60vh' }: { label?: string; minHeight?: number | string } = {}) {
  return (
    <div style={{ position: 'relative', minHeight, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
          padding: '28px 36px', borderRadius: 'var(--radius-lg)',
          background: 'color-mix(in srgb, var(--bg) 85%, transparent)',
          border: '1px solid var(--border)', boxShadow: 'var(--shadow)',
          backdropFilter: 'blur(2px)',
        }}
      >
        <span style={{ display: 'inline-block', width: 22, height: 22, border: '2.5px solid var(--border)', borderTopColor: 'var(--blue)', borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
        <span style={{ color: 'var(--text2)', fontSize: 12, fontWeight: 500 }}>{label}</span>
      </div>
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="error-bar" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <span>⚠ Could not load report data: {message}</span>
      <button className="btn btn-se btn-sm" onClick={onRetry}>Retry</button>
    </div>
  );
}
