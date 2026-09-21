import type { NextRequest } from 'next/server';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { checkCronSecret } from '@/lib/auth/cron-auth';
import { runScheduledRecordReads } from '@/lib/services/zoho/records-cron';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Vercel Cron entry point for keeping the mirrored Zoho records fresh (see
 * lib/services/zoho/records-cron.ts). Same CRON_SECRET guard as /internal/zoho-cron.
 * Only companies whose admin has already started a first read are touched.
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const denied = checkCronSecret(req, 'zoho-records-cron');
  if (denied) return denied;

  const results = await runScheduledRecordReads({ budgetMs: 55_000 });
  return json({ ran_at: new Date().toISOString(), results });
});
