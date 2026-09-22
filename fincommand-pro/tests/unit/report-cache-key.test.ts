import { buildReportCacheKey, buildThreeYearCacheKey, hashReportDataVersion, type ReportDataVersion } from '@/lib/cache/report-cache';

const base: ReportDataVersion = {
  batches: 'b1@2026-09-01 10:00:00+00,b2@2026-09-02 10:00:00+00',
  years: 'fy1:2025-04-01:2026-03-31:FY 2025-26:false',
  company: '2026-09-01 09:00:00+00',
  metrics: '2026-09-10 08:00:00+00#3',
  contacts: null,
};

describe('report cache key — changes whenever the inputs change', () => {
  test('same inputs → same version', () => {
    expect(hashReportDataVersion({ ...base })).toBe(hashReportDataVersion(base));
  });

  test.each([
    ['a new batch (upload / sync)', { batches: 'b1@2026-09-01 10:00:00+00,b3@2026-09-19 10:00:00+00' }],
    ['a reclassify (data_changed_at bumped)', { batches: 'b1@2026-09-01 10:00:00+00,b2@2026-09-19 11:00:00+00' }],
    ['a year locked', { years: 'fy1:2025-04-01:2026-03-31:FY 2025-26:true' }],
    ['a year added', { years: `${base.years},fy2:2026-04-01:2027-03-31:FY 2026-27:false` }],
    ['currency changed (companies.updated_at)', { company: '2026-09-19 09:00:00+00' }],
    ['a custom metric edited', { metrics: '2026-09-19 08:00:00+00#3' }],
    ['a custom metric deleted', { metrics: '2026-09-10 08:00:00+00#2' }],
    ['Zoho contacts re-synced', { contacts: '2026-09-19 07:00:00+00' }],
  ])('%s → different version', (_label, change) => {
    expect(hashReportDataVersion({ ...base, ...change })).not.toBe(hashReportDataVersion(base));
  });

  test('key keeps the company prefix (so invalidateReportCache(companyId) still clears it) and every request dimension', () => {
    const key = buildReportCacheKey('co-1', 'fy-1', { periodType: 'quarterly', period: 'Q2', yearType: 'CY' }, 'v123');
    expect(key.startsWith('co-1:')).toBe(true);
    expect(key).toBe('co-1:fy-1:quarterly:Q2:CY:v123');
    expect(buildReportCacheKey('co-1', 'fy-1', {}, 'v')).toBe('co-1:fy-1:annual:all:FY:v');
  });

  test('three-year key: also company-prefixed, and the same years in a different order share one entry', () => {
    const a = buildThreeYearCacheKey('co-1', ['fy-2', 'fy-1', 'fy-3'], 'FY', 'v1');
    const b = buildThreeYearCacheKey('co-1', ['fy-3', 'fy-1', 'fy-2'], 'FY', 'v1');
    expect(a.startsWith('co-1:')).toBe(true);
    expect(a).toBe(b);
    expect(a).toBe('co-1:three:fy-1,fy-2,fy-3:FY:v1');
  });

  test('three-year key changes with the set of years, the year type or the data version', () => {
    const base3 = buildThreeYearCacheKey('co-1', ['fy-1', 'fy-2'], 'FY', 'v1');
    expect(buildThreeYearCacheKey('co-1', ['fy-1', 'fy-3'], 'FY', 'v1')).not.toBe(base3);
    expect(buildThreeYearCacheKey('co-1', ['fy-1', 'fy-2'], 'CY', 'v1')).not.toBe(base3);
    expect(buildThreeYearCacheKey('co-1', ['fy-1', 'fy-2'], 'FY', 'v2')).not.toBe(base3);
  });
});
