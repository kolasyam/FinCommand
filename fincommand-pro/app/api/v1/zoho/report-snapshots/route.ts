import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { latestSnapshots } from '@/lib/db/queries/zoho-records';
import { ZOHO_REPORTS } from '@/lib/services/zoho/modules';

export const runtime = 'nodejs';

/**
 * Zoho's own report totals as last read: the newest snapshot of each period, for the caller's company.
 *   ?report=taxsummary            the periods and when each was read
 *   ?report=taxsummary&include=payload   with Zoho's full response
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.zohoRecords);

  const sp = req.nextUrl.searchParams;
  const report = sp.get('report') ?? '';
  if (!ZOHO_REPORTS.some((r) => r.key === report)) {
    return json({ error: `report must be one of ${ZOHO_REPORTS.map((r) => r.key).join(', ')}` }, { status: 400 });
  }
  return json({ report, snapshots: await latestSnapshots(user.company_id, report, sp.get('include') === 'payload') });
});
