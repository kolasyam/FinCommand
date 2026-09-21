const mockQuery = jest.fn();
const mockSlice = jest.fn();
const mockFail = jest.fn();

jest.mock('@/lib/db/neon', () => ({ query: (...a: unknown[]) => mockQuery(...a) }));
jest.mock('@/lib/services/zoho/records-sync', () => ({ DEFAULT_SLICE_MS: 40_000, runModuleSlice: (...a: unknown[]) => mockSlice(...a) }));
jest.mock('@/lib/services/zoho/health', () => ({ recordZohoFailure: (...a: unknown[]) => mockFail(...a) }));

import { runScheduledRecordReads } from '@/lib/services/zoho/records-cron';
import { ZOHO_MODULES, ZOHO_REPORTS } from '@/lib/services/zoho/modules';
import { recordRefreshIntervalMs, isValidDailyLimit, ZOHO_PLAN_LIMITS } from '@/lib/services/zoho/budget';

const T0 = Date.parse('2026-09-21T12:00:00Z');
const ok = (over: Record<string, unknown> = {}) => ({ done: true, stopped: 'complete', callsMade: 4, errors: [], ...over });

beforeEach(() => { mockQuery.mockReset(); mockSlice.mockReset(); mockFail.mockReset(); });

describe('which companies a scheduled read touches', () => {
  test('only connected companies whose admin already started a first read, not manual, not backed off', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await runScheduledRecordReads({ budgetMs: 55_000, now: () => T0 });
    const sql = String(mockQuery.mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(sql).toMatch(/is_active = TRUE AND zc\.org_id IS NOT NULL AND zc\.refresh_token IS NOT NULL/);
    expect(sql).toMatch(/sync_frequency <> 'manual'/);
    expect(sql).toMatch(/next_attempt_at IS NULL OR zc\.next_attempt_at <= NOW\(\)/);
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM zoho_module_state s WHERE s\.company_id = zc\.company_id AND s\.last_full_at IS NOT NULL\)/);
    expect(mockSlice).not.toHaveBeenCalled();
  });
});

describe('how a scheduled read runs', () => {
  test('reads all modules incrementally; what was read within the interval counts as fresh', async () => {
    mockQuery.mockResolvedValue({ rows: [{ company_id: 'c1', sync_frequency: 'hourly' }, { company_id: 'c2', sync_frequency: 'daily' }] });
    mockSlice.mockResolvedValue(ok());
    const r = await runScheduledRecordReads({ budgetMs: 55_000, now: () => T0 });
    expect(r).toEqual([
      { company_id: 'c1', status: 'ok', stopped: 'complete', calls: 4, error: undefined },
      { company_id: 'c2', status: 'ok', stopped: 'complete', calls: 4, error: undefined },
    ]);
    const [c1, o1] = mockSlice.mock.calls[0]!;
    expect(c1).toBe('c1');
    expect(o1.modules).toBe(ZOHO_MODULES);
    expect(o1.reports).toBe(ZOHO_REPORTS);
    expect(o1.scheduled).toBe(true);
    expect(o1.mode).toBe('incremental');
    expect(Date.parse(o1.runStartedAt)).toBe(T0 - 60 * 60_000);
    expect(Date.parse(mockSlice.mock.calls[1]![1].runStartedAt)).toBe(T0 - 24 * 60 * 60_000);
  });

  test('a 15-minute statement schedule still reads records no more than hourly', () => {
    expect(recordRefreshIntervalMs('15min')).toBe(60 * 60_000);
    expect(recordRefreshIntervalMs('hourly')).toBe(60 * 60_000);
    expect(recordRefreshIntervalMs('daily')).toBe(24 * 60 * 60_000);
  });

  test('the slice never outlasts the time left in the cron run', async () => {
    mockQuery.mockResolvedValue({ rows: [{ company_id: 'c1', sync_frequency: 'daily' }] });
    mockSlice.mockResolvedValue(ok());
    await runScheduledRecordReads({ budgetMs: 25_000, now: () => T0 });
    expect(mockSlice.mock.calls[0]![1].sliceMs).toBe(20_000);
    mockSlice.mockClear();
    await runScheduledRecordReads({ budgetMs: 55_000, now: () => T0 });
    expect(mockSlice.mock.calls[0]![1].sliceMs).toBe(40_000);
  });

  test('a company is not started when under 10 seconds remain', async () => {
    let t = T0;
    mockQuery.mockResolvedValue({ rows: [{ company_id: 'c1', sync_frequency: 'daily' }, { company_id: 'c2', sync_frequency: 'daily' }] });
    mockSlice.mockImplementation(async () => { t += 50_000; return ok(); });
    const r = await runScheduledRecordReads({ budgetMs: 55_000, now: () => t });
    expect(r.map((x) => x.company_id)).toEqual(['c1']);
  });
});

describe('when Zoho cannot be read', () => {
  test('a lost connection backs the company off and is reported as an error', async () => {
    mockQuery.mockResolvedValue({ rows: [{ company_id: 'c1', sync_frequency: 'daily' }] });
    mockSlice.mockResolvedValue(ok({ done: false, stopped: 'auth', errors: ['Zoho re-authentication failed'] }));
    const r = await runScheduledRecordReads({ budgetMs: 55_000, now: () => T0 });
    expect(mockFail).toHaveBeenCalledWith('c1');
    expect(r[0]).toMatchObject({ status: 'error', stopped: 'auth', error: 'Zoho re-authentication failed' });
  });

  test('running out of allowance or time is not a failure', async () => {
    mockQuery.mockResolvedValue({ rows: [{ company_id: 'c1', sync_frequency: 'daily' }] });
    for (const stopped of ['time', 'daily_budget', 'daily_limit', 'rate_limited']) {
      mockSlice.mockResolvedValue(ok({ done: false, stopped }));
      const r = await runScheduledRecordReads({ budgetMs: 55_000, now: () => T0 });
      expect(r[0]!.status).toBe('ok');
    }
    expect(mockFail).not.toHaveBeenCalled();
  });

  test('one company throwing does not stop the others', async () => {
    mockQuery.mockResolvedValue({ rows: [{ company_id: 'c1', sync_frequency: 'daily' }, { company_id: 'c2', sync_frequency: 'daily' }] });
    mockSlice.mockRejectedValueOnce(new Error('Zoho Books is not connected')).mockResolvedValueOnce(ok());
    const r = await runScheduledRecordReads({ budgetMs: 55_000, now: () => T0 });
    expect(r.map((x) => x.status)).toEqual(['error', 'ok']);
    expect(mockFail).toHaveBeenCalledWith('c1');
  });
});

describe('the plan limit', () => {
  test('only the plan values Zoho sells are accepted', () => {
    for (const v of Object.values(ZOHO_PLAN_LIMITS)) expect(isValidDailyLimit(v)).toBe(true);
    for (const v of [0, 999, 4000, 5000.5, '5000', null, undefined]) expect(isValidDailyLimit(v)).toBe(false);
  });
});
