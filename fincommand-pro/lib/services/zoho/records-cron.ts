import { query } from '@/lib/db/neon';
import { ZOHO_MODULES, ZOHO_REPORTS } from './modules';
import { DEFAULT_SLICE_MS, runModuleSlice } from './records-sync';
import { recordRefreshIntervalMs } from './budget';
import { recordZohoFailure } from './health';
import { runAsCompany } from '@/lib/db/tenant-context';

export interface ScheduledReadResult {
  company_id: string;
  status: 'ok' | 'error';
  stopped?: string;
  calls?: number;
  error?: string;
}

/**
 * The scheduled part of reading Zoho records: keeps the mirror fresh and finishes
 * a first read that stopped part-way (time box, daily allowance).
 *
 * Only companies whose admin has already started a first read are touched, so a
 * schedule never spends someone's API allowance on data they did not ask for.
 * Each company's modules count as "read in this run" if they were read within the
 * refresh interval (hourly, or daily for a daily schedule), so a tick reads only
 * what has gone stale, carries on an open pass, and reads pending detail. A company
 * whose connection is broken is backed off like a failing statement sync.
 */
export async function runScheduledRecordReads(opts: { budgetMs: number; now?: () => number }): Promise<ScheduledReadResult[]> {
  const now = opts.now ?? Date.now;
  const started = now();
  const { rows } = await query<{ company_id: string; sync_frequency: string }>(
    `SELECT zc.company_id, zc.sync_frequency FROM zoho_config zc
      WHERE zc.is_active = TRUE AND zc.org_id IS NOT NULL AND zc.refresh_token IS NOT NULL
        AND zc.sync_frequency <> 'manual'
        AND (zc.next_attempt_at IS NULL OR zc.next_attempt_at <= NOW())
        AND EXISTS (SELECT 1 FROM zoho_module_state s WHERE s.company_id = zc.company_id AND s.last_full_at IS NOT NULL)
      ORDER BY zc.company_id`
  );

  const results: ScheduledReadResult[] = [];
  for (const row of rows) {
    const left = opts.budgetMs - (now() - started);
    if (left < 10_000) break;
    try {
      // The company list is read on the system connection; each company's read runs AS that company.
      const r = await runAsCompany(row.company_id, () => runModuleSlice(row.company_id, {
        modules: ZOHO_MODULES,
        reports: ZOHO_REPORTS,
        scheduled: true,
        mode: 'incremental',
        runStartedAt: new Date(now() - recordRefreshIntervalMs(row.sync_frequency)).toISOString(),
        sliceMs: Math.min(DEFAULT_SLICE_MS, left - 5_000),
      }));
      if (r.stopped === 'auth') await recordZohoFailure(row.company_id);
      results.push({ company_id: row.company_id, status: r.stopped === 'auth' ? 'error' : 'ok', stopped: r.stopped, calls: r.callsMade, error: r.stopped === 'auth' ? r.errors[0] : undefined });
    } catch (e) {
      await recordZohoFailure(row.company_id);
      results.push({ company_id: row.company_id, status: 'error', error: (e as Error).message });
    }
  }
  return results;
}
