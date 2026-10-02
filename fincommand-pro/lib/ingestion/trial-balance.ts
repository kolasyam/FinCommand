import type { PoolClient } from 'pg';
import { randomUUID, randomUUID as uuid } from 'crypto';
import { withTransaction } from '@/lib/db/neon';
import { ApiError } from '@/lib/auth/permissions';
import {
  summarizeTrialBalance, decideSourceOwnership, findDuplicateLedgers,
  type DataSource, type TbAmountRow, type TrialBalanceSummary,
} from '@/lib/financial/tb-validation';
import { lockTrialBalanceWrite, assertYearUnlocked, setYearDataSource, sourceName, type WritableYear } from '@/lib/db/queries/tb-batches';
import { contentHash, hashableFromStoredLedger, hashableFromStoredEntity, type HashableLedger } from './content-hash';

/**
 * The ONE write path for trial-balance data (DB Phase 1). Every source —
 * Excel upload, Zoho sync, later Tally/QuickBooks — parses and maps its own
 * data into NormalizedLedger rows, then hands them here. Everything that must
 * be identical for every source happens here and only here:
 *
 *   duplicate check → debit/credit summary → [transaction] one-writer lock →
 *   year lock → "first source owns the year" → same-file check → supersede
 *   the current batch → insert batch + ledger + entity rows → record the owner.
 *
 * Before this, the Excel route and zoho.ts each did these steps their own way.
 */

/**
 * One mapped ledger, ready to store. Its stable account identity is not set
 * here: the database assigns it on insert (ledger_account_key() + trigger,
 * migration 0005) — Zoho account id, else code, else name — so it is defined
 * once for every writer.
 */
export interface NormalizedLedger {
  code: string | null;
  name: string;
  note_no: number | null;
  note_name: string | null;
  section: string | null;
  treasury_type: string | null;
  normal_bal: string;
  op_dr: number;
  op_cr: number;
  /** The 12 FY months, April first. */
  months: { dr: number; cr: number }[];
  zoho_account_id?: string | null;
  zoho_account_type?: string | null;
  depth?: number;
  is_child_present?: boolean;
}

/** One customer's or vendor's 12 monthly amounts (Zoho only today). */
export interface EntityMonthlyRow { externalId: string | null; name: string; m: number[] }

/** One raw response from the source, e.g. Zoho's 'P&L Apr' report. */
export interface RawPayload { label: string; periodFrom: string | null; periodTo: string | null; fetchedAt: string | null; payload: unknown }

export interface IngestInput {
  companyId: string;
  fyId: string;
  source: DataSource;
  uploadedBy: string | null;
  options?: { confirmReplace?: boolean; scheduled?: boolean };
  ledgers: NormalizedLedger[];
  customerRevenue?: EntityMonthlyRow[];
  vendorExpense?: EntityMonthlyRow[];
  customerCost?: EntityMonthlyRow[];
  batch: {
    currency: string;
    filename?: string | null;
    fileSizeKb?: number | null;
    /** Excel file fingerprint — an identical re-upload is refused. */
    fileSha256?: string | null;
    mappedCount: number;
    unmatched?: string[];
    coveragePct?: number | null;
    hasMonthlyCols: boolean;
    /** The raw source responses this batch was built from (stored once each, see storeRawPayloads). */
    rawPayloads?: RawPayload[];
  };
  /** Also make this the company's default currency for the next upload (Excel's currency picker). */
  companyDefaultCurrency?: string | null;
  /** Source-specific writes that must commit or roll back with the batch (Zoho: remembered auto-mappings). */
  inTransaction?: (client: PoolClient) => Promise<void>;
}

export interface IngestResult {
  /**
   * 'no_change' = the figures are identical to the current batch, so nothing
   * was written and `uploadId` is that current batch (Zoho only — an Excel
   * upload with the same figures is refused with NO_CHANGE instead).
   */
  status: 'created' | 'no_change';
  uploadId: string;
  summary: TrialBalanceSummary;
  /** The source that owned the year before this load replaced it (after the user confirmed). */
  replacedSource: DataSource | null;
}

function toHashable(l: NormalizedLedger): HashableLedger {
  return {
    code: l.code, name: l.name, note_no: l.note_no, note_name: l.note_name, section: l.section,
    treasury_type: l.treasury_type, normal_bal: l.normal_bal,
    zoho_account_id: l.zoho_account_id ?? null, zoho_account_type: l.zoho_account_type ?? null,
    amounts: [l.op_dr, l.op_cr, ...l.months.flatMap((mv) => [mv.dr, mv.cr])],
  };
}

