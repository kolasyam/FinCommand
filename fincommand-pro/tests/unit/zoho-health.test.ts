const mockQuery = jest.fn();
jest.mock('@/lib/db/neon', () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

import { recordZohoFailure, clearZohoFailures } from '@/lib/services/zoho/health';

const NOW = new Date('2026-09-21T07:00:00Z');
beforeEach(() => { mockQuery.mockReset(); jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe('recordZohoFailure', () => {
  test.each([
    [1, '2026-09-21T07:15:00.000Z'],
    [2, '2026-09-21T08:00:00.000Z'],
    [3, '2026-09-21T13:00:00.000Z'],
    [4, '2026-09-22T07:00:00.000Z'],
    [9, '2026-09-22T07:00:00.000Z'],
  ])('failure number %i sets the next attempt to %s', async (failures, expected) => {
    mockQuery.mockResolvedValueOnce({ rows: [{ consecutive_failures: failures }] }).mockResolvedValueOnce({ rows: [] });
    await recordZohoFailure('co1', NOW);
    expect(String(mockQuery.mock.calls[0]![0])).toMatch(/consecutive_failures = consecutive_failures \+ 1/);
    expect(mockQuery.mock.calls[0]![1]).toEqual(['co1']);
    expect(mockQuery.mock.calls[1]![1]).toEqual(['co1', new Date(expected)]);
  });

  test('never throws: a database problem in the bookkeeping must not hide the real failure', async () => {
    mockQuery.mockRejectedValue(new Error('column "consecutive_failures" does not exist'));
    await expect(recordZohoFailure('co1', NOW)).resolves.toBeUndefined();
  });

  test('does nothing more when the company has no config row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await recordZohoFailure('co1', NOW);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('clearZohoFailures', () => {
  test('resets the counter and the wait', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await clearZohoFailures('co1');
    expect(String(mockQuery.mock.calls[0]![0])).toMatch(/consecutive_failures=0, next_attempt_at=NULL/);
    expect(mockQuery.mock.calls[0]![1]).toEqual(['co1']);
  });

  test('never throws either', async () => {
    mockQuery.mockRejectedValue(new Error('boom'));
    await expect(clearZohoFailures('co1')).resolves.toBeUndefined();
  });
});
