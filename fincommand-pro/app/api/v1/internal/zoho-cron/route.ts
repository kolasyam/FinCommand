import type { NextRequest } from 'next/server';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';
import { syncFromZoho } from '@/lib/services/zoho';

export const runtime = 'nodejs';

/**
 * Vercel Cron entry point — replaces server.js's node-cron scheduler, which
 * relies on a long-lived process and never fires reliably on serverless.
 * Add a `crons` entry in vercel.json pointing at this route (schedule driven
 * by ZOHO_SYNC_CRON), protected by an optional CRON_SECRET bearer token.
 *
 * For local/traditional hosting where a long-lived process is available,
 * an external scheduler (cron, systemd timer) can hit this same endpoint on
 * the ZOHO_SYNC_CRON schedule instead of relying on Vercel Cron.
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const secret = req.headers.get('authorization');
  if (process.env.CRON_SECRET && secret !== `Bearer ${process.env.CRON_SECRET}`) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results: { company_id: string; status: string; error?: string }[] = [];
  const { rows } = await query<{ company_id: string; fy_id: string }>(
    `SELECT zc.company_id, fy.id AS fy_id
     FROM zoho_config zc
     JOIN financial_years fy ON fy.company_id=zc.company_id
     WHERE zc.is_active=TRUE AND zc.org_id IS NOT NULL
       AND zc.sync_frequency != 'manual'
       AND fy.is_locked=FALSE
       AND fy.end_date >= NOW()-INTERVAL '1 year'
     ORDER BY fy.start_date DESC`
  );
  for (const row of rows) {
    try {
      await syncFromZoho(row.company_id, row.fy_id, null);
      results.push({ company_id: row.company_id, status: 'ok' });
    } catch (e) {
      results.push({ company_id: row.company_id, status: 'error', error: (e as Error).message });
    }
  }

  return json({ ran_at: new Date().toISOString(), results });
});
