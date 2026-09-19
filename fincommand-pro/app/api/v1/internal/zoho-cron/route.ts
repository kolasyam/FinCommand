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
 *
 * Fails closed in production: with no CRON_SECRET configured this route
 * used to be open to anyone, letting any caller trigger syncs for every
 * company. Vercel Cron sends `Authorization: Bearer $CRON_SECRET` itself.
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const secret = req.headers.get('authorization');
  if (!process.env.CRON_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[zoho-cron] CRON_SECRET is not set — refusing to run.');
      return json({ error: 'Cron is not configured' }, { status: 503 });
    }
  } else if (secret !== `Bearer ${process.env.CRON_SECRET}`) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results: { company_id: string; status: string; error?: string; skipped?: string }[] = [];
  // sync_frequency gates *which* companies are due, not just whether cron
  // applies to them at all — this previously only excluded 'manual', so a
  // company configured for 'daily' (or 'hourly') sync was being re-synced on
  // every single cron tick regardless of how recently it last succeeded,
  // firing far more often than the CFO actually configured. Gated on
  // last_synced_at (set only on a *successful* completion — see
  // syncFromZoho) rather than updated_at (bumped on every attempt including
  // failures): a company stuck failing is retried on every cron tick until
  // it recovers, but a healthy one is left alone between its own configured
  // intervals. NULL last_synced_at (never yet synced) always qualifies.
  const { rows } = await query<{ company_id: string; fy_id: string }>(
    `SELECT zc.company_id, fy.id AS fy_id
     FROM zoho_config zc
     JOIN financial_years fy ON fy.company_id=zc.company_id
     WHERE zc.is_active=TRUE AND zc.org_id IS NOT NULL
       AND zc.sync_frequency != 'manual'
       AND fy.is_locked=FALSE
       -- "First source owns the year": never touch a year loaded from Excel
       -- (syncFromZoho's scheduled mode also skips one, if it changes mid-run).
       AND (fy.data_source IS NULL OR fy.data_source = 'zoho')
       AND fy.end_date >= NOW()-INTERVAL '1 year'
       AND (
         zc.last_synced_at IS NULL
         OR (zc.sync_frequency='15min' AND zc.last_synced_at <= NOW() - INTERVAL '15 minutes')
         OR (zc.sync_frequency='hourly' AND zc.last_synced_at <= NOW() - INTERVAL '1 hour')
         OR (zc.sync_frequency='daily' AND zc.last_synced_at <= NOW() - INTERVAL '1 day')
       )
     ORDER BY fy.start_date DESC`
  );
  for (const row of rows) {
    try {
      const r = await syncFromZoho(row.company_id, row.fy_id, null, { scheduled: true });
      results.push(r.skipped ? { company_id: row.company_id, status: 'skipped', skipped: r.skipped } : { company_id: row.company_id, status: 'ok' });
    } catch (e) {
      results.push({ company_id: row.company_id, status: 'error', error: (e as Error).message });
    }
  }

  return json({ ran_at: new Date().toISOString(), results });
});
