import {
  MODULE_SHARE, MIN_CALL_GAP_MS, usageDay, moduleCallCap, remainingModuleCalls, backoffMs, nextAttemptAt,
  projectedDailyCalls, isDailyLimitError, isRateLimitedError, NEEDS_ATTENTION_AFTER,
} from '@/lib/services/zoho/budget';

describe('Zoho API budget', () => {
  test('module reads may use 80% of the day, counting every Zoho call', () => {
    expect(MODULE_SHARE).toBe(0.8);
    expect(moduleCallCap(5000)).toBe(4000);
    expect(moduleCallCap(1000)).toBe(800);
    expect(remainingModuleCalls(5000, 1500)).toBe(2500);
    expect(remainingModuleCalls(5000, 4200)).toBe(0);
  });

  test('pacing stays under Zoho\'s 100 a minute', () => {
    expect(60_000 / MIN_CALL_GAP_MS).toBeLessThanOrEqual(80);
  });

  test('the usage day is the UTC date', () => {
    expect(usageDay(new Date('2026-09-21T23:59:59Z'))).toBe('2026-09-21');
    expect(usageDay(new Date('2026-09-22T00:00:00Z'))).toBe('2026-09-22');
  });
});

describe('retry back-off for a failing statement sync', () => {
  test('waits 15 min, 1 h, 6 h, then 24 h; no failures means no wait', () => {
    expect([0, 1, 2, 3, 4, 9].map(backoffMs)).toEqual([0, 15 * 60_000, 3_600_000, 21_600_000, 86_400_000, 86_400_000]);
  });

  test('nextAttemptAt is null with no failures, else now + the wait', () => {
    const now = new Date('2026-09-21T07:00:00Z');
    expect(nextAttemptAt(0, now)).toBeNull();
    expect(nextAttemptAt(1, now)!.toISOString()).toBe('2026-09-21T07:15:00.000Z');
    expect(nextAttemptAt(3, now)!.toISOString()).toBe('2026-09-21T13:00:00.000Z');
  });

  test('three failures in a row need attention', () => {
    expect(NEEDS_ATTENTION_AFTER).toBe(3);
  });

  test('the observed failure pattern would now cost far less than a full day of quota', () => {
    // The old build retried every 15 minutes (96 runs a day) at ~40 calls each.
    const before = 96 * 40;
    // With back-off: runs at failures 1..3 wait 15 min, 1 h, 6 h, then once a day.
    let t = 0; let runs = 0; let failures = 0;
    while (t < 24 * 3_600_000) { runs++; failures++; t += backoffMs(failures); }
    expect(runs * 40).toBeLessThan(before / 10);
  });
});

describe('what a statement-sync frequency costs', () => {
  test('15 minutes is ~86% of a Professional day; hourly ~22%; daily ~1%', () => {
    expect(projectedDailyCalls('15min')).toBe(4320);
    expect(projectedDailyCalls('hourly')).toBe(1080);
    expect(projectedDailyCalls('daily')).toBe(45);
    expect(projectedDailyCalls('manual')).toBe(0);
    expect(projectedDailyCalls('15min') / 5000).toBeCloseTo(0.864, 2);
  });
});

describe('error classification', () => {
  test('code 45 is the daily limit, an HTTP 429 without it is the per-minute window', () => {
    expect(isDailyLimitError({ status: 429, zohoCode: 45 })).toBe(true);
    expect(isDailyLimitError({ status: 429, zohoCode: 44 })).toBe(false);
    expect(isRateLimitedError({ status: 429, zohoCode: 44 })).toBe(true);
    expect(isRateLimitedError({ status: 429, zohoCode: 45 })).toBe(false);
    expect(isRateLimitedError({ status: 500 })).toBe(false);
    expect(isDailyLimitError(null)).toBe(false);
  });
});
