import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  if (!['admin', 'cfo', 'auditor'].includes(user.role)) {
    return json({ error: 'Audit trail access requires admin, cfo, or auditor role' }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;
  const action = searchParams.get('action');
  const userId = searchParams.get('user_id');
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const limit = searchParams.get('limit') || '100';
  const offset = searchParams.get('offset') || '0';

  let q = `SELECT a.*, u.name AS user_name_full
           FROM audit_trail a LEFT JOIN users u ON u.id=a.user_id
           WHERE a.company_id=$1`;
  const params: unknown[] = [user.company_id];
  if (action) { params.push(action); q += ` AND a.action=$${params.length}`; }
  if (userId) { params.push(userId); q += ` AND a.user_id=$${params.length}`; }
  if (from) { params.push(from); q += ` AND a.created_at >= $${params.length}`; }
  if (to) { params.push(to); q += ` AND a.created_at <= $${params.length}`; }
  params.push(Math.min(+limit, 500));
  q += ` ORDER BY a.created_at DESC LIMIT $${params.length}`;
  params.push(+offset);
  q += ` OFFSET $${params.length}`;

  const { rows } = await query(q, params);
  const { rows: cnt } = await query<{ count: string }>(`SELECT COUNT(*) FROM audit_trail WHERE company_id=$1`, [user.company_id]);

  return json({ total: parseInt(cnt[0].count), rows });
});
