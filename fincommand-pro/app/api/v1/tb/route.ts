import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const { searchParams } = req.nextUrl;

  const limitRaw = searchParams.get('limit');
  const offsetRaw = searchParams.get('offset');
  if (limitRaw !== null && (!/^\d+$/.test(limitRaw) || +limitRaw < 1 || +limitRaw > 100)) {
    return json({ errors: [{ field: 'limit', message: 'limit must be 1-100' }] }, { status: 422 });
  }
  if (offsetRaw !== null && (!/^\d+$/.test(offsetRaw) || +offsetRaw < 0)) {
    return json({ errors: [{ field: 'offset', message: 'offset must be >= 0' }] }, { status: 422 });
  }

  const { rows } = await query(
    `SELECT t.*, fy.label AS fy_label, u.name AS uploaded_by_name
     FROM tb_uploads t
     JOIN financial_years fy ON fy.id = t.financial_year_id
     JOIN users u ON u.id = t.uploaded_by
     WHERE t.company_id = $1
     ORDER BY t.uploaded_at DESC LIMIT 50`,
    [user.company_id]
  );
  return json(rows);
});
