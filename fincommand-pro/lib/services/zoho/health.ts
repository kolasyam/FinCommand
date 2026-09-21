import { query } from '@/lib/db/neon';
import { nextAttemptAt } from './budget';

/**
 * The scheduler retries a company whose Zoho reads keep failing only after a
 * growing wait (15 min -> 1 h -> 6 h -> 24 h) instead of on every tick. It used
 * to retry every tick, and each failed statement sync still fires ~40 requests:
 * a stuck company could spend nearly the whole daily Zoho quota on requests that
 * all fail. Best-effort: bookkeeping must never turn a failure into a bigger one,
 * and it works whether or not migration 0006 has been applied yet.
 */
export async function recordZohoFailure(companyId: string, now: Date = new Date()): Promise<void> {
  try {
    const { rows } = await query<{ consecutive_failures: number }>(
      `UPDATE zoho_config SET consecutive_failures = consecutive_failures + 1 WHERE company_id=$1 RETURNING consecutive_failures`,
      [companyId]
    );
    const failures = rows[0]?.consecutive_failures;
    if (failures) await query(`UPDATE zoho_config SET next_attempt_at=$2 WHERE company_id=$1`, [companyId, nextAttemptAt(failures, now)]);
  } catch (e) {
    console.error('[zoho] could not record the retry back-off:', (e as Error).message);
  }
}

export async function clearZohoFailures(companyId: string): Promise<void> {
  try {
    await query(`UPDATE zoho_config SET consecutive_failures=0, next_attempt_at=NULL WHERE company_id=$1`, [companyId]);
  } catch (e) {
    console.error('[zoho] could not clear the retry back-off:', (e as Error).message);
  }
}
