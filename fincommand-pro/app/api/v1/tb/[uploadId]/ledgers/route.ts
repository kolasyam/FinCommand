import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';
import { TB_UPLOAD_PUBLIC_COLUMNS } from '@/lib/db/queries/tb-batches';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ uploadId: string }> }) => {
  const user = await authenticate(req);
  const { uploadId } = await params;

  const { rows: upload } = await query(
    `SELECT ${TB_UPLOAD_PUBLIC_COLUMNS} FROM tb_uploads t WHERE t.id=$1 AND t.company_id=$2`,
    [uploadId, user.company_id]
  );
  if (!upload.length) return json({ error: 'Upload not found' }, { status: 404 });

  const { searchParams } = req.nextUrl;
  const section = searchParams.get('section');
  const noteNo = searchParams.get('note_no');
  const treasuryType = searchParams.get('treasury_type');

  // Monthly figures live in ledger_month_amounts; hand them back in the familiar m1_dr … m12_cr shape.
  const monthCols = Array.from({ length: 12 }, (_, i) =>
    `COALESCE(MAX(a.dr) FILTER (WHERE a.period_month = fy.start_date + INTERVAL '${i} months'), 0) AS m${i + 1}_dr, ` +
    `COALESCE(MAX(a.cr) FILTER (WHERE a.period_month = fy.start_date + INTERVAL '${i} months'), 0) AS m${i + 1}_cr`).join(', ');
  let q = `SELECT l.*, ${monthCols}
           FROM tb_ledgers l
           JOIN financial_years fy ON fy.id = l.financial_year_id
           LEFT JOIN ledger_month_amounts a ON a.ledger_id = l.id AND a.company_id = l.company_id
           WHERE l.upload_id=$1 AND l.company_id=$2`;
  const qParams: unknown[] = [uploadId, user.company_id];
  if (section) { qParams.push(section); q += ` AND l.section=$${qParams.length}`; }
  if (noteNo) { qParams.push(noteNo); q += ` AND l.note_no=$${qParams.length}`; }
  if (treasuryType) { qParams.push(treasuryType); q += ` AND l.treasury_type=$${qParams.length}`; }
  q += ' GROUP BY l.id, fy.start_date ORDER BY l.ledger_name';

  const { rows } = await query(q, qParams);
  return json({ upload: upload[0], ledgers: rows });
});
