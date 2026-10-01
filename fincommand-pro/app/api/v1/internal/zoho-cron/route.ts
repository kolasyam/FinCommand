import type { NextRequest } from 'next/server';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';
import { checkCronSecret } from '@/lib/auth/cron-auth';
import { syncFromZoho } from '@/lib/services/zoho';
import { runAsCompany } from '@/lib/db/tenant-context';

export const runtime = 'nodejs';
// Without this the platform default applies and a long list of companies is cut off mid-sync.
export const maxDuration = 60;

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
  const denied = checkCronSecret(req, 'zoho-cron');
  if (denied) return denied;

  const startedAt = Date.now();
  // Stop STARTING new syncs well before the function is killed; whatever is left is picked up on the next tick
  // (the list is ordered least-recently-synced first, so every company gets its turn).
  const budgetMs = parseInt(process.env.ZOHO_CRON_BUDGET_MS || '', 10) || 40_000;

  // A sync whose function was killed never wrote its end state — close those logs so they don't sit on "running" forever.
  await query(
    `UPDATE sync_logs SET status='error', error_message='Sync did not finish (the server stopped it)', completed_at=NOW()
      WHERE status='running' AND started_at < NOW() - INTERVAL '30 minutes'`
  ).catch((e: Error) => console.error('[zoho-cron] stale sync-log cleanup failed:', e.message));

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
     WHERE zc.is_active=TRUE AND zc.org_id IS NOT NULL AND zc.refresh_token IS NOT NULL
       AND zc.sync_frequency != 'manual'
       -- A company that keeps failing waits 15 min, 1 h, 6 h, 24 h between tries (health.ts) instead of
       -- being retried on every tick, each try spending ~40 of its daily Zoho API calls.
       AND (zc.next_attempt_at IS NULL OR zc.next_attempt_at <= NOW())
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
     ORDER BY zc.last_synced_at ASC NULLS FIRST, fy.start_date DESC`
  );
  for (const row of rows) {
    if (Date.now() - startedAt > budgetMs) { results.push({ company_id: row.company_id, status: 'deferred', skipped: 'time budget used — next run' }); continue; }
    try {
      // The company list above is read on the system connection; each company's sync then runs AS that company,
      // so under row-level security a bug in one sync cannot touch another company's rows.
      const r = await runAsCompany(row.company_id, () => syncFromZoho(row.company_id, row.fy_id, null, { scheduled: true }));
      results.push(r.skipped ? { company_id: row.company_id, status: 'skipped', skipped: r.skipped } : { company_id: row.company_id, status: 'ok' });
    } catch (e) {
      results.push({ company_id: row.company_id, status: 'error', error: (e as Error).message });
    }
  }

  return json({ ran_at: new Date().toISOString(), results });
}, { system: true });
