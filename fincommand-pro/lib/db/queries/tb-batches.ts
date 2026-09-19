import type { PoolClient } from 'pg';
import { query } from '@/lib/db/neon';
import { ApiError } from '@/lib/auth/permissions';
import type { DataSource } from '@/lib/financial/tb-validation';
import { tbWriteLockKey } from '@/lib/db/tb-write-lock';

/**
 * tb_uploads columns safe to send to the browser, for a table aliased `t`.
 * Deliberately NOT `t.*`: raw_zoho_months holds every raw Zoho response of
 * the sync (hundreds of KB per batch) and file_sha256 is internal.
 */
export const TB_UPLOAD_PUBLIC_COLUMNS = `
  t.id, t.company_id, t.financial_year_id, t.uploaded_by, t.source, t.filename, t.file_size_kb,
  t.ledger_count, t.mapped_count, t.unmatched_count, t.unmatched_ledgers, t.coverage_pct,
  t.has_monthly_cols, t.status, t.error_message, t.is_current, t.uploaded_at,
  t.currency, t.total_dr, t.total_cr, t.balance_diff, t.is_balanced, t.validation, t.data_changed_at`;

export interface WritableYear {
  id: string;
  label: string;
  is_locked: boolean;
  data_source: DataSource | null;
}

/**
 * Serialises every write to one company + year's trial balance — Excel
 * upload, Zoho sync, reclassify, batch delete — and returns the year as it
 * stands once the lock is held. Call it first inside withTransaction().
 *
 * pg_advisory_xact_lock is released automatically at COMMIT/ROLLBACK (and is
 * safe through Neon's transaction-mode pooler). lock_timeout bounds the wait:
 * a second writer gets a 55P03 after 15s, which withErrorHandling() turns into
 * a friendly 409, instead of hanging until the 30s statement timeout. The
 * year row is re-read FOR UPDATE, so a lock/unlock of the year can't slip in
 * between this check and the write.
 */
export async function lockTrialBalanceWrite(client: PoolClient, companyId: string, fyId: string): Promise<WritableYear> {
  await client.query(`SET LOCAL lock_timeout = '15s'`);
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [tbWriteLockKey(companyId, fyId)]);
  const { rows } = await client.query<WritableYear>(
    `SELECT id, label, is_locked, data_source FROM financial_years WHERE id=$1 AND company_id=$2 FOR UPDATE`,
    [fyId, companyId]
  );
  if (!rows.length) throw new ApiError(404, 'Financial year not found');
  return rows[0];
}

export function assertYearUnlocked(fy: WritableYear): void {
  if (fy.is_locked) throw new ApiError(403, `${fy.label} is locked (post-audit) — its data can't be changed.`, 'YEAR_LOCKED');
}

/** Records which source now owns the year's data ("first source owns the year"). */
export async function setYearDataSource(client: PoolClient, fyId: string, source: DataSource): Promise<void> {
  await client.query(`UPDATE financial_years SET data_source=$2 WHERE id=$1`, [fyId, source]);
}

/**
 * The raw source responses a batch was built from, by label ('P&L Apr',
 * 'BS Opening', …) — for audit and re-processing. Reads the de-duplicated
 * store (migration 0004); batches written before it fall back to their old
 * raw_zoho_months column until that is cleared.
 */
export async function loadBatchRawPayloads(companyId: string, uploadId: string): Promise<{ label: string; payload: unknown }[]> {
  const { rows } = await query<{ label: string; payload: unknown }>(
    `SELECT l.label, p.payload
     FROM upload_raw_payloads l
     JOIN raw_payloads p ON p.id = l.raw_payload_id
     JOIN tb_uploads u ON u.id = l.upload_id
     WHERE l.upload_id = $1 AND u.company_id = $2
     ORDER BY l.label`,
    [uploadId, companyId]
  );
  if (rows.length) return rows;
  const { rows: [legacy] } = await query<{ raw: { month: string; raw_response: unknown }[] | null }>(
    `SELECT raw_zoho_months AS raw FROM tb_uploads WHERE id = $1 AND company_id = $2`, [uploadId, companyId]
  );
  return (legacy?.raw ?? []).map((e) => ({ label: e.month, payload: e.raw_response }));
}

export function sourceName(s: DataSource): string {
  return s === 'zoho' ? 'Zoho Books' : 'an Excel upload';
}
