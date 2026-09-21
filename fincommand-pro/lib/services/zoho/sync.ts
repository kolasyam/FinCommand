import axios from 'axios';
import { v4 as uuid } from 'uuid';
import { query } from '@/lib/db/neon';
import { invalidateReportCache } from '@/lib/cache/report-cache';
import { ApiError } from '@/lib/auth/permissions';
import { decideSourceOwnership, type DataSource } from '@/lib/financial/tb-validation';
import { sourceName } from '@/lib/db/queries/tb-batches';
import { ingestTrialBalance } from '@/lib/ingestion/trial-balance';
import { ZOHO_API, callZoho, decryptZohoConfig, refreshZohoTokenSingleFlight, type ZohoConfigRow } from './client';
import { sanitizeSection, sanitizeTreasuryType } from './classify';
import { mapZohoLedgers, type LedgerMasterMapping } from './map';
import { FY_MONTHS_DR, assembleZohoLedgers, dayBeforeISO, monthEndISO } from './assemble';
import { syncZohoContacts } from './contacts';
import {
  aggregateSalesByCustomer, aggregateVendorBills, aggregateCustomerCost, fetchAllPages, buildSyncNotes,
} from './people';

export interface SyncResult {
  ledgers_synced: number;
  mapped: number;
  upload_id: string | null;
  duration_ms: number;
  warning: string | null;
  /** Set when a scheduled sync left the year alone because Excel owns it. */
  skipped?: string;
  /** Zoho's figures were identical to the current batch, so nothing was written. */
  unchanged?: boolean;
  /** Debit = credit check on the new batch (warn only). */
  is_balanced?: boolean;
  balance_diff?: number;
}

export interface SyncOptions {
  /** The user confirmed replacing a year whose data came from an Excel upload. */
  confirmReplace?: boolean;
  /** Called by the scheduler, not a person: never switches a year's source, skips instead. */
  scheduled?: boolean;
}

/**
 * Core Zoho → tb_ledgers sync — ported from routes/zoho.js syncFromZoho().
 *
 * Once this run has claimed the company's "running" slot, any failure marks
 * both zoho_config and its sync_logs row as 'error' (previously a failure
 * inside the DB transaction left both stuck on 'running'). A rejection before
 * the claim — year locked, year owned by Excel, another sync in progress —
 * changes neither, so it can't clobber the status of the sync that IS running.
 */
export async function syncFromZoho(
  companyId: string, fyId: string, triggeredBy: string | null = null, options: SyncOptions = {},
): Promise<SyncResult> {
  const logId = uuid();
  const state = { claimed: false };
  try {
    return await runZohoSync(companyId, fyId, triggeredBy, options, logId, state);
  } catch (err) {
    if (state.claimed) {
      const msg = (err as Error).message || 'Zoho sync failed';
      await query(
        `UPDATE zoho_config SET last_sync_status='error', last_sync_error=$1, updated_at=NOW()
         WHERE company_id=$2 AND last_sync_status='running'`,
        [msg, companyId]
      ).catch((e: Error) => console.error('[zoho] could not record sync failure on zoho_config:', e.message));
      await query(
        `UPDATE sync_logs SET status='error', error_message=$1, completed_at=NOW() WHERE id=$2 AND status='running'`,
        [msg, logId]
      ).catch((e: Error) => console.error('[zoho] could not record sync failure on sync_logs:', e.message));
    }
    throw err;
  }
}

