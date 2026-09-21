import axios from 'axios';
import { query } from '@/lib/db/neon';
import { ApiError } from '@/lib/auth/permissions';
import * as store from '@/lib/db/queries/zoho-records';
import type { ModuleState, StatePatch } from '@/lib/db/queries/zoho-records';
import { upsertListPage, writeDetail, saveSnapshot, type PageResult, type DetailOutcome } from '@/lib/ingestion/zoho-records';
import { upsertBankTransactionsPage } from '@/lib/ingestion/zoho-bank-transactions';
import { ZOHO_API, callZoho, decryptZohoConfig, refreshZohoTokenSingleFlight, type ZohoConfigRow } from './client';
import {
  detailDefault, detailRecord, formatZohoModifiedTime, hasMorePages, listRows, type ExtractCtx, type ModuleDef, type ReportDef,
} from './modules';
import { DAILY_LIMIT_BLOCK_MS, MIN_CALL_GAP_MS, isDailyLimitError, isRateLimitedError } from './budget';
import { blockZohoUntil, flushZohoUsage, getZohoUsage, type ZohoUsage } from './usage';

/**
 * Reads Zoho Books records into the mirror, a slice at a time.
 *
 * A full first read is ~1,000+ calls at <=80 a minute, which cannot fit in one
 * serverless request. A slice does as much as fits in a time box and saves where
 * it got to (per module: the page cursor and the pass start), so the next slice -
 * from the Upload tab or from cron - carries on exactly there. Every step is
 * idempotent, so an interrupted slice costs nothing but the calls it made.
 *
 * Order inside a slice: every module's LIST first (so each has headline data),
 * then the DETAIL reads (line items, GST) module by module.
 */

export const DEFAULT_SLICE_MS = 40_000;
const EST_CALL_MS = 3_000;
const INCREMENTAL_OVERLAP_MS = 5 * 60_000;
const MAX_PAGES = 500;
const DETAIL_BATCH = 25;
export const FULL_SWEEP_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
/** A module that can only be read in full is read by the scheduler at most this often (bank transactions cost ~24 calls). */
export const FULL_ONLY_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** A report period that ended longer ago than this no longer changes, so it is read once. */
const CLOSED_PERIOD_DAYS = 45;

export interface RecordStore {
  ensureStates(companyId: string, keys: string[]): Promise<void>;
  loadStates(companyId: string, keys: string[]): Promise<Map<string, ModuleState>>;
  claim(companyId: string, keys: string[]): Promise<string[]>;
  release(companyId: string, keys: string[]): Promise<void>;
  saveState(companyId: string, module: string, patch: StatePatch): Promise<void>;
  upsertPage(input: { companyId: string; def: ModuleDef; rows: Record<string, unknown>[]; ctx: ExtractCtx; parentId?: string | null }): Promise<PageResult>;
  needingDetail(companyId: string, module: string, limit: number): Promise<string[]>;
  writeDetail(input: { companyId: string; def: ModuleDef; zohoId: string; detail: Record<string, unknown>; ctx: ExtractCtx }): Promise<DetailOutcome>;
  markDetailFailure(companyId: string, module: string, zohoId: string, message: string): Promise<void>;
  markDetailGone(companyId: string, module: string, zohoId: string): Promise<void>;
  countSeenSince(companyId: string, module: string, since: Date): Promise<{ seen: number; total: number }>;
  markMissingRemoved(companyId: string, module: string, passStartedAt: Date): Promise<number>;
  detailPending(companyId: string, module: string): Promise<number>;
  /** Ids of the stored, non-removed records of a module (the parents a fan-out module is read for). */
  parentIds(companyId: string, module: string): Promise<string[]>;
  /** The company's financial years, as YYYY-MM-DD text, oldest first. */
  financialYears(companyId: string): Promise<Array<{ label: string; start: string; end: string }>>;
  /** When (ms) the newest snapshot of this report and period was last seen, or null when there is none. */
  snapshotSeen(companyId: string, report: string, periodTo: string): Promise<number | null>;
  saveSnapshot(input: { companyId: string; report: string; periodFrom: string | null; periodTo: string; payload: unknown }): Promise<'created' | 'unchanged'>;
}

