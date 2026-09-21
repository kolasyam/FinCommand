import { runSlice, type RecordStore, type SyncDeps, type SliceInput } from '@/lib/services/zoho/records-sync';
import { getModule, type ModuleDef, type ReportDef } from '@/lib/services/zoho/modules';
import type { ModuleState } from '@/lib/db/queries/zoho-records';

const invoices = getModule('invoices')!;
const bills = getModule('bills')!;
const expenses = getModule('expenses')!;

const blankState = (module: string): ModuleState => ({
  module, pass_kind: null, pass_started_at: null, page_cursor: null, sub_cursor: null, incremental_cursor: null,
  last_full_at: null, last_incremental_at: null, detail_enabled: null, claimed_at: null, last_error: null, last_error_at: null,
});

interface Rec { module: string; id: string; stale: boolean; attempts: number; removed: boolean; lastSeen: number }

/** An in-memory RecordStore: the same contract as the Postgres one, minus SQL. */
function fakeStore(seed: { states?: ModuleState[]; records?: Rec[]; busy?: string[]; years?: Array<{ label: string; start: string; end: string }>; snapshots?: Record<string, number> } = {}) {
  const snapshots = new Map<string, number>(Object.entries(seed.snapshots ?? {}));
  const snapshotSaves: Array<{ report: string; periodFrom: string | null; periodTo: string }> = [];
  const pageParents: Array<string | null> = [];
  const states = new Map<string, ModuleState>((seed.states ?? []).map((s) => [s.module, s]));
  const records = new Map<string, Rec>((seed.records ?? []).map((r) => [`${r.module}:${r.id}`, r]));
  const saves: Array<{ module: string; patch: Record<string, unknown> }> = [];
  const detailWrites: string[] = [];
  let clock = () => 0;
  const store: RecordStore = {
    async ensureStates(_c, keys) { for (const k of keys) if (!states.has(k)) states.set(k, blankState(k)); },
    async loadStates(_c, keys) { return new Map(keys.map((k) => [k, { ...states.get(k)! }])); },
    async claim(_c, keys) { return keys.filter((k) => !(seed.busy ?? []).includes(k)); },
    async release() {},
    async saveState(_c, module, patch) { saves.push({ module, patch }); states.set(module, { ...states.get(module)!, ...patch } as ModuleState); },
    async upsertPage({ def, rows, parentId }) {
      pageParents.push(parentId ?? null);
      let created = 0; let unchanged = 0; let skipped = 0;
      for (const r of rows) {
        const raw = String(r[def.fields.id] ?? '');
        if (!raw) { skipped++; continue; }
        const id = def.fanOut && parentId ? `${parentId}:${raw}` : raw;
        const k = `${def.key}:${id}`;
        const ex = records.get(k);
        if (ex) { ex.lastSeen = clock(); ex.removed = false; unchanged++; }
        else { records.set(k, { module: def.key, id, stale: def.detail !== 'none', attempts: 0, removed: false, lastSeen: clock() }); created++; }
      }
      return { received: rows.length, created, updated: 0, unchanged, skipped };
    },
    async needingDetail(_c, module, limit) {
      return [...records.values()].filter((r) => r.module === module && r.stale && !r.removed && r.attempts < 3).slice(0, limit).map((r) => r.id);
    },
    async writeDetail({ def, zohoId }) { records.get(`${def.key}:${zohoId}`)!.stale = false; detailWrites.push(`${def.key}:${zohoId}`); return 'updated'; },
    async markDetailFailure(_c, module, id) { records.get(`${module}:${id}`)!.attempts++; },
    async markDetailGone(_c, module, id) { const r = records.get(`${module}:${id}`)!; r.removed = true; r.stale = false; },
    async countSeenSince(_c, module, since) {
      const mine = [...records.values()].filter((r) => r.module === module && !r.removed);
      return { seen: mine.filter((r) => r.lastSeen >= since.getTime()).length, total: mine.length };
    },
    async markMissingRemoved(_c, module, since) {
      let n = 0;
      for (const r of records.values()) if (r.module === module && !r.removed && r.lastSeen < since.getTime()) { r.removed = true; n++; }
      return n;
    },
    async detailPending(_c, module) { return [...records.values()].filter((r) => r.module === module && r.stale && !r.removed && r.attempts < 3).length; },
    async parentIds(_c, module) { return [...records.values()].filter((r) => r.module === module && !r.removed).map((r) => r.id).sort(); },
    async financialYears() { return seed.years ?? []; },
    async snapshotSeen(_c, report, to) { return snapshots.get(`${report}:${to}`) ?? null; },
    async saveSnapshot({ report, periodFrom, periodTo }) {
      const k = `${report}:${periodTo}`; const had = snapshots.has(k);
      snapshots.set(k, clock()); snapshotSaves.push({ report, periodFrom, periodTo });
      return had ? 'unchanged' : 'created';
    },
  };
  return { store, states, records, saves, detailWrites, snapshots, snapshotSaves, pageParents, bindClock: (f: () => number) => { clock = f; } };
}

