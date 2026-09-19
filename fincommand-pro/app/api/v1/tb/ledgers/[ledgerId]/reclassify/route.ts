import type { NextRequest } from 'next/server';
import { ApiError, authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { withTransaction } from '@/lib/db/neon';
import { findNoteCatalogEntry } from '@/lib/financial/note-catalog';
import { invalidateReportCache } from '@/lib/cache/report-cache';
import { logAudit } from '@/lib/audit/audit';
import { lockTrialBalanceWrite, type WritableYear } from '@/lib/db/queries/tb-batches';

export const runtime = 'nodejs';

interface LedgerRow {
  id: string; upload_id: string; financial_year_id: string; is_current: boolean;
  ledger_code: string | null; ledger_name: string;
  note_no: number | null; note_name: string | null; section: string | null; treasury_type: string | null; normal_bal: string | null;
}

/**
 * Drag-and-drop reclassification (Notes to Accounts) — a real, user-facing
 * fix for exactly the kind of classifier miscall this session already
 * found and hand-corrected once via a one-off script (a real ledger named
 * "Fixed Deposit- Axis Bank" sat under Cash & Bank instead of Fixed
 * Deposits, from a bad auto-classify call that then stuck via the sticky
 * ledger_master mapping). Rather than requiring a DB script each time this
 * happens, a user can drag the ledger onto the right note and this route
 * does the same two writes by hand: the already-synced ledger data (so the
 * fix is visible immediately, not just on the next sync) and the sticky
 * mapping (so future syncs remember it too).
 *
 * One transaction, holding the trial-balance write lock of every year it
 * touches. Only CURRENT batches of UNLOCKED years change: superseded batches
 * are history, and a locked year is signed off (it used to rewrite both).
 */
export const PATCH = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ ledgerId: string }> }) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.canWrite);
  const { ledgerId } = await params;

  const body = await req.json().catch(() => ({}));
  const targetNoteNo = Number(body.target_note_no);
  const targetSection = String(body.target_section || '');
  if (!Number.isFinite(targetNoteNo) || !targetSection) {
    return json({ error: 'target_note_no and target_section are required' }, { status: 400 });
  }

  // Validate against the same canonical note list the drag-target UI itself
  // is built from — never trust note_no/section/note_name from the client
  // directly, so a buggy or tampered request can't write an arbitrary made-
  // up "note" into real financial data.
  const target = findNoteCatalogEntry(targetNoteNo, targetSection);
  if (!target) {
    return json({ error: `Not a recognized Schedule III note: note ${targetNoteNo} / section ${targetSection}` }, { status: 400 });
  }

  const result = await withTransaction(async (client) => {
    const { rows: existingRows } = await client.query<LedgerRow>(
      `SELECT l.id, l.upload_id, l.financial_year_id, u.is_current, l.ledger_code, l.ledger_name,
              l.note_no, l.note_name, l.section, l.treasury_type, l.normal_bal
       FROM tb_ledgers l JOIN tb_uploads u ON u.id = l.upload_id
       WHERE l.id=$1 AND l.company_id=$2`,
      [ledgerId, user.company_id]
    );
    if (!existingRows.length) throw new ApiError(404, 'Ledger not found');
    const ledger = existingRows[0];
    if (!ledger.is_current) {
      throw new ApiError(409, 'This ledger is from an older upload that has since been replaced — reload and try again.', 'STALE_BATCH');
    }
    if (ledger.note_no === target.note_no && ledger.section === target.section) {
      throw new ApiError(400, 'Ledger is already classified under that note');
    }

    // Every year whose current batch has this ledger (by code), locked in a
    // fixed order so two concurrent requests can't deadlock each other.
    const { rows: yearRows } = await client.query<{ financial_year_id: string }>(
      `SELECT DISTINCT l.financial_year_id
       FROM tb_ledgers l JOIN tb_uploads u ON u.id = l.upload_id AND u.is_current = TRUE
       WHERE l.company_id = $1 AND (l.id = $2 OR ($3::varchar IS NOT NULL AND l.ledger_code = $3))`,
      [user.company_id, ledger.id, ledger.ledger_code]
    );
    const yearIds = [...new Set([ledger.financial_year_id, ...yearRows.map(r => r.financial_year_id)])].sort();
    const years: WritableYear[] = [];
    for (const id of yearIds) years.push(await lockTrialBalanceWrite(client, user.company_id, id));

    const ownYear = years.find(y => y.id === ledger.financial_year_id)!;
    if (ownYear.is_locked) {
      throw new ApiError(403, `${ownYear.label} is locked (post-audit) — its ledgers can't be reclassified.`, 'YEAR_LOCKED');
    }
    const writableYearIds = years.filter(y => !y.is_locked).map(y => y.id);
    const skippedLockedYears = years.filter(y => y.is_locked).map(y => y.label);

    // Note 19 (Cash and Cash Equivalents) covers three real treasury
    // sub-types (cash / bank current / bank savings) that this note-level
    // drop target can't distinguish between — preserve whichever the ledger
    // already had if it's already one of the three (so dropping onto "Note
    // 19" to fix an unrelated note/section mistake doesn't also silently
    // reclassify e.g. a savings account as a current account), and only fall
    // back to the catalog's 'bank_ca' default when it wasn't already one.
    const CASH_SUBTYPES = new Set(['cash', 'bank_ca', 'bank_sb']);
    const targetTreasuryType = target.note_no === 19 && target.section === 'ac' && CASH_SUBTYPES.has(ledger.treasury_type ?? '')
      ? ledger.treasury_type
      : target.treasuryType;

    // The dragged row, plus the same ledger (by code) in the other unlocked
    // years' current data — keeps the correction consistent across years.
    const { rows: updated } = await client.query<{ upload_id: string }>(
      `UPDATE tb_ledgers l SET note_no=$1, note_name=$2, section=$3, treasury_type=$4
       FROM tb_uploads u
       WHERE u.id = l.upload_id AND u.is_current = TRUE
         AND l.company_id = $5 AND l.financial_year_id = ANY($6::uuid[])
         AND (l.id = $7 OR ($8::varchar IS NOT NULL AND l.ledger_code = $8))
       RETURNING l.upload_id`,
      [target.note_no, target.note_name, target.section, targetTreasuryType,
       user.company_id, writableYearIds, ledger.id, ledger.ledger_code]
    );
    const uploadIds = [...new Set(updated.map(r => r.upload_id))];
    // Part of the report cache key — other server instances stop serving the old numbers.
    await client.query(`UPDATE tb_uploads SET data_changed_at = NOW() WHERE id = ANY($1::uuid[])`, [uploadIds]);

    // Sticky mapping — so the next Zoho sync (or a fresh Excel upload using
    // the same ledger identity) remembers this correction instead of
    // re-guessing the same wrong classification via the auto-classifier.
    // One row per company + code (or + name when there is no code) since
    // migration 0002, so this is a plain upsert; is_active is restored
    // because the user has just chosen this mapping explicitly.
    const mappingValues = [user.company_id, ledger.ledger_code, ledger.ledger_name, target.note_no, target.note_name,
      target.section, targetTreasuryType, ledger.normal_bal || 'Dr', user.id];
    const conflictTarget = ledger.ledger_code
      ? `(company_id, ledger_code) WHERE ledger_code IS NOT NULL`
      : `(company_id, lower(btrim(ledger_name))) WHERE ledger_code IS NULL`;
    await client.query(
      `INSERT INTO ledger_master (company_id, ledger_code, ledger_name, note_no, note_name, section, treasury_type, normal_bal, is_global, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,$9)
       ON CONFLICT ${conflictTarget} DO UPDATE SET
         note_no = EXCLUDED.note_no, note_name = EXCLUDED.note_name, section = EXCLUDED.section,
         treasury_type = EXCLUDED.treasury_type, is_active = TRUE, updated_at = NOW()`,
      mappingValues
    );

    return { ledger, targetTreasuryType, rowsUpdated: updated.length, skippedLockedYears };
  });

  // Any cached /reports/all response (production only — dev always
  // computes fresh) would otherwise keep serving the pre-reclassification
  // numbers for up to its 15-minute TTL.
  invalidateReportCache(user.company_id);

  const { ledger, targetTreasuryType } = result;
  const from = { note_no: ledger.note_no, note_name: ledger.note_name, section: ledger.section, treasury_type: ledger.treasury_type };
  const to = { note_no: target.note_no, note_name: target.note_name, section: target.section, treasury_type: targetTreasuryType };
  logAudit(req, user, 'TB_RECLASSIFY', 'tb_ledger', ledger.id, {
    ledger_name: ledger.ledger_name,
    ledger_code: ledger.ledger_code,
    rows_updated: result.rowsUpdated,
    ...(result.skippedLockedYears.length ? { skipped_locked_years: result.skippedLockedYears } : {}),
  }, from, to);

  return json({
    ledger_id: ledger.id,
    ledger_name: ledger.ledger_name,
    from: { note_no: ledger.note_no, note_name: ledger.note_name, section: ledger.section },
    to,
    historical_rows_updated: result.rowsUpdated,
    skipped_locked_years: result.skippedLockedYears,
  });
});
