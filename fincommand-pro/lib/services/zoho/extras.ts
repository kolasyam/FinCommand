import { createHash } from 'crypto';
import { MIN_CALL_GAP_MS, isDailyLimitError, isRateLimitedError } from './budget';
import type { ZohoUsage } from './usage';

/**
 * Reads what Zoho keeps ABOUT its records, after the records themselves are read:
 *
 *   comments     GET /{module}/{id}/comments     who did what to a record, and when
 *   attachments  GET /{module}/{id}/attachment   the files (invoice PDFs, bill scans); expenses use /receipt
 *   statements   GET /bankaccounts/{id}/statement/lastimported   the last imported bank statement per account
 *
 * Each costs one Zoho call per record, so it runs in small, budgeted slices, only on spare daily allowance, and
 * resumes where it stopped. A failing record or module never stops the others: an endpoint Zoho does not offer
 * for a module is dropped for the slice after a few misses. Pure orchestration - the database and Zoho are
 * injected, so it is unit-tested with fakes.
 */

export const COMMENT_MODULES = ['invoices', 'bills', 'expenses', 'vendorpayments', 'customerpayments', 'creditnotes', 'purchaseorders', 'journals'] as const;
/** Modules whose records can carry a file, and the path of that file under the record. */
export const ATTACHMENT_PATHS: Record<string, string> = { invoices: 'attachment', bills: 'attachment', expenses: 'receipt', creditnotes: 'attachment' };
export const MAX_ATTACHMENT_BYTES = (parseInt(process.env.ZOHO_MAX_ATTACHMENT_MB || '', 10) || 15) * 1024 * 1024;
/** A module's endpoint is given up for the slice after this many misses in a row with no success. */
const MODULE_MISS_LIMIT = 3;
const STATEMENT_EVERY_MS = 24 * 60 * 60 * 1000;

export type ExtrasKind = 'comments' | 'attachment';

export interface CommentRow {
  commentId: string; commentedBy: string | null; commentedAt: string | null; commentType: string | null; description: string | null;
  payload: Record<string, unknown>;
}

export type BinaryResponse =
  | { kind: 'file'; bytes: Buffer; contentType: string | null; fileName: string | null }
  | { kind: 'json'; body: unknown };

export interface ExtrasStore {
  /** Zoho ids of records of `module` still to read for `kind` (never read, changed in Zoho since, or failed a few times ago). */
  needing(companyId: string, kind: ExtrasKind, module: string, limit: number): Promise<string[]>;
  saveComments(companyId: string, module: string, zohoId: string, rows: CommentRow[]): Promise<number>;
  saveAttachment(companyId: string, module: string, zohoId: string, file: { sha256: string; fileName: string | null; contentType: string | null; bytes: Buffer }): Promise<'stored' | 'duplicate'>;
  markDone(companyId: string, kind: ExtrasKind, module: string, zohoId: string): Promise<void>;
  markFailure(companyId: string, kind: ExtrasKind, module: string, zohoId: string, message: string): Promise<void>;
  /** Bank accounts whose last statement was read more than `olderThanMs` ago (or never). */
  accountsNeedingStatement(companyId: string, olderThanMs: number): Promise<string[]>;
  saveStatement(companyId: string, accountId: string, payload: unknown): Promise<void>;
}

export interface ExtrasDeps {
  store: ExtrasStore;
  http: (path: string, params: Record<string, unknown>) => Promise<unknown>;
  httpBinary: (path: string, params: Record<string, unknown>) => Promise<BinaryResponse>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  usage: { get(): Promise<ZohoUsage>; flush(): Promise<void>; block(until: Date): Promise<void> };
}

export interface ExtrasOptions {
  /** At most this many Zoho calls in this slice. */
  maxCalls: number;
  /** Stop starting calls when fewer than this many ms remain. */
  deadlineAt: number;
  batch?: number;
}

export interface ExtrasResult {
  callsMade: number;
  comments: { records: number; rows: number; failed: number };
  attachments: { records: number; stored: number; duplicate: number; skipped: number; failed: number };
  statements: { accounts: number; failed: number };
  stopped: 'complete' | 'calls' | 'time' | 'daily_budget' | 'daily_limit' | 'rate_limited' | 'auth';
  errors: string[];
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The comment rows of a `GET .../comments` response. */
export function commentRows(data: unknown): CommentRow[] {
  const list = (data as { comments?: unknown } | null)?.comments;
  if (!Array.isArray(list)) return [];
  const out: CommentRow[] = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const id = o.comment_id ?? o.id;
    if (id === undefined || id === null || String(id) === '') continue;
    const when = typeof o.date === 'string' && o.date
      ? new Date(typeof o.time === 'string' && /^\d/.test(o.time) && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? `${o.date} ${o.time}` : o.date)
      : null;
    out.push({
      commentId: String(id),
      commentedBy: typeof o.commented_by === 'string' ? o.commented_by : null,
      commentedAt: when && !Number.isNaN(when.getTime()) ? when.toISOString() : null,
      commentType: typeof o.comment_type === 'string' ? o.comment_type : (typeof o.operation_type === 'string' ? o.operation_type : null),
      description: typeof o.description === 'string' ? o.description : null,
      payload: o,
    });
  }
  return out;
}

/** The file name in a Content-Disposition header, if it names one. */
export function fileNameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) { try { return decodeURIComponent(star[1]!.trim().replace(/^"|"$/g, '')); } catch { /* fall through */ } }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  return plain ? (plain[2] ?? plain[1]!).trim() || null : null;
}

