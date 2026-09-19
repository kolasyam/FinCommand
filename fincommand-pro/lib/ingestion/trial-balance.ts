import type { PoolClient } from 'pg';
import { v4 as uuid } from 'uuid';
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

export interface NormalizedLedger {
  /** Stable identity of the account within its source: Zoho account id; Excel code, else the name. */
  sourceKey: string;
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
    rawZohoMonths?: unknown[] | null;
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
  const [ledgers, rev, ven, cost] = await Promise.all([
    client.query(`SELECT * FROM tb_ledgers WHERE upload_id=$1`, [uploadId]),
    client.query(`SELECT zoho_customer_id, customer_name, m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12 FROM tb_customer_revenue WHERE upload_id=$1`, [uploadId]),
    client.query(`SELECT zoho_vendor_id, vendor_name, m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12 FROM tb_vendor_expense WHERE upload_id=$1`, [uploadId]),
    client.query(`SELECT zoho_customer_id, customer_name, m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12 FROM tb_customer_cost WHERE upload_id=$1`, [uploadId]),
  ]);
  return contentHash({
    currency,
    ledgers: ledgers.rows.map(hashableFromStoredLedger),
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
  ...Array.from({ length: 12 }, (_, i) => [`m${i + 1}_dr`, `m${i + 1}_cr`]).flat(),
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
  let uploadId = uuid();
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
          status, is_current, raw_zoho_months,
          currency, file_sha256, total_dr, total_cr, balance_diff, is_balanced, validation, data_changed_at, content_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'complete',TRUE,$14::jsonb,
               $15,$16,$17,$18,$19,$20,$21,NOW(),$22)`,
      [uploadId, companyId, fyId, input.uploadedBy, source, batch.filename ?? null, batch.fileSizeKb ?? null,
       input.ledgers.length, batch.mappedCount, unmatched.length, JSON.stringify(unmatched.slice(0, 50)),
       batch.coveragePct ?? null, batch.hasMonthlyCols,
       batch.rawZohoMonths ? JSON.stringify(batch.rawZohoMonths) : null,
       batch.currency, batch.fileSha256 ?? null, summary.total_dr, summary.total_cr, summary.balance_diff,
       summary.is_balanced, JSON.stringify(summary.validation), incomingHash]
    );

    await insertRows(client, 'tb_ledgers', LEDGER_COLUMNS, input.ledgers, (l) => [
      uploadId, companyId, fyId, l.code, l.name,
      l.note_no, l.note_name, l.section, l.treasury_type, l.normal_bal, l.op_dr, l.op_cr,
      ...l.months.flatMap((mv) => [mv.dr, mv.cr]),
      l.zoho_account_id ?? null, l.zoho_account_type ?? null, l.depth ?? 0, l.is_child_present ?? false,
    ]);

    const key = { uploadId, companyId, fyId };
    await insertEntityRows(client, 'tb_customer_revenue', 'zoho_customer_id', 'customer_name', input.customerRevenue, key);
    await insertEntityRows(client, 'tb_vendor_expense', 'zoho_vendor_id', 'vendor_name', input.vendorExpense, key);
    await insertEntityRows(client, 'tb_customer_cost', 'zoho_customer_id', 'customer_name', input.customerCost, key);

    await setYearDataSource(client, fyId, source);
  });

  return { status, uploadId, summary, replacedSource };
}