/** Fingerprint of an already-stored batch, from its own rows (for batches written before 0003). */
async function hashStoredBatch(client: PoolClient, uploadId: string, currency: string): Promise<string> {
  // One transaction client runs one query at a time, so these go in sequence (pg@9 refuses overlapping queries).
  // The monthly figures live in ledger_month_amounts (the deferred drop (db/deferred) removes the wide columns).
  const ledgers = await client.query(
      `SELECT l.*,
              (SELECT array_agg(a.dr ORDER BY a.period_month) FROM ledger_month_amounts a WHERE a.ledger_id = l.id) AS month_dr,
              (SELECT array_agg(a.cr ORDER BY a.period_month) FROM ledger_month_amounts a WHERE a.ledger_id = l.id) AS month_cr
         FROM tb_ledgers l WHERE l.upload_id=$1`, [uploadId]);
  const rev = await client.query(`SELECT zoho_customer_id, customer_name, m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12 FROM tb_customer_revenue WHERE upload_id=$1`, [uploadId]);
  const ven = await client.query(`SELECT zoho_vendor_id, vendor_name, m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12 FROM tb_vendor_expense WHERE upload_id=$1`, [uploadId]);
  const cost = await client.query(`SELECT zoho_customer_id, customer_name, m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12 FROM tb_customer_cost WHERE upload_id=$1`, [uploadId]);
  return contentHash({
    currency,
    ledgers: ledgers.rows.map((r) => {
      const wide: Record<string, unknown> = { ...r };
      for (let i = 0; i < 12; i++) { wide[`m${i + 1}_dr`] = r.month_dr?.[i] ?? 0; wide[`m${i + 1}_cr`] = r.month_cr?.[i] ?? 0; }
      return hashableFromStoredLedger(wide);
    }),
    customerRevenue: rev.rows.map((r) => hashableFromStoredEntity(r, 'zoho_customer_id', 'customer_name')),
    vendorExpense: ven.rows.map((r) => hashableFromStoredEntity(r, 'zoho_vendor_id', 'vendor_name')),
    customerCost: cost.rows.map((r) => hashableFromStoredEntity(r, 'zoho_customer_id', 'customer_name')),
  });
}

// 40 bind parameters per ledger row → 20,000 per statement, under Postgres' 65,535 limit.
const CHUNK_ROWS = 500;

const LEDGER_COLUMNS = [
  'upload_id', 'company_id', 'financial_year_id', 'ledger_code', 'ledger_name',
  'note_no', 'note_name', 'section', 'treasury_type', 'normal_bal', 'op_dr', 'op_cr',
  'zoho_account_id', 'zoho_account_type', 'depth', 'is_child_present',
];

/** tb_ledgers column shape (op_dr, m1_dr …) — what the debit/credit check reads. */
export function toAmountRows(ledgers: NormalizedLedger[]): TbAmountRow[] {
  return ledgers.map((l) => {
    const row: TbAmountRow = { op_dr: l.op_dr, op_cr: l.op_cr };
    l.months.forEach((mv, i) => { row[`m${i + 1}_dr`] = mv.dr; row[`m${i + 1}_cr`] = mv.cr; });
    return row;
  });
}

function sourceOwnedError(fy: WritableYear, incoming: DataSource): ApiError {
  const message = incoming === 'excel'
    ? `${fy.label}'s data currently comes from ${sourceName(fy.data_source!)}. Replace it with this Excel file? ` +
      `Scheduled Zoho syncs will then skip this year.`
    // A sync is checked before it starts fetching; reaching this means the owner changed meanwhile.
    : `${fy.label}'s data source changed while syncing — please try again.`;
  return new ApiError(409, message, 'SOURCE_OWNED', { owner: fy.data_source });
}

/** Multi-row INSERT in chunks; `values` builds one row's bind values. */
async function insertRows<T>(client: PoolClient, table: string, columns: string[], rows: T[], values: (r: T) => unknown[]) {
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
    const params: unknown[] = [];
    const tuples = rows.slice(i, i + CHUNK_ROWS).map((r) => {
      const v = values(r);
      const base = params.length;
      params.push(...v);
      return `(${v.map((_, j) => `$${base + j + 1}`).join(',')})`;
    });
    await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, params);
  }
}

