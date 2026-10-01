import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const { rows } = await query(
    `SELECT fy.id, fy.company_id, fy.label, fy.short_label,
            fy.start_date::text AS start_date,
            fy.end_date::text AS end_date,
            fy.year_type, fy.is_locked, fy.created_at,
            (SELECT COUNT(*) FROM tb_uploads t WHERE t.financial_year_id=fy.id AND t.is_current=TRUE) AS has_tb
     FROM financial_years fy
     WHERE fy.company_id=$1 ORDER BY fy.start_date DESC`,
    [user.company_id]
  );
  return json(rows);
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.canWrite);

  const body = await req.json().catch(() => ({}));
  const { label, short_label, start_date, end_date, year_type = 'FY' } = body;
  if (!label || !start_date || !end_date) {
    return json({ error: 'label, start_date, end_date required' }, { status: 400 });
  }
  // Every month of the year is stored as start_date + n months; a start that is not the 1st would
  // make the stored months and the report months disagree.
  if (!/^\d{4}-\d{2}-01$/.test(String(start_date))) {
    return json({ error: 'start_date must be the first day of a month (YYYY-MM-01)' }, { status: 400 });
  }
  try {
    const { rows } = await query(
      `INSERT INTO financial_years (company_id,label,short_label,start_date,end_date,year_type)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, company_id, label, short_label, start_date::text AS start_date, end_date::text AS end_date, year_type, is_locked, created_at`,
      [user.company_id, label, short_label || label, start_date, end_date, year_type]
    );
    return json(rows[0], { status: 201 });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') return json({ error: 'Financial year already exists' }, { status: 409 });
    // Database rules since migration 0001: real date range, no overlap with another year.
    if (code === '23P01') return json({ error: `${label} overlaps the dates of an existing financial year` }, { status: 409 });
    if (code === '23514') return json({ error: 'The start date must be before the end date' }, { status: 400 });
    throw err;
  }
});
