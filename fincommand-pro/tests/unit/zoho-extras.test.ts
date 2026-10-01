import { commentRows, fileNameFromDisposition, runExtrasSlice, type ExtrasDeps, type ExtrasStore, type BinaryResponse } from '@/lib/services/zoho/extras';

function fake(opts: {
  pending?: Record<string, string[]>; // "kind:module" -> ids still to read
  http?: (path: string) => Promise<unknown>;
  bin?: (path: string) => Promise<BinaryResponse>;
  accounts?: string[];
  used?: number; cap?: number;
}) {
  const saved = { comments: [] as string[], files: [] as string[], failures: [] as string[], done: [] as string[], statements: [] as string[], calls: [] as string[] };
  const pending = new Map(Object.entries(opts.pending ?? {}).map(([k, v]) => [k, [...v]]));
  const store: ExtrasStore = {
    needing: async (_c, kind, module, limit) => (pending.get(`${kind}:${module}`) ?? []).slice(0, limit),
    saveComments: async (_c, module, id, rows) => { saved.comments.push(`${module}/${id}`); pending.set(`comments:${module}`, (pending.get(`comments:${module}`) ?? []).filter((x) => x !== id)); return rows.length; },
    saveAttachment: async (_c, module, id, f) => { saved.files.push(`${module}/${id}/${f.fileName}`); pending.set(`attachment:${module}`, (pending.get(`attachment:${module}`) ?? []).filter((x) => x !== id)); return 'stored'; },
    markDone: async (_c, kind, module, id) => { saved.done.push(`${kind}:${module}/${id}`); pending.set(`${kind}:${module}`, (pending.get(`${kind}:${module}`) ?? []).filter((x) => x !== id)); },
    markFailure: async (_c, kind, module, id) => { saved.failures.push(`${kind}:${module}/${id}`); pending.set(`${kind}:${module}`, (pending.get(`${kind}:${module}`) ?? []).filter((x) => x !== id)); },
    accountsNeedingStatement: async () => opts.accounts ?? [],
    saveStatement: async (_c, id) => { saved.statements.push(id); },
  };
  let t = 1_000_000;
  const deps: ExtrasDeps = {
    store,
    http: async (path) => { saved.calls.push(path); return opts.http ? opts.http(path) : { comments: [] }; },
    httpBinary: async (path) => { saved.calls.push(path); return opts.bin ? opts.bin(path) : { kind: 'file', bytes: Buffer.from('pdf'), contentType: 'application/pdf', fileName: 'a.pdf' }; },
    now: () => t,
    sleep: async (ms) => { t += ms; },
    usage: { get: async () => ({ used: opts.used ?? 0, dailyLimit: 5000, moduleCap: opts.cap ?? 4000, blockedUntil: null }), flush: async () => {}, block: async () => {} },
  };
  return { deps, saved };
}
const run = (d: ExtrasDeps, maxCalls = 100) => runExtrasSlice('co', d, { maxCalls, deadlineAt: 1_000_000 + 10 * 60_000 });

describe('commentRows', () => {
  test('keeps every comment with its id, author, time and the full payload', () => {
    const rows = commentRows({ comments: [
      { comment_id: '1', description: 'Invoice created', commented_by: 'Arun', date: '2026-07-02', time: '10:30 AM', operation_type: 'Added' },
      { comment_id: 2, description: 'Sent', commented_by: 'Arun', date: '2026-07-03' },
      { description: 'no id - dropped' },
    ] });
    expect(rows.map((r) => r.commentId)).toEqual(['1', '2']);
    expect(rows[0]).toMatchObject({ commentedBy: 'Arun', description: 'Invoice created', commentType: 'Added' });
    expect(rows[1]!.commentedAt).not.toBeNull();
    expect(rows[0]!.payload.operation_type).toBe('Added');
  });
  test('anything else is no comments', () => {
    expect(commentRows(null)).toEqual([]);
    expect(commentRows({ comments: 'x' })).toEqual([]);
  });
});

