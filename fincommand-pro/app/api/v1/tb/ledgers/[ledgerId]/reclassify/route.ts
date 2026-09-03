import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';
import { findNoteCatalogEntry } from '@/lib/financial/note-catalog';
import { invalidateReportCache } from '@/lib/cache/report-cache';

export const runtime = 'nodejs';

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

  const { rows: existingRows } = await query(
    `SELECT id, company_id, ledger_code, ledger_name, note_no, note_name, section, treasury_type, normal_bal
     FROM tb_ledgers WHERE id=$1 AND company_id=$2`,
    [ledgerId, user.company_id]
  );
  if (!existingRows.length) return json({ error: 'Ledger not found' }, { status: 404 });
  const ledger = existingRows[0];

  if (ledger.note_no === target.note_no && ledger.section === target.section) {
    return json({ error: 'Ledger is already classified under that note' }, { status: 400 });
  }

  // Note 19 (Cash and Cash Equivalents) covers three real treasury
  // sub-types (cash / bank current / bank savings) that this note-level
  // drop target can't distinguish between — preserve whichever the ledger
  // already had if it's already one of the three (so dropping onto "Note
  // 19" to fix an unrelated note/section mistake doesn't also silently
  // reclassify e.g. a savings account as a current account), and only fall
  // back to the catalog's 'bank_ca' default when it wasn't already one.
  const CASH_SUBTYPES = new Set(['cash', 'bank_ca', 'bank_sb']);
  const targetTreasuryType = target.note_no === 19 && target.section === 'ac' && CASH_SUBTYPES.has(ledger.treasury_type)
    ? ledger.treasury_type
    : target.treasuryType;

  // Update the specific row the user actually dragged first — this is what
  // makes the fix visible immediately, independent of whether the broader
  // ledger_code-matched update below finds anything else to touch.
  await query(
    `UPDATE tb_ledgers SET note_no=$1, note_name=$2, section=$3, treasury_type=$4 WHERE id=$5`,
    [target.note_no, target.note_name, target.section, targetTreasuryType, ledger.id]
  );

  // Same real ledger (by code) may also appear in other financial years'
  // already-synced data — keep the correction consistent across all of
  // them rather than leaving history half-fixed, same as the one-off
  // script this route replaces.
  let historicalRowsUpdated = 1;
  if (ledger.ledger_code) {
    const { rowCount } = await query(
      `UPDATE tb_ledgers SET note_no=$1, note_name=$2, section=$3, treasury_type=$4
       WHERE company_id=$5 AND ledger_code=$6`,
      [target.note_no, target.note_name, target.section, targetTreasuryType, user.company_id, ledger.ledger_code]
    );
    historicalRowsUpdated = rowCount ?? 1;
  }

  // Sticky mapping — so the next Zoho sync (or a fresh Excel upload using
  // the same ledger identity) remembers this correction instead of
  // re-guessing the same wrong classification via the auto-classifier.
  let mappingUpdated = false;
  if (ledger.ledger_code) {
    const { rowCount } = await query(
      `UPDATE ledger_master SET note_no=$1, note_name=$2, section=$3, treasury_type=$4, updated_at=NOW()
       WHERE company_id=$5 AND ledger_code=$6`,
      [target.note_no, target.note_name, target.section, targetTreasuryType, user.company_id, ledger.ledger_code]
    );
    mappingUpdated = (rowCount ?? 0) > 0;
  }
  if (!mappingUpdated) {
    await query(
      `INSERT INTO ledger_master (company_id, ledger_code, ledger_name, note_no, note_name, section, treasury_type, normal_bal, is_global, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,$9)`,
      [user.company_id, ledger.ledger_code || null, ledger.ledger_name, target.note_no, target.note_name,
       target.section, targetTreasuryType, ledger.normal_bal || 'Dr', user.id]
    );
  }

  // Any cached /reports/all response (production only — dev always
  // computes fresh) would otherwise keep serving the pre-reclassification
  // numbers for up to its 15-minute TTL.
  invalidateReportCache(user.company_id);

  return json({
    ledger_id: ledger.id,
    ledger_name: ledger.ledger_name,
    from: { note_no: ledger.note_no, note_name: ledger.note_name, section: ledger.section },
    to: { note_no: target.note_no, note_name: target.note_name, section: target.section, treasury_type: targetTreasuryType },
    historical_rows_updated: historicalRowsUpdated,
  });
});
