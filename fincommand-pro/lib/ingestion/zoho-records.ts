import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '@/lib/db/neon';
import {
  extractRecord, extractLines, type ModuleDef, type ExtractCtx, type ExtractedRecord, type LineRow,
} from '@/lib/services/zoho/modules';

/**
 * The one write path for mirrored Zoho records. Every save is one transaction
 * and safe to retry: a record whose content did not change writes nothing but
 * its "seen" time; a record that changed first has its previous version copied
 * to zoho_record_history.
 */

export interface RecordsDeps {
  transaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
}
const defaultDeps: RecordsDeps = { transaction: withTransaction };

type Obj = Record<string, unknown>;

// Fields Zoho changes when someone merely looks at a document. They are stored,
// but they must not count as "the record changed" (a history row + a re-read).
const VOLATILE_KEYS = new Set([
  'client_viewed_time', 'is_viewed_by_client', 'mail_first_viewed_time', 'mail_last_viewed_time',
  'is_viewed_in_mail', 'last_reminder_sent_date', 'reminders_sent',
]);

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Obj;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** SHA-256 of a record's content: key order does not matter, look-only fields are ignored. */
export function hashRecord(record: unknown): string {
  let content = record;
  if (record && typeof record === 'object' && !Array.isArray(record)) {
    content = Object.fromEntries(Object.entries(record as Obj).filter(([k]) => !VOLATILE_KEYS.has(k)));
  }
  return createHash('sha256').update(canonical(content)).digest('hex');
}

const LIST_CHUNK = 100;
const LINE_CHUNK = 50;

// Columns the detail record may add to (or correct in) what the list row gave.
const DETAIL_DERIVED = ['currency_code', 'exchange_rate', 'base_amount', 'sub_amount', 'tax_amount', 'gst_treatment', 'gst_no', 'place_of_supply'] as const;

export interface PageResult { received: number; created: number; updated: number; unchanged: number; skipped: number }

/** The columns written for a list row, in the order listRowValues() returns them. */
export const LIST_COLUMNS = [
  'company_id', 'module', 'zoho_id', 'title', 'parent_id', 'doc_number', 'doc_date', 'due_date', 'status', 'contact_id', 'contact_name',
  'currency_code', 'exchange_rate', 'amount', 'base_amount', 'balance', 'sub_amount', 'tax_amount',
  'gst_treatment', 'gst_no', 'place_of_supply', 'zoho_modified_at', 'payload', 'payload_sha256', 'detail_stale',
] as const;

function listRowValues(companyId: string, module: string, ex: ExtractedRecord, row: Obj, sha: string, detailStale: boolean): unknown[] {
  return [
    companyId, module, ex.zohoId, ex.title, ex.parentId, ex.docNumber, ex.docDate, ex.dueDate, ex.status, ex.contactId, ex.contactName,
    ex.currencyCode, ex.exchangeRate, ex.amount, ex.baseAmount, ex.balance, ex.subAmount, ex.taxAmount,
    ex.gstTreatment, ex.gstNo, ex.placeOfSupply, ex.modifiedAt, JSON.stringify(row), sha, detailStale,
  ];
}

/**
 * Stores one page of a module's list response.
 * `skipped` counts rows without an id (they cannot be stored) - reported, not hidden.
 */
