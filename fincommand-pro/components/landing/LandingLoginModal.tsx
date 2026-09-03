'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { storeSession, type StoredUser } from '@/lib/dashboard/api-client';
import { PasswordInput } from '@/components/ui/PasswordInput';

const passInputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 11px', border: '1px solid rgba(255,255,255,.12)', borderRadius: 6,
  fontSize: 12, background: 'rgba(255,255,255,.04)', color: '#e5e7eb', outline: 'none',
};

export function LandingLoginModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  async function doLogin() {
    setErr(null);
    if (!email || !pass) { setErr('Email and password required'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password: pass }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');

      storeSession(data.access_token, data.refresh_token, data.user as StoredUser);
      const role = data.user?.role;
      router.push(role === 'admin' ? '/dashboard/company-overview' : '/dashboard');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 500, alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }} onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#0f1826', border: '1px solid rgba(255,255,255,.1)', borderRadius: 14, padding: 32, width: 360, boxShadow: '0 20px 60px rgba(0,0,0,.5)' }}
      >
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#fff', marginBottom: 4 }}>FinCommand Pro</div>
          <div style={{ fontSize: 11, color: '#9ca3af' }}>Sign in to your company workspace</div>
        </div>
        {err && (
          <div style={{ background: 'rgba(217,90,48,.14)', color: '#f5a582', padding: '8px 10px', borderRadius: 6, fontSize: 11, marginBottom: 12, borderLeft: '3px solid #d85a30' }}>
            {err}
          </div>
        )}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Email address</label>
          <input
            type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="cfo@yourcompany.in" autoComplete="email"
            style={{ width: '100%', padding: '9px 11px', border: '1px solid rgba(255,255,255,.12)', borderRadius: 6, fontSize: 12, background: 'rgba(255,255,255,.04)', color: '#e5e7eb', outline: 'none' }}
            onKeyDown={e => { if (e.key === 'Enter') document.getElementById('landing-login-pass')?.focus(); }}
          />
        </div>
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Password</label>
          <PasswordInput
            id="landing-login-pass" value={pass} onChange={setPass}
            placeholder="Enter password" inputStyle={passInputStyle}
            onKeyDown={e => { if (e.key === 'Enter') doLogin(); }}
          />
        </div>
        <button
          onClick={doLogin} disabled={busy}
          style={{ width: '100%', padding: 10, fontSize: 13, fontWeight: 600, borderRadius: 8, background: '#185fa5', color: '#fff', border: 'none', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? .7 : 1, marginBottom: 10 }}
        >
          {busy ? 'Signing in…' : 'Sign In'}
        </button>
        <div style={{ textAlign: 'center', fontSize: 11, color: '#6b7280' }}>
          New entity? <a href="/signup" style={{ color: '#5b9fe0', fontWeight: 600 }}>Register your company here</a>
        </div>
      </div>
    </div>
  );
}