type Route = (params: Record<string, unknown>) => unknown;

/** A fake clock and HTTP: every call takes `callMs`, sleeping advances the clock. */
function harness(routes: Record<string, Route>, opts: { callMs?: number; used?: number; dailyLimit?: number; blockedUntil?: string | null; store?: ReturnType<typeof fakeStore> } = {}) {
  let t = Date.parse('2026-09-21T10:00:00Z');
  const calls: Array<{ path: string; params: Record<string, unknown> }> = [];
  const sleeps: number[] = [];
  const blocks: Date[] = [];
  const fs = opts.store ?? fakeStore();
  fs.bindClock(() => t);
  const dailyLimit = opts.dailyLimit ?? 5000;
  const deps: SyncDeps = {
    store: fs.store,
    http: async (path, params) => {
      calls.push({ path, params });
      t += opts.callMs ?? 300;
      const route = routes[path];
      if (!route) throw Object.assign(new Error('Invalid URL Passed (code 5)'), { status: 404, zohoCode: 5 });
      return route(params);
    },
    now: () => t,
    sleep: async (n) => { sleeps.push(n); t += n; },
    usage: {
      get: async () => ({ used: opts.used ?? 0, dailyLimit, moduleCap: Math.floor(dailyLimit * 0.8), blockedUntil: opts.blockedUntil ?? null }),
      flush: async () => {},
      block: async (until) => { blocks.push(until); },
    },
  };
  const run = (input: Partial<SliceInput> & { modules: ModuleDef[] }) => runSlice({ companyId: 'co1', baseCurrency: 'INR', mode: 'incremental', ...input }, deps);
  return { deps, run, calls, sleeps, blocks, fs, now: () => t };
}

const page = (key: string, idKey: string, ids: string[], more: boolean) => ({ [key]: ids.map((id) => ({ [idKey]: id })), page_context: { has_more_page: more } });
const detailRoute = (key: string, idKey: string) => () => ({ [key]: { [idKey]: 'x', line_items: [] } });

describe('runSlice — a full first read', () => {
  test('lists every page, then reads each record\'s detail, and finishes', async () => {
    const h = harness({
      '/invoices': (p) => (p.page === 1 ? page('invoices', 'invoice_id', ['1', '2'], true) : page('invoices', 'invoice_id', ['3'], false)),
      '/invoices/1': detailRoute('invoice', 'invoice_id'), '/invoices/2': detailRoute('invoice', 'invoice_id'), '/invoices/3': detailRoute('invoice', 'invoice_id'),
    });
    const r = await h.run({ modules: [invoices] });
    expect(r.done).toBe(true);
    expect(r.stopped).toBe('complete');
    expect(r.callsMade).toBe(5);
    expect(h.calls.map((c) => c.path)).toEqual(['/invoices', '/invoices', '/invoices/1', '/invoices/2', '/invoices/3']);
    expect(h.calls[0]!.params).toEqual({ per_page: 200, page: 1 });
    expect(h.calls[1]!.params).toEqual({ per_page: 200, page: 2 });
    expect(r.modules[0]).toMatchObject({ listing: 'complete', pass: 'full', received: 3, created: 3, detailFetched: 3, detailPending: 0 });
    const st = h.fs.states.get('invoices')!;
    expect(st.pass_kind).toBeNull();
    expect(st.last_full_at).not.toBeNull();
    expect(st.incremental_cursor).toBe(st.last_full_at);
  });

  test('lists of ALL modules come before any detail read', async () => {
    const h = harness({
      '/invoices': () => page('invoices', 'invoice_id', ['1'], false),
      '/bills': () => page('bills', 'bill_id', ['9'], false),
      '/invoices/1': detailRoute('invoice', 'invoice_id'), '/bills/9': detailRoute('bill', 'bill_id'),
    });
    await h.run({ modules: [invoices, bills] });
    expect(h.calls.map((c) => c.path)).toEqual(['/invoices', '/bills', '/invoices/1', '/bills/9']);
  });

  test('calls are spaced so the rate stays under Zoho\'s limit', async () => {
    const h = harness({
      '/invoices': () => page('invoices', 'invoice_id', ['1'], false), '/invoices/1': detailRoute('invoice', 'invoice_id'),
    }, { callMs: 100 });
    await h.run({ modules: [invoices] });
    expect(h.sleeps.length).toBeGreaterThan(0);
    expect(h.sleeps.every((s) => s <= 750)).toBe(true);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(600);
  });
});

