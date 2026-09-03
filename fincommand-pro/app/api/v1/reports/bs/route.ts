import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { validateReportQuery } from '@/lib/validations/common';
import { getFY, loadLedgers, parsePeriodParams } from '@/lib/db/queries/reports';
import { computeBS, resolvePeriod } from '@/lib/financial/tb-engine';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const { searchParams } = req.nextUrl;

  const errors = validateReportQuery(searchParams);
  if (errors.length) return json({ errors }, { status: 422 });

  const fyId = searchParams.get('fy_id');
  if (!fyId) return json({ error: 'fy_id required' }, { status: 400 });

  const fy = await getFY(user.company_id, fyId);
  if (!fy) return json({ error: 'Financial year not found' }, { status: 404 });

  const ledgers = await loadLedgers(user.company_id, fyId);
  if (!ledgers.length) return json({ error: 'No Trial Balance data found. Upload TB first.' }, { status: 404 });

  const params = parsePeriodParams(searchParams);
  const result = computeBS(ledgers, params);
  const resolved = resolvePeriod(params);

  return json({
    financial_year: fy,
    period_params: params,
    period_end: resolved.periodEnd || fy.end_date,
    period_label: resolved.label,
    ...result,
    generated_at: new Date().toISOString(),
    ind_as_note: 'Balance Sheet prepared as per Schedule III of Companies Act 2013 — IND AS. Closing balance = Opening + Σ monthly movements to period end.',
  });
});