/**
 * Per-customer/vendor tables are supplementary: a failure there is logged
 * and the trial balance itself still commits (same behaviour as before).
 */
async function insertEntityRows(
  client: PoolClient, table: 'tb_customer_revenue' | 'tb_vendor_expense' | 'tb_customer_cost',
  idColumn: 'zoho_customer_id' | 'zoho_vendor_id', nameColumn: 'customer_name' | 'vendor_name',
  rows: EntityMonthlyRow[] | undefined, key: { uploadId: string; companyId: string; fyId: string },
) {
  if (!rows?.length) return;
  await client.query(`SAVEPOINT ${table}_sp`);
  try {
    await insertRows(client, table,
      ['upload_id', 'company_id', 'financial_year_id', idColumn, nameColumn, ...Array.from({ length: 12 }, (_, i) => `m${i + 1}`)],
      rows, (r) => [key.uploadId, key.companyId, key.fyId, r.externalId, r.name, ...r.m]);
    await client.query(`RELEASE SAVEPOINT ${table}_sp`);
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${table}_sp`).catch(() => {});
    console.warn(`${table} insert failed (non-fatal):`, (err as Error).message);
  }
}

/**
 * Raw responses are stored once per company (DB Phase 1.3, migration 0004):
 * Postgres fingerprints the canonical JSONB text, an identical response
 * already on file is reused (only its last_seen_at moves), and the batch
 * links to it under its own label. Most months don't change between syncs,
 * so most responses are stored exactly once.
 */
/**
 * Drops response metadata that changes on every request but says nothing
 * about the figures — today Zoho's page_context.*accessed_time* stamps
 * (found on the 1,195 migrated entries: they were the only difference
 * between otherwise identical months, so nothing de-duplicated). When the
 * response was fetched is kept on the link row (fetched_at) instead.
 */
export function stripVolatileMetadata(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  const ctx = p.page_context;
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return payload;
  const kept = Object.fromEntries(Object.entries(ctx as Record<string, unknown>).filter(([k]) => !/accessed_time/i.test(k)));
  return { ...p, page_context: kept };
}

async function storeRawPayloads(client: PoolClient, key: { uploadId: string; companyId: string; source: DataSource }, payloads: RawPayload[]) {
  for (const p of payloads) {
    const { rows: [stored] } = await client.query<{ id: string }>(
      `INSERT INTO raw_payloads (company_id, source, sha256, payload)
       SELECT $1, $2, encode(sha256(convert_to(x.p::text, 'UTF8')), 'hex'), x.p FROM (SELECT $3::jsonb AS p) x
       ON CONFLICT (company_id, sha256) DO UPDATE SET last_seen_at = NOW()
       RETURNING id`,
      [key.companyId, key.source, JSON.stringify(stripVolatileMetadata(p.payload))]
    );
    await client.query(
      `INSERT INTO upload_raw_payloads (upload_id, label, period_from, period_to, fetched_at, raw_payload_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [key.uploadId, p.label, p.periodFrom, p.periodTo, p.fetchedAt, stored.id]
    );
  }
}

/** Injectable for unit tests (a fake client); production always uses the real pool. */
export interface IngestDeps {
  transaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
}

