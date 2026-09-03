import { useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { useToast } from '@/lib/dashboard/ToastContext';
import { apiFetch, getToken, getRefreshToken } from '@/lib/dashboard/api-client';
import { CURRENCY_META, SUPPORTED_CURRENCIES, isCurrencyCode, type CurrencyCode } from '@/lib/services/currency';

const FY_MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];

interface UploadResult {
  upload_id: string; ledger_count: number; mapped_count: number;
  unmatched_count: number; coverage_pct: number; message: string;
  unmatched_sample: string[];
}

export function UploadTab({ onOpenLogin, onNavigate, onOpenAddFy }: { onOpenLogin: () => void; onNavigate: (tab: string) => void; onOpenAddFy: () => void }) {
  const { dataMode, currentFyId, fyList, uploadComplete } = useDashboard();
  const toast = useToast();
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Connection provider selection state
  const [connectionProvider, setConnectionProvider] = useState('zoho');

  // REST API Connection state
  const [apiBaseUrl, setApiBaseUrl] = useState('https://api.yourcompany.com/v1');
  const [authType, setAuthType] = useState('API Key (Header)');
  const [apiKey, setApiKey] = useState('');
  const [apiTesting, setApiTesting] = useState(false);
  const [apiSaved, setApiSaved] = useState(false);

  // Zoho Books Connection state
  const [zohoOrgId, setZohoOrgId] = useState('');
  const [zohoDc, setZohoDc] = useState('IN');
  const [zohoStatus, setZohoStatus] = useState<{
    connected?: boolean;
    org_id?: string;
    last_synced_at?: string;
    last_sync_status?: string;
    last_sync_error?: string;
    synced_ledgers?: number;
    token_valid?: boolean;
  }>({});
  const [zohoLoading, setZohoLoading] = useState(false);
  const [zohoSyncing, setZohoSyncing] = useState(false);

  const currentFy = fyList.find(f => f.id === currentFyId);
  const locked = !!currentFy?.is_locked;

  const [sheetWarning, setSheetWarning] = useState<string | null>(null);

  const [initialLoading, setInitialLoading] = useState(dataMode === 'api');

  // Source Currency (IAS 21 / IND AS 21) — the currency THIS Trial Balance's
  // ledgers are actually recorded in, confirmed/changed at upload time.
  // Seeded from the company's current companies.currency below once loaded;
  // 'INR' until then, matching that column's own DB default.
  const [tbCurrency, setTbCurrency] = useState<CurrencyCode>('INR');

  const loadZohoStatus = async () => {
    if (dataMode !== 'api') return;
    try {
      const data = await apiFetch<{
        connected?: boolean;
        org_id?: string;
        last_synced_at?: string;
        last_sync_status?: string;
        last_sync_error?: string;
        synced_ledgers?: number;
        token_valid?: boolean;
      }>('/zoho/status');
      setZohoStatus(data);
      if (data.org_id) setZohoOrgId(data.org_id);
    } catch {
      /* ignore if unauthenticated */
    }
  };

  const autoSyncedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function initTab() {
      if (dataMode !== 'api') {
        setInitialLoading(false);
        return;
      }
      setInitialLoading(true);
      try {
        if (typeof window !== 'undefined') {
          const params = new URLSearchParams(window.location.search);
          if (params.get('zoho') === 'connected') {
            window.history.replaceState({}, '', window.location.pathname);
            if (!autoSyncedRef.current) {
              autoSyncedRef.current = true;
              if (currentFyId) {
                toast('✓ Zoho Books connected! Syncing Trial Balance...');
                setZohoSyncing(true);
                try {
                  const data = await apiFetch<{ message: string; ledgers_synced: number }>('/zoho/sync', {
                    method: 'POST',
                    body: JSON.stringify({ fy_id: currentFyId }),
                  });
                  toast(`✓ ${data.message} (${data.ledgers_synced} ledgers mapped)`);
                  uploadComplete();
                } catch (e) {
                  toast(`Sync Error: ${(e as Error).message}`);
                } finally {
                  setZohoSyncing(false);
                }
              } else {
                toast('✓ Zoho Books connected — but no financial year exists yet. Create one, then click "Sync Trial Balance".');
              }
            }
          } else if (params.get('zoho_error')) {
            toast(`⚠ ${params.get('zoho_error')}`);
            window.history.replaceState({}, '', window.location.pathname);
          }
        }
        await loadZohoStatus();
        try {
          const co = await apiFetch<{ currency?: string }>('/companies/me');
          if (!cancelled && isCurrencyCode(co.currency?.toUpperCase())) setTbCurrency(co.currency!.toUpperCase() as CurrencyCode);
        } catch {
          /* ignore — dropdown just stays at its 'INR' default */
        }
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    }

    initTab();
    return () => { cancelled = true; };
  }, [dataMode, currentFyId]);

  async function handleConnectZoho() {
    if (dataMode !== 'api' || (!getToken() && !getRefreshToken())) {
      onOpenLogin();
      toast('Please sign in to connect Zoho Books');
      return;
    }
    if (!zohoOrgId.trim()) {
      toast('⚠ Please enter your Zoho Organization ID before connecting');
      return;
    }
    if (fyList.length === 0) {
      toast('⚠ No financial year found. Create a financial year first, then connect Zoho Books.');
      onOpenAddFy();
      return;
    }
    setZohoLoading(true);
    try {
      await apiFetch('/zoho/config', {
        method: 'PUT',
        body: JSON.stringify({ org_id: zohoOrgId.trim() }),
      });

      const data = await apiFetch<{ auth_url?: string }>(`/zoho/auth-url?data_center=${zohoDc}`);
      if (data.auth_url) {
        window.location.href = data.auth_url;
      }
    } catch (e) {
      toast(`Error: ${(e as Error).message}`);
    } finally {
      setZohoLoading(false);
    }
  }

  async function handleSaveZohoConfig() {
    if (dataMode !== 'api' || (!getToken() && !getRefreshToken())) {
      onOpenLogin();
      toast('Please sign in to save settings');
      return;
    }
    if (!zohoOrgId.trim()) {
      toast('⚠ Please enter your Zoho Organization ID');
      return;
    }
    setZohoLoading(true);
    try {
      await apiFetch('/zoho/config', {
        method: 'PUT',
        body: JSON.stringify({ org_id: zohoOrgId.trim() }),
      });
      toast('✓ Zoho Organization ID saved');
      loadZohoStatus();
    } catch (e) {
      toast(`Error: ${(e as Error).message}`);
    } finally {
      setZohoLoading(false);
    }
  }

  async function handleSyncZoho() {
    if (dataMode !== 'api' || (!getToken() && !getRefreshToken())) {
      onOpenLogin();
      toast('Please sign in to sync');
      return;
    }
    if (fyList.length === 0) {
      toast('⚠ No financial year found. Create a financial year first, then sync.');
      onOpenAddFy();
      return;
    }
    if (!currentFyId) { toast('Please select a Financial Year first'); return; }
    setZohoSyncing(true);
    try {
      const data = await apiFetch<{ message: string; ledgers_synced: number }>('/zoho/sync', {
        method: 'POST',
        body: JSON.stringify({ fy_id: currentFyId }),
      });
      toast(`✓ ${data.message} (${data.ledgers_synced} ledgers mapped)`);
      uploadComplete();
      loadZohoStatus();
    } catch (e) {
      toast(`Sync Error: ${(e as Error).message}`);
    } finally {
      setZohoSyncing(false);
    }
  }

  async function handleDisconnectZoho() {
    if (dataMode !== 'api') return;
    if (!confirm('Disconnect Zoho Books? You can reconnect or connect with a different Organization ID at any time.')) return;
    setZohoLoading(true);
    try {
      await apiFetch('/zoho/config', { method: 'DELETE' });
      toast('✓ Zoho Books disconnected');
      setZohoStatus({ connected: false });
    } catch (e) {
      toast(`Error: ${(e as Error).message}`);
    } finally {
      setZohoLoading(false);
    }
  }

  function pickFile(f: File | null) {
    if (!f) return;
    if (!/\.(xlsx|xls)$/i.test(f.name)) { setError('Please choose a .xlsx or .xls file'); return; }
    setFile(f);
    setError(null);
    setResult(null);
    setSheetWarning(null);

    // Quick client-side sheet name check
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = new Uint8Array(ev.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array', sheetRows: 1 });
        const names = wb.SheetNames;
        const tbCandidates = ['trial_balance', 'trialbalance', 'tb', 'sheet1'];
        const normalised = names.map(n => n.toLowerCase().replace(/[\s_-]/g, ''));
        const found = normalised.some(n => tbCandidates.includes(n));

        if (!found) {
          // Check if any sheet has TB-like headers
          let hasHeaders = false;
          for (const sn of names) {
            const peek: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1 });
            const hdrStr = (peek[0] || []).map(h => String(h || '').toLowerCase().replace(/[\s_-]/g, '')).join('|');
            if (hdrStr.includes('ledgername') || hdrStr.includes('ledgercode') ||
                (hdrStr.includes('openingdr') && hdrStr.includes('openingcr'))) {
              hasHeaders = true;
              break;
            }
          }

          if (!hasHeaders) {
            setSheetWarning(
              `⚠ Sheet "Trial_Balance" not found. Found sheets: [${names.join(', ')}]. ` +
              `This may not be a Trial Balance file. Download the template for the correct format.`
            );
          }
        }
      } catch { /* ignore parse errors at this stage — the server will catch them */ }
    };
    reader.readAsArrayBuffer(f);
  }

  async function doUpload() {
    if (dataMode !== 'api') { onOpenLogin(); toast('Please sign in to upload a Trial Balance'); return; }
    if (fyList.length === 0) {
      toast('⚠ No financial year found. Create a financial year first, then upload the Trial Balance.');
      onOpenAddFy();
      return;
    }
    if (!currentFyId) { toast('Please select a financial year first'); return; }
    if (!file) { toast('No file selected'); return; }

    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('trial_balance', file);
      formData.append('financial_year_id', currentFyId);
      formData.append('currency', tbCurrency);

      const data = await apiFetch<UploadResult>('/tb/upload', {
        method: 'POST',
        body: formData,
      });

      setResult(data);
      toast(data.message);
      uploadComplete();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    const wb = XLSX.utils.book_new();
    const hdr = ['Ledger_Code', 'Ledger_Name', 'Opening_Dr', 'Opening_Cr', ...FY_MONTHS.flatMap(m => [`${m}_Dr`, `${m}_Cr`])];
    const sampleRows = [
      ['6001', 'IT Services Revenue', 0, 0, 0, 1410, 0, 1473, 0, 1553, 0, 1638, 0, 1596, 0, 1694, 0, 1757, 0, 1876, 0, 1813, 0, 1904, 0, 1995, 0, 1915],
      ['7011', 'Salaries & Wages', 0, 0, 486, 0, 508, 0, 537, 0, 567, 0, 551, 0, 585, 0, 606, 0, 648, 0, 627, 0, 659, 0, 730, 0, 619, 0],
      ['2101', 'HDFC Bank — Current Account', 3960, 0, ...Array(24).fill(0)],
      ['3001', 'Equity Share Capital', 0, 10000, ...Array(24).fill(0)],
      ['3013', 'Retained Earnings', 0, 61240, ...Array(24).fill(0)],
    ];
    const sheet = XLSX.utils.aoa_to_sheet([hdr, ...sampleRows]);
    sheet['!cols'] = [{ wch: 14 }, { wch: 36 }, { wch: 12 }, { wch: 12 }, ...FY_MONTHS.flatMap(() => [{ wch: 8 }, { wch: 8 }])];
    XLSX.utils.book_append_sheet(wb, sheet, 'Trial_Balance');
    const instr = XLSX.utils.aoa_to_sheet([
      ['FinCommand Pro — Monthly Trial Balance Template'], [''],
      ['Required sheet name: Trial_Balance'],
      ['Columns: Ledger_Code, Ledger_Name, Opening_Dr, Opening_Cr, then Apr_Dr/Apr_Cr … Mar_Dr/Mar_Cr'],
      ['Monthly Dr/Cr are MOVEMENTS for that month, not cumulative balances.'],
      ['Balance Sheet = Opening + cumulative movements. P&L = sum of movements for the selected period.'],
    ]);
    XLSX.utils.book_append_sheet(wb, instr, 'Instructions');
    XLSX.writeFile(wb, 'FinCommand_TB_Monthly_Template.xlsx');
    toast('Template downloaded');
  }

  async function testConnection() {
    if (!apiBaseUrl.trim()) { toast('Please enter a Base URL'); return; }
    setApiTesting(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey.trim()) {
        if (authType === 'API Key (Header)') headers['X-API-Key'] = apiKey;
        else headers['Authorization'] = `Bearer ${apiKey}`;
      }
      const res = await fetch(apiBaseUrl.replace(/\/$/, '') + '/health', {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        toast('✓ Connection successful');
      } else {
        toast(`Connection failed: HTTP ${res.status}`);
      }
    } catch {
      toast('Connection failed: could not reach the server');
    } finally {
      setApiTesting(false);
    }
  }

  function saveConfig() {
    if (!apiBaseUrl.trim()) { toast('Please enter a Base URL'); return; }
    localStorage.setItem('fc_api_base_url', apiBaseUrl);
    localStorage.setItem('fc_api_auth_type', authType);
    if (apiKey) localStorage.setItem('fc_api_key', apiKey);
    setApiSaved(true);
    toast('API configuration saved');
    setTimeout(() => setApiSaved(false), 2000);
  }

  if (initialLoading) {
    return (
      <div className="card p-8 text-center" style={{ minHeight: 340, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', margin: '20px 0' }}>
        <div className="spinner mb-4" style={{ width: 38, height: 38, borderWidth: 3, borderColor: 'var(--primary)', borderTopColor: 'transparent' }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-main)', marginBottom: 8 }}>
          {autoSyncedRef.current ? 'Connecting & Syncing Trial Balance with Zoho Books…' : 'Loading Integration Details…'}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text2)', maxWidth: 480, lineHeight: 1.6 }}>
          {autoSyncedRef.current
            ? 'Fetching 12-month Trial Balance ledgers from Zoho Books and mapping IND AS Schedule III classifications. Please wait…'
            : 'Retrieving secure connection status and financial year mappings…'}
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Info bar */}
      <div className="info-bar" style={{ marginBottom: 14 }}>
        <strong>Two data modes:</strong> Upload a Trial Balance Excel (auto-populates all statements) or connect via <strong>REST API (Zoho Books / ERP)</strong>.
      </div>

      {/* 4-Layer Architecture Cards */}
      <div className="step-grid" style={{ marginBottom: 14 }}>
        <div className="step-box" style={{ borderLeft: '3px solid var(--blue)', background: 'var(--blue-l)' }}>
          <div className="step-num" style={{ color: 'var(--blue)' }}>LAYER 1 · SOURCE</div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Trial Balance</div>
          <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.6 }}>
            Opening balances + 12 months × Dr/Cr per ledger. Sync from Zoho Books or upload Excel.
          </div>
          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 8, fontFamily: 'var(--mono)' }}>
            28 cols · 1 sheet · monthly
          </div>
        </div>
        <div className="step-box" style={{ borderLeft: '3px solid var(--green)', background: 'var(--green-l)' }}>
          <div className="step-num" style={{ color: 'var(--green)' }}>LAYER 2 · MAP</div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Ledger Master</div>
          <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.6 }}>
            Pre-seeded 90+ IND AS mappings. Each ledger → Note No + BS/PL section + treasury type.
          </div>
          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 8, fontFamily: 'var(--mono)' }}>
            Pre-seeded · customizable
          </div>
        </div>
        <div className="step-box" style={{ borderLeft: '3px solid var(--amber)', background: 'var(--amber-l)' }}>
          <div className="step-num" style={{ color: 'var(--amber)' }}>LAYER 3 · COMPUTE</div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Period Engine</div>
          <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.6 }}>
            BS = cumulative, P&L = selected months. All period views from same TB — no re-upload.
          </div>
          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 8, fontFamily: 'var(--mono)' }}>
            Monthly → Q → H → Annual
          </div>
        </div>
        <div className="step-box" style={{ borderLeft: '3px solid var(--purple)', background: 'var(--purple-l)' }}>
          <div className="step-num" style={{ color: 'var(--purple)' }}>LAYER 4 · OUTPUT</div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>All Reports</div>
          <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.6 }}>
            MIS, Balance Sheet, P&L, Notes 1-26, Treasury — all live from same TB.
          </div>
          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 8, fontFamily: 'var(--mono)' }}>
            6 reports · 1 sync/upload
          </div>
        </div>
      </div>

      {/* Not derivable warning bar */}
      <div className="warn-bar" style={{ marginBottom: 14 }}>
        <strong>Not derivable from TB:</strong> PPE Gross Block / Asset Register · IND AS 19 Actuarial DBO · ECL invoice-level ageing · IND AS 102 ESOP register · IND AS 116 Lease schedules.
      </div>

      {/* Sample mode / locked FY warnings */}
      {dataMode !== 'api' && (
        <div className="warn-bar">
          You&apos;re in sample mode. <a href="#" onClick={e => { e.preventDefault(); onOpenLogin(); }}>Sign in</a> to connect Zoho Books or upload a real Trial Balance.
        </div>
      )}
      {dataMode === 'api' && locked && (
        <div className="warn-bar">{currentFy?.label} is locked (post-audit) — sync and uploads are disabled for this financial year.</div>
      )}
      {dataMode === 'api' && fyList.length === 0 && (
        <div className="warn-bar" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>No financial year has been created yet. Create one before connecting Zoho Books or uploading a Trial Balance.</span>
          <button className="btn btn-se btn-sm" onClick={onOpenAddFy}>➕ Create Financial Year</button>
        </div>
      )}

      {/* Two-column layout: Option 1 (Upload) + Option 2 (Zoho Books REST API) */}
      <div className="grid2" style={{ gap: 14, alignItems: 'start' }}>

        {/* Option 1 — Upload Trial Balance (Monthly) */}
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="card-hdr">
            <span className="ct">Option 1 — Upload Trial Balance (Monthly)</span>
          </div>
          <div className="card-body">
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 500, display: 'block', marginBottom: 4 }}>
                Trial Balance Currency (Source / Functional Currency)
              </label>
              <select
                value={tbCurrency}
                onChange={e => setTbCurrency(e.target.value as CurrencyCode)}
                title="The currency these ledger figures are actually recorded in — confirmed/changed at upload time (IAS 21 / IND AS 21). Independent of the Presentation Currency selector in the top bar."
                style={{
                  width: '100%', padding: '7px 10px', fontSize: 11, border: '1px solid var(--border2)',
                  borderRadius: 'var(--radius-sm)', color: 'var(--text)', background: 'var(--bg)',
                  outline: 'none', cursor: 'pointer', appearance: 'auto',
                }}
              >
                {SUPPORTED_CURRENCIES.map(c => (
                  <option key={c} value={c}>{CURRENCY_META[c].symbol} {c} — {CURRENCY_META[c].name}</option>
                ))}
              </select>
              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4, lineHeight: 1.5 }}>
                Defaults to this company&apos;s saved currency. Change it if this particular Trial Balance is denominated differently — every uploaded figure is treated as this currency until changed again.
              </div>
            </div>

            <button
              className="btn btn-gr"
              onClick={downloadTemplate}
              style={{ marginBottom: 12 }}
            >
              ⬇ Download TB Template (.xlsx)
            </button>

            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 14, lineHeight: 1.7 }}>
              Template has 3 sheets: <strong>Trial_Balance</strong> — 28 columns: Ledger_Code, Ledger_Name, Opening_Dr, Opening_Cr, then Apr_Dr … Mar_Cr.
            </div>

            <div
              className={`upload-zone${dragOver ? ' drag' : ''}${result ? ' done' : ''}`}
              onClick={() => inputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files[0] ?? null); }}
            >
              <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.5 }}>📂</div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                {file ? file.name : 'Drop Trial Balance Excel here or click to browse'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text2)' }}>
                {file ? `${(file.size / 1024).toFixed(1)} KB — ready to upload` : 'Supports .xlsx — Trial_Balance sheet required'}
              </div>
            </div>
            <input ref={inputRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={e => pickFile(e.target.files?.[0] ?? null)} />

            {sheetWarning && <div className="warn-bar" style={{ marginTop: 8 }}>{sheetWarning}</div>}
            {error && <div className="warn-bar" style={{ marginTop: 8 }}>⚠ {error}</div>}

            {file && !result && (
              <button
                className="btn btn-pr"
                disabled={busy || dataMode !== 'api' || locked || fyList.length === 0}
                title={fyList.length === 0 ? 'Create a financial year first' : undefined}
                onClick={doUpload}
                style={{ marginTop: 8 }}
              >
                {busy ? 'Uploading…' : 'Upload & Recompute Reports'}
              </button>
            )}

            {result && (
              <div className="success-bar" style={{ marginTop: 8 }}>
                {result.message}
                {result.unmatched_count > 0 && (
                  <div style={{ marginTop: 4 }}>Unmatched ledgers: {result.unmatched_sample.join(', ')}{result.unmatched_count > result.unmatched_sample.length ? '…' : ''}</div>
                )}
                <div style={{ marginTop: 8 }}>
                  <button className="btn btn-gr btn-sm" onClick={() => onNavigate('overview')}>View Reports →</button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Option 2 — REST API Connection */}
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="card-hdr" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="ct">Option 2 — REST API Connection</span>
            {connectionProvider === 'zoho' && (
              <span
                style={{
                  fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 12,
                  background: zohoStatus.connected ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                  color: zohoStatus.connected ? '#15803d' : '#b91c1c',
                  border: `1px solid ${zohoStatus.connected ? '#86efac' : '#fca5a5'}`,
                }}
              >
                {zohoStatus.connected ? '● Connected' : '○ Not Connected'}
              </span>
            )}
          </div>
          <div className="card-body">
            {/* Connection Provider / ERP Selector */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 500, display: 'block', marginBottom: 4 }}>
                Connection Type / Integration
              </label>
              <select
                value={connectionProvider}
                onChange={e => setConnectionProvider(e.target.value)}
                style={{
                  width: '100%', padding: '7px 10px', fontSize: 11, border: '1px solid var(--border2)',
                  borderRadius: 'var(--radius-sm)', color: 'var(--text)', background: 'var(--bg)',
                  outline: 'none', cursor: 'pointer', appearance: 'auto', fontWeight: 600,
                }}
              >
                <option value="zoho">Zoho Books (REST API / OAuth 2.0)</option>
                <option value="custom">Custom REST API (API Key / Bearer)</option>
                <option value="sap">SAP ERP (REST API)</option>
                <option value="oracle">Oracle NetSuite (REST API)</option>
                <option value="tally">Tally Prime (REST / XML)</option>
                <option value="quickbooks">QuickBooks Online (OAuth 2.0)</option>
              </select>
            </div>

            {/* ZOHO BOOKS FORM */}
            {connectionProvider === 'zoho' ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8, marginBottom: 12 }}>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 500, display: 'block', marginBottom: 4 }}>
                      Data Center
                    </label>
                    <select
                      value={zohoDc}
                      onChange={e => setZohoDc(e.target.value)}
                      style={{
                        width: '100%', padding: '7px 10px', fontSize: 11, border: '1px solid var(--border2)',
                        borderRadius: 'var(--radius-sm)', color: 'var(--text)', background: 'var(--bg)',
                        outline: 'none', cursor: 'pointer', appearance: 'auto',
                      }}
                    >
                      <option value="IN">India (.in)</option>
                      <option value="US">US (.com)</option>
                      <option value="EU">EU (.eu)</option>
                      <option value="AU">Australia (.com.au)</option>
                    </select>
                  </div>

                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 500, display: 'block', marginBottom: 4 }}>
                      Organization ID
                    </label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        type="text"
                        value={zohoOrgId}
                        onChange={e => setZohoOrgId(e.target.value)}
                        placeholder="e.g. 60029248187"
                        style={{
                          flex: 1, padding: '7px 10px', fontSize: 11, border: '1px solid var(--border2)',
                          borderRadius: 'var(--radius-sm)', fontFamily: 'var(--mono)', color: 'var(--text)',
                          background: 'var(--bg)', outline: 'none',
                        }}
                      />
                      <button
                        className="btn btn-se btn-sm"
                        onClick={handleSaveZohoConfig}
                        disabled={zohoLoading}
                        title="Save Org ID"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                </div>

                {zohoStatus.connected && (
                  <div
                    style={{
                      background: zohoStatus.last_sync_status === 'error' ? '#fef2f2' : 'var(--bg2, #f8fafc)',
                      padding: 12, borderRadius: 8,
                      border: zohoStatus.last_sync_status === 'error' ? '1px solid #fca5a5' : '1px solid var(--border2, #e2e8f0)',
                      fontSize: 11, marginBottom: 14, lineHeight: 1.6,
                    }}
                  >
                    <div><strong>Sync Status:</strong> <span style={{ color: zohoStatus.last_sync_status === 'error' ? '#dc2626' : '#16a34a', fontWeight: 600 }}>{zohoStatus.last_sync_status || 'connected'}</span></div>
                    {zohoStatus.last_synced_at && (
                      <div><strong>Last Synced:</strong> {new Date(zohoStatus.last_synced_at).toLocaleString()}</div>
                    )}
                    {zohoStatus.synced_ledgers !== undefined && (
                      <div><strong>Synced Ledgers:</strong> {zohoStatus.synced_ledgers} ledgers</div>
                    )}
                    {zohoStatus.last_sync_error && (
                      <div style={{ color: '#dc2626', marginTop: 4, fontSize: 11, fontWeight: 500 }}>⚠ {zohoStatus.last_sync_error}</div>
                    )}
                    {zohoStatus.last_sync_status === 'error' && (
                      <div style={{
                        marginTop: 8, padding: '8px 10px', borderRadius: 6,
                        background: '#ffffff', border: '1px solid #f87171',
                        color: '#991b1b', fontSize: 11, fontWeight: 500,
                        display: 'flex', alignItems: 'center', gap: 6,
                      }}>
                        <span>👉</span>
                        <span>Sync error encountered. Please click the <strong>&quot;Sync Trial Balance&quot;</strong> button below to re-try syncing your trial balance.</span>
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-pr"
                    onClick={handleConnectZoho}
                    disabled={zohoLoading || fyList.length === 0}
                    title={fyList.length === 0 ? 'Create a financial year first' : undefined}
                    style={{ flex: 1, minWidth: 140 }}
                  >
                    {zohoLoading ? 'Connecting…' : zohoStatus.connected ? '🔄 Reconnect Zoho' : '🔗 Connect Zoho Books'}
                  </button>

                  <button
                    className="btn btn-gr"
                    onClick={handleSyncZoho}
                    disabled={!zohoStatus.connected || zohoSyncing || locked || fyList.length === 0}
                    title={fyList.length === 0 ? 'Create a financial year first' : undefined}
                    style={{
                      flex: 1, minWidth: 140,
                      ...(zohoStatus.last_sync_status === 'error' ? {
                        border: '2px solid #dc2626',
                        boxShadow: '0 0 10px rgba(220, 38, 38, 0.4)',
                        fontWeight: 700,
                      } : {}),
                    }}
                  >
                    {zohoSyncing ? 'Syncing Data…' : zohoStatus.last_sync_status === 'error' ? '⚡ Re-try Sync Trial Balance' : '⚡ Sync Trial Balance'}
                  </button>

                  {zohoStatus.connected && (
                    <button
                      className="btn btn-se"
                      onClick={handleDisconnectZoho}
                      disabled={zohoLoading}
                      style={{ color: '#dc2626', borderColor: '#fca5a5' }}
                      title="Disconnect current Zoho organization"
                    >
                      Disconnect
                    </button>
                  )}
                </div>

                <div style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.7 }}>
                  {zohoStatus.connected ? (
                    <>🟢 <strong>Live Sync Active</strong> · Connected via OAuth 2.0. Auto-sync runs every 15 mins via Cron.</>
                  ) : (
                    <>🔒 <strong>OAuth 2.0 Integration</strong> · Click "Connect Zoho Books" to authorize direct REST API sync.</>
                  )}
                </div>
              </>
            ) : (
              /* GENERIC REST API FORM (ORIGINAL UI) */
              <>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 500, display: 'block', marginBottom: 4 }}>
                    Base URL
                  </label>
                  <input
                    type="text"
                    value={apiBaseUrl}
                    onChange={e => setApiBaseUrl(e.target.value)}
                    placeholder="https://api.yourcompany.com/v1"
                    style={{
                      width: '100%', padding: '7px 10px', fontSize: 11, border: '1px solid var(--border2)',
                      borderRadius: 'var(--radius-sm)', fontFamily: 'var(--mono)', color: 'var(--text)',
                      background: 'var(--bg)', outline: 'none',
                    }}
                  />
                </div>

                <div style={{ marginBottom: 12 }}>
                  <label style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 500, display: 'block', marginBottom: 4 }}>
                    Authentication
                  </label>
                  <select
                    value={authType}
                    onChange={e => setAuthType(e.target.value)}
                    style={{
                      width: '100%', padding: '7px 10px', fontSize: 11, border: '1px solid var(--border2)',
                      borderRadius: 'var(--radius-sm)', color: 'var(--text)', background: 'var(--bg)',
                      outline: 'none', cursor: 'pointer', appearance: 'auto',
                    }}
                  >
                    <option>API Key (Header)</option>
                    <option>Bearer Token</option>
                    <option>OAuth 2.0</option>
                    <option>Basic Auth</option>
                  </select>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 500, display: 'block', marginBottom: 4 }}>
                    API Key / Token
                  </label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    placeholder="Enter API key or Bearer token"
                    style={{
                      width: '100%', padding: '7px 10px', fontSize: 11, border: '1px solid var(--border2)',
                      borderRadius: 'var(--radius-sm)', fontFamily: 'var(--mono)', color: 'var(--text)',
                      background: 'var(--bg)', outline: 'none',
                    }}
                  />
                </div>

                <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                  <button
                    className="btn btn-pr"
                    onClick={testConnection}
                    disabled={apiTesting}
                  >
                    {apiTesting ? 'Testing…' : 'Test Connection'}
                  </button>
                  <button
                    className="btn btn-se"
                    onClick={saveConfig}
                    style={apiSaved ? { borderColor: 'var(--green)', color: 'var(--green)' } : {}}
                  >
                    {apiSaved ? '✓ Saved' : 'Save Config'}
                  </button>
                </div>

                <div style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.7 }}>
                  Supports: <strong>SAP</strong> · <strong>Oracle</strong> · <strong>Tally</strong> · <strong>Zoho Books</strong> · <strong>QuickBooks</strong> · <strong>Custom ERP</strong>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

