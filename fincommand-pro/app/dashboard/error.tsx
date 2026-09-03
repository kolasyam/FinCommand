'use client';

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', gap: 12, padding: 24, textAlign: 'center' }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>Something went wrong loading the dashboard</div>
      <div style={{ fontSize: 12, color: 'var(--text2)', maxWidth: 480 }}>{error.message}</div>
      <button className="btn btn-pr" onClick={reset}>Try again</button>
    </div>
  );
}
