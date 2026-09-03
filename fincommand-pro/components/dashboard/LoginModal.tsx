'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { useToast } from '@/lib/dashboard/ToastContext';
import { getStoredUser } from '@/lib/dashboard/api-client';
import { PasswordInput } from '@/components/ui/PasswordInput';

const passInputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 11px', border: '1px solid var(--border2)', borderRadius: 'var(--radius-sm)',
  fontSize: 12, background: 'var(--bg)', color: 'var(--text)', outline: 'none',
};

export function LoginModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { login, useSampleData } = useDashboard();
  const toast = useToast();
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
      await login(email.trim(), pass);
      onClose();
      toast('Welcome back');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 500, alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(3px)' }}>
      <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 32, width: 360, boxShadow: '0 8px 32px rgba(0,0,0,.12)' }}>
        <div style={{ marginBottom: 20 }}>
          <div className="logo" style={{ fontSize: 18, marginBottom: 4 }}>FinCommand Pro</div>
          <div style={{ fontSize: 11, color: 'var(--text2)' }}>IND AS · CFO/CEO Financial Dashboard</div>
        </div>
        {err && (
          <div style={{ background: 'var(--red-l)', color: 'var(--red)', padding: '8px 10px', borderRadius: 'var(--radius-sm)', fontSize: 11, marginBottom: 12, borderLeft: '3px solid currentColor' }}>
            {err}
          </div>
        )}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: 'var(--text2)', display: 'block', marginBottom: 4 }}>Email address</label>
          <input
            type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="cfo@yourcompany.in" autoComplete="email"
            style={{ width: '100%', padding: '9px 11px', border: '1px solid var(--border2)', borderRadius: 'var(--radius-sm)', fontSize: 12, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}
            onKeyDown={e => { if (e.key === 'Enter') document.getElementById('login-pass')?.focus(); }}
          />
        </div>
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 11, color: 'var(--text2)', display: 'block', marginBottom: 4 }}>Password</label>
          <PasswordInput
            id="login-pass" value={pass} onChange={setPass}
            placeholder="Enter password" inputStyle={passInputStyle}
            onKeyDown={e => { if (e.key === 'Enter') doLogin(); }}
          />
        </div>
        <button onClick={doLogin} disabled={busy} className="btn btn-pr" style={{ width: '100%', justifyContent: 'center', padding: 10, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
          {busy ? 'Signing in…' : 'Sign In'}
        </button>
        <button
          onClick={() => { useSampleData(); onClose(); }}
          className="btn btn-se" style={{ width: '100%', justifyContent: 'center', padding: 9, fontSize: 12 }}
        >
          Continue with Sample Data
        </button>
        <div style={{ textAlign: 'center', marginTop: 14, fontSize: 10, color: 'var(--text3)' }}>
          Demo: admin@acmetech.in / Admin@123
        </div>
        <div style={{ textAlign: 'center', marginTop: 10, fontSize: 11, color: 'var(--text2)' }}>
          New entity? <a href="/signup" style={{ color: 'var(--blue)', fontWeight: 600 }}>Register your company here</a>
        </div>
      </div>
    </div>
  );
}
