import Link from 'next/link';

export default function NotFound() {
  return (
    <div style={{ background: '#0b1220', color: '#e5e7eb', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ padding: '20px 32px', maxWidth: 1200, margin: '0 auto', width: '100%' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>
          FinCommand Pro <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 20, background: 'rgba(15,110,86,.25)', color: '#5DCAA5', marginLeft: 8, fontWeight: 500 }}>IND AS · Schedule III</span>
        </div>
      </header>

      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 32px', textAlign: 'center' }}>
        <div>
          <div style={{ fontSize: 13, letterSpacing: 2, textTransform: 'uppercase', color: '#5b9fe0', marginBottom: 12, fontWeight: 600 }}>
            Error 404
          </div>
          <div style={{ fontSize: 88, fontWeight: 800, color: '#fff', lineHeight: 1, marginBottom: 8, background: 'linear-gradient(135deg, #fff 0%, #5b9fe0 100%)', WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            404
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: '#fff', marginBottom: 10 }}>This page doesn&apos;t exist</h1>
          <p style={{ fontSize: 13, color: '#9ca3af', maxWidth: 420, margin: '0 auto 32px', lineHeight: 1.6 }}>
            The page you&apos;re looking for was moved, renamed, or never existed. Let&apos;s get you back to somewhere useful.
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link href="/" style={{ fontSize: 13, padding: '11px 24px', borderRadius: 8, background: '#185fa5', color: '#fff', textDecoration: 'none', fontWeight: 600 }}>
              ← Home
            </Link>
            <Link href="/dashboard" style={{ fontSize: 13, padding: '11px 24px', borderRadius: 8, background: 'transparent', color: '#e5e7eb', textDecoration: 'none', fontWeight: 500, border: '1px solid rgba(255,255,255,.15)' }}>
              Go to Dashboard
            </Link>
          </div>
        </div>
      </main>

      <footer style={{ borderTop: '1px solid rgba(255,255,255,.08)', padding: '20px 32px', textAlign: 'center', fontSize: 11, color: '#6b7280' }}>
        FinCommand Pro — CFO/CEO Financial Command Center
      </footer>
    </div>
  );
}
