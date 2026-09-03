import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ uploadId: string }> }) => {
  const user = await authenticate(req);
  const { uploadId } = await params;

  const { rows: upload } = await query(`SELECT * FROM tb_uploads WHERE id=$1 AND company_id=$2`, [uploadId, user.company_id]);
  if (!upload.length) return json({ error: 'Upload not found' }, { status: 404 });

  const { searchParams } = req.nextUrl;
  const section = searchParams.get('section');
  const noteNo = searchParams.get('note_no');
  const treasuryType = searchParams.get('treasury_type');

  let q = `SELECT * FROM tb_ledgers WHERE upload_id=$1`;
  const qParams: unknown[] = [uploadId];
  if (section) { qParams.push(section); q += ` AND section=$${qParams.length}`; }
  if (noteNo) { qParams.push(noteNo); q += ` AND note_no=$${qParams.length}`; }
  if (treasuryType) { qParams.push(treasuryType); q += ` AND treasury_type=$${qParams.length}`; }
  q += ' ORDER BY ledger_name';

  const { rows } = await query(q, qParams);
  return json({ upload: upload[0], ledgers: rows });
});