describe('runSlice — time-boxed and resumable', () => {
  const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => String(from + i));
  const manyPages = (total: number) => (p: Record<string, unknown>) => page('bills', 'bill_id', ids(2, (p.page as number) * 10), (p.page as number) < total);

  test('a slice that runs out of time saves its page and the next slice resumes there', async () => {
    const h = harness({ '/bills': manyPages(8) }, { callMs: 1000 });
    const first = await h.run({ modules: [bills], sliceMs: 5500 });
    expect(first.done).toBe(false);
    expect(first.stopped).toBe('time');
    expect(first.modules[0]!.listing).toBe('partial');
    const firstPages = h.calls.map((c) => c.params.page);
    expect(firstPages).toEqual([1, 2, 3]);
    expect(h.fs.states.get('bills')).toMatchObject({ pass_kind: 'full', page_cursor: 4 });

    const second = await h.run({ modules: [bills], sliceMs: 5500, runStartedAt: first.runStartedAt });
    expect(h.calls.slice(3).map((c) => c.params.page)).toEqual([4, 5, 6]);
    expect(second.done).toBe(false);
  });

  test('carried on to the end, every page was read exactly once and the pass is closed', async () => {
    const h = harness({ '/bills': manyPages(8), ...Object.fromEntries(ids(64, 10).map((i) => [`/bills/${i}`, detailRoute('bill', 'bill_id')])) }, { callMs: 1000 });
    let runStartedAt: string | undefined;
    let done = false; let slices = 0;
    while (!done && slices < 60) {
      const r = await h.run({ modules: [bills], sliceMs: 5500, runStartedAt });
      runStartedAt = r.runStartedAt; done = r.done; slices++;
    }
    expect(done).toBe(true);
    const listCalls = h.calls.filter((c) => c.path === '/bills').map((c) => c.params.page);
    expect(listCalls).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(h.fs.states.get('bills')!.pass_kind).toBeNull();
  });

  test('once a module was read in this run, another slice of the run does not read it again', async () => {
    const h = harness({ '/invoices': () => page('invoices', 'invoice_id', [], false) });
    const a = await h.run({ modules: [invoices] });
    const before = h.calls.length;
    const b = await h.run({ modules: [invoices], runStartedAt: a.runStartedAt });
    expect(h.calls.length).toBe(before);
    expect(b.done).toBe(true);
  });
});

describe('runSlice — incremental', () => {
  test('after a full read, only records modified since the cursor (minus a 5-minute overlap) are asked for', async () => {
    const seeded = fakeStore({ states: [{ ...blankState('invoices'), last_full_at: '2026-09-19T00:00:00.000Z', incremental_cursor: '2026-09-20T00:00:00.000Z' }] });
    const h = harness({ '/invoices': () => page('invoices', 'invoice_id', [], false) }, { store: seeded });
    const r = await h.run({ modules: [invoices], mode: 'incremental' });
    expect(h.calls[0]!.params.last_modified_time).toBe('2026-09-19T23:55:00+0000');
    expect(r.modules[0]!.pass).toBe('incremental');
    expect(seeded.states.get('invoices')!.last_incremental_at).not.toBeNull();
  });

  test('mode "full" reads everything again, without the modified-time filter', async () => {
    const seeded = fakeStore({ states: [{ ...blankState('invoices'), last_full_at: '2026-09-19T00:00:00.000Z', incremental_cursor: '2026-09-20T00:00:00.000Z' }] });
    const h = harness({ '/invoices': () => page('invoices', 'invoice_id', [], false) }, { store: seeded });
    await h.run({ modules: [invoices], mode: 'full' });
    expect(h.calls[0]!.params).toEqual({ per_page: 200, page: 1 });
  });

  test('a module never fully read is read in full even in incremental mode', async () => {
    const h = harness({ '/invoices': () => page('invoices', 'invoice_id', [], false) });
    const r = await h.run({ modules: [invoices], mode: 'incremental' });
    expect(r.modules[0]!.pass).toBe('full');
  });
});