async function runZohoSync(
  companyId: string, fyId: string, triggeredBy: string | null, options: SyncOptions,
  logId: string, state: { claimed: boolean },
): Promise<SyncResult> {
  const start = Date.now();

  // Dates as 'YYYY-MM-DD' text, never a JS Date: pg turns a DATE into LOCAL
  // midnight, so on a machine in India (UTC+5:30) 1 April became 31 March in
  // UTC. The opening snapshot was then taken on 30 March instead of 31 March
  // (every year-end entry missed; month 1 absorbed them), and bills were
  // bucketed one month late with March's dropped.
  const { rows: fyRows } = await query(
    `SELECT id, label, is_locked, data_source, start_date::text AS start_date, end_date::text AS end_date
     FROM financial_years WHERE id=$1 AND company_id=$2`,
    [fyId, companyId]
  );
  if (!fyRows.length) throw new Error('Financial year not found');
  const fy = fyRows[0] as { start_date: string; label: string; is_locked: boolean; data_source: DataSource | null };
  const startYear = parseInt(fy.start_date.slice(0, 4), 10);

  // Checked before claiming the "running" slot (and re-checked under the
  // write lock inside the transaction below).
  if (fy.is_locked) {
    throw new ApiError(403, `${fy.label} is locked (post-audit) — it can't be re-synced.`, 'YEAR_LOCKED');
  }
  const ownership = decideSourceOwnership(fy.data_source, 'zoho', options);
  if (ownership === 'skip') {
    const reason = `${fy.label} is owned by ${sourceName(fy.data_source!)} — scheduled Zoho sync skipped it`;
    await query(
      `INSERT INTO sync_logs (id,company_id,source,financial_year,triggered_by,status,error_message,started_at,completed_at,duration_ms)
       VALUES ($1,$2,'zoho',$3,$4,'skipped',$5,NOW(),NOW(),0)`,
      [logId, companyId, fy.label, triggeredBy, reason]
    );
    return { ledgers_synced: 0, mapped: 0, upload_id: null, duration_ms: 0, warning: null, skipped: reason };
  }
  if (ownership === 'needs_confirm') {
    throw new ApiError(
      409,
      `${fy.label}'s data currently comes from ${sourceName(fy.data_source!)}. Replace it with data from Zoho Books? ` +
      `Scheduled syncs will then keep this year up to date from Zoho.`,
      'SOURCE_OWNED',
      { owner: fy.data_source },
    );
  }

  const { rows: coRows } = await query<{ currency: string }>(`SELECT currency FROM companies WHERE id=$1`, [companyId]);
  const baseCurrency = (coRows[0]?.currency || 'INR').toUpperCase();

  const { rows: cfgRows } = await query<ZohoConfigRow>(`SELECT * FROM zoho_config WHERE company_id=$1`, [companyId]);
  if (!cfgRows.length) throw new Error('Zoho Books not connected');
  const cfg = decryptZohoConfig(cfgRows[0]);
  const orgId = cfg.org_id;
  if (!orgId) throw new Error('Zoho Organisation ID not set');

  // Atomically claim the "running" slot — reject if another sync for this
  // company is already in flight, rather than letting two syncFromZoho()
  // runs race each other. Nothing previously stopped this: a cron tick
  // landing at the same moment as a manual "Sync Now" click (or two cron
  // ticks overlapping if a run ever took longer than the schedule interval)
  // would both proceed, each flipping tb_uploads.is_current and racing
  // Zoho's OAuth endpoint for the same company — see
  // refreshZohoTokenSingleFlight's doc comment for how that race surfaced in
  // production. A stale 'running' row (a previous run that crashed before
  // reaching any terminal status) self-heals after 5 minutes — comfortably
  // longer than a real sync's observed ~30-40s — rather than permanently
  // wedging this company's syncs.
  const { rowCount: claimed } = await query(
    `UPDATE zoho_config SET last_sync_status='running', updated_at=NOW()
     WHERE company_id=$1
       AND NOT (last_sync_status='running' AND updated_at > NOW() - INTERVAL '5 minutes')`,
    [companyId]
  );
  if (!claimed) {
    const e = new Error('A Zoho sync is already in progress for this company. Please wait for it to finish.') as Error & { status?: number };
    e.status = 409;
    throw e;
  }
  state.claimed = true;
  await query(
    `INSERT INTO sync_logs (id,company_id,source,financial_year,triggered_by,status,started_at)
     VALUES ($1,$2,'zoho',$3,$4,'running',NOW())`,
    [logId, companyId, fy.label, triggeredBy]
  );

  const apiBase = ZOHO_API[cfg.data_center] || ZOHO_API.IN;
  const ZOHO_TIMEOUT_MS = 20000;

  // Ensure token is fresh before starting requests. Single-flight so that if
  // the very first batch's concurrent callZoho() calls also see the token as
  // expiring, they join this same refresh instead of each starting their
  // own race against Zoho's OAuth endpoint — see
  // refreshZohoTokenSingleFlight's doc comment for the full root cause.
  if (new Date(cfg.token_expiry) <= new Date(Date.now() + 30000)) {
    await refreshZohoTokenSingleFlight(cfg).catch(() => {});
  }

  // 1. Fetch Chart of Accounts
  const coaMap = new Map<string, { account_type: string; account_code?: string }>();
  let coaError: string | null = null;
  let coaTruncated = false;
  try {
    // Every page: this used to be ONE unpaged request, which Zoho answers with
    // the first 200 accounts — Real Variable's chart has 299+.
    const coaPages = await fetchAllPages<Record<string, unknown>>(async (page) => {
      const res = await callZoho(companyId, (token) => axios.get(`${apiBase}/chartofaccounts`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: orgId, per_page: 200, page },
        timeout: ZOHO_TIMEOUT_MS,
      }));
      const items = res.data?.chartofaccounts || res.data?.accounts || [];
      return { items: Array.isArray(items) ? items as Record<string, unknown>[] : [], hasMore: Boolean(res.data?.page_context?.has_more_page) };
    });
    coaTruncated = coaPages.truncated;
    const accounts = coaPages.items;
    accounts.forEach((acct: Record<string, unknown>) => {
      const n = String(acct.account_name || acct.name || '').toLowerCase().trim();
      const t = String(acct.account_type || acct.type || '').toLowerCase().trim();
      const c = String(acct.account_code || acct.code || '').trim();
      if (n) coaMap.set(n, { account_type: t, account_code: c });
    });
  } catch (e) {
    coaError = (e as Error).message;
    console.warn('COA fetch failed:', (e as Error).message);
  }

  // 2. Fetch monthly Income/Expense movement from the P&L report and
  //    point-in-time Asset/Liability/Equity balances from the Balance Sheet
  //    report — NOT the single /reports/trialbalance endpoint, which turned
  //    out to silently ignore from_date/to_date entirely for this
  //    integration (confirmed empirically: a request for 2000-01-01 returns
  //    the exact same totals as one for 2026-03-31). /reports/profitandloss
  //    and /reports/balancesheet are Zoho's documented reports and both
  //    correctly vary by date — confirmed empirically the same way.
  //
  //    P&L leaves carry a `total` that IS already the period's movement,
  //    signed positive-when-normal (Cr for income, Dr for expense) — used
  //    directly, no differencing needed.
  //    Balance Sheet leaves carry a CUMULATIVE balance as of `to_date`,
  //    signed positive-when-normal for that leaf's structural half of the
  //    report (Dr under "Assets", Cr under "Liabilities & Equities") — each
  //    month's movement is the difference between consecutive snapshots,
  //    with one extra "Opening" snapshot as of the day before the FY starts
  //    supplying real opening balances (previously always defaulted to 0).
  //    Batched in groups of 5 (BATCH_SIZE below) to stay within Zoho's API rate limits (Code 43).
  interface ReportFetchResult {
    kind: 'pl' | 'bs' | 'cust' | 'bill' | 'exp';
    key: number; // pl/cust/bill/exp: 0-11 month index. bs: -1 = Opening, 0-11 = month-end index.
    label: string;
    error: string | null;
    to_date: string;
    fromDate?: string;
    rawResponse?: unknown;
    fetchedAt?: string;
  }

  const openingToDate = dayBeforeISO(fy.start_date);

  /** Calendar year and last day of FY month `m` (e.g. Feb 2028 → 2028-02-29, not the old fixed 02-28). */
  const fyMonthYear = (m: (typeof FY_MONTHS_DR)[number]) => (m.next_yr ? startYear + 1 : startYear);
  const fyMonthEnd = (m: (typeof FY_MONTHS_DR)[number]) => monthEndISO(fyMonthYear(m), parseInt(m.from_suffix.slice(0, 2), 10));

  const lastMonth = FY_MONTHS_DR[FY_MONTHS_DR.length - 1];
  const fyEndDate = fyMonthEnd(lastMonth);

  // Launch full-year Vendor Bills and Expenses fetches in parallel with monthly financial reports
  const fullYearBillsPromise = (async () => {
    try {
      const merged: Record<string, unknown>[] = [];
      let page = 1;
      for (;;) {
        const res = await callZoho(companyId, (token) => axios.get(`${apiBase}/bills`, {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          params: { organization_id: orgId, date_start: fy.start_date, date_end: fyEndDate, per_page: 200, page },
          timeout: ZOHO_TIMEOUT_MS,
        }), 2, cfg);
        const pageItems = Array.isArray(res.data?.bills) ? res.data.bills as Record<string, unknown>[] : [];
        merged.push(...pageItems);
        if (!res.data?.page_context?.has_more_page) break;
        page++;
      }
      return { bills: merged, error: null };
    } catch (e) {
      const err = e as Error;
      console.warn('Vendor Bills full-year fetch failed:', err.message);
      return { bills: [], error: err.message };
    }
  })();

  const fullYearExpensesPromise = (async () => {
    try {
      const merged: Record<string, unknown>[] = [];
      let page = 1;
      for (;;) {
        const res = await callZoho(companyId, (token) => axios.get(`${apiBase}/expenses`, {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          params: { organization_id: orgId, date_start: fy.start_date, date_end: fyEndDate, per_page: 200, page },
          timeout: ZOHO_TIMEOUT_MS,
        }), 2, cfg);
        const pageItems = Array.isArray(res.data?.expenses) ? res.data.expenses as Record<string, unknown>[] : [];
        merged.push(...pageItems);
        if (!res.data?.page_context?.has_more_page) break;
        page++;
      }
      return { expenses: merged, error: null };
    } catch (e) {
      const err = e as Error;
      console.warn('Expenses full-year fetch failed:', err.message);
      return { expenses: [], error: err.message };
    }
  })();

  type FetchDef = { kind: 'pl' | 'bs' | 'cust'; key: number; label: string; from_date?: string; to_date: string };
  const fetchDefs: FetchDef[] = [
    { kind: 'bs', key: -1, label: 'Opening', to_date: openingToDate },
    ...FY_MONTHS_DR.map((m, mi) => (
      { kind: 'pl' as const, key: mi, label: m.name, from_date: `${fyMonthYear(m)}-${m.from_suffix}`, to_date: fyMonthEnd(m) }
    )),
    ...FY_MONTHS_DR.map((m, mi) => (
      { kind: 'bs' as const, key: mi, label: m.name, to_date: fyMonthEnd(m) }
    )),
    ...FY_MONTHS_DR.map((m, mi) => (
      { kind: 'cust' as const, key: mi, label: m.name, from_date: `${fyMonthYear(m)}-${m.from_suffix}`, to_date: fyMonthEnd(m) }
    )),
  ];

  const fetchResults: ReportFetchResult[] = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < fetchDefs.length; i += BATCH_SIZE) {
    const batch = fetchDefs.slice(i, i + BATCH_SIZE).map((def) => {
      return (async (): Promise<ReportFetchResult> => {
        const endpoint = def.kind === 'pl' ? 'profitandloss' : def.kind === 'cust' ? 'salesbycustomer' : 'balancesheet';
        const params: Record<string, string> = def.kind === 'bs'
          ? { organization_id: orgId, to_date: def.to_date }
          : { organization_id: orgId, from_date: def.from_date!, to_date: def.to_date };

        try {
          const res = await callZoho(companyId, (token) => axios.get(`${apiBase}/reports/${endpoint}`, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            params,
            timeout: ZOHO_TIMEOUT_MS,
          }), 2, cfg);

          return {
            kind: def.kind,
            key: def.key,
            label: def.label,
            error: null,
            to_date: def.to_date,
            fromDate: def.from_date,
            rawResponse: res.data,
            fetchedAt: new Date().toISOString(),
          };
        } catch (e) {
          const err = e as Error & { status?: number };
          const kindLabel = def.kind === 'pl' ? 'P&L' : def.kind === 'cust' ? 'Sales by Customer' : 'Balance Sheet';
          console.warn(`${kindLabel} ${def.label} fetch failed:`, err.message);
          return {
            kind: def.kind,
            key: def.key,
            label: def.label,
            error: `${def.label}: ${err.message}`,
            to_date: def.to_date,
            fromDate: def.from_date,
            rawResponse: null,
            fetchedAt: new Date().toISOString(),
          };
        }
      })();
    });

    const res = await Promise.all(batch);
    fetchResults.push(...res);

    if (i + BATCH_SIZE < fetchDefs.length) {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }

  const [fullYearBillsRes, fullYearExpensesRes] = await Promise.all([fullYearBillsPromise, fullYearExpensesPromise]);

  const plResults = fetchResults.filter(r => r.kind === 'pl').sort((a, b) => a.key - b.key);
  const bsResults = fetchResults.filter(r => r.kind === 'bs').sort((a, b) => a.key - b.key);
  const custResults = fetchResults.filter(r => r.kind === 'cust').sort((a, b) => a.key - b.key);

  const openingResult = bsResults.find(r => r.key === -1);
  const bsMonthResults = bsResults.filter(r => r.key >= 0);

  const monthErrors: string[] = [];
  if (openingResult?.error) monthErrors.push(`Opening balance: ${openingResult.error} (opening balances defaulted to 0)`);

  const rawZohoMonths: Array<{
    month: string; from_date: string; to_date: string; fetched_at: string; raw_response: unknown;
  }> = fetchResults
    .filter(r => !r.error && r.rawResponse)
    .map(r => ({
      month: `${{ pl: 'P&L', cust: 'Sales by Customer', bs: 'BS', bill: 'Vendor Bills', exp: 'Expenses' }[r.kind]} ${r.label}`,
      from_date: r.fromDate || r.to_date,
      to_date: r.to_date,
      fetched_at: r.fetchedAt || new Date().toISOString(),
      raw_response: r.rawResponse,
    }));

  // ── Customers, vendors and customer-tagged cost — pure, see ./people.ts ──
  // Customer amounts are ALREADY in the base currency whatever the customer's
  // own currency is (proved against Zoho's invoices — people.ts explains); they
  // used to be skipped when the currency differed, dropping the largest customer.
  const customerAgg = aggregateSalesByCustomer(custResults, baseCurrency);
  const customerRevMap = customerAgg.rows;
  if (customerAgg.otherCurrency.length > 0) {
    console.log(`Sales by Customer: ${customerAgg.otherCurrency.length} customer(s) invoice in another currency (${customerAgg.otherCurrency.join(', ')}); their amounts are already in ${baseCurrency} and are included.`);
  }
  if (customerRevMap.size === 0) {
    console.warn(
      customerAgg.fetchErrors === custResults.length
        ? `Sales by Customer: all ${custResults.length} month(s) failed — Top Customers will show "not available" for this sync.`
        : 'Sales by Customer: report returned no customer rows for this period.'
    );
  }

  // Vendor bills (processed from the full-year single fetch).
  const vendorAgg = aggregateVendorBills(fullYearBillsRes.error ? [] : fullYearBillsRes.bills, fy.start_date, baseCurrency);
  const vendorExpenseMap = vendorAgg.rows;
  if (vendorAgg.skippedForeign > 0) {
    console.warn(`Vendor Bills: left out ${vendorAgg.skippedForeign} bill(s) in a currency other than ${baseCurrency} that carried no base-currency amount. Affected: ${vendorAgg.skippedNames.join(', ')}`);
  }
  if (vendorExpenseMap.size === 0) {
    console.warn(
      fullYearBillsRes.error
        ? `Vendor Bills: fetch failed — Vendor Expense Report will show "not available" for this sync.`
        : 'Vendor Bills: no bills found for this period.'
    );
  }

  // Customer-tagged direct cost (processed from the full-year single fetch).
  const customerCostMap = aggregateCustomerCost(fullYearExpensesRes.error ? [] : fullYearExpensesRes.expenses, fy.start_date);
  if (customerCostMap.size === 0) {
    console.warn(
      fullYearExpensesRes.error
        ? `Expenses: fetch failed — Customer Margin Report will show direct cost as unavailable for this sync.`
        : 'Expenses: no expense was billable-and-customer-tagged for this period — this Zoho org does not appear to track direct per-customer cost. Customer Margin Report will show real revenue with direct cost disclosed as "not tracked", not a fabricated figure.'
    );
  }

  // Anything non-fatal that limits this sync, in plain words (stored on the
  // sync log and returned as `warning`): before, a failed bills fetch left the
  // Vendor Expense report silently empty.
  const syncNotes = buildSyncNotes({
    coaTruncated, coaError,
    customers: { fetchErrors: customerAgg.fetchErrors, totalMonths: custResults.length, count: customerRevMap.size },
    bills: { error: fullYearBillsRes.error, agg: vendorAgg },
    expensesError: fullYearExpensesRes.error,
  });
  const syncWarning = syncNotes.length ? syncNotes.join(' | ') : null;

  const { ledgerMap, errors: assemblyErrors } = assembleZohoLedgers({
    pl: plResults, openingBs: openingResult, monthBs: bsMonthResults,
  });
  monthErrors.push(...assemblyErrors);

  if (Object.keys(ledgerMap).length === 0) {
    // syncFromZoho() records this on zoho_config and sync_logs.
    const reason = monthErrors[0] || coaError || 'Zoho returned no trial balance data for this period';
    throw new Error(`Zoho sync failed: ${reason}`);
  }

  // Never write a partial trial balance. A P&L or Balance Sheet report that
  // failed (rate limit, timeout) leaves that month's figures missing — a
  // missing month-end snapshot even turns into a fake movement — and this
  // used to REPLACE the good current data anyway (status 'error', batch
  // written). Now the current data is kept and the next sync retries.
  // (Sales-by-customer, bills and expenses stay non-fatal, as before.)
  if (monthErrors.length) {
    throw new Error(
      `Zoho sync incomplete — ${monthErrors.length} report(s) failed (${monthErrors.slice(0, 3).join('; ')}${monthErrors.length > 3 ? '; …' : ''}). ` +
      `The previous data was kept; the next sync will retry.`
    );
  }

  // Global rows first, company rows last — the maps below keep the LAST row
  // per key, so the company's own mapping (e.g. a reclassification) wins.
  // There was no ORDER BY at all, so which of a duplicated mapping won
  // depended on physical row order.
  const { rows: lmRows } = await query<LedgerMasterMapping>(
    `SELECT * FROM ledger_master WHERE (company_id=$1 OR company_id IS NULL) AND is_active=TRUE
     ORDER BY company_id NULLS FIRST, ledger_code, id`,
    [companyId]
  );

  const tbRows = Object.values(ledgerMap);
  // Mapping (ledger_master, else the classifier) is pure — see ./map.ts.
  const { ledgers, mapped, autoMappings } = mapZohoLedgers(ledgerMap, lmRows, coaMap);

  // Lock, year lock, ownership re-check, supersede, write — the shared
  // pipeline every source uses (lib/ingestion/trial-balance.ts).
  const { uploadId, summary, status: ingestStatus } = await ingestTrialBalance({
    companyId,
    fyId,
    source: 'zoho',
    uploadedBy: triggeredBy,
    options,
    ledgers,
    customerRevenue: Array.from(customerRevMap.values()).map((c) => ({ externalId: c.id || null, name: c.name, m: c.m })),
    vendorExpense: Array.from(vendorExpenseMap.values()).map((v) => ({ externalId: v.id ?? null, name: v.name, m: v.m })),
    customerCost: Array.from(customerCostMap.values()).map((c) => ({ externalId: c.id ?? null, name: c.name, m: c.m })),
    batch: {
      currency: baseCurrency, mappedCount: mapped, hasMonthlyCols: true,
      rawPayloads: [
        ...rawZohoMonths.map((r) => ({ label: r.month, periodFrom: r.from_date, periodTo: r.to_date, fetchedAt: r.fetched_at, payload: r.raw_response })),
        // The year's bills and expenses as Zoho returned them (stored once, deduplicated).
        // They were not kept before, so a vendor report that came out empty could not be explained afterwards.
        ...(fullYearBillsRes.error ? [] : [{ label: 'Vendor Bills', periodFrom: fy.start_date, periodTo: fyEndDate, fetchedAt: new Date().toISOString(), payload: { bills: fullYearBillsRes.bills } }]),
        ...(fullYearExpensesRes.error ? [] : [{ label: 'Expenses', periodFrom: fy.start_date, periodTo: fyEndDate, fetchedAt: new Date().toISOString(), payload: { expenses: fullYearExpensesRes.expenses } }]),
      ],
    },
    inTransaction: async (client) => {
      for (const lm of autoMappings) {
        await client.query(
          `INSERT INTO ledger_master
            (company_id, ledger_code, ledger_name, note_no, note_name, section, treasury_type, normal_bal, is_global)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE)
           ON CONFLICT DO NOTHING`,
          [companyId, lm.ledger_code, lm.ledger_name, lm.note_no, lm.note_name, sanitizeSection(lm.section) || 'ac', sanitizeTreasuryType(lm.treasury_type), lm.normal_bal]
        );
      }
    },
  });

  const duration = Date.now() - start;
  const unchanged = ingestStatus === 'no_change';

  // last_synced_at advances either way, so the cron's schedule still works.
  await query(
    `UPDATE zoho_config SET last_synced_at=NOW(),last_sync_status='success',last_sync_error=NULL,
      synced_ledgers=$1, updated_at=NOW() WHERE company_id=$2`,
    [tbRows.length, companyId]
  );
  // A success can still carry notes (e.g. bills could not be fetched); they go
  // in error_message, which the Recent Syncs list shows as the row's tooltip.
  await query(
    `UPDATE sync_logs SET status=$1,ledgers_synced=$2,duration_ms=$3,error_message=$5,completed_at=NOW() WHERE id=$4`,
    [unchanged ? 'no_change' : 'success', unchanged ? 0 : tbRows.length, duration, logId, syncWarning]
  );

  // Nothing new was written when unchanged — every cached report is still right.
  if (!unchanged) invalidateReportCache(companyId);

  // Real customer & vendor MASTER data (contact details, live outstanding
  // balances) — independent of the Trial Balance upload above (a contact
  // isn't period-scoped the way a ledger movement is), so a failure here
  // must never fail the main sync — purely logged, matching the same
  // non-fatal convention already used for vendor bills/customer expenses
  // above. See zoho_contacts' own schema comment for why this is upserted
  // in place rather than versioned per upload like everything else here.
  try {
    const contactResult = await syncZohoContacts(companyId);
    if (contactResult.errors.length) {
      console.warn(`Zoho contacts sync: ${contactResult.errors.length} issue(s) — ${contactResult.errors.join('; ')}`);
    } else {
      console.log(`Zoho contacts synced: ${contactResult.synced} (${contactResult.customers} customers, ${contactResult.vendors} vendors)`);
    }
  } catch (e) {
    console.warn('Zoho contacts sync failed (non-fatal):', (e as Error).message);
  }

  return {
    ledgers_synced: tbRows.length, mapped, upload_id: uploadId, duration_ms: duration, warning: syncWarning,
    unchanged, is_balanced: summary.is_balanced, balance_diff: summary.balance_diff,
  };
}
