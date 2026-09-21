const mockQuery = jest.fn();
jest.mock('@/lib/db/neon', () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

import { noteZohoCall, unflushedCalls, flushZohoUsage, getZohoUsage, blockZohoUntil } from '@/lib/services/zoho/usage';

const NOW = new Date('2026-09-21T10:00:00Z');
beforeEach(() => { mockQuery.mockReset(); jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe('usage counter', () => {
  test('counts in memory and writes the total with one upsert for the UTC day', async () => {
    noteZohoCall('u1'); noteZohoCall('u1'); noteZohoCall('u1', 3);
    expect(unflushedCalls('u1')).toBe(5);
    mockQuery.mockResolvedValue({ rows: [] });
    await flushZohoUsage('u1', NOW);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(String(sql)).toMatch(/ON CONFLICT \(company_id, day\) DO UPDATE SET calls = zoho_api_usage\.calls \+ EXCLUDED\.calls/);
    expect(params).toEqual(['u1', '2026-09-21', 5]);
    expect(unflushedCalls('u1')).toBe(0);
  });

  test('flushing with nothing counted does not touch the database', async () => {
    await flushZohoUsage('nothing', NOW);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a failed write keeps the count for the next flush and never throws', async () => {
    noteZohoCall('u2', 4);
    mockQuery.mockRejectedValueOnce(new Error('relation "zoho_api_usage" does not exist'));
    await expect(flushZohoUsage('u2', NOW)).resolves.toBeUndefined();
    expect(unflushedCalls('u2')).toBe(4);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await flushZohoUsage('u2', NOW);
    expect(unflushedCalls('u2')).toBe(0);
  });

  test('counts of different companies never mix', async () => {
    noteZohoCall('ca'); noteZohoCall('cb', 7);
    expect(unflushedCalls('ca')).toBe(1);
    expect(unflushedCalls('cb')).toBe(7);
    mockQuery.mockResolvedValue({ rows: [] });
    await flushZohoUsage('ca', NOW); await flushZohoUsage('cb', NOW);
    expect(mockQuery.mock.calls.map((c) => c[1])).toEqual([['ca', '2026-09-21', 1], ['cb', '2026-09-21', 7]]);
  });
});

describe('getZohoUsage', () => {
  test('adds calls not yet written to what is stored, against the plan limit, with the 80% cap', async () => {
    noteZohoCall('g1', 10);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ calls: 990, blocked_until: null }] })
      .mockResolvedValueOnce({ rows: [{ api_daily_limit: 5000 }] });
    expect(await getZohoUsage('g1', NOW)).toEqual({ used: 1000, dailyLimit: 5000, moduleCap: 4000, blockedUntil: null });
    for (const c of mockQuery.mock.calls) expect(c[1][0]).toBe('g1');
  });

  test('defaults to the Free plan when nothing is stored, and reports a block', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ calls: 3, blocked_until: '2026-09-21T11:00:00Z' }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await getZohoUsage('g2', NOW)).toEqual({ used: 3, dailyLimit: 1000, moduleCap: 800, blockedUntil: '2026-09-21T11:00:00.000Z' });
  });
});

describe('blockZohoUntil', () => {
  test('records the block on today\'s row', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const until = new Date('2026-09-21T11:00:00Z');
    await blockZohoUntil('b1', until, NOW);
    expect(mockQuery.mock.calls[0]![1]).toEqual(['b1', '2026-09-21', until]);
    expect(String(mockQuery.mock.calls[0]![0])).toMatch(/blocked_until = EXCLUDED\.blocked_until/);
  });
});