describe('runSlice — weekly full listing', () => {
  const seededAt = (daysAgo: number) => {
    const t = Date.parse('2026-09-21T10:00:00Z');
    return fakeStore({ states: [{ ...blankState('invoices'), last_full_at: new Date(t - daysAgo * 86_400_000).toISOString(), incremental_cursor: new Date(t - 3_600_000).toISOString() }] });
  };

  test('an incremental run turns into a full listing once the last full one is over a week old', async () => {
    const h = harness({ '/invoices': () => page('invoices', 'invoice_id', [], false) }, { store: seededAt(8) });
    const r = await h.run({ modules: [invoices], mode: 'incremental' });
    expect(r.modules[0]!.pass).toBe('full');
    expect(h.calls[0]!.params.last_modified_time).toBeUndefined();
  });

  test('within the week it stays incremental', async () => {
    const h = harness({ '/invoices': () => page('invoices', 'invoice_id', [], false) }, { store: seededAt(3) });
    const r = await h.run({ modules: [invoices], mode: 'incremental' });
    expect(r.modules[0]!.pass).toBe('incremental');
    expect(h.calls[0]!.params.last_modified_time).toBeDefined();
  });
});

describe('runSlice — one read per parent record (bank transactions per bank account)', () => {
  const bankTx: ModuleDef = {
    key: 'banktransactions', label: 'Bank transactions', phase: 'B', path: '/banktransactions', listKey: 'banktransactions',
    detail: 'none', incremental: false, fanOut: { parentModule: 'bankaccounts', param: 'account_id' }, fields: { id: 'transaction_id' },
  };
  const accounts = () => fakeStore({ records: ['a1', 'a2'].map((id) => ({ module: 'bankaccounts', id, stale: false, attempts: 0, removed: false, lastSeen: 1 })) });
  const txRoute: Route = (p) => {
    if (p.account_id === 'a1') return p.page === 1 ? page('banktransactions', 'transaction_id', ['t1', 't2'], true) : page('banktransactions', 'transaction_id', ['t3'], false);
    return page('banktransactions', 'transaction_id', ['t4'], false);
  };

  test('every account is read, page by page, with its id in the request', async () => {
    const h = harness({ '/banktransactions': txRoute }, { store: accounts() });
    const r = await h.run({ modules: [bankTx] });
    expect(h.calls.map((c) => [c.params.account_id, c.params.page])).toEqual([['a1', 1], ['a1', 2], ['a2', 1]]);
    expect(r.done).toBe(true);
    expect(r.modules[0]).toMatchObject({ received: 4, created: 4 });
  });

  test('each page is stored for the account it was listed for', async () => {
    const st = accounts();
    const h = harness({ '/banktransactions': txRoute }, { store: st });
    await h.run({ modules: [bankTx] });
    expect(st.pageParents).toEqual(['a1', 'a1', 'a2']);
  });

  test('the same transaction id under both accounts is kept for both', async () => {
    const st = accounts();
    const same: Route = (p) => page('banktransactions', 'transaction_id', ['SHARED'], false);
    const h = harness({ '/banktransactions': same }, { store: st });
    const r = await h.run({ modules: [bankTx] });
    expect(r.modules[0]).toMatchObject({ received: 2, created: 2, updated: 0 });
    expect([...st.records.keys()].filter((k) => k.startsWith('banktransactions:')).sort()).toEqual(['banktransactions:a1:SHARED', 'banktransactions:a2:SHARED']);
  });

  test('a stop in the middle of an account remembers the account and the page', async () => {
    const h = harness({ '/banktransactions': txRoute }, { store: accounts(), callMs: 1000 });
    const first = await h.run({ modules: [bankTx], sliceMs: 4000 }); // room for exactly one call
    expect(first.done).toBe(false);
    expect(h.calls.map((c) => [c.params.account_id, c.params.page])).toEqual([['a1', 1]]);
    expect(h.fs.states.get('bankTransactions'.toLowerCase())).toMatchObject({ pass_kind: 'full', page_cursor: 2 });
    const second = await h.run({ modules: [bankTx], sliceMs: 40_000, runStartedAt: first.runStartedAt });
    expect(h.calls.slice(1).map((c) => [c.params.account_id, c.params.page])).toEqual([['a1', 2], ['a2', 1]]);
    expect(second.done).toBe(true);
  });

  test('a stop between two accounts resumes at the next account, page 1', async () => {
    const h = harness({ '/banktransactions': txRoute }, { store: accounts(), callMs: 1000 });
    const first = await h.run({ modules: [bankTx], sliceMs: 4500 }); // two calls: a1 page 1 and 2
    expect(h.calls.map((c) => [c.params.account_id, c.params.page])).toEqual([['a1', 1], ['a1', 2]]);
    expect(h.fs.states.get('banktransactions')).toMatchObject({ pass_kind: 'full', sub_cursor: 'a2', page_cursor: 1 });
    await h.run({ modules: [bankTx], sliceMs: 40_000, runStartedAt: first.runStartedAt });
    expect(h.calls.slice(2).map((c) => [c.params.account_id, c.params.page])).toEqual([['a2', 1]]);
    expect(h.fs.states.get('banktransactions')).toMatchObject({ pass_kind: null, sub_cursor: null });
  });

  test('without the parent records it says so instead of reading nothing', async () => {
    const h = harness({ '/banktransactions': txRoute });
    const r = await h.run({ modules: [bankTx] });
    expect(h.calls).toHaveLength(0);
    expect(r.errors.join(' ')).toMatch(/no bankaccounts have been read yet/);
  });
});

