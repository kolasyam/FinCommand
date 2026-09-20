import {
  buildReportInputsKey, getCachedReportInputs, setCachedReportInputs, invalidateReportCache,
} from '@/lib/cache/report-cache';

const key = (company: string, fy: string, isCY: boolean, version: string) => buildReportInputsKey(company, fy, isCY, version);

describe('report inputs cache — the database reads a bundle is computed from', () => {
  beforeEach(() => invalidateReportCache());

  test('the key carries the company, year, FY-vs-CY and the data version', () => {
    const base = key('c1', 'fy1', false, 'v1');
    expect(key('c1', 'fy1', false, 'v2')).not.toBe(base);   // any data change → a different key, so stale rows can't be served
    expect(key('c1', 'fy1', true, 'v1')).not.toBe(base);    // CY merges two years; FY doesn't
    expect(key('c1', 'fy2', false, 'v1')).not.toBe(base);
    expect(key('c2', 'fy1', false, 'v1')).not.toBe(base);   // never shared across companies
    expect(base.startsWith('c1:')).toBe(true);              // so invalidateReportCache('c1') can clear it
  });

  test('a stored value comes back, but only under the same key', () => {
    setCachedReportInputs(key('c1', 'fy1', false, 'v1'), { rows: [{ a: 1 }] });
    expect(getCachedReportInputs(key('c1', 'fy1', false, 'v1'))).toEqual({ rows: [{ a: 1 }] });
    expect(getCachedReportInputs(key('c1', 'fy1', false, 'v2'))).toBeNull();
  });

  test('nothing a caller does to what it got — or to what it stored — can change what the next reader sees', () => {
    const original = { rows: [{ amount: '100.00' }], when: new Date('2026-01-01T00:00:00Z') };
    setCachedReportInputs(key('c1', 'fy1', false, 'v1'), original);
    original.rows[0].amount = 'CORRUPTED-AFTER-STORE';

    const first = getCachedReportInputs<typeof original>(key('c1', 'fy1', false, 'v1'))!;
    expect(first.rows[0].amount).toBe('100.00');
    // A real Date with the same instant. (Not toBeInstanceOf: structuredClone runs in Node's realm, jest's Date in its sandbox.)
    expect(Object.prototype.toString.call(first.when)).toBe('[object Date]');
    expect(first.when.getTime()).toBe(original.when.getTime());
    first.rows[0].amount = 'CORRUPTED-BY-A-READER';
    first.rows.push({ amount: 'x' });

    const second = getCachedReportInputs<typeof original>(key('c1', 'fy1', false, 'v1'))!;
    expect(second.rows).toEqual([{ amount: '100.00' }]);
    expect(second).not.toBe(first);
  });

  test('entries expire', () => {
    setCachedReportInputs(key('c1', 'fy1', false, 'v1'), { ok: true }, -1);
    expect(getCachedReportInputs(key('c1', 'fy1', false, 'v1'))).toBeNull();
  });

  test('memory is bounded: the oldest entry goes first once there are more than 12', () => {
    for (let i = 0; i < 13; i++) setCachedReportInputs(key('c1', `fy${i}`, false, 'v1'), { i });
    expect(getCachedReportInputs(key('c1', 'fy0', false, 'v1'))).toBeNull();
    expect(getCachedReportInputs(key('c1', 'fy1', false, 'v1'))).toEqual({ i: 1 });
    expect(getCachedReportInputs(key('c1', 'fy12', false, 'v1'))).toEqual({ i: 12 });
  });

  test('a write to a company clears only that company\'s inputs', () => {
    setCachedReportInputs(key('c1', 'fy1', false, 'v1'), { c: 1 });
    setCachedReportInputs(key('c2', 'fy1', false, 'v1'), { c: 2 });
    invalidateReportCache('c1');
    expect(getCachedReportInputs(key('c1', 'fy1', false, 'v1'))).toBeNull();
    expect(getCachedReportInputs(key('c2', 'fy1', false, 'v1'))).toEqual({ c: 2 });
    invalidateReportCache();
    expect(getCachedReportInputs(key('c2', 'fy1', false, 'v1'))).toBeNull();
  });

  test('a value that can\'t be copied is not cached, and does not throw', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => setCachedReportInputs(key('c1', 'fy1', false, 'v1'), { fn: () => 1 })).not.toThrow();
    expect(getCachedReportInputs(key('c1', 'fy1', false, 'v1'))).toBeNull();
    spy.mockRestore();
  });

  test('development always reads fresh, like the bundle cache', () => {
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = 'development';
    try {
      setCachedReportInputs(key('c1', 'fy1', false, 'v1'), { a: 1 });
      expect(getCachedReportInputs(key('c1', 'fy1', false, 'v1'))).toBeNull();
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev as string;
    }
  });
});
