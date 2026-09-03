import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';

export const runtime = 'nodejs';

export const DELETE = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ uploadId: string }> }) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.canWrite);
  const { uploadId } = await params;

  const { rows } = await query(
    `DELETE FROM tb_uploads WHERE id=$1 AND company_id=$2 AND is_current=FALSE RETURNING id`,
    [uploadId, user.company_id]
  );
  if (!rows.length) return json({ error: 'Upload not found or is the current active upload' }, { status: 404 });
  return json({ message: 'Upload deleted', id: uploadId });
});