export const pgStore: RecordStore = {
  ensureStates: store.ensureStates,
  loadStates: store.loadStates,
  claim: store.claimModules,
  release: store.releaseModules,
  saveState: store.saveState,
  // Bank transactions have their own partitioned table (migration 0009); every other module is a zoho_records row.
  upsertPage: (i) => (i.def.store === 'bank_transactions' ? upsertBankTransactionsPage(i) : upsertListPage(i)),
  needingDetail: store.needingDetail,
  writeDetail: (i) => writeDetail(i),
  markDetailFailure: store.markDetailFailure,
  markDetailGone: store.markDetailGone,
  countSeenSince: store.countSeenSince,
  markMissingRemoved: store.markMissingRemoved,
  detailPending: store.countDetailPending,
  parentIds: store.parentIds,
  financialYears: store.financialYears,
  snapshotSeen: store.snapshotSeen,
  saveSnapshot: (i) => saveSnapshot(i),
};

export interface SyncDeps {
  store: RecordStore;
  /** One GET against Zoho Books; resolves to the response body. */
  http: (path: string, params: Record<string, unknown>) => Promise<unknown>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  usage: { get(): Promise<ZohoUsage>; flush(): Promise<void>; block(until: Date): Promise<void> };
}

export interface SliceInput {
  companyId: string;
  modules: ModuleDef[];
  mode: 'incremental' | 'full';
  baseCurrency: string;
  sliceMs?: number;
  /** Set by the first slice of a run and passed back on the following ones, so a module read in this run is not read again. */
  runStartedAt?: string;
  /** Modules whose optional detail read (e.g. expense GST lines) is switched on. */
  enableDetail?: string[];
  /** Zoho reports to keep as dated snapshots (tax summary, ageing ...). */
  reports?: ReportDef[];
  /** Started by the scheduler: complete-listing-only modules are then read at most once a day. */
  scheduled?: boolean;
}

export type StopReason = 'complete' | 'time' | 'daily_budget' | 'daily_limit' | 'rate_limited' | 'auth';

export interface ModuleProgress {
  module: string;
  label: string;
  listing: 'idle' | 'partial' | 'complete' | 'error' | 'busy';
  pass: 'full' | 'incremental' | null;
  received: number; created: number; updated: number; unchanged: number; skipped: number; removed: number;
  detailFetched: number; detailFailed: number; detailPending: number;
  error: string | null;
}

