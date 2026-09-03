import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const { searchParams } = req.nextUrl;
  const section = searchParams.get('section');
  const noteNo = searchParams.get('note_no');
  const search = searchParams.get('search');

  let q = `SELECT * FROM ledger_master WHERE (company_id=$1 OR company_id IS NULL) AND is_active=TRUE`;
  const params: unknown[] = [user.company_id];
  if (section) { params.push(section); q += ` AND section=$${params.length}`; }
  if (noteNo) { params.push(noteNo); q += ` AND note_no=$${params.length}`; }
  if (search) { params.push(`%${search}%`); q += ` AND ledger_name ILIKE $${params.length}`; }
  q += ' ORDER BY note_no, ledger_name';

  const { rows } = await query(q, params);
  return json(rows);
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.canWrite);

  const body = await req.json().catch(() => ({}));
  const { ledger_code, ledger_name, note_no, note_name, section, treasury_type, normal_bal } = body;
  if (!ledger_name || !note_no || !section) {
    return json({ error: 'ledger_name, note_no, section required' }, { status: 400 });
  }
  const { rows } = await query(
    `INSERT INTO ledger_master
       (company_id,ledger_code,ledger_name,note_no,note_name,section,treasury_type,normal_bal,is_global,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,$9)
     ON CONFLICT DO NOTHING RETURNING *`,
    [user.company_id, ledger_code || null, ledger_name, note_no, note_name || null,
     section, treasury_type || null, normal_bal || 'Dr', user.id]
  );
  return json(rows[0] || { message: 'Already exists' }, { status: 201 });
});
