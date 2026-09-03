'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { isEmail, isCIN, isPAN, isNotFutureDate, isStrongPassword } from '@/lib/validations/common';
import { storeSession } from '@/lib/dashboard/api-client';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { CustomSelect } from '@/components/ui/CustomSelect';
import { IncorporationDateInput } from '@/components/ui/IncorporationDateInput';
import { CURRENCY_META, SUPPORTED_CURRENCIES } from '@/lib/services/currency';

type Role = 'cfo' | 'ceo' | 'auditor' | 'manager' | 'viewer';

interface AdminForm { name: string; email: string; password: string; confirm: string }
interface CompanyForm {
  name: string; cin: string; date_of_incorporation: string; pan: string; gstin: string; registered_address: string;
  /** Source/Functional Currency (IAS 21 / IND AS 21) — the currency this company's Trial Balance ledgers will be recorded in. */
  currency: string;
  /** Default Presentation Currency — '' means "same as Source Currency" (no conversion), the CustomSelect's own explicit option. */
  presentation_currency: string;
}
interface MemberForm { name: string; email: string; password: string; role: Role }

interface RoleCaps {
  login: boolean; viewReports: boolean; uploadTb: boolean;
  manageUsers: boolean; lockFy: boolean; viewAudit: boolean;
}

const ROLE_CAPS: Record<Role | 'admin', RoleCaps> = {
  admin:   { login: true, viewReports: true, uploadTb: true,  manageUsers: true,  lockFy: true,  viewAudit: true },
  cfo:     { login: true, viewReports: true, uploadTb: true,  manageUsers: false, lockFy: false, viewAudit: true },
  ceo:     { login: true, viewReports: true, uploadTb: false, manageUsers: false, lockFy: false, viewAudit: false },
  auditor: { login: true, viewReports: true, uploadTb: false, manageUsers: false, lockFy: false, viewAudit: true },
  manager: { login: true, viewReports: true, uploadTb: true,  manageUsers: false, lockFy: false, viewAudit: false },
  viewer:  { login: true, viewReports: true, uploadTb: false, manageUsers: false, lockFy: false, viewAudit: false },
};

const CAPABILITY_LABELS: { key: keyof RoleCaps; label: string }[] = [
  { key: 'login', label: 'Login' },
  { key: 'viewReports', label: 'View Reports' },
  { key: 'uploadTb', label: 'Upload TB' },
  { key: 'manageUsers', label: 'Manage Users' },
  { key: 'lockFy', label: 'Lock FY' },
  { key: 'viewAudit', label: 'View Audit' },
];

const ROLE_LABELS: Record<Role, string> = {
  cfo: 'CFO / Head of Finance',
  ceo: 'CEO / Executive Review',
  auditor: 'External Statutory Auditor',
  manager: 'Controller / Financial Analyst',
  viewer: 'Read-Only Stakeholder',
};

const MAX_MEMBERS = 4;
const STEP_LABELS = ['Administrator', 'Corporate Entity', 'Team & Access', 'Review & Launch'];

const emptyMember = (): MemberForm => ({ name: '', email: '', password: '', role: 'viewer' });

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