describe('fileNameFromDisposition', () => {
  test('plain, quoted and UTF-8 names', () => {
    expect(fileNameFromDisposition('attachment; filename="INV-001.pdf"')).toBe('INV-001.pdf');
    expect(fileNameFromDisposition("attachment; filename*=UTF-8''Bill%20May.pdf")).toBe('Bill May.pdf');
    expect(fileNameFromDisposition('inline; filename=scan.png')).toBe('scan.png');
    expect(fileNameFromDisposition(null)).toBeNull();
  });
});

describe('runExtrasSlice', () => {
  test('reads statements, comments and files, one call each, and records them', async () => {
    const { deps, saved } = fake({ accounts: ['acc1'], pending: { 'comments:invoices': ['i1', 'i2'], 'attachment:bills': ['b1'] } });
    const r = await run(deps);
    expect(saved.statements).toEqual(['acc1']);
    expect(saved.comments).toEqual(['invoices/i1', 'invoices/i2']);
    expect(saved.files).toEqual(['bills/b1/a.pdf']);
    expect(r.callsMade).toBe(4);
    expect(r.stopped).toBe('complete');
    expect(saved.calls).toContain('/invoices/i1/comments');
    expect(saved.calls).toContain('/bills/b1/attachment');
  });

  test('expenses use the /receipt path', async () => {
    const { deps, saved } = fake({ pending: { 'attachment:expenses': ['e1'] } });
    await run(deps);
    expect(saved.calls).toContain('/expenses/e1/receipt');
  });

  test('stops at the call limit and leaves the rest for the next slice', async () => {
    const { deps, saved } = fake({ pending: { 'comments:invoices': ['a', 'b', 'c', 'd', 'e'] } });
    const r = await run(deps, 3);
    expect(r.callsMade).toBe(3);
    expect(r.stopped).toBe('calls');
    expect(saved.comments).toHaveLength(3);
  });

  test('does nothing when the daily allowance is already used', async () => {
    const { deps } = fake({ used: 4000, pending: { 'comments:invoices': ['a'] } });
    const r = await run(deps);
    expect(r.callsMade).toBe(0);
    expect(r.stopped).toBe('daily_budget');
  });

  test('a module whose endpoint always fails is given up after 3 misses; other modules still run', async () => {
    const { deps, saved } = fake({
      pending: { 'comments:vendorpayments': ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'], 'comments:bills': ['b1'] },
      http: async (p) => { if (p.startsWith('/vendorpayments')) throw Object.assign(new Error('Invalid URL Passed'), { status: 404 }); return { comments: [{ comment_id: 'c', date: '2026-01-01' }] }; },
    });
    const r = await run(deps);
    expect(saved.failures).toHaveLength(3);
    expect(saved.comments).toEqual(['bills/b1']);
    expect(r.comments.failed).toBe(3);
  });

  test('a dead connection ends the slice at once', async () => {
    const { deps, saved } = fake({
      pending: { 'comments:invoices': ['a', 'b'] },
      http: async () => { throw Object.assign(new Error('Zoho re-authentication failed'), { status: 401 }); },
    });
    const r = await run(deps);
    expect(r.stopped).toBe('auth');
    expect(r.callsMade).toBe(1);
    expect(saved.failures).toHaveLength(0);
  });

  test('"no file" answers are failures, and an oversized file is skipped but not retried', async () => {
    const big = Buffer.alloc(16 * 1024 * 1024);
    const { deps, saved } = fake({
      pending: { 'attachment:invoices': ['n1', 'big1'] },
      bin: async (p) => (p.includes('n1') ? { kind: 'json', body: { code: 5, message: 'no attachment' } } : { kind: 'file', bytes: big, contentType: 'application/pdf', fileName: 'big.pdf' }),
    });
    const r = await run(deps);
    expect(r.attachments.failed).toBe(1);
    expect(r.attachments.skipped).toBe(1);
    expect(saved.files).toHaveLength(0);
    expect(saved.done).toContain('attachment:invoices/big1');
  });
});