export async function upsertListPage(
  input: { companyId: string; def: ModuleDef; rows: Obj[]; ctx: ExtractCtx; /** The parent this page was listed for (fan-out modules). */ parentId?: string | null },
  deps: RecordsDeps = defaultDeps,
): Promise<PageResult> {
  const { companyId, def, rows, ctx } = input;
  const result: PageResult = { received: rows.length, created: 0, updated: 0, unchanged: 0, skipped: 0 };

  const seenIds = new Set<string>();
  const items: Array<{ ex: ExtractedRecord; row: Obj; sha: string }> = [];
  for (const row of rows) {
    const ex = extractRecord(def, row, ctx, null, input.parentId);
    if (!ex) { result.skipped++; continue; }
    if (seenIds.has(ex.zohoId)) continue; // Zoho can repeat a row across pages while data shifts
    seenIds.add(ex.zohoId);
    items.push({ ex, row, sha: hashRecord(row) });
  }
  if (!items.length) return result;

  return deps.transaction(async (c) => {
    const ids = items.map((i) => i.ex.zohoId);
    const { rows: existing } = await c.query(
      `SELECT zoho_id, payload_sha256 FROM zoho_records WHERE company_id=$1 AND module=$2 AND zoho_id = ANY($3::text[])`,
      [companyId, def.key, ids]
    );
    const known = new Map<string, string>(existing.map((r: { zoho_id: string; payload_sha256: string }) => [r.zoho_id, r.payload_sha256]));

    const unchangedIds: string[] = [];
    const changedIds: string[] = [];
    const toWrite: typeof items = [];
    for (const it of items) {
      const sha = known.get(it.ex.zohoId);
      if (sha === undefined) { toWrite.push(it); result.created++; }
      else if (sha === it.sha) { unchangedIds.push(it.ex.zohoId); result.unchanged++; }
      else { toWrite.push(it); changedIds.push(it.ex.zohoId); result.updated++; }
    }

    if (unchangedIds.length) {
      await c.query(
        `UPDATE zoho_records SET last_seen_at=NOW(), deleted_at=NULL WHERE company_id=$1 AND module=$2 AND zoho_id = ANY($3::text[])`,
        [companyId, def.key, unchangedIds]
      );
    }
    if (changedIds.length) {
      await c.query(
        `INSERT INTO zoho_record_history (company_id, module, zoho_id, revision, payload, detail)
         SELECT company_id, module, zoho_id, revision, payload, detail FROM zoho_records
          WHERE company_id=$1 AND module=$2 AND zoho_id = ANY($3::text[])`,
        [companyId, def.key, changedIds]
      );
    }

    const detailStale = def.detail !== 'none';
    for (let i = 0; i < toWrite.length; i += LIST_CHUNK) {
      const chunk = toWrite.slice(i, i + LIST_CHUNK);
      const params: unknown[] = [];
      const tuples = chunk.map(({ ex, row, sha }) => {
        const base = params.length;
        params.push(...listRowValues(companyId, def.key, ex, row, sha, detailStale));
        return `(${LIST_COLUMNS.map((col, k) => `$${base + k + 1}${col === 'payload' ? '::jsonb' : ''}`).join(',')})`;
      });
      // Detail-derived columns keep what the last detail read gave unless Zoho's modified time moved
      // (then the detail is about to be re-read, and the old figure would be wrong).
      const keepUnlessModified = (col: string) =>
        `${col} = CASE WHEN zoho_records.zoho_modified_at IS DISTINCT FROM EXCLUDED.zoho_modified_at THEN EXCLUDED.${col} ELSE COALESCE(EXCLUDED.${col}, zoho_records.${col}) END`;
      await c.query(
        `INSERT INTO zoho_records (${LIST_COLUMNS.join(', ')})
         VALUES ${tuples.join(', ')}
         ON CONFLICT (company_id, module, zoho_id) DO UPDATE SET
           title=EXCLUDED.title, parent_id=EXCLUDED.parent_id,
           doc_number=EXCLUDED.doc_number, doc_date=EXCLUDED.doc_date, due_date=EXCLUDED.due_date, status=EXCLUDED.status,
           contact_id=EXCLUDED.contact_id, contact_name=EXCLUDED.contact_name, amount=EXCLUDED.amount, balance=EXCLUDED.balance,
           ${DETAIL_DERIVED.map(keepUnlessModified).join(', ')},
           detail_stale = zoho_records.detail_stale OR (EXCLUDED.detail_stale AND zoho_records.zoho_modified_at IS DISTINCT FROM EXCLUDED.zoho_modified_at),
           zoho_modified_at=EXCLUDED.zoho_modified_at, payload=EXCLUDED.payload, payload_sha256=EXCLUDED.payload_sha256,
           revision = zoho_records.revision + 1, last_seen_at=NOW(), deleted_at=NULL`,
        params
      );
    }
    return result;
  });
}

/**
 * Keeps one of Zoho's reports for a period. The same content for the same period is one row (only its
 * "last seen" moves); changed content is a new row, so what Zoho reported earlier is never overwritten.
 */
export async function saveSnapshot(
  input: { companyId: string; report: string; periodFrom: string | null; periodTo: string; payload: unknown },
  deps: RecordsDeps = defaultDeps,
): Promise<'created' | 'unchanged'> {
  const sha = hashRecord(input.payload);
  return deps.transaction(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO zoho_report_snapshots (company_id, report, period_from, period_to, payload, payload_sha256)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (company_id, report, COALESCE(period_from, DATE '0001-01-01'), period_to, payload_sha256)
       DO UPDATE SET last_seen_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [input.companyId, input.report, input.periodFrom, input.periodTo, JSON.stringify(input.payload), sha]
    );
    return rows[0]?.inserted ? 'created' : 'unchanged';
  });
}

export type DetailOutcome = 'updated' | 'unchanged' | 'missing';

/**
 * Stores a record's detail (line items, GST, applied documents) and replaces its
 * line rows in the same transaction. The line rows are derived from the detail
 * JSON, which is kept in full, so replacing them loses nothing.
 */