export default function SignupWizardPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [admin, setAdmin] = useState<AdminForm>({ name: '', email: '', password: '', confirm: '' });
  const [company, setCompany] = useState<CompanyForm>({ name: '', cin: '', date_of_incorporation: '', pan: '', gstin: '', registered_address: '', currency: 'INR', presentation_currency: '' });
  const [members, setMembers] = useState<MemberForm[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const today = new Date().toISOString().slice(0, 10);

  function validateStep1(): boolean {
    const e: Record<string, string> = {};
    if (!admin.name.trim()) e.name = 'Full name is required';
    if (!isEmail(admin.email)) e.email = 'Enter a valid business email address';
    if (!isStrongPassword(admin.password)) e.password = 'At least 8 characters, including a letter and a number';
    if (admin.confirm !== admin.password) e.confirm = 'Passwords do not match';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function validateStep2(): boolean {
    const e: Record<string, string> = {};
    if (!company.name.trim()) e.cname = 'Company legal name is required';
    if (!isCIN(company.cin)) e.cin = '21-character MCA CIN, e.g. U72900MH2015PTC123456';
    if (!isNotFutureDate(company.date_of_incorporation) || !company.date_of_incorporation) {
      e.doi = 'Select a valid date of incorporation (not in the future)';
    }
    if (company.pan.trim() && !isPAN(company.pan)) e.pan = '10-character PAN, e.g. AAAPL1234C';
    if (company.registered_address.trim().length > 500) e.address = 'Address must be 500 characters or fewer';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function validateStep3(): boolean {
    const e: Record<string, string> = {};
    const seen = new Set([admin.email.trim().toLowerCase()]);
    members.forEach((m, i) => {
      if (!m.name.trim()) e[`m${i}name`] = 'Name is required';
      if (!isEmail(m.email)) e[`m${i}email`] = 'Enter a valid business email address';
      else {
        const norm = m.email.trim().toLowerCase();
        if (seen.has(norm)) e[`m${i}email`] = 'This email is already used elsewhere in the form';
        seen.add(norm);
      }
      if (!isStrongPassword(m.password)) e[`m${i}password`] = 'At least 8 characters, including a letter and a number';
    });
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function goNext() {
    setSubmitError(null);
    if (step === 1 && !validateStep1()) return;
    if (step === 2 && !validateStep2()) return;
    if (step === 3 && !validateStep3()) return;
    setErrors({});
    setStep(s => Math.min(4, s + 1));
  }
  function goBack() {
    setSubmitError(null);
    setErrors({});
    setStep(s => Math.max(1, s - 1));
  }

  function addMember() {
    if (members.length >= MAX_MEMBERS) return;
    setMembers(ms => [...ms, emptyMember()]);
  }
  function removeMember(i: number) {
    setMembers(ms => ms.filter((_, idx) => idx !== i));
  }
  function updateMember(i: number, patch: Partial<MemberForm>) {
    setMembers(ms => ms.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  }

  async function submit() {
    if (!validateStep1() || !validateStep2() || !validateStep3()) {
      setSubmitError('Please resolve the highlighted errors before continuing.');
      return;
    }
    setBusy(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/v1/auth/signup-wizard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin: { name: admin.name.trim(), email: admin.email.trim(), password: admin.password },
          company: {
            name: company.name.trim(),
            cin: company.cin.trim().toUpperCase(),
            date_of_incorporation: company.date_of_incorporation,
            pan: company.pan.trim() ? company.pan.trim().toUpperCase() : undefined,
            gstin: company.gstin.trim() ? company.gstin.trim().toUpperCase() : undefined,
            registered_address: company.registered_address.trim() ? company.registered_address.trim() : undefined,
            currency: company.currency,
            presentation_currency: company.presentation_currency || undefined,
          },
          members: members.map(m => ({ name: m.name.trim(), email: m.email.trim(), password: m.password, role: m.role })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.errors?.length) {
          setSubmitError(data.errors.map((e: { message: string }) => e.message).join(' · '));
        } else {
          setSubmitError(data.error || 'Signup failed. Please try again.');
        }
        return;
      }
      storeSession(data.access_token, data.refresh_token, data.user);
      router.push('/dashboard/company-overview');
    } catch {
      setSubmitError('Network error — please check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ background: '#0b1220', color: '#e5e7eb', minHeight: '100vh' }}>
      <style>{`
        .sw-btn { transition: transform .12s ease, background .15s ease, filter .15s ease; }
        .sw-btn:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); }
        .sw-btn:active:not(:disabled) { transform: translateY(0) scale(.98); }
        .sw-btn:disabled { opacity: .5; cursor: not-allowed; }
        .sw-input:focus { border-color: #185fa5 !important; box-shadow: 0 0 0 3px rgba(24,95,165,.25); }
        .sw-card { animation: sw-fade-in .25s ease; }
        @keyframes sw-fade-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .sw-step-dot { transition: background .2s ease, color .2s ease; }
      `}</style>

      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 32px', maxWidth: 900, margin: '0 auto' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>
          FinCommand Pro <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 20, background: 'rgba(15,110,86,.25)', color: '#5DCAA5', marginLeft: 8, fontWeight: 500 }}>IND AS · Schedule III</span>
        </div>
        <Link href="/?auth=login" style={{ fontSize: 12, color: '#9ca3af' }}>
          Already have an account? <span style={{ color: '#5b9fe0', fontWeight: 600 }}>Sign In</span>
        </Link>
      </header>

      <main style={{ maxWidth: 720, margin: '0 auto', padding: '24px 24px 80px' }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: '#5DCAA5', marginBottom: 8, fontWeight: 600 }}>
            Enterprise Setup
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: '#fff', margin: 0 }}>Register your company</h1>
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 28, flexWrap: 'wrap' }}>
          {STEP_LABELS.map((label, i) => {
            const n = i + 1;
            const active = n === step;
            const done = n < step;
            return (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div
                  className="sw-step-dot"
                  style={{
                    width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700,
                    background: active || done ? '#185fa5' : 'rgba(255,255,255,.08)',
                    color: active || done ? '#fff' : '#6b7280',
                  }}
                >
                  {done ? '✓' : n}
                </div>
                <span style={{ fontSize: 11, color: active ? '#fff' : '#6b7280', fontWeight: active ? 600 : 400, whiteSpace: 'nowrap' }}>{label}</span>
                {n < STEP_LABELS.length && <div style={{ width: 20, height: 1, background: 'rgba(255,255,255,.15)', margin: '0 4px' }} />}
              </div>
            );
          })}
        </div>

        <div className="sw-card" key={step} style={{ background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)', borderRadius: 14, padding: 28 }}>
          {step === 1 && (
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 600, color: '#fff', marginTop: 0, marginBottom: 4 }}>Administrator Account</h2>
              <p style={{ fontSize: 12, color: '#9ca3af', marginBottom: 20 }}>
                This account is provisioned with the <strong>admin</strong> role — full system administration and Corporate Secretary access.
              </p>
              <div style={fieldWrap}>
                <label style={labelStyle}>Full Name</label>
                <input className="sw-input" style={inputStyle} value={admin.name} onChange={e => setAdmin(a => ({ ...a, name: e.target.value }))} placeholder="Priya Sharma" />
                {errors.name && <div style={errStyle}>{errors.name}</div>}
              </div>
              <div style={fieldWrap}>
                <label style={labelStyle}>Business Email Address</label>
                <input className="sw-input" style={inputStyle} type="email" value={admin.email} onChange={e => setAdmin(a => ({ ...a, email: e.target.value }))} placeholder="admin@yourcompany.in" />
                {errors.email && <div style={errStyle}>{errors.email}</div>}
              </div>
              <div style={fieldWrap}>
                <label style={labelStyle}>Password</label>
                <PasswordInput value={admin.password} onChange={v => setAdmin(a => ({ ...a, password: v }))} placeholder="At least 8 characters" inputStyle={inputStyle} />
                {errors.password && <div style={errStyle}>{errors.password}</div>}
              </div>
              <div style={fieldWrap}>
                <label style={labelStyle}>Confirm Password</label>
                <PasswordInput value={admin.confirm} onChange={v => setAdmin(a => ({ ...a, confirm: v }))} placeholder="Re-enter password" inputStyle={inputStyle} />
                {errors.confirm && <div style={errStyle}>{errors.confirm}</div>}
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 600, color: '#fff', marginTop: 0, marginBottom: 4 }}>Corporate Entity Profile</h2>
              <p style={{ fontSize: 12, color: '#9ca3af', marginBottom: 20 }}>
                Used verbatim as the legal entity heading on Schedule III reports.
              </p>
              <div style={fieldWrap}>
                <label style={labelStyle}>Company Name (legal entity)</label>
                <input className="sw-input" style={inputStyle} value={company.name} onChange={e => setCompany(c => ({ ...c, name: e.target.value }))} placeholder="Acme Technologies Private Limited" />
                {errors.cname && <div style={errStyle}>{errors.cname}</div>}
              </div>
              <div style={fieldWrap}>
                <label style={labelStyle}>Corporate Identification Number (CIN)</label>
                <input
                  className="sw-input" style={{ ...inputStyle, fontFamily: 'var(--mono, monospace)', textTransform: 'uppercase' }}
                  value={company.cin} maxLength={21}
                  onChange={e => setCompany(c => ({ ...c, cin: e.target.value.toUpperCase() }))}
                  placeholder="U72900MH2015PTC123456"
                />
                {errors.cin && <div style={errStyle}>{errors.cin}</div>}
              </div>
              <div style={fieldWrap}>
                <label style={labelStyle}>Date of Incorporation</label>
                <IncorporationDateInput value={company.date_of_incorporation} max={today} error={!!errors.doi} theme="dark" onChange={v => setCompany(c => ({ ...c, date_of_incorporation: v }))} />
                {errors.doi && <div style={errStyle}>{errors.doi}</div>}
              </div>
              <div style={fieldWrap}>
                <label style={labelStyle}>Permanent Account Number (PAN) — optional</label>
                <input
                  className="sw-input" style={{ ...inputStyle, fontFamily: 'var(--mono, monospace)', textTransform: 'uppercase' }}
                  value={company.pan} maxLength={10}
                  onChange={e => setCompany(c => ({ ...c, pan: e.target.value.toUpperCase() }))}
                  placeholder="AAAPL1234C"
                />
                {errors.pan && <div style={errStyle}>{errors.pan}</div>}
              </div>
              <div style={fieldWrap}>
                <label style={labelStyle}>GSTIN — optional</label>
                <input
                  className="sw-input" style={{ ...inputStyle, fontFamily: 'var(--mono, monospace)', textTransform: 'uppercase' }}
                  value={company.gstin} maxLength={15}
                  onChange={e => setCompany(c => ({ ...c, gstin: e.target.value.toUpperCase() }))}
                  placeholder="22AAAAA0000A1Z5"
                />
              </div>
              <div style={fieldWrap}>
                <label style={labelStyle}>Registered Office Address — optional</label>
                <textarea
                  className="sw-input" style={{ ...inputStyle, resize: 'vertical', minHeight: 64, fontFamily: 'inherit' }}
                  value={company.registered_address} maxLength={500}
                  onChange={e => setCompany(c => ({ ...c, registered_address: e.target.value }))}
                  placeholder="Registered office address as per MCA records"
                />
                {errors.address && <div style={errStyle}>{errors.address}</div>}
              </div>
              <div style={fieldWrap}>
                <label style={labelStyle}>Source Currency (Functional Currency)</label>
                <CustomSelect
                  variant="dark"
                  value={company.currency}
                  onChange={v => setCompany(c => ({ ...c, currency: v }))}
                  options={SUPPORTED_CURRENCIES.map(cc => ({ value: cc, label: `${CURRENCY_META[cc].symbol} ${cc} — ${CURRENCY_META[cc].name}` }))}
                />
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 5 }}>
                  The currency your Trial Balance ledgers will be recorded in. If you connect Zoho Books later, this is auto-detected from your organization instead.
                </div>
              </div>
              <div style={fieldWrap}>
                <label style={labelStyle}>Default Presentation Currency</label>
                <CustomSelect
                  variant="dark"
                  value={company.presentation_currency}
                  onChange={v => setCompany(c => ({ ...c, presentation_currency: v }))}
                  options={[
                    { value: '', label: 'Same as Source Currency (no conversion)' },
                    ...SUPPORTED_CURRENCIES.map(cc => ({ value: cc, label: `${CURRENCY_META[cc].symbol} ${cc} — ${CURRENCY_META[cc].name}` })),
                  ]}
                />
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 5 }}>
                  Currency your dashboards and exports will display by default. You (or your team) can always switch this later from the top bar.
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 600, color: '#fff', marginTop: 0, marginBottom: 4 }}>Team Configuration</h2>
              <p style={{ fontSize: 12, color: '#9ca3af', marginBottom: 20 }}>
                Provision up to {MAX_MEMBERS} teammates now with role-based access. They can sign in immediately with the credentials you set.
              </p>

              {members.map((m, i) => (
                <div key={i} style={{ border: '1px solid rgba(255,255,255,.1)', borderRadius: 10, padding: 16, marginBottom: 14, background: 'rgba(255,255,255,.02)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.4px' }}>Team Member {i + 1}</span>
                    <button type="button" onClick={() => removeMember(i)} style={{ background: 'none', border: 'none', color: '#f5a582', fontSize: 11, cursor: 'pointer' }}>Remove</button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                    <div>
                      <label style={labelStyle}>Name</label>
                      <input className="sw-input" style={inputStyle} value={m.name} onChange={e => updateMember(i, { name: e.target.value })} placeholder="Full name" />
                      {errors[`m${i}name`] && <div style={errStyle}>{errors[`m${i}name`]}</div>}
                    </div>
                    <div>
                      <label style={labelStyle}>Role</label>
                      <CustomSelect
                        variant="dark"
                        value={m.role}
                        onChange={v => updateMember(i, { role: v as Role })}
                        options={(Object.keys(ROLE_LABELS) as Role[]).map(r => ({ value: r, label: ROLE_LABELS[r] }))}
                      />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                    <div>
                      <label style={labelStyle}>Business Email</label>
                      <input className="sw-input" style={inputStyle} type="email" value={m.email} onChange={e => updateMember(i, { email: e.target.value })} placeholder="name@yourcompany.in" />
                      {errors[`m${i}email`] && <div style={errStyle}>{errors[`m${i}email`]}</div>}
                    </div>
                    <div>
                      <label style={labelStyle}>Password</label>
                      <PasswordInput value={m.password} onChange={v => updateMember(i, { password: v })} placeholder="At least 8 characters" inputStyle={inputStyle} />
                      {errors[`m${i}password`] && <div style={errStyle}>{errors[`m${i}password`]}</div>}
                    </div>
                  </div>
                  <SodGrid role={m.role} />
                </div>
              ))}

              {members.length < MAX_MEMBERS && (
                <button type="button" className="sw-btn" onClick={addMember} style={{ width: '100%', padding: '10px', borderRadius: 8, border: '1px dashed rgba(255,255,255,.2)', background: 'transparent', color: '#9ca3af', fontSize: 12, cursor: 'pointer' }}>
                  + Add Team Member ({members.length}/{MAX_MEMBERS})
                </button>
              )}
              {members.length === 0 && (
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 10, fontStyle: 'italic' }}>
                  Optional — you can also invite teammates later from the Company Overview page.
                </div>
              )}
            </div>
          )}

          {step === 4 && (
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 600, color: '#fff', marginTop: 0, marginBottom: 4 }}>Review &amp; Launch</h2>
              <p style={{ fontSize: 12, color: '#9ca3af', marginBottom: 20 }}>
                Confirm the details below. Your session will start automatically once your company is provisioned.
              </p>

              <ReviewBlock title="Administrator">
                <ReviewRow label="Name" value={admin.name} />
                <ReviewRow label="Email" value={admin.email} />
                <ReviewRow label="Role" value="Admin — System Administrator" />
              </ReviewBlock>

              <ReviewBlock title="Corporate Entity">
                <ReviewRow label="Company Name" value={company.name} />
                <ReviewRow label="CIN" value={company.cin} mono />
                <ReviewRow label="Date of Incorporation" value={company.date_of_incorporation} />
                <ReviewRow label="PAN" value={company.pan || '—'} mono />
                <ReviewRow label="GSTIN" value={company.gstin || '—'} mono />
                <ReviewRow label="Registered Address" value={company.registered_address.trim() || '—'} />
                <ReviewRow label="Source Currency" value={`${CURRENCY_META[company.currency as keyof typeof CURRENCY_META]?.symbol ?? ''} ${company.currency}`} />
                <ReviewRow label="Default Presentation Currency" value={company.presentation_currency ? `${CURRENCY_META[company.presentation_currency as keyof typeof CURRENCY_META]?.symbol ?? ''} ${company.presentation_currency}` : `Same as Source (${company.currency})`} />
              </ReviewBlock>

              <ReviewBlock title={`Team Members (${members.length})`}>
                {members.length === 0 && <div style={{ fontSize: 12, color: '#6b7280' }}>None provisioned</div>}
                {members.map((m, i) => (
                  <ReviewRow key={i} label={m.name || `Member ${i + 1}`} value={`${m.email} · ${ROLE_LABELS[m.role]}`} />
                ))}
              </ReviewBlock>

              {submitError && (
                <div style={{ background: 'rgba(217,90,48,.12)', color: '#f5a582', padding: '10px 12px', borderRadius: 8, fontSize: 12, marginTop: 12, borderLeft: '3px solid #d85a30' }}>
                  {submitError}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24, gap: 10 }}>
            <button type="button" className="sw-btn" disabled={step === 1} onClick={goBack} style={{ padding: '10px 20px', borderRadius: 8, background: 'transparent', border: '1px solid rgba(255,255,255,.15)', color: '#e5e7eb', fontSize: 13, cursor: 'pointer' }}>
              ← Back
            </button>
            {step < 4 ? (
              <button type="button" className="sw-btn" onClick={goNext} style={{ padding: '10px 24px', borderRadius: 8, background: '#185fa5', border: 'none', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                Continue →
              </button>
            ) : (
              <button type="button" className="sw-btn" disabled={busy} onClick={submit} style={{ padding: '10px 24px', borderRadius: 8, background: '#185fa5', border: 'none', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                {busy ? 'Provisioning…' : 'Create Company & Sign In →'}
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function SodGrid({ role }: { role: Role }) {
  const caps = ROLE_CAPS[role];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {CAPABILITY_LABELS.map(({ key, label }) => {
        const on = caps[key];
        return (
          <span
            key={key}
            style={{
              fontSize: 10, padding: '3px 9px', borderRadius: 20, fontWeight: 500,
              background: on ? 'rgba(93,202,165,.14)' : 'rgba(255,255,255,.04)',
              color: on ? '#5DCAA5' : '#6b7280',
              textDecoration: on ? 'none' : 'line-through',
            }}
          >
            {on ? '✓ ' : ''}{label}
          </span>
        );
      })}
    </div>
  );
}

function ReviewBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#5b9fe0', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>{title}</div>
      <div style={{ border: '1px solid rgba(255,255,255,.08)', borderRadius: 8, padding: '10px 14px', background: 'rgba(255,255,255,.02)' }}>
        {children}
      </div>
    </div>
  );
}

function ReviewRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', fontSize: 12 }}>
      <span style={{ color: '#9ca3af' }}>{label}</span>
      <span style={{ color: '#e5e7eb', fontFamily: mono ? 'var(--mono, monospace)' : undefined, textAlign: 'right' }}>{value}</span>
    </div>
  );
}
