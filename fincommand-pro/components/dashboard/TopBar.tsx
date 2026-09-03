'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { useToast } from '@/lib/dashboard/ToastContext';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { AddFyModal } from '@/components/dashboard/AddFyModal';
import { getUnitHeader } from '@/lib/utils/format';
import { CURRENCY_META, SUPPORTED_CURRENCIES, type CurrencyCode } from '@/lib/services/currency';

interface Props {
  onNavigate: (tab: string) => void;
  onOpenLogin: () => void;
  onDownloadAllXlsx: () => void;
  onDownloadAllPdf: () => void;
  onOpenAddFy?: () => void;
}

export function TopBar({ onNavigate, onOpenLogin, onDownloadAllXlsx, onDownloadAllPdf, onOpenAddFy }: Props) {
  const {
    dataMode, user, fyList, currentFyId, selectFy, logout, yearType, displayUnit, setDisplayUnit,
    sourceCurrency, presentationCurrency, setPresentationCurrency, fxRate, fxAsOf, fxLoading, fxError,
  } = useDashboard();
  const toast = useToast();
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [addFyOpen, setAddFyOpen] = useState(false);

  function handleAddFy() {
    if (onOpenAddFy) onOpenAddFy();
    else setAddFyOpen(true);
  }

  const currentFy = fyList.find(f => f.id === currentFyId);
  const companyName = user?.company_name || (dataMode === 'api' ? 'Loading Company...' : 'Acme Technologies Ltd');
  // In CY mode show the calendar year label (e.g. "CY2024") instead of FY label
  const fyLabel = currentFy
    ? (yearType === 'CY'
      ? `CY${parseInt((currentFy.end_date || currentFy.start_date).slice(0, 4), 10) + (currentFy.end_date ? 0 : 1)}`
      : currentFy.label)
    : '';
  const coInfo = dataMode === 'api'
    ? `${companyName}${fyLabel ? ` · ${fyLabel}` : ''} · Live`
    : `${companyName} · ${fyLabel || 'FY 2024-25'} · Standalone Financial Statements`;

  function requestLogout() {
    setConfirmOpen(true);
  }

  async function confirmLogout() {
    setLoggingOut(true);
    try {
      await logout();
      toast('Signed out');
      router.push('/');
    } finally {
      setLoggingOut(false);
      setConfirmOpen(false);
    }
  }

  return (
    <div className="topbar">
      <div>
        <div
          className="logo"
          role="button" tabIndex={0}
          onClick={() => router.push('/')}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') router.push('/'); }}
          style={{ cursor: 'pointer', display: 'inline-block' }}
          title="Go to FinCommand Pro home"
        >
          FinCommand Pro <span>IND AS · Schedule III</span>
        </div>
        <div className="co-info">{coInfo}</div>
      </div>
      <div className="tbar-right">
        {user?.role === 'admin' && (
          <button className="btn btn-se btn-sm" onClick={() => router.push('/dashboard/company-overview')}>🏢 Company Overview</button>
        )}
        <select
          value={currentFyId ?? ''}
          onChange={e => selectFy(e.target.value)}
          style={{ padding: '5px 10px', border: '1px solid var(--border2)', borderRadius: 'var(--radius-sm)', fontSize: 11, background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer' }}
        >
          {fyList.length === 0 && (
            <option value="" disabled>No years — Add a year ↗</option>
          )}
          {fyList.map(fy => (
            <option key={fy.id} value={fy.id}>{fy.label}{fy.is_locked ? ' 🔒' : ''}</option>
          ))}
        </select>
        {(user?.role === 'admin' || user?.role === 'cfo') && (
          <button className="btn btn-se btn-sm" onClick={handleAddFy} title="Add a new financial year">➕ Add Year</button>
        )}
        <select
          value={displayUnit}
          onChange={e => setDisplayUnit(e.target.value as 'Lakhs' | 'Thousands' | 'Crores')}
          title="Table display unit — applies to every tab's tables and KPI-adjacent figures"
          style={{ padding: '5px 10px', border: '1px solid var(--border2)', borderRadius: 'var(--radius-sm)', fontSize: 11, background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer' }}
        >
          <option value="Lakhs">{getUnitHeader('Lakhs', presentationCurrency)}</option>
          <option value="Thousands">{getUnitHeader('Thousands', presentationCurrency)}</option>
          <option value="Crores">{getUnitHeader('Crores', presentationCurrency)}</option>
        </select>
        <select
          value={presentationCurrency}
          onChange={e => setPresentationCurrency(e.target.value as CurrencyCode)}
          title={
            presentationCurrency === sourceCurrency
              ? `Presentation currency — this company's books are in ${sourceCurrency}, no conversion needed`
              : fxLoading
                ? 'Fetching live FX rate…'
                : fxError
                  ? `Live FX rate unavailable (${fxError}) — figures below are shown in ${sourceCurrency}, not ${presentationCurrency}, until a rate can be fetched`
                  : fxAsOf
                    ? `1 ${sourceCurrency} = ${fxRate.toFixed(4)} ${presentationCurrency} as of ${new Date(fxAsOf).toLocaleString('en-IN')} — spot rate, for reference only`
                    : 'Presentation currency'
          }
          style={{
            padding: '5px 10px', border: `1px solid ${fxError ? 'var(--amber)' : 'var(--border2)'}`, borderRadius: 'var(--radius-sm)',
            fontSize: 11, background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer',
          }}
        >
          {SUPPORTED_CURRENCIES.map(c => (
            <option key={c} value={c}>{CURRENCY_META[c].symbol} {c}</option>
          ))}
        </select>
        {fxError && presentationCurrency !== sourceCurrency && (
          <span className="pill pa" title={fxError}>⚠ FX unavailable — showing {sourceCurrency}</span>
        )}
        <span
          className={`pill ${dataMode === 'api' ? 'pg' : 'pa'}`}
          style={{ cursor: 'pointer' }}
          onClick={() => (dataMode === 'api' ? requestLogout() : onOpenLogin())}
          title={dataMode === 'api' ? 'Click to sign out' : 'Click to sign in'}
        >
          {dataMode === 'api' ? '● Live — API' : 'Sample Data'}
        </span>
        {user && (
          <span style={{ fontSize: 10, color: 'var(--text2)', padding: '3px 8px', background: 'var(--bg2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
            {user.name} · {user.role.toUpperCase()}
          </span>
        )}
        {dataMode === 'api' && (
          <button className="btn btn-dl btn-sm" onClick={requestLogout}>Logout</button>
        )}
        <button className="btn btn-se btn-sm" onClick={() => onNavigate('upload')}>⬆ Upload TB</button>
        <button className="btn btn-se btn-sm" onClick={onDownloadAllXlsx}>⬇ All Excel</button>
        <button className="btn btn-pr btn-sm" onClick={onDownloadAllPdf}>⬇ Annual Report PDF</button>
      </div>
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
      <AddFyModal open={addFyOpen} onClose={() => setAddFyOpen(false)} />
    </div>
  );
}
