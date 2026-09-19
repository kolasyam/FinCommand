import { parseRunMode, intArg, listId, lockCompanyYears } from '@/db/scripts/script-support';
import { tbWriteLockKey } from '@/lib/db/tb-write-lock';
import type { PoolClient } from 'pg';

describe('maintenance scripts — the dry-run → approval → apply gate', () => {
  test('a mode must be chosen explicitly, and --apply only with the approved list id', () => {
    expect(() => parseRunMode([])).toThrow(/no default/);
    expect(() => parseRunMode(['--dry-run', '--apply'])).toThrow(/no default/);
    expect(() => parseRunMode(['--apply'])).toThrow(/--confirm/);
    expect(() => parseRunMode(['--apply', '--confirm='])).toThrow(/--confirm/);
    expect(() => parseRunMode(['--dry-run', '--confirm=abc'])).toThrow(/only goes with --apply/);
    expect(parseRunMode(['--dry-run'])).toEqual({ apply: false, confirm: null });
    expect(parseRunMode(['--apply', '--confirm=abc123'])).toEqual({ apply: true, confirm: 'abc123' });
  });

  test('numeric options have a floor and reject junk', () => {
    expect(intArg([], 'days', 90, 1)).toBe(90);
    expect(intArg(['--days=30'], 'days', 90, 1)).toBe(30);
    expect(intArg(['--keep=0'], 'keep', 5, 0)).toBe(0);
    expect(() => intArg(['--days=0'], 'days', 90, 1)).toThrow(/≥ 1/);
    expect(() => intArg(['--days=1.5'], 'days', 90, 1)).toThrow();
    expect(() => intArg(['--days=abc'], 'days', 90, 1)).toThrow();
  });

  test('the list id ignores order but changes with any item or the policy', () => {
    const a = listId({ policy: '90d/5', batches: ['b1', 'b2'], payloads: ['p1'] });
    expect(listId({ payloads: ['p1'], batches: ['b2', 'b1'], policy: '90d/5' })).toBe(a);
    expect(listId({ policy: '90d/5', batches: ['b1', 'b2', 'b3'], payloads: ['p1'] })).not.toBe(a);
    expect(listId({ policy: '90d/5', batches: ['b1', 'b2'], payloads: [] })).not.toBe(a);
    expect(listId({ policy: '30d/5', batches: ['b1', 'b2'], payloads: ['p1'] })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  test('locks take the app\'s own trial-balance lock keys, de-duplicated and in a fixed order', async () => {
    const calls: [string, unknown[] | undefined][] = [];
    const client = { query: async (sql: string, params?: unknown[]) => { calls.push([sql, params]); return { rows: [] }; } } as unknown as PoolClient;
    await lockCompanyYears(client, [
      { company_id: 'c2', financial_year_id: 'y9' },
      { company_id: 'c1', financial_year_id: 'y1' },
      { company_id: 'c2', financial_year_id: 'y9' },
    ]);
    const lockKeys = calls.filter(([sql]) => /pg_advisory_xact_lock/.test(sql)).map(([, p]) => p![0]);
    expect(lockKeys).toEqual([tbWriteLockKey('c1', 'y1'), tbWriteLockKey('c2', 'y9')]);
    expect(calls[0][0]).toMatch(/SET LOCAL lock_timeout/);
    expect(calls[calls.length - 1][0]).toMatch(/FOR UPDATE/);
  });
});