export async function writeDetail(
  input: { companyId: string; def: ModuleDef; zohoId: string; detail: Obj; ctx: ExtractCtx },
  deps: RecordsDeps = defaultDeps,
): Promise<DetailOutcome> {
  const { companyId, def, zohoId, detail, ctx } = input;
  const sha = hashRecord(detail);
  return deps.transaction(async (c) => {
    const { rows } = await c.query(
      `SELECT payload, detail, detail_sha256, revision FROM zoho_records
        WHERE company_id=$1 AND module=$2 AND zoho_id=$3 FOR UPDATE`,
      [companyId, def.key, zohoId]
    );
    if (!rows.length) return 'missing';
    const cur = rows[0] as { payload: Obj; detail: Obj | null; detail_sha256: string | null; revision: number };

    if (cur.detail_sha256 === sha) {
      await c.query(
        `UPDATE zoho_records SET detail_stale=FALSE, detail_attempts=0, detail_error=NULL WHERE company_id=$1 AND module=$2 AND zoho_id=$3`,
        [companyId, def.key, zohoId]
      );
      return 'unchanged';
    }

    if (cur.detail) {
      await c.query(
        `INSERT INTO zoho_record_history (company_id, module, zoho_id, revision, payload, detail) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
        [companyId, def.key, zohoId, cur.revision, JSON.stringify(cur.payload), JSON.stringify(cur.detail)]
      );
    }

    const ex = extractRecord(def, cur.payload, ctx, detail);
    await c.query(
      `UPDATE zoho_records SET
         detail=$4::jsonb, detail_sha256=$5, detail_stale=FALSE, detail_attempts=0, detail_error=NULL,
         revision = revision + $6,
         doc_number=COALESCE($7, doc_number), doc_date=COALESCE($8, doc_date), due_date=COALESCE($9, due_date),
         status=COALESCE($10, status), currency_code=COALESCE($11, currency_code), exchange_rate=COALESCE($12, exchange_rate),
         amount=COALESCE($13, amount), base_amount=COALESCE($14, base_amount), balance=COALESCE($15, balance),
         sub_amount=COALESCE($16, sub_amount), tax_amount=COALESCE($17, tax_amount),
         gst_treatment=COALESCE($18, gst_treatment), gst_no=COALESCE($19, gst_no), place_of_supply=COALESCE($20, place_of_supply)
       WHERE company_id=$1 AND module=$2 AND zoho_id=$3`,
      [
        companyId, def.key, zohoId, JSON.stringify(detail), sha, cur.detail ? 1 : 0,
        ex?.docNumber ?? null, ex?.docDate ?? null, ex?.dueDate ?? null, ex?.status ?? null, ex?.currencyCode ?? null, ex?.exchangeRate ?? null,
        ex?.amount ?? null, ex?.baseAmount ?? null, ex?.balance ?? null, ex?.subAmount ?? null, ex?.taxAmount ?? null,
        ex?.gstTreatment ?? null, ex?.gstNo ?? null, ex?.placeOfSupply ?? null,
      ]
    );

    await c.query(`DELETE FROM zoho_record_lines WHERE company_id=$1 AND module=$2 AND zoho_id=$3`, [companyId, def.key, zohoId]);
    const lines = extractLines(def, detail);
    for (let i = 0; i < lines.length; i += LINE_CHUNK) await insertLines(c, companyId, def.key, zohoId, lines.slice(i, i + LINE_CHUNK));
    return 'updated';
  });
}

const LINE_COLUMNS = [
  'company_id', 'module', 'zoho_id', 'line_no', 'kind', 'account_id', 'account_name', 'account_code', 'item_id', 'item_name', 'description',
  'quantity', 'rate', 'amount', 'base_amount', 'debit_or_credit', 'tax_id', 'tax_name', 'tax_percentage', 'tax_amount',
  'hsn_or_sac', 'gst_treatment_code', 'itc_eligibility', 'ref_id', 'ref_number', 'taxes',
] as const;

async function insertLines(c: PoolClient, companyId: string, module: string, zohoId: string, lines: LineRow[]): Promise<void> {
  const params: unknown[] = [];
  const tuples = lines.map((l) => {
    const base = params.length;
    params.push(
      companyId, module, zohoId, l.lineNo, l.kind, l.accountId, l.accountName, l.accountCode, l.itemId, l.itemName, l.description,
      l.quantity, l.rate, l.amount, l.baseAmount, l.debitOrCredit, l.taxId, l.taxName, l.taxPercentage, l.taxAmount,
      l.hsnOrSac, l.gstTreatmentCode, l.itcEligibility, l.refId, l.refNumber, l.taxes ? JSON.stringify(l.taxes) : null,
    );
    return `(${LINE_COLUMNS.map((_, k) => `$${base + k + 1}${k === LINE_COLUMNS.length - 1 ? '::jsonb' : ''}`).join(',')})`;
  });
  await c.query(`INSERT INTO zoho_record_lines (${LINE_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`, params);
}
