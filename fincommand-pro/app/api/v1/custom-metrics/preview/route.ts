import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { getFY, loadPeriodLedgers, parsePeriodParams } from '@/lib/db/queries/reports';
import { computeLedgerMetric, resolvePeriod, priorPeriodOf } from '@/lib/financial/tb-engine';
import { validateLedgerSpec } from '@/lib/financial/custom-metric-engine';

export const runtime = 'nodejs';

const MAX_PREVIEW_LEDGERS = 25;

/**
 * POST — live preview of an UNSAVED ledger metric against the real Trial
 * Balance for the period the builder is showing: the value, its comparative
 * (same period last year, the previous period, or none — the metric's
 * `comparison`), the monthly trend, and exactly which ledgers matched (so an
 * accountant can verify "contains Salary" didn't also pick up Salary
 * Payable). Nothing is stored. Role-gated like saving a metric (canWrite).
 * Formula metrics need no endpoint — they preview client-side from the
 * already-loaded bundle.
 */
export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.canWrite);

  const body = await req.json().catch(() => ({}));
  const spec = validateLedgerSpec(body.ledgerSpec);
  if (!spec.ok) return json({ error: spec.error }, { status: 400 });
  const fyId = typeof body.fy_id === 'string' ? body.fy_id : '';
  if (!fyId) return json({ error: 'fy_id required' }, { status: 400 });

  const params = parsePeriodParams(new URLSearchParams({
    period_type: typeof body.period_type === 'string' ? body.period_type : 'annual',
    ...(typeof body.period === 'string' && body.period ? { period: body.period } : {}),
    year_type: typeof body.year_type === 'string' ? body.year_type : 'FY',
  }));
  let periodLabel: string;
  try {
    periodLabel = resolvePeriod(params).label;
  } catch {
    return json({ error: 'Invalid period' }, { status: 400 });
  }

  const fy = await getFY(user.company_id, fyId);
  if (!fy) return json({ error: 'Financial year not found' }, { status: 404 });
  const { ledgers, prevLedgers } = await loadPeriodLedgers(user.company_id, fy, params);
  if (!ledgers.length) return json({ error: 'No Trial Balance data found for this financial year.' }, { status: 404 });

  const current = computeLedgerMetric(ledgers, spec.spec, params);
  const comparison = body.comparison === 'prior_period' || body.comparison === 'none' ? body.comparison : 'prior_year';
  let previous: ReturnType<typeof computeLedgerMetric> | null = null;
  if (comparison === 'prior_year') {
    previous = prevLedgers ? computeLedgerMetric(prevLedgers, spec.spec, params) : null;
  } else if (comparison === 'prior_period') {
    // Same rule reports/all uses for the dashboard: Q2–Q4 / H2 from this
    // year's ledgers, Q1 / H1 / a whole year from the previous FY.
    const pp = priorPeriodOf(params);
    const ppLedgers = pp ? (pp.source === 'same' ? ledgers : prevLedgers) : null;
    previous = pp && ppLedgers ? computeLedgerMetric(ppLedgers, spec.spec, pp.params) : null;
  }
  return json({
    value: current.value,
    previous: previous && previous.matchedCount > 0 ? previous.value : null,
    trend: current.trend,
    matchedCount: current.matchedCount,
    matchedLedgers: current.breakdown.slice(0, MAX_PREVIEW_LEDGERS),
    periodLabel,
  });
});
