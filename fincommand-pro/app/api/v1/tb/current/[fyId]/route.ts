import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ fyId: string }> }) => {
  const user = await authenticate(req);
  const { fyId } = await params;

  const { rows } = await query(
    `SELECT t.*, fy.label AS fy_label
     FROM tb_uploads t JOIN financial_years fy ON fy.id=t.financial_year_id
     WHERE t.company_id=$1 AND t.financial_year_id=$2 AND t.is_current=TRUE
     LIMIT 1`,
    [user.company_id, fyId]
  );
  if (!rows.length) return json({ error: 'No TB uploaded for this financial year' }, { status: 404 });
  return json(rows[0]);
});
