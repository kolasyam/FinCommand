import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';

export const runtime = 'nodejs';

export const PUT = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isAdmin);
  const { id } = await params;

  const { rows } = await query(
    `UPDATE financial_years SET is_locked=TRUE, locked_by=$1, locked_at=NOW()
     WHERE id=$2 AND company_id=$3 RETURNING *`,
    [user.id, id, user.company_id]
  );
  if (!rows.length) return json({ error: 'FY not found' }, { status: 404 });
  return json({ message: 'Financial year locked', fy: rows[0] });
});