export async function ingestTrialBalance(input: IngestInput, deps: IngestDeps = { transaction: withTransaction }): Promise<IngestResult> {
  const { companyId, fyId, source, batch } = input;

  // The same ledger twice would be summed twice into every report (and the
  // database refuses it anyway) — name it before taking any lock.
  const duplicates = findDuplicateLedgers(input.ledgers.map((l) => ({ name: l.name, code: l.code })));
  if (duplicates.length) {
    const where = source === 'excel' ? 'in the file' : 'in the source data';
    throw new ApiError(422,
      `These ledgers appear more than once ${where}: ${duplicates.slice(0, 10).join(', ')}${duplicates.length > 10 ? ` and ${duplicates.length - 10} more` : ''}. Remove the extra rows and try again.`,
      'DUPLICATE_LEDGERS', { duplicates });
  }

  // Warn-and-record: stored on the batch, never blocks the load.
  const summary = summarizeTrialBalance(toAmountRows(input.ledgers));
  const incomingHash = contentHash({
    currency: batch.currency,
    ledgers: input.ledgers.map(toHashable),
    customerRevenue: input.customerRevenue,
    vendorExpense: input.vendorExpense,
    customerCost: input.customerCost,
  });
  let uploadId: string = uuid();
  let status: IngestResult['status'] = 'created';
  let replacedSource: DataSource | null = null;

  await deps.transaction(async (client) => {
    const fy = await lockTrialBalanceWrite(client, companyId, fyId);
    assertYearUnlocked(fy);
    if (decideSourceOwnership(fy.data_source, source, input.options) !== 'allow') throw sourceOwnedError(fy, source);

    const { rows: [current] } = await client.query<{ id: string; currency: string | null; file_sha256: string | null; content_sha256: string | null }>(
      `SELECT id, currency, file_sha256, content_sha256 FROM tb_uploads
       WHERE company_id=$1 AND financial_year_id=$2 AND is_current=TRUE`,
      [companyId, fyId]
    );
    if (batch.fileSha256 && current?.file_sha256 === batch.fileSha256) {
      throw new ApiError(409, `This exact file is already the current Trial Balance for ${fy.label} — nothing changed.`, 'DUPLICATE_FILE');
    }

    // Same figures as the current batch? Then there is nothing to write
    // (DB Phase 1.2 — most scheduled syncs were identical full copies).
    if (current) {
      let currentHash = current.content_sha256;
      if (!currentHash) {
        currentHash = await hashStoredBatch(client, current.id, current.currency ?? batch.currency);
        await client.query(`UPDATE tb_uploads SET content_sha256=$1 WHERE id=$2`, [currentHash, current.id]);
      }
      if (currentHash === incomingHash) {
        if (source === 'excel') {
          throw new ApiError(409, `This file has exactly the same figures as the current Trial Balance for ${fy.label} — nothing changed.`, 'NO_CHANGE');
        }
        status = 'no_change';
        uploadId = current.id;
        return;
      }
    }
    if (fy.data_source && fy.data_source !== source) replacedSource = fy.data_source;

    // companies.currency is only the default offered for the NEXT upload;
    // the batch keeps its own currency, so history is never re-labelled.
    if (input.companyDefaultCurrency) {
      await client.query(`UPDATE companies SET currency=$1, updated_at=NOW() WHERE id=$2`, [input.companyDefaultCurrency, companyId]);
    }

    await input.inTransaction?.(client);

    await client.query(
      `UPDATE tb_uploads SET is_current=FALSE, status='superseded'
       WHERE company_id=$1 AND financial_year_id=$2 AND is_current=TRUE`,
      [companyId, fyId]
    );
    const unmatched = batch.unmatched ?? [];
    await client.query(
      `INSERT INTO tb_uploads
         (id, company_id, financial_year_id, uploaded_by, source, filename, file_size_kb,
          ledger_count, mapped_count, unmatched_count, unmatched_ledgers, coverage_pct, has_monthly_cols,
          status, is_current,
          currency, file_sha256, total_dr, total_cr, balance_diff, is_balanced, validation, data_changed_at, content_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'complete',TRUE,
               $14,$15,$16,$17,$18,$19,$20,NOW(),$21)`,
      [uploadId, companyId, fyId, input.uploadedBy, source, batch.filename ?? null, batch.fileSizeKb ?? null,
       input.ledgers.length, batch.mappedCount, unmatched.length, JSON.stringify(unmatched.slice(0, 50)),
       batch.coveragePct ?? null, batch.hasMonthlyCols,
       batch.currency, batch.fileSha256 ?? null, summary.total_dr, summary.total_cr, summary.balance_diff,
       summary.is_balanced, JSON.stringify(summary.validation), incomingHash]
    );
    if (batch.rawPayloads?.length) await storeRawPayloads(client, { uploadId, companyId, source }, batch.rawPayloads);

    await insertRows(client, 'tb_ledgers', LEDGER_COLUMNS, input.ledgers, (l) => [
      uploadId, companyId, fyId, l.code, l.name,
      l.note_no, l.note_name, l.section, l.treasury_type, l.normal_bal, l.op_dr, l.op_cr,
      l.zoho_account_id ?? null, l.zoho_account_type ?? null, l.depth ?? 0, l.is_child_present ?? false,
    ]);

    // ── Phase D dual-write: ledger_month_amounts ───────────────────────────
    // Runs inside the same transaction as the wide tb_ledgers insert — both
    // succeed or both roll back. The long table is kept in sync on every
    // ingest going forward. Reclassify (note_no/section/treasury_type only)
    // does NOT touch amount columns and therefore does NOT need to touch
    // ledger_month_amounts — only ingestion writes amounts.
    await insertLedgerMonthAmounts(client, uploadId, companyId, fyId, input.ledgers);

    const key = { uploadId, companyId, fyId };
    await insertEntityRows(client, 'tb_customer_revenue', 'zoho_customer_id', 'customer_name', input.customerRevenue, key);
    await insertEntityRows(client, 'tb_vendor_expense', 'zoho_vendor_id', 'vendor_name', input.vendorExpense, key);
    await insertEntityRows(client, 'tb_customer_cost', 'zoho_customer_id', 'customer_name', input.customerCost, key);

    await setYearDataSource(client, fyId, source);
  });

  return { status, uploadId, summary, replacedSource };
}

