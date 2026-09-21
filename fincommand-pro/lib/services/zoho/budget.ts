/**
 * Pure: Zoho API quota arithmetic. Zoho Books allows a fixed number of calls per
 * organisation per day (Free 1,000 · Standard 2,000 · Professional 5,000 ·
 * Premium/Elite/Ultimate 10,000) and 100 per minute. No DB, no clock of its own.
 */

/** Share of the daily allowance the record reads may use (owner decision, 2026-09-21). */
export const MODULE_SHARE = 0.8;

/** Stay under Zoho's 100/min so the statement sync always has room: ~80 calls a minute. */
export const MIN_CALL_GAP_MS = 750;

/** After Zoho's own daily-limit answer (code 45): stop for an hour, then probe once. */
export const DAILY_LIMIT_BLOCK_MS = 60 * 60 * 1000;

/** A statement sync: chart of accounts + 12 P&L + 13 Balance Sheet + 12 Sales by Customer + bills + expenses + contacts. */
export const CALLS_PER_STATEMENT_SYNC = 45;

/** The calendar day usage is counted against (UTC; Zoho's own reset moment is the authority via code 45). */
export function usageDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** How many calls per day the record reads may make, all Zoho calls that day counted. */
export function moduleCallCap(dailyLimit: number, share: number = MODULE_SHARE): number {
  return Math.max(0, Math.floor(dailyLimit * share));
}

export function remainingModuleCalls(dailyLimit: number, usedToday: number, share: number = MODULE_SHARE): number {
  return Math.max(0, moduleCallCap(dailyLimit, share) - usedToday);
}

/**
 * How long a company whose statement sync keeps failing waits before the next
 * scheduled try: 15 min, 1 h, 6 h, then 24 h. 0 failures = no wait.
 */
export function backoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const steps = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
  return steps[Math.min(consecutiveFailures, steps.length) - 1]!;
}

export function nextAttemptAt(consecutiveFailures: number, now: Date): Date | null {
  const wait = backoffMs(consecutiveFailures);
  return wait ? new Date(now.getTime() + wait) : null;
}

/** Three failures in a row: the panel says "needs attention". */
export const NEEDS_ATTENTION_AFTER = 3;

/** Calls per day a statement sync frequency would use if every run reads Zoho. */
export function projectedDailyCalls(frequency: string, callsPerSync: number = CALLS_PER_STATEMENT_SYNC): number {
  const runsPerDay: Record<string, number> = { '15min': 96, hourly: 24, daily: 1, manual: 0 };
  return (runsPerDay[frequency] ?? 1) * callsPerSync;
}

/**
 * How stale a module may get before a scheduled run reads it again. Follows the
 * company's sync frequency but never faster than hourly: an incremental read
 * costs about one call per module, and every 15 minutes would add up.
 */
export function recordRefreshIntervalMs(frequency: string): number {
  return frequency === 'daily' ? 24 * 60 * 60_000 : 60 * 60_000;
}

/** The plans Zoho Books sells, and the API calls a day each allows. */
export const ZOHO_PLAN_LIMITS = { free: 1000, standard: 2000, professional: 5000, premium: 10000 } as const;

export function isValidDailyLimit(n: unknown): n is number {
  return typeof n === 'number' && (Object.values(ZOHO_PLAN_LIMITS) as number[]).includes(n);
}

/** True for Zoho's "daily API limit reached" answer. */
export function isDailyLimitError(err: unknown): boolean {
  return (err as { zohoCode?: number } | null)?.zohoCode === 45;
}

/** True for an HTTP 429 that survived callZoho's own retries (the per-minute window). */
export function isRateLimitedError(err: unknown): boolean {
  const e = err as { status?: number; zohoCode?: number } | null;
  return e?.status === 429 && e.zohoCode !== 45;
}
