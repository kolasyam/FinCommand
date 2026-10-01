import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';
import { logAudit } from '@/lib/audit/audit';
import { invalidateReportCache } from '@/lib/cache/report-cache';

export const runtime = 'nodejs';

/**
 * Re-opens a locked financial year (admin only, always audited). A year used to be lockable but never
 * unlockable, so one mistaken click was permanent. A reason is required so the audit trail says why.
 */
export const PUT = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isAdmin);
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 5) return json({ error: 'Give a reason (at least 5 characters) for re-opening a locked year' }, { status: 400 });

  const { rows } = await query(
    `UPDATE financial_years SET is_locked=FALSE, locked_by=NULL, locked_at=NULL
     WHERE id=$1 AND company_id=$2 AND is_locked=TRUE
     RETURNING id, label, is_locked`,
    [id, user.company_id]
  );
  if (!rows.length) return json({ error: 'Year not found or not locked' }, { status: 404 });

  invalidateReportCache(user.company_id);
  logAudit(req, user, 'FY_UNLOCK', 'financial_year', id, { reason, label: rows[0].label });
  return json({ message: 'Financial year re-opened', fy: rows[0] });
});