/**
 * Inserts one row per ledger per month into ledger_month_amounts.
 * Called inside the same transaction as the tb_ledgers insert.
 * fyStartDate is derived from the financial_year's start_date (queried once).
 */
async function insertLedgerMonthAmounts(
  client: PoolClient,
  uploadId: string,
  companyId: string,
  fyId: string,
  ledgers: NormalizedLedger[],
): Promise<void> {
  // The 12 month dates are computed by Postgres with the very same expression
  // the report queries use (fy.start_date + n months), so what is written is
  // always what is read — and nothing depends on the server's time zone
  // (a JS Date built from a DATE shifts a month early on an India-time machine).
  const { rows: monthDates } = await client.query<{ d: string }>(
    `SELECT (fy.start_date + (g.i * INTERVAL '1 month'))::date::text AS d
       FROM financial_years fy, generate_series(0, 11) AS g(i)
      WHERE fy.id = $1 ORDER BY g.i`, [fyId],
  );
  if (monthDates.length !== 12) return; // should never happen inside the same transaction

  // Newly inserted ledger ids + their stable account identity (set by the 0005 trigger).
  const { rows: ledgerIds } = await client.query<{ id: string; account_id: string | null; ledger_code: string | null; ledger_name: string }>(
    `SELECT id, account_id, ledger_code, ledger_name FROM tb_ledgers WHERE upload_id = $1`, [uploadId],
  );
  const idByKey = new Map(ledgerIds.map((r) => [`${r.ledger_code ?? ''}::${r.ledger_name}`, r]));

  const LMA_COLUMNS = ['id', 'company_id', 'batch_id', 'ledger_id', 'account_id', 'period_month', 'dr', 'cr'];

  // Build (ledger × 12 months) rows
  const monthRows: Array<{ ledgerId: string; accountId: string | null; periodMonth: string; dr: number; cr: number }> = [];
  for (const l of ledgers) {
    const row = idByKey.get(`${l.code ?? ''}::${l.name}`);
    // Every ledger was inserted above in this transaction; a miss means its figures would silently vanish.
    if (!row) throw new Error(`Monthly amounts: ledger "${l.name}" was not found in batch ${uploadId}`);
    for (let i = 0; i < 12; i++) {
      monthRows.push({
        ledgerId: row.id,
        accountId: row.account_id,
        periodMonth: monthDates[i].d, // 'YYYY-MM-DD'
        dr: l.months[i]?.dr ?? 0,
        cr: l.months[i]?.cr ?? 0,
      });
    }
  }

  // Chunk-insert (same helper as wide rows, reuse insertRows)
  const LMA_CHUNK = 500; // 8 params × 500 = 4000 < 65535
  for (let i = 0; i < monthRows.length; i += LMA_CHUNK) {
    const params: unknown[] = [];
    const tuples = monthRows.slice(i, i + LMA_CHUNK).map((r) => {
      const base = params.length;
      params.push(randomUUID(), companyId, uploadId, r.ledgerId, r.accountId, r.periodMonth, r.dr, r.cr);
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8})`;
    });
    await client.query(
      `INSERT INTO ledger_month_amounts (${LMA_COLUMNS.join(',')}) VALUES ${tuples.join(',')}
       ON CONFLICT (ledger_id, period_month) DO UPDATE SET dr=EXCLUDED.dr, cr=EXCLUDED.cr`,
      params,
    );
  }
}