export const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export async function runExtrasSlice(companyId: string, deps: ExtrasDeps, opts: ExtrasOptions): Promise<ExtrasResult> {
  const st = deps.store;
  const batch = opts.batch ?? 20;
  const usage = await deps.usage.get();
  const result: ExtrasResult = {
    callsMade: 0, stopped: 'complete', errors: [],
    comments: { records: 0, rows: 0, failed: 0 },
    attachments: { records: 0, stored: 0, duplicate: 0, skipped: 0, failed: 0 },
    statements: { accounts: 0, failed: 0 },
  };
  let lastCallAt = 0;

  /** false = stop the slice (calls, time, budget). Otherwise waits out the pacing gap. */
  const beforeCall = async (): Promise<boolean> => {
    if (result.stopped !== 'complete') return false;
    if (result.callsMade >= opts.maxCalls) { result.stopped = 'calls'; return false; }
    if (usage.blockedUntil && Date.parse(usage.blockedUntil) > deps.now()) { result.stopped = 'daily_limit'; return false; }
    if (usage.used + result.callsMade >= usage.moduleCap) { result.stopped = 'daily_budget'; return false; }
    const wait = lastCallAt ? lastCallAt + MIN_CALL_GAP_MS - deps.now() : 0;
    if (deps.now() + Math.max(wait, 0) + 3_000 >= opts.deadlineAt) { result.stopped = 'time'; return false; }
    if (wait > 0) await deps.sleep(wait);
    lastCallAt = deps.now();
    result.callsMade++;
    return true;
  };

  /** true = stop the slice because of Zoho itself. */
  const fatal = async (e: unknown): Promise<boolean> => {
    if (isDailyLimitError(e)) {
      await deps.usage.block(new Date(deps.now() + 60 * 60 * 1000)).catch(() => {});
      result.stopped = 'daily_limit'; result.errors.push('Zoho says the daily API limit is used up');
      return true;
    }
    if (isRateLimitedError(e)) { result.stopped = 'rate_limited'; return true; }
    const status = (e as { status?: number } | null)?.status;
    if (status === 401 || /re-authentication failed|not connected/i.test(errText(e))) { result.stopped = 'auth'; result.errors.push(errText(e)); return true; }
    return false;
  };

  try {
    // 1. Bank statements: one call per account, at most once a day each.
    const accounts = await st.accountsNeedingStatement(companyId, STATEMENT_EVERY_MS);
    for (const id of accounts) {
      if (!(await beforeCall())) break;
      try {
        const data = await deps.http(`/bankaccounts/${encodeURIComponent(id)}/statement/lastimported`, {});
        await st.saveStatement(companyId, id, data);
        result.statements.accounts++;
      } catch (e) {
        if (await fatal(e)) break;
        result.statements.failed++;
        // A statement is read again tomorrow; remember the miss only as an error line.
        result.errors.push(`Bank statement ${id}: ${errText(e)}`.slice(0, 300));
      }
    }

    // 2. Comments / activity history.
    for (const module of COMMENT_MODULES) {
      if (result.stopped !== 'complete') break;
      let misses = 0; let hits = 0;
      for (;;) {
        if (misses >= MODULE_MISS_LIMIT && hits === 0) break;
        const ids = await st.needing(companyId, 'comments', module, batch);
        if (!ids.length) break;
        let progressed = false;
        for (const id of ids) {
          if (misses >= MODULE_MISS_LIMIT && hits === 0) break;
          if (!(await beforeCall())) break;
          try {
            const data = await deps.http(`/${module}/${encodeURIComponent(id)}/comments`, {});
            const rows = commentRows(data);
            result.comments.rows += await st.saveComments(companyId, module, id, rows);
            result.comments.records++; hits++; progressed = true;
          } catch (e) {
            if (await fatal(e)) break;
            await st.markFailure(companyId, 'comments', module, id, errText(e));
            result.comments.failed++; misses++; progressed = true;
          }
        }
        if (result.stopped !== 'complete' || !progressed) break;
        if (ids.length < batch) break;
      }
    }

    // 3. Attached files - only for records Zoho says have one.
    for (const [module, suffix] of Object.entries(ATTACHMENT_PATHS)) {
      if (result.stopped !== 'complete') break;
      let misses = 0; let hits = 0;
      for (;;) {
        if (misses >= MODULE_MISS_LIMIT && hits === 0) break;
        const ids = await st.needing(companyId, 'attachment', module, batch);
        if (!ids.length) break;
        let progressed = false;
        for (const id of ids) {
          if (misses >= MODULE_MISS_LIMIT && hits === 0) break;
          if (!(await beforeCall())) break;
          try {
            const res = await deps.httpBinary(`/${module}/${encodeURIComponent(id)}/${suffix}`, {});
            if (res.kind === 'json') throw new Error(`Zoho sent no file: ${JSON.stringify(res.body).slice(0, 160)}`);
            if (res.bytes.length > MAX_ATTACHMENT_BYTES) {
              result.attachments.skipped++;
              await st.markFailure(companyId, 'attachment', module, id, `File is ${Math.round(res.bytes.length / 1024 / 1024)} MB, over the ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB limit - not stored`);
              await st.markDone(companyId, 'attachment', module, id);
              progressed = true;
              continue;
            }
            const outcome = await st.saveAttachment(companyId, module, id, { sha256: sha256Hex(res.bytes), fileName: res.fileName, contentType: res.contentType, bytes: res.bytes });
            if (outcome === 'stored') result.attachments.stored++; else result.attachments.duplicate++;
            result.attachments.records++; hits++; progressed = true;
          } catch (e) {
            if (await fatal(e)) break;
            await st.markFailure(companyId, 'attachment', module, id, errText(e));
            result.attachments.failed++; misses++; progressed = true;
          }
        }
        if (result.stopped !== 'complete' || !progressed) break;
        if (ids.length < batch) break;
      }
    }
  } finally {
    await deps.usage.flush().catch(() => {});
  }
  return result;
}
