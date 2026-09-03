import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';
import { syncFromZoho } from '@/lib/services/zoho';
import { invalidateReportCache } from '@/lib/cache/report-cache';

export const runtime = 'nodejs';

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isCFO);

  const body = await req.json().catch(() => ({}));
  const fy_id = body.fy_id as string | undefined;
  if (!fy_id) return json({ error: 'fy_id required' }, { status: 400 });

  try {
    const result = await syncFromZoho(user.company_id, fy_id, user.id);
    invalidateReportCache(user.company_id);
    return json({ message: 'Zoho Books sync complete', ...result });
  } catch (err) {
    await query(
      `UPDATE zoho_config SET last_sync_status='error',last_sync_error=$1 WHERE company_id=$2`,
      [(err as Error).message, user.company_id]
    ).catch(() => {});
    throw err;
  }
});
