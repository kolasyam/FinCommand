const mockQuery = jest.fn();
jest.mock('@/lib/db/neon', () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

import { loadStates, normalizeState } from '@/lib/db/queries/zoho-records';
import { runSlice, type SyncDeps } from '@/lib/services/zoho/records-sync';
import { getModule } from '@/lib/services/zoho/modules';

beforeEach(() => mockQuery.mockReset());

describe('module state read from the database', () => {
  test('timestamps come back as ISO strings with their milliseconds, not as Date objects', async () => {
    const t = new Date('2026-09-21T08:17:00.937Z');
    mockQuery.mockResolvedValue({ rows: [{ module: 'chartofaccounts', pass_kind: null, last_full_at: t, incremental_cursor: t, last_error_at: null, claimed_at: null }] });
    const s = (await loadStates('co1', ['chartofaccounts'])).get('chartofaccounts')!;
    expect(s.last_full_at).toBe('2026-09-21T08:17:00.937Z');
    expect(typeof s.incremental_cursor).toBe('string');
    expect(s.last_error_at).toBeNull();
  });

  test('normalizeState leaves strings and nulls alone', () => {
    expect(normalizeState({ module: 'x', last_full_at: '2026-01-01T00:00:00.000Z', pass_started_at: null }))
      .toMatchObject({ last_full_at: '2026-01-01T00:00:00.000Z', pass_started_at: null });
  });

  test('regression: Date.parse on a Date drops milliseconds, which is what made a module read 0.7 s into a run look unread', () => {
    const d = new Date('2026-09-21T08:17:00.937Z');
    expect(Date.parse(d as unknown as string)).toBeLessThan(d.getTime()); // the trap
    expect(Date.parse(normalizeState({ last_full_at: d }).last_full_at as string)).toBe(d.getTime()); // the fix
  });

  test('a module read moments after a run started is not read again in the same run', async () => {
    // Exactly the failing case: pass started 0.4 s after the run began, in the same clock second.
    const runStart = Date.parse('2026-09-21T08:17:00.500Z');
    const passStart = new Date('2026-09-21T08:17:00.900Z');
    mockQuery.mockResolvedValue({ rows: [{ module: 'chartofaccounts', pass_kind: null, last_full_at: passStart, incremental_cursor: passStart, last_incremental_at: null, last_error_at: null, claimed_at: null, detail_enabled: null }] });
    const states = await loadStates('co1', ['chartofaccounts']);
    const http = jest.fn();
    const deps: SyncDeps = {
      store: {
        ensureStates: async () => {}, loadStates: async () => states, claim: async (_c, k) => k, release: async () => {}, saveState: async () => {},
        upsertPage: async () => ({ received: 0, created: 0, updated: 0, unchanged: 0, skipped: 0 }), needingDetail: async () => [],
        writeDetail: async () => 'updated', markDetailFailure: async () => {}, markDetailGone: async () => {}, countSeenSince: async () => ({ seen: 0, total: 0 }),
        markMissingRemoved: async () => 0, detailPending: async () => 0, parentIds: async () => [], financialYears: async () => [], snapshotSeen: async () => null,
        saveSnapshot: async () => 'created',
      },
      http, now: () => runStart + 5_000, sleep: async () => {},
      usage: { get: async () => ({ used: 0, dailyLimit: 5000, moduleCap: 4000, blockedUntil: null }), flush: async () => {}, block: async () => {} },
    };
    const r = await runSlice({ companyId: 'co1', baseCurrency: 'INR', mode: 'incremental', modules: [getModule('chartofaccounts')!], runStartedAt: new Date(runStart).toISOString() }, deps);
    expect(http).not.toHaveBeenCalled();
    expect(r.modules[0]!.listing).toBe('complete');
  });
});