describe('runSlice — modules that can only be read in full', () => {
  const items: ModuleDef = { key: 'items', label: 'Items', phase: 'B', path: '/items', listKey: 'items', detail: 'none', incremental: false, fields: { id: 'item_id' } };
  const at = (hoursAgo: number) => new Date(Date.parse('2026-09-21T10:00:00Z') - hoursAgo * 3_600_000).toISOString();
  const seeded = (hoursAgo: number) => fakeStore({ states: [{ ...blankState('items'), last_full_at: at(hoursAgo), incremental_cursor: at(hoursAgo) }] });
  const route = { '/items': () => page('items', 'item_id', ['i1'], false) };

  test('the scheduler reads them at most once a day', async () => {
    const h = harness(route, { store: seeded(2) });
    const r = await h.run({ modules: [items], scheduled: true, runStartedAt: at(1) });
    expect(h.calls).toHaveLength(0);
    expect(r.modules[0]!.listing).toBe('complete');
  });

  test('once a day has passed the scheduler reads them again', async () => {
    const h = harness(route, { store: seeded(30) });
    await h.run({ modules: [items], scheduled: true, runStartedAt: at(1) });
    expect(h.calls).toHaveLength(1);
  });

  test('a person asking to read reads them every time', async () => {
    const h = harness(route, { store: seeded(2) });
    await h.run({ modules: [items], runStartedAt: at(0) });
    expect(h.calls).toHaveLength(1);
  });

  test('incremental modules are not held back by the daily rule', async () => {
    const st = fakeStore({ states: [{ ...blankState('invoices'), last_full_at: at(5), incremental_cursor: at(5) }] });
    const h = harness({ '/invoices': () => page('invoices', 'invoice_id', [], false) }, { store: st });
    await h.run({ modules: [invoices], scheduled: true, runStartedAt: at(1) });
    expect(h.calls).toHaveLength(1);
  });
});

