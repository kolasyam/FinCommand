import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';

export const runtime = 'nodejs';

export const PUT = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.canWrite);
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const { note_no, note_name, section, treasury_type, normal_bal } = body;
  const { rows } = await query(
    `UPDATE ledger_master SET
       note_no=COALESCE($1,note_no), note_name=COALESCE($2,note_name),
       section=COALESCE($3,section), treasury_type=$4,
       normal_bal=COALESCE($5,normal_bal), updated_at=NOW()
     WHERE id=$6 AND company_id=$7 RETURNING *`,
    [note_no ?? null, note_name ?? null, section ?? null, treasury_type || null, normal_bal ?? null, id, user.company_id]
  );
  if (!rows.length) return json({ error: 'Mapping not found' }, { status: 404 });
  return json(rows[0]);
});

export const DELETE = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.canWrite);
  const { id } = await params;

  await query(`UPDATE ledger_master SET is_active=FALSE WHERE id=$1 AND company_id=$2`, [id, user.company_id]);
  return json({ message: 'Mapping deactivated' });
});
