import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { validateReportQuery } from '@/lib/validations/common';
import { getFY, loadLedgers, parsePeriodParams } from '@/lib/db/queries/reports';
import { computeNotes } from '@/lib/financial/tb-engine';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const { searchParams } = req.nextUrl;

  const errors = validateReportQuery(searchParams);
  if (errors.length) return json({ errors }, { status: 422 });

  const fyId = searchParams.get('fy_id');
  const noteNo = searchParams.get('note_no');
  if (!fyId) return json({ error: 'fy_id required' }, { status: 400 });

  const fy = await getFY(user.company_id, fyId);
  if (!fy) return json({ error: 'Financial year not found' }, { status: 404 });

  const ledgers = await loadLedgers(user.company_id, fyId);
  if (!ledgers.length) return json({ error: 'No Trial Balance data found.' }, { status: 404 });

  const params = parsePeriodParams(searchParams);
  const notes = computeNotes(ledgers, params);

  const filtered = noteNo
    ? Object.fromEntries(Object.entries(notes).filter(([k]) => k === String(noteNo)))
    : notes;

  const sorted = Object.values(filtered).sort((a, b) => a.note_no - b.note_no);

  return json({
    financial_year: fy,
    period_params: params,
    total_notes: sorted.length,
    notes: sorted,
    generated_at: new Date().toISOString(),
  });
});
