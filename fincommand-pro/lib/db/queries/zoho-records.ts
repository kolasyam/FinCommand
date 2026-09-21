import { query } from '@/lib/db/neon';

/** SQL for the mirrored Zoho records: read progress, the detail queue, removals, and reading records back. Every query filters on company_id. */

export interface ModuleState {
  module: string;
  pass_kind: 'full' | 'incremental' | null;
  pass_started_at: string | null;
  page_cursor: number | null;
  sub_cursor: string | null;
  incremental_cursor: string | null;
  last_full_at: string | null;
  last_incremental_at: string | null;
  detail_enabled: boolean | null;
  claimed_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

const STATE_COLUMNS = `module, pass_kind, pass_started_at, page_cursor, sub_cursor, incremental_cursor, last_full_at,
  last_incremental_at, detail_enabled, claimed_at, last_error, last_error_at`;

export async function ensureStates(companyId: string, modules: string[]): Promise<void> {
  if (!modules.length) return;
  await query(
    `INSERT INTO zoho_module_state (company_id, module) SELECT $1, m FROM unnest($2::text[]) AS m ON CONFLICT (company_id, module) DO NOTHING`,
    [companyId, modules]
  );
}

const STATE_TIME_FIELDS = ['pass_started_at', 'incremental_cursor', 'last_full_at', 'last_incremental_at', 'claimed_at', 'last_error_at'] as const;

/**
 * The pg driver returns timestamptz columns as Date objects, not the ISO strings ModuleState promises.
 * Date.parse(dateObject) goes through Date.toString() and loses the milliseconds, which made a module
 * read a few hundred ms into a run look "not read in this run" and get listed twice. Normalised here so the
 * rest of the code sees exactly what the type says.
 */
export function normalizeState(row: Record<string, unknown>): ModuleState {
  const out = { ...row };
  for (const f of STATE_TIME_FIELDS) {
    const v = out[f];
    if (v instanceof Date) out[f] = v.toISOString();
  }
  return out as unknown as ModuleState;
}

export async function loadStates(companyId: string, modules: string[]): Promise<Map<string, ModuleState>> {
  const { rows } = await query<ModuleState>(
    `SELECT ${STATE_COLUMNS} FROM zoho_module_state WHERE company_id=$1 AND module = ANY($2::text[])`, [companyId, modules]);
  return new Map(rows.map((r) => [r.module, normalizeState(r as unknown as Record<string, unknown>)]));
}

/** Claims the modules for one slice. A claim older than 3 minutes is a crashed slice and can be taken over. */
export async function claimModules(companyId: string, modules: string[]): Promise<string[]> {
  const { rows } = await query<{ module: string }>(
    `UPDATE zoho_module_state SET claimed_at=NOW()
      WHERE company_id=$1 AND module = ANY($2::text[]) AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '3 minutes')
      RETURNING module`,
    [companyId, modules]
  );
  return rows.map((r) => r.module);
}

export async function releaseModules(companyId: string, modules: string[]): Promise<void> {
  if (!modules.length) return;
  await query(`UPDATE zoho_module_state SET claimed_at=NULL WHERE company_id=$1 AND module = ANY($2::text[])`, [companyId, modules]);
}

const PATCHABLE = new Set([
  'pass_kind', 'pass_started_at', 'page_cursor', 'sub_cursor', 'incremental_cursor', 'last_full_at',
  'last_incremental_at', 'detail_enabled', 'last_error', 'last_error_at',
]);

export type StatePatch = Partial<Omit<ModuleState, 'module' | 'claimed_at'>>;

export async function saveState(companyId: string, module: string, patch: StatePatch): Promise<void> {
  const entries = Object.entries(patch).filter(([k]) => PATCHABLE.has(k));
  if (!entries.length) return;
  const sets = entries.map(([k], i) => `${k}=$${i + 3}`);
  await query(
    `UPDATE zoho_module_state SET ${sets.join(', ')}, updated_at=NOW() WHERE company_id=$1 AND module=$2`,
    [companyId, module, ...entries.map(([, v]) => v)]
  );
}

/** Newest documents first, so a partly finished read is the most useful part. Records that failed 3 times are left alone. */
export async function needingDetail(companyId: string, module: string, limit: number): Promise<string[]> {
  const { rows } = await query<{ zoho_id: string }>(
    `SELECT zoho_id FROM zoho_records
      WHERE company_id=$1 AND module=$2 AND detail_stale AND deleted_at IS NULL AND detail_attempts < 3
      ORDER BY doc_date DESC NULLS LAST, zoho_id LIMIT $3`,
    [companyId, module, limit]
  );
  return rows.map((r) => r.zoho_id);
}

export async function countDetailPending(companyId: string, module: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*) AS n FROM zoho_records
      WHERE company_id=$1 AND module=$2 AND detail_stale AND deleted_at IS NULL AND detail_attempts < 3`,
    [companyId, module]
  );
  return Number(rows[0]?.n ?? 0);
}

export async function parentIds(companyId: string, module: string): Promise<string[]> {
  const { rows } = await query<{ zoho_id: string }>(
    `SELECT zoho_id FROM zoho_records WHERE company_id=$1 AND module=$2 AND deleted_at IS NULL ORDER BY zoho_id`,
    [companyId, module]
  );
  return rows.map((r) => r.zoho_id);
}

export async function financialYears(companyId: string): Promise<Array<{ label: string; start: string; end: string }>> {
  const { rows } = await query<{ label: string; start: string; end: string }>(
    `SELECT label, start_date::text AS start, end_date::text AS "end" FROM financial_years WHERE company_id=$1 ORDER BY start_date`,
    [companyId]
  );
  return rows;
}

/** When the newest snapshot of this report and period was last seen (ms), or null. */
export async function snapshotSeen(companyId: string, report: string, periodTo: string): Promise<number | null> {
  const { rows } = await query<{ seen: string | null }>(
    `SELECT max(last_seen_at) AS seen FROM zoho_report_snapshots WHERE company_id=$1 AND report=$2 AND period_to=$3::date`,
    [companyId, report, periodTo]
  );
  return rows[0]?.seen ? new Date(rows[0].seen).getTime() : null;
}

export interface SnapshotSummary { report: string; snapshots: number; last_seen_at: string | null }

export async function snapshotSummaries(companyId: string): Promise<Map<string, SnapshotSummary>> {
  const { rows } = await query<{ report: string; snapshots: string; last_seen_at: string | null }>(
    `SELECT report, count(*) AS snapshots, max(last_seen_at) AS last_seen_at FROM zoho_report_snapshots WHERE company_id=$1 GROUP BY report`,
    [companyId]
  );
  return new Map(rows.map((r) => [r.report, { report: r.report, snapshots: Number(r.snapshots), last_seen_at: r.last_seen_at }]));
}

/** The newest snapshot of each period of a report (optionally with Zoho's full response). */
export async function latestSnapshots(companyId: string, report: string, includePayload: boolean) {
  const { rows } = await query(
    `SELECT DISTINCT ON (period_to) report, period_from::text AS period_from, period_to::text AS period_to, fetched_at, last_seen_at
            ${includePayload ? ', payload' : ''}
       FROM zoho_report_snapshots WHERE company_id=$1 AND report=$2
      ORDER BY period_to DESC, last_seen_at DESC`,
    [companyId, report]
  );
  return rows;
}

export async function markDetailFailure(companyId: string, module: string, zohoId: string, message: string): Promise<void> {
  await query(
    `UPDATE zoho_records SET detail_attempts = detail_attempts + 1, detail_error=$4 WHERE company_id=$1 AND module=$2 AND zoho_id=$3`,
    [companyId, module, zohoId, message.slice(0, 500)]
  );
}

/** Zoho answered 404 for a record it listed: it was removed. Flagged, not deleted. */
export async function markDetailGone(companyId: string, module: string, zohoId: string): Promise<void> {
  await query(
    `UPDATE zoho_records SET deleted_at=NOW(), detail_stale=FALSE WHERE company_id=$1 AND module=$2 AND zoho_id=$3`,
    [companyId, module, zohoId]
  );
}

/** How many stored, non-removed records were seen at or after `since`. */
export async function countSeenSince(companyId: string, module: string, since: Date): Promise<{ seen: number; total: number }> {
  const { rows } = await query<{ seen: string; total: string }>(
    `SELECT count(*) FILTER (WHERE last_seen_at >= $3) AS seen, count(*) AS total
       FROM zoho_records WHERE company_id=$1 AND module=$2 AND deleted_at IS NULL`,
    [companyId, module, since]
  );
  return { seen: Number(rows[0]?.seen ?? 0), total: Number(rows[0]?.total ?? 0) };
}

/** After a COMPLETE full listing: records Zoho no longer lists are flagged as removed (never deleted). */
export async function markMissingRemoved(companyId: string, module: string, passStartedAt: Date): Promise<number> {
  const { rowCount } = await query(
    `UPDATE zoho_records SET deleted_at=NOW()
      WHERE company_id=$1 AND module=$2 AND deleted_at IS NULL AND last_seen_at < $3`,
    [companyId, module, passStartedAt]
  );
  return rowCount ?? 0;
}

export interface ModuleCounts { module: string; records: number; removed: number; with_detail: number; detail_pending: number; detail_failed: number }

export async function moduleCounts(companyId: string): Promise<Map<string, ModuleCounts>> {
  const { rows } = await query<Record<string, string>>(
    `SELECT module,
            count(*) FILTER (WHERE deleted_at IS NULL) AS records,
            count(*) FILTER (WHERE deleted_at IS NOT NULL) AS removed,
            count(*) FILTER (WHERE deleted_at IS NULL AND detail IS NOT NULL) AS with_detail,
            count(*) FILTER (WHERE deleted_at IS NULL AND detail_stale AND detail_attempts < 3) AS detail_pending,
            count(*) FILTER (WHERE deleted_at IS NULL AND detail_stale AND detail_attempts >= 3) AS detail_failed
       FROM zoho_records WHERE company_id=$1 GROUP BY module`,
    [companyId]
  );
  return new Map(rows.map((r) => [r.module!, {
    module: r.module!, records: Number(r.records), removed: Number(r.removed), with_detail: Number(r.with_detail),
    detail_pending: Number(r.detail_pending), detail_failed: Number(r.detail_failed),
  }]));
}

export interface RecordFilters {
  module: string;
  q?: string;
  contactId?: string;
  parentId?: string;
  status?: string;
  from?: string;
  to?: string;
  includeRemoved?: boolean;
  page?: number;
  perPage?: number;
}

const LIST_COLUMNS = `zoho_id, module, title, parent_id, doc_number, doc_date::text AS doc_date, due_date::text AS due_date, status, contact_id, contact_name,
  currency_code, exchange_rate, amount, base_amount, balance, sub_amount, tax_amount, gst_treatment, gst_no, place_of_supply,
  zoho_modified_at, detail IS NOT NULL AS has_detail, detail_stale, revision, first_seen_at, last_seen_at, deleted_at`;

export async function listRecords(companyId: string, f: RecordFilters) {
  const where = ['company_id=$1', 'module=$2'];
  const params: unknown[] = [companyId, f.module];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (!f.includeRemoved) where.push('deleted_at IS NULL');
  if (f.q) {
    params.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`);
    where.push(`(doc_number ILIKE $${params.length} OR contact_name ILIKE $${params.length} OR title ILIKE $${params.length})`);
  }
  if (f.parentId) add('parent_id = ?', f.parentId);
  if (f.contactId) add('contact_id = ?', f.contactId);
  if (f.status) add('status = ?', f.status);
  if (f.from) add('doc_date >= ?::date', f.from);
  if (f.to) add('doc_date <= ?::date', f.to);
  const perPage = Math.min(Math.max(f.perPage ?? 50, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const whereSql = where.join(' AND ');
  const [{ rows }, { rows: total }] = await Promise.all([
    query(`SELECT ${LIST_COLUMNS} FROM zoho_records WHERE ${whereSql} ORDER BY doc_date DESC NULLS LAST, zoho_id LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`, params),
    query<{ n: string }>(`SELECT count(*) AS n FROM zoho_records WHERE ${whereSql}`, params),
  ]);
  return { records: rows, total: Number(total[0]?.n ?? 0), page, per_page: perPage };
}

export async function getRecord(companyId: string, module: string, zohoId: string) {
  const { rows } = await query(
    `SELECT ${LIST_COLUMNS}, payload, detail FROM zoho_records WHERE company_id=$1 AND module=$2 AND zoho_id=$3`,
    [companyId, module, zohoId]
  );
  if (!rows.length) return null;
  const { rows: lines } = await query(
    `SELECT line_no, kind, account_id, account_name, account_code, item_id, item_name, description, quantity, rate, amount, base_amount,
            debit_or_credit, tax_id, tax_name, tax_percentage, tax_amount, hsn_or_sac, gst_treatment_code, itc_eligibility, ref_id, ref_number, taxes
       FROM zoho_record_lines WHERE company_id=$1 AND module=$2 AND zoho_id=$3 ORDER BY line_no`,
    [companyId, module, zohoId]
  );
  return { ...rows[0], lines };
}
