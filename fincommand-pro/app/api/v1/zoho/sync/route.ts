import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { syncFromZoho } from '@/lib/services/zoho';
import { invalidateReportCache } from '@/lib/cache/report-cache';

export const runtime = 'nodejs';

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isCFO);

  const body = await req.json().catch(() => ({}));
  const fy_id = body.fy_id as string | undefined;
  if (!fy_id) return json({ error: 'fy_id required' }, { status: 400 });

  // syncFromZoho() records its own failures on zoho_config/sync_logs — but
  // only once it has actually started. A rejection (year locked, year owned
  // by an Excel upload → SOURCE_OWNED, another sync already running) must
  // not mark anything: this route used to set 'error' for every throw,
  // overwriting the status of the sync that was genuinely running.
  const result = await syncFromZoho(user.company_id, fy_id, user.id, { confirmReplace: body.confirm_replace === true });
  if (result.unchanged) {
    return json({ message: 'Zoho Books is up to date — nothing changed since the last sync', ...result });
  }
  invalidateReportCache(user.company_id);
  return json({ message: 'Zoho Books sync complete', ...result });
});
