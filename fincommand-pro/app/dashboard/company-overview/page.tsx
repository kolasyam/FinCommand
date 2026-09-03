'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiClientError, clearSession, getRefreshToken, getToken } from '@/lib/dashboard/api-client';
import { formatDate } from '@/lib/utils/format';
import { LoadingBar, ErrorBanner } from '@/components/ui/StatusBanners';
import { CustomSelect } from '@/components/ui/CustomSelect';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { IncorporationDateInput } from '@/components/ui/IncorporationDateInput';
import { isCIN, isPAN, isNotFutureDate } from '@/lib/validations/common';
import { CURRENCY_META, SUPPORTED_CURRENCIES } from '@/lib/services/currency';

interface CompanyRow {
  id: string; name: string; cin: string | null; pan: string | null;
  date_of_incorporation: string | null; fiscal_year_start: number;
  currency: string; reporting_standard: string; created_at: string;
  registered_address: string | null; gstin: string | null;
  presentation_currency: string | null;
}
interface UserRow {
  id: string; name: string; email: string; role: string;
  is_active: boolean; last_login: string | null; created_at: string;
}

const ROLE_PILL: Record<string, string> = {
  admin: 'pb', cfo: 'pg', ceo: 'ppu', auditor: 'pa', manager: 'pgy', viewer: 'pgy',
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '11px 13px', borderRadius: 8, fontSize: 13,
  background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.12)',
  color: '#e5e7eb', outline: 'none',
};
const labelStyle: React.CSSProperties = {
  fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 6, fontWeight: 500,
};
const fieldWrap: React.CSSProperties = { marginBottom: 16 };
const errStyle: React.CSSProperties = { fontSize: 11, color: '#f5a582', marginTop: 5 };

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin — System Administrator' },
  { value: 'cfo', label: 'CFO — Head of Finance' },
  { value: 'ceo', label: 'CEO — Executive Review' },
  { value: 'auditor', label: 'Auditor — External Statutory Auditor' },
  { value: 'manager', label: 'Manager — Controller / Financial Analyst' },
  { value: 'viewer', label: 'Viewer — Read-Only Stakeholder' },
];

