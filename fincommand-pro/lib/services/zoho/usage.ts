import { query } from '@/lib/db/neon';
import { usageDay, moduleCallCap } from './budget';

/**
 * Zoho API calls per company per day. callZoho() counts every call in memory
 * (no extra database round trip per call); the total is written with one
 * upsert when a sync or read slice ends. Counts from separate server
 * instances add up, so the figure is close, not exact - Zoho's own
 * daily-limit answer (code 45) is the authority.
 */
const pending = new Map<string, number>();

export function noteZohoCall(companyId: string, n = 1): void {
  pending.set(companyId, (pending.get(companyId) ?? 0) + n);
}

export function unflushedCalls(companyId: string): number {
  return pending.get(companyId) ?? 0;
}

/** Writes this process's counted calls. Never throws: usage tracking must not break a sync. */
export async function flushZohoUsage(companyId: string, now: Date = new Date()): Promise<void> {
  const n = pending.get(companyId) ?? 0;
  if (!n) return;
  pending.delete(companyId);
  try {
    await query(
      `INSERT INTO zoho_api_usage (company_id, day, calls) VALUES ($1, $2, $3)
       ON CONFLICT (company_id, day) DO UPDATE SET calls = zoho_api_usage.calls + EXCLUDED.calls`,
      [companyId, usageDay(now), n]
    );
  } catch (e) {
    pending.set(companyId, (pending.get(companyId) ?? 0) + n);
    console.warn('Zoho usage not recorded:', (e as Error).message);
  }
}

export interface ZohoUsage {
  used: number;
  dailyLimit: number;
  moduleCap: number;
  blockedUntil: string | null;
}

/** Today's calls (stored + not yet written) against the company's daily allowance. */
export async function getZohoUsage(companyId: string, now: Date = new Date()): Promise<ZohoUsage> {
  const [usage, cfg] = await Promise.all([
    query<{ calls: number; blocked_until: string | null }>(
      `SELECT calls, blocked_until FROM zoho_api_usage WHERE company_id=$1 AND day=$2`, [companyId, usageDay(now)]),
    query<{ api_daily_limit: number }>(`SELECT api_daily_limit FROM zoho_config WHERE company_id=$1`, [companyId]),
  ]);
  const dailyLimit = cfg.rows[0]?.api_daily_limit ?? 1000;
  return {
    used: (usage.rows[0]?.calls ?? 0) + unflushedCalls(companyId),
    dailyLimit,
    moduleCap: moduleCallCap(dailyLimit),
    blockedUntil: usage.rows[0]?.blocked_until ? new Date(usage.rows[0].blocked_until).toISOString() : null,
  };
}

/** Zoho said the daily limit is spent: nothing reads this company until `until`. */
export async function blockZohoUntil(companyId: string, until: Date, now: Date = new Date()): Promise<void> {
  await query(
    `INSERT INTO zoho_api_usage (company_id, day, calls, blocked_until) VALUES ($1, $2, 0, $3)
     ON CONFLICT (company_id, day) DO UPDATE SET blocked_until = EXCLUDED.blocked_until`,
    [companyId, usageDay(now), until]
  );
}