describe('runSlice — report snapshots', () => {
  const taxsummary: ReportDef = { key: 'taxsummary', label: 'Tax summary', path: '/reports/taxsummary', period: 'fy' };
  const aging: ReportDef = { key: 'aragingsummary', label: 'Receivables ageing', path: '/reports/aragingsummary', period: 'asof' };
  const years = [
    { label: 'FY 2024-25', start: '2024-04-01', end: '2025-03-31' },
    { label: 'FY 2025-26', start: '2025-04-01', end: '2026-03-31' },
    { label: 'FY 2026-27', start: '2026-04-01', end: '2027-03-31' },
  ];
  const reportRoutes = { '/reports/taxsummary': () => ({ code: 0, tax: [] }), '/reports/aragingsummary': () => ({ code: 0, invoice: {} }) };

  test('a period report is read for each year (to today for the running one); an as-at report only needs the date', async () => {
    const h = harness(reportRoutes, { store: fakeStore({ years }) });
    const r = await h.run({ modules: [], reports: [taxsummary, aging] });
    expect(r.done).toBe(true);
    const tax = h.calls.filter((c) => c.path === '/reports/taxsummary').map((c) => c.params);
    expect(tax).toEqual([
      { from_date: '2024-04-01', to_date: '2025-03-31' },
      { from_date: '2025-04-01', to_date: '2026-03-31' },
      { from_date: '2026-04-01', to_date: '2026-09-21' },
    ]);
    expect(h.calls.filter((c) => c.path === '/reports/aragingsummary').map((c) => c.params)).toEqual([
      { to_date: '2025-03-31' }, { to_date: '2026-03-31' }, { to_date: '2026-09-21' },
    ]);
    expect(h.fs.snapshotSaves.filter((s) => s.report === 'aragingsummary').every((s) => s.periodFrom === null)).toBe(true);
    expect(r.modules.find((m) => m.module === 'report:taxsummary')).toMatchObject({ listing: 'complete', created: 3 });
  });

  test('when no financial year covers today, an ageing report is also read as at today, a period report is not', async () => {
    const past = years.slice(0, 2); // FY 2024-25 and FY 2025-26: both over
    const h = harness(reportRoutes, { store: fakeStore({ years: past }) });
    await h.run({ modules: [], reports: [taxsummary, aging] });
    expect(h.calls.filter((c) => c.path === '/reports/aragingsummary').map((c) => c.params.to_date)).toEqual(['2025-03-31', '2026-03-31', '2026-09-21']);
    expect(h.calls.filter((c) => c.path === '/reports/taxsummary').map((c) => c.params.to_date)).toEqual(['2025-03-31', '2026-03-31']);
  });

  test('a running year already reaching today is not read twice as at today', async () => {
    const h = harness(reportRoutes, { store: fakeStore({ years }) });
    await h.run({ modules: [], reports: [aging] });
    expect(h.calls.map((c) => c.params.to_date).filter((d) => d === '2026-09-21')).toHaveLength(1);
  });

  test('a year that ended long ago is read once; the running year again on the next run', async () => {
    const first = harness(reportRoutes, { store: fakeStore({ years }) });
    await first.run({ modules: [], reports: [taxsummary] });
    const snaps = Object.fromEntries(first.fs.snapshots);
    const second = harness(reportRoutes, { store: fakeStore({ years, snapshots: snaps }) });
    // The next run starts an hour later: the running year's snapshot is now older than the run.
    await second.run({ modules: [], reports: [taxsummary], runStartedAt: new Date(Date.parse('2026-09-21T10:00:00Z') + 3_600_000).toISOString() });
    expect(second.calls.map((c) => c.params.to_date)).toEqual(['2026-09-21']);
  });

  test('"read everything again" re-reads the closed years too', async () => {
    const seen = { 'taxsummary:2025-03-31': 1, 'taxsummary:2026-03-31': 1 };
    const h = harness(reportRoutes, { store: fakeStore({ years: years.slice(0, 2), snapshots: seen }) });
    await h.run({ modules: [], reports: [taxsummary], mode: 'full' });
    expect(h.calls).toHaveLength(2);
  });

  test('a report Zoho rejects is reported once and left alone for the rest of the run', async () => {
    const h = harness({ '/reports/aragingsummary': () => ({ code: 0 }) }, { store: fakeStore({ years }) });
    const first = await h.run({ modules: [], reports: [taxsummary, aging] }); // taxsummary has no route: 404
    expect(first.modules.find((m) => m.module === 'report:taxsummary')).toMatchObject({ listing: 'error' });
    expect(first.modules.find((m) => m.module === 'report:aragingsummary')).toMatchObject({ listing: 'complete' });
    const before = h.calls.length;
    await h.run({ modules: [], reports: [taxsummary, aging], runStartedAt: first.runStartedAt });
    expect(h.calls.length).toBe(before);
  });

  test('reports honour the same time box and call budget', async () => {
    const h = harness(reportRoutes, { store: fakeStore({ years }), dailyLimit: 1000, used: 798 });
    const r = await h.run({ modules: [], reports: [taxsummary] });
    expect(r.stopped).toBe('daily_budget');
    expect(r.callsMade).toBe(2);
    expect(r.modules[0]!.listing).toBe('partial');
    expect(r.done).toBe(false);
  });
});

