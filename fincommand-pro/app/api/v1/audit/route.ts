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
  // Bad paging or date values are the caller's mistake (400), not a server crash.
  const limit = searchParams.has('limit') ? Number(searchParams.get('limit')) : 100;
  const offset = searchParams.has('offset') ? Number(searchParams.get('offset')) : 0;
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) {
    return json({ error: 'limit must be a positive whole number and offset a non-negative whole number' }, { status: 400 });
  }
  if ((from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to)))) {
    return json({ error: 'from and to must be valid dates' }, { status: 400 });
  }
  if (userId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return json({ error: 'user_id must be a valid id' }, { status: 400 });
  }

  let whereClauses = `WHERE a.company_id=$1`;
  const params: unknown[] = [user.company_id];
  if (action) { params.push(action); whereClauses += ` AND a.action=$${params.length}`; }
  if (userId) { params.push(userId); whereClauses += ` AND a.user_id=$${params.length}`; }
  if (from) { params.push(from); whereClauses += ` AND a.created_at >= $${params.length}`; }
  if (to) { params.push(to); whereClauses += ` AND a.created_at <= $${params.length}`; }

  const countParams = [...params];

  let q = `SELECT a.*, u.name AS user_name_full
           FROM audit_trail a LEFT JOIN users u ON u.id=a.user_id
           ${whereClauses}`;
  
  params.push(Math.min(limit, 500));
  q += ` ORDER BY a.created_at DESC LIMIT $${params.length}`;
  params.push(offset);
  q += ` OFFSET $${params.length}`;

  const { rows } = await query(q, params);
  const { rows: cnt } = await query<{ count: string }>(
    `SELECT COUNT(*) FROM audit_trail a ${whereClauses}`, 
    countParams
  );

  return json({ total: parseInt(cnt[0].count), rows });
});
