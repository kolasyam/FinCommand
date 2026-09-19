import type { NextRequest } from 'next/server';
import { ApiError, authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { withTransaction } from '@/lib/db/neon';
import { logAudit } from '@/lib/audit/audit';
import { lockTrialBalanceWrite, assertYearUnlocked } from '@/lib/db/queries/tb-batches';

export const runtime = 'nodejs';

/** Deletes a superseded (never the current) upload. Refused for a locked year; audited. */
export const DELETE = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ uploadId: string }> }) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.canWrite);
  const { uploadId } = await params;

  const deleted = await withTransaction(async (client) => {
    const { rows } = await client.query<{ financial_year_id: string; source: string; filename: string | null; uploaded_at: string; ledger_count: number }>(
      `SELECT financial_year_id, source, filename, uploaded_at, ledger_count
       FROM tb_uploads WHERE id=$1 AND company_id=$2`,
      [uploadId, user.company_id]
    );
    if (!rows.length) throw new ApiError(404, 'Upload not found or is the current active upload');
    const fy = await lockTrialBalanceWrite(client, user.company_id, rows[0].financial_year_id);
    assertYearUnlocked(fy);

    const { rowCount } = await client.query(
      `DELETE FROM tb_uploads WHERE id=$1 AND company_id=$2 AND is_current=FALSE`,
      [uploadId, user.company_id]
    );
    if (!rowCount) throw new ApiError(404, 'Upload not found or is the current active upload');
    return { ...rows[0], fy_label: fy.label };
  });

  logAudit(req, user, 'TB_UPLOAD_DELETE', 'tb_upload', uploadId, {}, deleted, null);
  return json({ message: 'Upload deleted', id: uploadId });
});