describe('runSlice — removals', () => {
  test('after a COMPLETE full listing, records Zoho no longer lists are flagged, not deleted', async () => {
    const seeded = fakeStore({ records: [{ module: 'invoices', id: 'gone', stale: false, attempts: 0, removed: false, lastSeen: 1 }] });
    const h = harness({
      '/invoices': () => page('invoices', 'invoice_id', ['1'], false), '/invoices/1': detailRoute('invoice', 'invoice_id'),
    }, { store: seeded });
    const r = await h.run({ modules: [invoices] });
    expect(r.modules[0]!.removed).toBe(1);
    expect(seeded.records.get('invoices:gone')!.removed).toBe(true);
    expect(seeded.records.get('invoices:1')!.removed).toBe(false);
  });

  test('an incremental pass never flags removals (it only sees what changed)', async () => {
    const seeded = fakeStore({
      states: [{ ...blankState('invoices'), last_full_at: '2026-09-19T00:00:00.000Z', incremental_cursor: '2026-09-20T00:00:00.000Z' }],
      records: [{ module: 'invoices', id: 'old', stale: false, attempts: 0, removed: false, lastSeen: 1 }],
    });
    const h = harness({ '/invoices': () => page('invoices', 'invoice_id', [], false) }, { store: seeded });
    await h.run({ modules: [invoices], mode: 'incremental' });
    expect(seeded.records.get('invoices:old')!.removed).toBe(false);
  });

  test('a full listing that returns nothing while records are stored flags nothing and says so', async () => {
    const seeded = fakeStore({ records: [{ module: 'invoices', id: 'a', stale: false, attempts: 0, removed: false, lastSeen: 1 }] });
    const h = harness({ '/invoices': () => page('invoices', 'invoice_id', [], false) }, { store: seeded });
    const r = await h.run({ modules: [invoices] });
    expect(seeded.records.get('invoices:a')!.removed).toBe(false);
    expect(r.errors.join(' ')).toMatch(/nothing was flagged as removed/);
  });
});

describe('runSlice — Zoho limits', () => {
  test('stops at the daily call cap (80% of the allowance, counting calls already made today)', async () => {
    const h = harness({ '/bills': (p) => page('bills', 'bill_id', [String(p.page)], true) }, { dailyLimit: 1000, used: 797 });
    const r = await h.run({ modules: [bills] });
    expect(r.stopped).toBe('daily_budget');
    expect(r.callsMade).toBe(3); // 800 cap - 797 used
    expect(r.done).toBe(false);
    expect(r.usage).toMatchObject({ used: 800, moduleCap: 800, dailyLimit: 1000 });
  });

  test('Zoho\'s own daily-limit answer (code 45) stops the slice and blocks the company for an hour', async () => {
    const h = harness({ '/bills': () => { throw Object.assign(new Error('You have reached the maximum number of API calls allowed per day.'), { status: 429, zohoCode: 45 }); } });
    const r = await h.run({ modules: [bills] });
    expect(r.stopped).toBe('daily_limit');
    expect(h.blocks).toHaveLength(1);
    expect(h.blocks[0]!.getTime() - h.now()).toBeGreaterThan(50 * 60_000);
    expect(r.errors.join(' ')).toMatch(/daily API limit/);
  });

  test('while the block lasts, nothing is called', async () => {
    const h = harness({ '/bills': () => page('bills', 'bill_id', ['1'], false) }, { blockedUntil: new Date(Date.parse('2026-09-21T10:00:00Z') + 30 * 60_000).toISOString() });
    const r = await h.run({ modules: [bills] });
    expect(r.stopped).toBe('daily_limit');
    expect(h.calls).toHaveLength(0);
  });

  test('a per-minute 429 that survives the retries ends the slice without blocking the day', async () => {
    const h = harness({ '/bills': () => { throw Object.assign(new Error('Too many requests'), { status: 429, zohoCode: 44 }); } });
    const r = await h.run({ modules: [bills] });
    expect(r.stopped).toBe('rate_limited');
    expect(h.blocks).toHaveLength(0);
  });

  test('a lost connection stops the slice instead of failing every module one by one', async () => {
    const h = harness({
      '/invoices': () => { throw Object.assign(new Error('Zoho re-authentication failed: invalid_code. You may need to reconnect Zoho Books'), { status: 401 }); },
      '/bills': () => page('bills', 'bill_id', ['1'], false),
    });
    const r = await h.run({ modules: [invoices, bills] });
    expect(r.stopped).toBe('auth');
    expect(h.calls.map((c) => c.path)).toEqual(['/invoices']);
  });
});