export default function CompanyOverviewPage() {
  const router = useRouter();
  const [company, setCompany] = useState<CompanyRow | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [editing, setEditing] = useState<UserRow | null>(null);

  const [editingCompany, setEditingCompany] = useState(false);
  const [coName, setCoName] = useState('');
  const [coCin, setCoCin] = useState('');
  const [coDoi, setCoDoi] = useState('');
  const [coPan, setCoPan] = useState('');
  const [coGstin, setCoGstin] = useState('');
  const [coAddress, setCoAddress] = useState('');
  const [coCurrency, setCoCurrency] = useState('INR');
  // '' means "same as Source Currency" — the CustomSelect's own explicit option, not an unset field.
  const [coPresentationCurrency, setCoPresentationCurrency] = useState('');
  const [coErrors, setCoErrors] = useState<Record<string, string>>({});
  const [savingCo, setSavingCo] = useState(false);

  function startEditCompany() {
    if (!company) return;
    setCoName(company.name || '');
    setCoCin(company.cin || '');
    setCoDoi(company.date_of_incorporation || '');
    setCoPan(company.pan || '');
    setCoGstin(company.gstin || '');
    setCoAddress(company.registered_address || '');
    setCoCurrency(company.currency || 'INR');
    setCoPresentationCurrency(company.presentation_currency || '');
    setCoErrors({});
    setEditingCompany(true);
  }

  async function saveCompany() {
    const e: Record<string, string> = {};
    if (!coName.trim()) e.name = 'Company legal name is required';
    if (!isCIN(coCin)) e.cin = '21-character MCA CIN, e.g. U72900MH2015PTC123456';
    if (!coDoi) {
      e.doi = 'Date of incorporation is required';
    } else if (!isNotFutureDate(coDoi)) {
      e.doi = 'Date of incorporation cannot be in the future';
    }
    if (coPan.trim() && !isPAN(coPan)) e.pan = '10-character PAN, e.g. AAAPL1234C';
    if (coAddress.trim().length > 500) e.address = 'Address must be 500 characters or fewer';

    if (Object.keys(e).length > 0) {
      setCoErrors(e);
      return;
    }

    setSavingCo(true);
    setCoErrors({});
    try {
      const updated = await apiFetch<CompanyRow>('/companies/me', {
        method: 'PUT',
        body: JSON.stringify({
          name: coName,
          cin: coCin,
          date_of_incorporation: coDoi,
          pan: coPan,
          gstin: coGstin,
          registered_address: coAddress,
          currency: coCurrency,
          presentation_currency: coPresentationCurrency,
        })
      });
      setCompany(updated);
      setEditingCompany(false);
      setNotice({ kind: 'success', text: 'Company details updated successfully.' });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to update company details' });
    } finally {
      setSavingCo(false);
    }
  }

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    if (!getToken()) { router.replace('/?auth=login'); return; }
    try {
      const me = await apiFetch<{ id: string; role: string }>('/auth/me');
      if (me.role !== 'admin') { router.replace('/dashboard'); return; }
      setAuthorized(true);
      setCurrentUserId(me.id);
      const [companyData, usersData] = await Promise.all([
        apiFetch<CompanyRow>('/companies/me'),
        apiFetch<UserRow[]>('/companies/users'),
      ]);
      setCompany(companyData);
      setUsers(usersData);
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 401) {
        clearSession();
        router.replace('/?auth=login');
        return;
      }
      setError(e instanceof Error ? e.message : 'Failed to load company overview');
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  function requestLogout() {
    setConfirmOpen(true);
  }

  async function confirmLogout() {
    setLoggingOut(true);
    try {
      await apiFetch('/auth/logout', { method: 'POST', body: JSON.stringify({ refresh_token: getRefreshToken() }) });
    } catch {
      // ignore — we're clearing the local session regardless
    }
    clearSession();
    router.push('/');
  }

  function handleSaved(updated: UserRow) {
    setUsers(list => list.map(u => (u.id === updated.id ? { ...u, ...updated } : u)));
    setEditing(null);
    setNotice({ kind: 'success', text: `Updated ${updated.name}'s access.` });
  }

  if (!authorized && loading) {
    return <LoadingBar label="Verifying access…" minHeight="100vh" />;
  }

  return (
    <div>
      <style>{`
        .sw-input {
          width: 100%;
          padding: 10px 12px;
          border-radius: 6px;
          font-size: 13px;
          background: #ffffff !important;
          border: 1px solid var(--border2, #d1d5db) !important;
          color: var(--text, #111827) !important;
          outline: none;
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .sw-input:focus {
          border-color: var(--blue, #185fa5) !important;
          box-shadow: 0 0 0 3px rgba(24,95,165,.25) !important;
        }
      `}</style>

      <div className="topbar">
        <div>
          <div
            className="logo" role="button" tabIndex={0}
            onClick={() => router.push('/')}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') router.push('/'); }}
            style={{ cursor: 'pointer', display: 'inline-block' }}
            title="Go to FinCommand Pro home"
          >
            FinCommand Pro <span>IND AS · Schedule III</span>
          </div>
          <div className="co-info">Company Overview · System Administrator</div>
        </div>
        <div className="tbar-right">
          <button className="btn btn-dl btn-sm" onClick={requestLogout}>Logout</button>
          <button className="btn btn-pr btn-sm" onClick={() => router.push('/dashboard')}>Go to Financial Dashboard →</button>
        </div>
      </div>

      <div className="content">
        {loading && <LoadingBar />}
        {error && !loading && <ErrorBanner message={error} onRetry={load} />}

        {notice && !loading && (
          <div className={notice.kind === 'success' ? 'success-bar' : 'error-bar'} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <span>{notice.text}</span>
            <button onClick={() => setNotice(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 13 }}>✕</button>
          </div>
        )}

        {!loading && !error && company && (
          <>
            {editingCompany ? (
              <div className="card">
                <div className="card-hdr" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="ct">Edit Legal Entity Details</span>
                  <span className="cbadge cb-blue">{company.reporting_standard}</span>
                </div>
                <div className="card-body">
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 20 }}>
                    <div style={fieldWrap}>
                      <label style={labelStyle}>Company Name (legal entity)</label>
                      <input className="sw-input" style={inputStyle} value={coName} onChange={e => setCoName(e.target.value)} />
                      {coErrors.name && <div style={errStyle}>{coErrors.name}</div>}
                    </div>
                    <div style={fieldWrap}>
                      <label style={labelStyle}>Corporate Identification Number (CIN)</label>
                      <input className="sw-input" style={{ ...inputStyle, fontFamily: 'var(--mono)', textTransform: 'uppercase' }} value={coCin} maxLength={21} onChange={e => setCoCin(e.target.value.toUpperCase())} />
                      {coErrors.cin && <div style={errStyle}>{coErrors.cin}</div>}
                    </div>
                    <div style={fieldWrap}>
                      <label style={labelStyle}>Date of Incorporation</label>
                      <IncorporationDateInput value={coDoi} max={new Date().toISOString().slice(0, 10)} error={!!coErrors.doi} onChange={setCoDoi} />
                      {coErrors.doi && <div style={errStyle}>{coErrors.doi}</div>}
                    </div>
                    <div style={fieldWrap}>
                      <label style={labelStyle}>Permanent Account Number (PAN) — optional</label>
                      <input className="sw-input" style={{ ...inputStyle, fontFamily: 'var(--mono)', textTransform: 'uppercase' }} value={coPan} maxLength={10} onChange={e => setCoPan(e.target.value.toUpperCase())} />
                      {coErrors.pan && <div style={errStyle}>{coErrors.pan}</div>}
                    </div>
                    <div style={fieldWrap}>
                      <label style={labelStyle}>GSTIN (optional)</label>
                      <input className="sw-input" style={{ ...inputStyle, fontFamily: 'var(--mono)', textTransform: 'uppercase' }} value={coGstin} maxLength={15} onChange={e => setCoGstin(e.target.value.toUpperCase())} />
                    </div>
                    <div style={{ ...fieldWrap, gridColumn: 'span 2' }}>
                      <label style={labelStyle}>Registered Office Address</label>
                      <textarea className="sw-input" style={{ ...inputStyle, resize: 'vertical', minHeight: 64, fontFamily: 'inherit' }} value={coAddress} maxLength={500} onChange={e => setCoAddress(e.target.value)} />
                      {coErrors.address && <div style={errStyle}>{coErrors.address}</div>}
                    </div>
                    <div style={fieldWrap}>
                      <label style={labelStyle}>Source Currency (Functional Currency)</label>
                      <CustomSelect
                        variant="light"
                        value={coCurrency}
                        onChange={setCoCurrency}
                        options={SUPPORTED_CURRENCIES.map(c => ({ value: c, label: `${CURRENCY_META[c].symbol} ${c} — ${CURRENCY_META[c].name}` }))}
                      />
                      <div style={{ fontSize: 10, color: 'var(--text3, #6b7280)', marginTop: 5 }}>
                        The currency your Trial Balance ledgers are recorded in. Auto-detected for a connected Zoho Books org — change this only if it&apos;s wrong, or if you upload Excel Trial Balances instead.
                      </div>
                    </div>
                    <div style={fieldWrap}>
                      <label style={labelStyle}>Default Presentation Currency</label>
                      <CustomSelect
                        variant="light"
                        value={coPresentationCurrency}
                        onChange={setCoPresentationCurrency}
                        options={[
                          { value: '', label: 'Same as Source Currency (no conversion)' },
                          ...SUPPORTED_CURRENCIES.map(c => ({ value: c, label: `${CURRENCY_META[c].symbol} ${c} — ${CURRENCY_META[c].name}` })),
                        ]}
                      />
                      <div style={{ fontSize: 10, color: 'var(--text3, #6b7280)', marginTop: 5 }}>
                        Currency the dashboard/exports display figures in by default. Anyone signed in can still override this for their own session from the top bar.
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 10 }}>
                    <button className="btn btn-se" onClick={() => setEditingCompany(false)} disabled={savingCo}>Cancel</button>
                    <button className="btn btn-pr" onClick={saveCompany} disabled={savingCo}>{savingCo ? 'Saving...' : 'Save Changes'}</button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="card">
                <div className="card-hdr" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span className="ct">Legal Entity Details</span>
                    <span className="cbadge cb-blue" style={{ marginLeft: 8 }}>{company.reporting_standard}</span>
                  </div>
                  <button className="btn btn-se btn-sm" onClick={startEditCompany}>Edit Details</button>
                </div>
                <div className="card-body">
                  <div className="grid4">
                    <div className="kpi">
                      <div className="lbl">Company Name</div>
                      <div className="val" style={{ fontSize: 14 }}>{company.name}</div>
                    </div>
                    <div className="kpi">
                      <div className="lbl">CIN</div>
                      <div className="val" style={{ fontSize: 14, fontFamily: 'var(--mono)' }}>{company.cin || '—'}</div>
                    </div>
                    <div className="kpi">
                      <div className="lbl">Date of Incorporation</div>
                      <div className="val" style={{ fontSize: 14 }}>{formatDate(company.date_of_incorporation)}</div>
                    </div>
                    <div className="kpi">
                      <div className="lbl">PAN</div>
                      <div className="val" style={{ fontSize: 14, fontFamily: 'var(--mono)' }}>{company.pan || '—'}</div>
                    </div>
                    {company.gstin && (
                      <div className="kpi">
                        <div className="lbl">GSTIN</div>
                        <div className="val" style={{ fontSize: 14, fontFamily: 'var(--mono)' }}>{company.gstin}</div>
                      </div>
                    )}
                    <div className="kpi">
                      <div className="lbl">Source Currency</div>
                      <div className="val" style={{ fontSize: 14 }}>{company.currency}</div>
                    </div>
                    <div className="kpi">
                      <div className="lbl">Default Presentation Currency</div>
                      <div className="val" style={{ fontSize: 14 }}>{company.presentation_currency || `Same as Source (${company.currency})`}</div>
                    </div>
                    <div className="kpi" style={{ gridColumn: '1 / -1' }}>
                      <div className="lbl">Registered Address</div>
                      <div className="val" style={{ fontSize: 14 }}>{company.registered_address || '—'}</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="card">
              <div className="card-hdr">
                <span className="ct">Access Registry</span>
                <span className="cbadge cb-green">{users.length} provisioned</span>
              </div>
              <div className="card-body" style={{ padding: 0 }}>
                <table className="fc-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th>Last Login</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map(u => (
                      <tr key={u.id}>
                        <td>{u.name}{u.id === currentUserId && <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--text3)' }}>(you)</span>}</td>
                        <td>{u.email}</td>
                        <td><span className={`pill ${ROLE_PILL[u.role] || 'pgy'}`}>{u.role.toUpperCase()}</span></td>
                        <td><span className={`pill ${u.is_active ? 'pg' : 'pr'}`}>{u.is_active ? 'Active' : 'Inactive'}</span></td>
                        <td>{u.last_login ? formatDate(u.last_login) : 'Never'}</td>
                        <td className="num">
                          <button className="btn btn-se btn-sm" onClick={() => setEditing(u)}>Edit</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card-body" style={{ paddingTop: 0 }}>
                <div className="notice" style={{ padding: '8px 2px 0' }}>
                  For security and compliance, email addresses and passwords cannot be viewed or changed here — only name, role, and active status. Members reset their own password after signing in.
                </div>
              </div>
            </div>

            <div style={{ textAlign: 'center', marginTop: 20 }}>
              <button className="btn btn-pr" onClick={() => router.push('/dashboard')}>Go to Financial Dashboard →</button>
            </div>
          </>
        )}
      </div>

      {editing && (
        <EditUserModal
          user={editing}
          isSelf={editing.id === currentUserId}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
          onError={msg => setNotice({ kind: 'error', text: msg })}
        />
      )}

      <ConfirmModal
        open={confirmOpen}
        title="Confirm Sign Out"
        message="Are you sure you want to log out of your session?"
        confirmLabel="Log Out"
        cancelLabel="Cancel"
        danger
        busy={loggingOut}
        onConfirm={confirmLogout}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function EditUserModal({
  user, isSelf, onClose, onSaved, onError,
}: {
  user: UserRow; isSelf: boolean;
  onClose: () => void;
  onSaved: (u: UserRow) => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState(user.role);
  const [isActive, setIsActive] = useState(user.is_active);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) { setErr('Name cannot be empty'); return; }
    const patch: Record<string, unknown> = {};
    if (name.trim() !== user.name) patch.name = name.trim();
    if (role !== user.role) patch.role = role;
    if (isActive !== user.is_active) patch.is_active = isActive;
    if (Object.keys(patch).length === 0) { onClose(); return; }

    setBusy(true);
    setErr(null);
    try {
      const updated = await apiFetch<UserRow>(`/companies/users/${user.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      onSaved(updated);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to update user';
      setErr(msg);
      onError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 500, alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(3px)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 28, width: 380, boxShadow: '0 8px 32px rgba(0,0,0,.16)' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>Edit Team Member</div>
        <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 18 }}>{user.email} <span style={{ color: 'var(--text3)' }}>(read-only)</span></div>

        {err && (
          <div style={{ background: 'var(--red-l)', color: 'var(--red)', padding: '8px 10px', borderRadius: 'var(--radius-sm)', fontSize: 11, marginBottom: 12, borderLeft: '3px solid currentColor' }}>
            {err}
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 11, color: 'var(--text2)', display: 'block', marginBottom: 4 }}>Name</label>
          <input
            value={name} onChange={e => setName(e.target.value)}
            style={{ width: '100%', padding: '9px 11px', border: '1px solid var(--border2)', borderRadius: 'var(--radius-sm)', fontSize: 12, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 11, color: 'var(--text2)', display: 'block', marginBottom: 4 }}>Role</label>
          <CustomSelect variant="light" value={role} onChange={setRole} options={ROLE_OPTIONS} />
          {isSelf && <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>You cannot change your own role away from admin.</div>}
        </div>

        <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text2)', display: 'block' }}>Active Status</label>
            {isSelf && <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>You cannot deactivate your own account.</div>}
          </div>
          <ToggleSwitch checked={isActive} disabled={isSelf} onChange={setIsActive} />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-se" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>Cancel</button>
          <button className="btn btn-pr" style={{ flex: 1, justifyContent: 'center' }} disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ToggleSwitch({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width: 40, height: 22, borderRadius: 999, border: 'none', position: 'relative',
        background: checked ? 'var(--green)' : 'var(--border2)',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
        transition: 'background .15s ease', flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute', top: 2, left: checked ? 20 : 2, width: 18, height: 18, borderRadius: '50%',
          background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.25)', transition: 'left .15s ease',
        }}
      />
    </button>
  );
}