export interface SliceResult {
  done: boolean;
  stopped: StopReason;
  callsMade: number;
  runStartedAt: string;
  modules: ModuleProgress[];
  errors: string[];
  usage: { used: number; moduleCap: number; dailyLimit: number; blockedUntil: string | null };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (v: string | null | undefined) => (v ? Date.parse(v) : NaN);

function looksLikeAuthFailure(e: unknown): boolean {
  const s = (e as { status?: number } | null)?.status;
  return s === 401 || /re-authentication failed|not connected|refresh token is no longer valid/i.test(errText(e));
}

export async function runSlice(input: SliceInput, deps: SyncDeps): Promise<SliceResult> {
  const { companyId, modules, mode } = input;
  const st = deps.store;
  const t0 = deps.now();
  const deadline = t0 + (input.sliceMs ?? DEFAULT_SLICE_MS);
  const runStartedAt = input.runStartedAt ? Date.parse(input.runStartedAt) : t0;
  const reports = input.reports ?? [];
  const reportKey = (r: ReportDef) => `report:${r.key}`;
  const keys = [...modules.map((m) => m.key), ...reports.map(reportKey)];
  const ctx: ExtractCtx = { baseCurrency: input.baseCurrency };

  const blankProgress = (module: string, label: string): ModuleProgress => ({
    module, label, listing: 'idle', pass: null,
    received: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, removed: 0,
    detailFetched: 0, detailFailed: 0, detailPending: 0, error: null,
  });
  const progress = new Map<string, ModuleProgress>([
    ...modules.map((m): [string, ModuleProgress] => [m.key, blankProgress(m.key, m.label)]),
    ...reports.map((r): [string, ModuleProgress] => [reportKey(r), blankProgress(reportKey(r), `Report: ${r.label}`)]),
  ]);
  const errors: string[] = [];
  const flow: { stopped: StopReason | null; made: number; lastCallAt: number } = { stopped: null, made: 0, lastCallAt: 0 };

  await st.ensureStates(companyId, keys);
  const claimed = await st.claim(companyId, keys);
  const claimedSet = new Set(claimed);
  for (const k of keys) if (!claimedSet.has(k)) progress.get(k)!.listing = 'busy';

  const usage = await deps.usage.get();
  let blockedUntil = usage.blockedUntil;

  /** false = the slice must stop (time, budget or Zoho's own limit); waits out the pacing gap otherwise. */
  const beforeCall = async (): Promise<boolean> => {
    if (flow.stopped) return false;
    if (usage.used + flow.made >= usage.moduleCap) { flow.stopped = 'daily_budget'; return false; }
    const wait = flow.lastCallAt ? flow.lastCallAt + MIN_CALL_GAP_MS - deps.now() : 0;
    if (deps.now() + Math.max(wait, 0) + EST_CALL_MS >= deadline) { flow.stopped = 'time'; return false; }
    if (wait > 0) await deps.sleep(wait);
    return true;
  };

  const call = async (path: string, params: Record<string, unknown>) => {
    flow.lastCallAt = deps.now();
    flow.made++;
    return deps.http(path, params);
  };

  /** 'stop' ends the slice (Zoho's limits, a dead connection); 'continue' is a problem with one module or record only. */
  const onCallError = async (e: unknown): Promise<'stop' | 'continue'> => {
    if (isDailyLimitError(e)) {
      const until = new Date(deps.now() + DAILY_LIMIT_BLOCK_MS);
      blockedUntil = until.toISOString();
      await deps.usage.block(until).catch(() => {});
      flow.stopped = 'daily_limit';
      errors.push('Zoho says the daily API limit is used up - reading resumes automatically in about an hour');
      return 'stop';
    }
    if (isRateLimitedError(e)) { flow.stopped = 'rate_limited'; return 'stop'; }
    if (looksLikeAuthFailure(e)) { flow.stopped = 'auth'; errors.push(errText(e)); return 'stop'; }
    return 'continue';
  };

  const listModule = async (def: ModuleDef, state: ModuleState, prog: ModuleProgress): Promise<void> => {
    // A module that failed in this run is left alone until the next run - whether or not a pass is open -
    // so a rejecting endpoint is asked once, not on every slice.
    if (state.last_error_at && ms(state.last_error_at) >= runStartedAt) { prog.listing = 'error'; prog.error = state.last_error; return; }
    if (!state.pass_kind) {
      const doneAt = Math.max(ms(state.last_full_at) || 0, ms(state.last_incremental_at) || 0);
      if (doneAt && doneAt >= runStartedAt) { prog.listing = 'complete'; return; }
      if (input.scheduled && !def.incremental && doneAt && deps.now() - doneAt < FULL_ONLY_MIN_AGE_MS) { prog.listing = 'complete'; return; }
      // A full listing every so often even when reads are incremental: it is the only way to notice records removed in Zoho.
      const sweepDue = state.last_full_at !== null && deps.now() - ms(state.last_full_at) > FULL_SWEEP_EVERY_MS;
      const kind = mode === 'full' || !state.last_full_at || !def.incremental || !state.incremental_cursor || sweepDue ? 'full' : 'incremental';
      state = { ...state, pass_kind: kind, pass_started_at: iso(deps.now()), page_cursor: 1, sub_cursor: null };
      await st.saveState(companyId, def.key, { pass_kind: kind, pass_started_at: state.pass_started_at, page_cursor: 1, sub_cursor: null });
    }
    prog.pass = state.pass_kind;
    const passStart = new Date(state.pass_started_at ?? deps.now());
    let page = state.page_cursor ?? 1;

    // A fan-out module (bank transactions) is read once per parent record (per bank account), in a fixed order.
    let parents: string[] | null = null;
    let parentIdx = 0;
    if (def.fanOut) {
      parents = await st.parentIds(companyId, def.fanOut.parentModule);
      if (!parents.length) {
        const msg = `${def.label}: no ${def.fanOut.parentModule} have been read yet - read them first`;
        errors.push(msg); prog.listing = 'error'; prog.error = msg;
        return;
      }
      parentIdx = Math.max(0, state.sub_cursor ? parents.indexOf(state.sub_cursor) : 0);
    }

    for (;;) {
      if (page > MAX_PAGES) {
        const msg = `${def.label}: stopped after ${MAX_PAGES} pages`;
        errors.push(msg); prog.listing = 'error'; prog.error = msg;
        await st.saveState(companyId, def.key, { last_error: msg, last_error_at: iso(deps.now()) });
        return;
      }
      if (!(await beforeCall())) { prog.listing = 'partial'; return; }

      const params: Record<string, unknown> = { per_page: 200, page };
      if (def.fanOut && parents) params[def.fanOut.param] = parents[parentIdx];
      if (state.pass_kind === 'incremental' && state.incremental_cursor) {
        params.last_modified_time = formatZohoModifiedTime(new Date(ms(state.incremental_cursor) - INCREMENTAL_OVERLAP_MS));
      }
      let data: unknown;
      try {
        data = await call(def.path, params);
      } catch (e) {
        if ((await onCallError(e)) === 'stop') { prog.listing = 'partial'; return; }
        const msg = errText(e);
        errors.push(`${def.label}: ${msg}`);
        prog.listing = 'error'; prog.error = msg;
        // The pass and its page cursor are kept, so the next run picks up where this one failed.
        await st.saveState(companyId, def.key, { last_error: msg.slice(0, 500), last_error_at: iso(deps.now()) });
        return;
      }

      const r = await st.upsertPage({ companyId, def, rows: listRows(def, data), ctx, parentId: parents ? parents[parentIdx] : null });
      prog.received += r.received; prog.created += r.created; prog.updated += r.updated; prog.unchanged += r.unchanged; prog.skipped += r.skipped;

      if (hasMorePages(data)) {
        page++;
        await st.saveState(companyId, def.key, { page_cursor: page });
        continue;
      }
      if (parents && parentIdx + 1 < parents.length) {
        parentIdx++;
        page = 1;
        await st.saveState(companyId, def.key, { page_cursor: 1, sub_cursor: parents[parentIdx] });
        continue;
      }

      // The listing is complete. After a FULL listing, whatever Zoho no longer lists is flagged as removed.
      if (state.pass_kind === 'full') {
        const { seen, total } = await st.countSeenSince(companyId, def.key, passStart);
        if (seen === 0 && total > 0) {
          errors.push(`${def.label}: Zoho listed no records although ${total} are stored - nothing was flagged as removed`);
        } else {
          prog.removed = await st.markMissingRemoved(companyId, def.key, passStart);
        }
      }
      const at = passStart.toISOString();
      await st.saveState(companyId, def.key, {
        pass_kind: null, page_cursor: null, sub_cursor: null, incremental_cursor: at,
        ...(state.pass_kind === 'full' ? { last_full_at: at } : { last_incremental_at: at }),
        last_error: null, last_error_at: null,
      });
      prog.listing = 'complete';
      return;
    }
  };

  const detailModule = async (def: ModuleDef, prog: ModuleProgress): Promise<void> => {
    // One attempt per record per slice: a record that failed is retried in a later slice, not straight away.
    const tried = new Set<string>();
    for (;;) {
      const ids = (await st.needingDetail(companyId, def.key, DETAIL_BATCH + tried.size)).filter((id) => !tried.has(id));
      if (!ids.length) return;
      for (const id of ids) {
        if (!(await beforeCall())) return;
        tried.add(id);
        try {
          const data = await call(`${def.path}/${encodeURIComponent(id)}`, {});
          const detail = detailRecord(def, data);
          if (!detail) {
            await st.markDetailFailure(companyId, def.key, id, 'Zoho returned no record for this id');
            prog.detailFailed++;
            continue;
          }
          await st.writeDetail({ companyId, def, zohoId: id, detail, ctx });
          prog.detailFetched++;
        } catch (e) {
          if ((e as { status?: number }).status === 404) { await st.markDetailGone(companyId, def.key, id); continue; }
          if ((await onCallError(e)) === 'stop') return;
          await st.markDetailFailure(companyId, def.key, id, errText(e));
          prog.detailFailed++;
        }
      }
    }
  };

  /**
   * Zoho's own report totals for each financial year, kept as dated snapshots so the records can be reconciled
   * against them. A period that ended long ago is read once; the current one again whenever a run is due.
   */
  const reportsPhase = async (states: Map<string, ModuleState>): Promise<void> => {
    if (!reports.length) return;
    const years = await st.financialYears(companyId);
    const today = new Date(deps.now()).toISOString().slice(0, 10);
    const closedBefore = new Date(deps.now() - CLOSED_PERIOD_DAYS * 86_400_000).toISOString().slice(0, 10);
    for (const rep of reports) {
      const key = reportKey(rep);
      if (!claimedSet.has(key) || flow.stopped) continue;
      const prog = progress.get(key)!;
      const state = states.get(key);
      if (state?.last_error_at && ms(state.last_error_at) >= runStartedAt) { prog.listing = 'error'; prog.error = state.last_error; continue; }
      let open = false;
      // One period per financial year (to its end, or to today for the running one). An "as at" report (ageing) is
      // also read as at TODAY when no financial year covers today: it is the figure people ask for, and the last
      // year's end is months old once that year is over.
      const periods = years.map((fy) => ({ start: fy.start, to: fy.end < today ? fy.end : today })).filter((p) => p.to >= p.start);
      if (rep.period === 'asof' && !periods.some((p) => p.to === today)) periods.push({ start: today, to: today });
      for (const fy of periods) {
        const to = fy.to;
        const seen = await st.snapshotSeen(companyId, rep.key, to);
        const fresh = seen !== null && (seen >= runStartedAt || (to < closedBefore && mode !== 'full'));
        if (fresh) continue;
        if (!(await beforeCall())) { open = true; break; }
        try {
          const data = await call(rep.path, rep.period === 'fy' ? { from_date: fy.start, to_date: to } : { to_date: to });
          const saved = await st.saveSnapshot({ companyId, report: rep.key, periodFrom: rep.period === 'fy' ? fy.start : null, periodTo: to, payload: data });
          prog.received++;
          if (saved === 'created') prog.created++; else prog.unchanged++;
        } catch (e) {
          if ((await onCallError(e)) === 'stop') { open = true; break; }
          const msg = errText(e);
          errors.push(`${prog.label}: ${msg}`);
          prog.error = msg;
          await st.saveState(companyId, key, { last_error: msg.slice(0, 500), last_error_at: iso(deps.now()) });
          break;
        }
      }
      if (open) { prog.listing = 'partial'; continue; }
      if (prog.error) { prog.listing = 'error'; continue; }
      await st.saveState(companyId, key, { last_full_at: iso(deps.now()), last_error: null, last_error_at: null });
      prog.listing = 'complete';
    }
  };

  try {
    if (blockedUntil && Date.parse(blockedUntil) > deps.now()) {
      flow.stopped = 'daily_limit';
      errors.push(`Zoho's daily API limit was reached earlier - reading resumes after ${blockedUntil}`);
    } else {
      for (const key of input.enableDetail ?? []) {
        const def = modules.find((m) => m.key === key);
        if (def && def.detail === 'optional' && claimedSet.has(key)) await st.saveState(companyId, key, { detail_enabled: true });
      }
      const states = await st.loadStates(companyId, claimed);

      for (const def of modules) {
        if (!claimedSet.has(def.key) || flow.stopped) continue;
        await listModule(def, states.get(def.key)!, progress.get(def.key)!);
      }
      for (const def of modules) {
        if (!claimedSet.has(def.key) || flow.stopped) continue;
        const enabled = states.get(def.key)?.detail_enabled ?? detailDefault(def);
        if (def.detail !== 'none' && enabled) await detailModule(def, progress.get(def.key)!);
      }
      await reportsPhase(states);
    }
  } finally {
    // Never leave a claim behind, and record the calls made even when the slice failed.
    await st.release(companyId, claimed).catch(() => {});
    await deps.usage.flush().catch(() => {});
  }

  const stillPending = await Promise.all(claimed.map(async (k) => {
    const def = modules.find((m) => m.key === k);
    const p = progress.get(k)!;
    p.detailPending = !def || def.detail === 'none' ? 0 : await st.detailPending(companyId, k);
    return p;
  }));
  const anyBusy = keys.some((k) => !claimedSet.has(k));
  const stopped: StopReason = flow.stopped ?? 'complete';
  const listingOpen = stillPending.some((p) => p.listing === 'partial');
  return {
    done: stopped === 'complete' && !anyBusy && !listingOpen,
    stopped,
    callsMade: flow.made,
    runStartedAt: iso(runStartedAt),
    modules: [...progress.values()],
    errors,
    usage: { used: usage.used + flow.made, moduleCap: usage.moduleCap, dailyLimit: usage.dailyLimit, blockedUntil },
  };
}

// ── Wiring to the real Zoho connection ────────────────────────────────────

export interface ZohoSession {
  http: SyncDeps['http'];
  baseCurrency: string;
}

/** The connection a read uses. Throws a clear 409 when Zoho is not connected. */
export async function openZohoSession(companyId: string): Promise<ZohoSession> {
  const { rows } = await query<ZohoConfigRow>(
    `SELECT * FROM zoho_config WHERE company_id=$1 AND is_active=TRUE AND refresh_token IS NOT NULL`, [companyId]);
  if (!rows.length) throw new ApiError(409, 'Zoho Books is not connected. Connect it first.', 'ZOHO_NOT_CONNECTED');
  const cfg = decryptZohoConfig(rows[0]!);
  if (!cfg.org_id) throw new ApiError(409, 'Zoho Organisation ID is not set.', 'ZOHO_NO_ORG');
  const orgId = cfg.org_id;
  const apiBase = ZOHO_API[cfg.data_center] || ZOHO_API.IN;

  if (new Date(cfg.token_expiry) <= new Date(Date.now() + 30_000)) {
    await refreshZohoTokenSingleFlight(cfg).catch(() => {});
  }
  const { rows: co } = await query<{ currency: string }>(`SELECT currency FROM companies WHERE id=$1`, [companyId]);
  return {
    baseCurrency: (co[0]?.currency || 'INR').toUpperCase(),
    http: async (path, params) => {
      const res = await callZoho(companyId, (token) => axios.get(`${apiBase}${path}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: orgId, ...params },
        timeout: 20_000,
      }), 2, cfg);
      return res.data;
    },
  };
}

export function realDeps(companyId: string, session: ZohoSession): SyncDeps {
  return {
    store: pgStore,
    http: session.http,
    now: () => Date.now(),
    sleep: (n) => new Promise((r) => setTimeout(r, n)),
    usage: { get: () => getZohoUsage(companyId), flush: () => flushZohoUsage(companyId), block: (until) => blockZohoUntil(companyId, until) },
  };
}

/** One time-boxed slice against the real Zoho connection and database. */
export async function runModuleSlice(
  companyId: string,
  opts: { modules: ModuleDef[]; mode: 'incremental' | 'full'; runStartedAt?: string; enableDetail?: string[]; sliceMs?: number; reports?: ReportDef[]; scheduled?: boolean },
): Promise<SliceResult> {
  const session = await openZohoSession(companyId);
  const envSlice = Number(process.env.ZOHO_SLICE_MS);
  return runSlice({
    companyId, baseCurrency: session.baseCurrency, modules: opts.modules, mode: opts.mode,
    runStartedAt: opts.runStartedAt, enableDetail: opts.enableDetail, reports: opts.reports, scheduled: opts.scheduled,
    sliceMs: opts.sliceMs ?? (Number.isFinite(envSlice) && envSlice > 0 ? envSlice : DEFAULT_SLICE_MS),
  }, realDeps(companyId, session));
}