describe('runSlice — problems with one module or record', () => {
  test('a module Zoho rejects is reported, does not stop the others, and is not retried within the run', async () => {
    const h = harness({
      '/bills': () => page('bills', 'bill_id', ['9'], false), '/bills/9': detailRoute('bill', 'bill_id'),
    });
    const first = await h.run({ modules: [invoices, bills] }); // /invoices has no route: Zoho answers 404
    expect(first.done).toBe(true);
    expect(first.modules.find((m) => m.module === 'invoices')).toMatchObject({ listing: 'error' });
    expect(first.modules.find((m) => m.module === 'bills')).toMatchObject({ listing: 'complete', detailFetched: 1 });
    expect(first.errors.join(' ')).toMatch(/Invoices: Invalid URL Passed/);
    const before = h.calls.length;
    await h.run({ modules: [invoices, bills], runStartedAt: first.runStartedAt });
    expect(h.calls.length).toBe(before);
  });

  test('a record Zoho no longer has (404 on detail) is flagged removed and not asked again', async () => {
    const h = harness({
      '/bills': () => page('bills', 'bill_id', ['1', '2'], false),
      '/bills/1': detailRoute('bill', 'bill_id'),
      '/bills/2': () => { throw Object.assign(new Error('gone'), { status: 404 }); },
    });
    const r = await h.run({ modules: [bills] });
    expect(r.done).toBe(true);
    expect(h.fs.records.get('bills:2')!.removed).toBe(true);
    expect(h.calls.filter((c) => c.path === '/bills/2')).toHaveLength(1);
  });

  test('a record whose detail keeps failing is given up on after 3 attempts, not retried forever', async () => {
    const h = harness({
      '/bills': () => page('bills', 'bill_id', ['1'], false),
      '/bills/1': () => { throw Object.assign(new Error('server error'), { status: 500 }); },
    });
    let runStartedAt: string | undefined;
    for (let i = 0; i < 5; i++) { const r = await h.run({ modules: [bills], runStartedAt }); runStartedAt = r.runStartedAt; }
    // One attempt per slice, three slices, then it is left alone.
    expect(h.calls.filter((c) => c.path === '/bills/1')).toHaveLength(3);
    expect(h.fs.records.get('bills:1')!.attempts).toBe(3);
  });

  test('a response with no record body counts as a failed detail read, not a crash', async () => {
    const h = harness({ '/bills': () => page('bills', 'bill_id', ['1'], false), '/bills/1': () => ({ code: 0, message: 'success' }) });
    const r = await h.run({ modules: [bills] });
    expect(r.modules[0]!.detailFailed).toBeGreaterThan(0);
  });
});

describe('runSlice — optional detail (expenses)', () => {
  test('expense detail is not read unless switched on', async () => {
    const h = harness({ '/expenses': () => page('expenses', 'expense_id', ['e1'], false), '/expenses/e1': detailRoute('expense', 'expense_id') });
    await h.run({ modules: [expenses] });
    expect(h.calls.map((c) => c.path)).toEqual(['/expenses']);
  });

  test('switching it on reads the detail, and the choice is remembered for later slices', async () => {
    const h = harness({ '/expenses': () => page('expenses', 'expense_id', ['e1'], false), '/expenses/e1': detailRoute('expense', 'expense_id') });
    await h.run({ modules: [expenses], enableDetail: ['expenses'] });
    expect(h.calls.map((c) => c.path)).toEqual(['/expenses', '/expenses/e1']);
    expect(h.fs.states.get('expenses')!.detail_enabled).toBe(true);
  });

  test('enable_detail is ignored for a module whose detail is not optional', async () => {
    const h = harness({ '/invoices': () => page('invoices', 'invoice_id', [], false) });
    await h.run({ modules: [invoices], enableDetail: ['invoices'] });
    expect(h.fs.states.get('invoices')!.detail_enabled).toBeNull();
  });
});

describe('runSlice — two readers at once', () => {
  test('a module another slice has claimed is skipped and the run is not reported done', async () => {
    const h = harness({ '/bills': () => page('bills', 'bill_id', [], false) }, { store: fakeStore({ busy: ['invoices'] }) });
    const r = await h.run({ modules: [invoices, bills] });
    expect(r.modules.find((m) => m.module === 'invoices')!.listing).toBe('busy');
    expect(h.calls.map((c) => c.path)).toEqual(['/bills']);
    expect(r.done).toBe(false);
  });
});
