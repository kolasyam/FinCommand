import type { NextRequest } from 'next/server';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';
import { checkCronSecret } from '@/lib/auth/cron-auth';

export const runtime = 'nodejs';

/**
 * Keeps the Neon compute awake. Neon suspends an idle compute after a few
 * minutes; the first request after that waits for it to wake (seconds). A
 * scheduler (vercel.json `crons`) calls this every 4 minutes with a trivial
 * query, so the database never gets the chance to suspend. Costs compute
 * hours: the compute now runs around the clock — see docs/LATENCY.md §5.
 *
 * Same CRON_SECRET guard as /internal/zoho-cron. Long-lived servers don't need
 * this: lib/db/neon.ts pings by itself (DB_KEEPALIVE_MS).
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const denied = checkCronSecret(req, 'keepalive');
  if (denied) return denied;

  const started = performance.now();
  await query('SELECT 1');
  // `ms` is how long the database took to answer — a wake-up shows as seconds.
  return json({ ok: true, ms: Math.round(performance.now() - started) });
});
