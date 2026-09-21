/**
 * lib/db/neon.ts with the restricted login configured: which pool a query uses, and the exact
 * statement sequence a company-scoped query or transaction sends. `pg` is faked.
 */
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface FakeClient { sql: string[]; release: jest.Mock; query: jest.Mock }
const pools: Array<{ config: Record<string, unknown>; query: jest.Mock; connect: jest.Mock; end: jest.Mock; on: jest.Mock; clients: FakeClient[] }> = [];
let failOn: RegExp | null = null;
let failRollback = false;

jest.mock('pg', () => ({
  Pool: class {
    config: Record<string, unknown>; query = jest.fn(async () => ({ rows: [{ via: 'pool' }], rowCount: 1 }));
    end = jest.fn(async () => {}); on = jest.fn(); clients: FakeClient[] = [];
    connect = jest.fn(async () => {
      const sql: string[] = [];
      const client: FakeClient = {
        sql, release: jest.fn(),
        query: jest.fn(async (text: string) => {
          sql.push(text);
          if (failRollback && text === 'ROLLBACK') throw new Error('connection lost');
          if (failOn && failOn.test(text)) throw new Error('statement failed');
          return { rows: [{ via: 'client' }], rowCount: 1 };
        }),
      };
      this.clients.push(client);
      return client;
    });
    constructor(config: Record<string, unknown>) { this.config = config; pools.push(this as never); }
  },
}));

const load = () => {
  let mod!: typeof import('@/lib/db/neon');
  let ctx!: typeof import('@/lib/db/tenant-context');
  jest.isolateModules(() => {
    mod = require('@/lib/db/neon');
    ctx = require('@/lib/db/tenant-context');
  });
  return { ...mod, ...ctx };
};

const ENV_KEYS = ['DB_APP_USER', 'DB_APP_PASSWORD', 'DATABASE_URL', 'DB_USER', 'DB_PASSWORD', 'DB_HOST'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  pools.length = 0; failOn = null; failRollback = false;
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  delete (global as { __fcPgPool?: unknown }).__fcPgPool;
  delete (global as { __fcTenantPool?: unknown }).__fcTenantPool;
});
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('when the restricted login is NOT configured (today, and local dev)', () => {
  test('there is one pool and a company context changes nothing', async () => {
    const n = load();
    expect(pools).toHaveLength(1);
    expect(n.rowLevelSecurityActive()).toBe(false);
    expect(n.tenantPool).toBeNull();
    await n.runAsCompany(A, () => n.query('SELECT 1'));
    expect(pools[0]!.query).toHaveBeenCalledWith('SELECT 1', undefined);
    expect(pools[0]!.connect).not.toHaveBeenCalled();
  });

  test('withTransaction sends a plain BEGIN', async () => {
    const n = load();
    await n.runAsCompany(A, () => n.withTransaction(async (c) => { await c.query('SELECT 2'); }));
    expect(pools[0]!.clients[0]!.sql).toEqual(['BEGIN', 'SELECT 2', 'COMMIT']);
  });

  test('one variable without the other is not enough', () => {
    process.env.DB_APP_USER = 'fincommand_app';
    expect(load().rowLevelSecurityActive()).toBe(false);
    process.env.DB_APP_USER = ''; process.env.DB_APP_PASSWORD = 'x';
    expect(load().rowLevelSecurityActive()).toBe(false);
  });
});

describe('when the restricted login IS configured', () => {
  beforeEach(() => { process.env.DB_APP_USER = 'fincommand_app'; process.env.DB_APP_PASSWORD = 'not-a-real-password'; process.env.DB_HOST = 'db.example'; process.env.DB_USER = 'owner'; process.env.DB_PASSWORD = 'owner-pw'; });

  test('two pools exist: the system one keeps the owner login, the tenant one logs in as the restricted role', () => {
    const n = load();
    expect(pools).toHaveLength(2);
    expect(n.rowLevelSecurityActive()).toBe(true);
    expect(pools[0]!.config).toMatchObject({ user: 'owner', password: 'owner-pw' });
    expect(pools[1]!.config).toMatchObject({ user: 'fincommand_app', password: 'not-a-real-password', host: 'db.example' });
  });

  test('with DATABASE_URL the tenant pool gets the same URL with the restricted login', () => {
    process.env.DATABASE_URL = 'postgresql://owner:owner-pw@ep-x.example/neondb?sslmode=require';
    load();
    const url = new URL(String(pools[1]!.config.connectionString));
    expect(url.username).toBe('fincommand_app');
    expect(url.password).toBe('not-a-real-password');
    expect(url.host).toBe('ep-x.example');
    expect(String(pools[0]!.config.connectionString)).toContain('owner:owner-pw@');
  });

  test('a query with NO company (login, cron listing, keepalive) uses the system pool', async () => {
    const n = load();
    const r = await n.query('SELECT 1');
    expect(r.rows[0]).toEqual({ via: 'pool' });
    expect(pools[0]!.query).toHaveBeenCalledTimes(1);
    expect(pools[1]!.connect).not.toHaveBeenCalled();
  });

  test('a query inside a company runs BEGIN+scope, the statement with its parameters, then COMMIT, on the tenant pool', async () => {
    const n = load();
    const r = await n.runAsCompany(A, () => n.query('SELECT * FROM tb_uploads WHERE id = $1', ['u1']));
    expect(r.rows[0]).toEqual({ via: 'client' });
    const client = pools[1]!.clients[0]!;
    expect(client.sql).toEqual([
      `BEGIN; SELECT set_config('app.company_id', '${A}', true)`,
      'SELECT * FROM tb_uploads WHERE id = $1',
      'COMMIT',
    ]);
    expect(client.query.mock.calls[1]).toEqual(['SELECT * FROM tb_uploads WHERE id = $1', ['u1']]);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(undefined);
    expect(pools[0]!.query).not.toHaveBeenCalled();
  });

  test('the scope is local to the transaction (set_config is_local = true), so nothing lingers on a pooled connection', () => {
    const n = load();
    expect(n.scopedBeginSql(A)).toMatch(/set_config\('app\.company_id', '[0-9a-f-]{36}', true\)$/);
  });

  test('runAsSystem inside a company goes back to the system pool', async () => {
    const n = load();
    await n.runAsCompany(A, () => n.runAsSystem(() => n.query('SELECT 1')));
    expect(pools[0]!.query).toHaveBeenCalledTimes(1);
    expect(pools[1]!.connect).not.toHaveBeenCalled();
  });

  test('a failing statement is rolled back, the error reaches the caller, and the connection is released', async () => {
    const n = load();
    failOn = /^UPDATE/;
    await expect(n.runAsCompany(A, () => n.query('UPDATE t SET a = 1'))).rejects.toThrow('statement failed');
    const client = pools[1]!.clients[0]!;
    expect(client.sql).toEqual([expect.stringMatching(/^BEGIN/), 'UPDATE t SET a = 1', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  test('a connection that cannot even roll back is discarded, not reused', async () => {
    const n = load();
    failOn = /^UPDATE/; failRollback = true;
    await expect(n.runAsCompany(A, () => n.query('UPDATE t SET a = 1'))).rejects.toThrow('statement failed');
    expect(pools[1]!.clients[0]!.release).toHaveBeenCalledWith(expect.any(Error));
  });

  test('withTransaction inside a company is scoped from its FIRST statement (no extra round trip) and commits', async () => {
    const n = load();
    await n.runAsCompany(A, () => n.withTransaction(async (c) => { await c.query('INSERT INTO t VALUES (1)'); await c.query('INSERT INTO t VALUES (2)'); }));
    expect(pools[1]!.clients[0]!.sql).toEqual([
      `BEGIN; SELECT set_config('app.company_id', '${A}', true)`, 'INSERT INTO t VALUES (1)', 'INSERT INTO t VALUES (2)', 'COMMIT',
    ]);
    expect(pools[0]!.connect).not.toHaveBeenCalled();
  });

  test('withTransaction with no company uses the system pool and a plain BEGIN', async () => {
    const n = load();
    await n.withTransaction(async (c) => { await c.query('SELECT 1'); });
    expect(pools[0]!.clients[0]!.sql).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(pools[1]!.connect).not.toHaveBeenCalled();
  });

  test('a failure inside withTransaction rolls back on the tenant client', async () => {
    const n = load();
    await expect(n.runAsCompany(A, () => n.withTransaction(async () => { throw new Error('nope'); }))).rejects.toThrow('nope');
    expect(pools[1]!.clients[0]!.sql).toEqual([expect.stringMatching(/^BEGIN/), 'ROLLBACK']);
  });

  test('parallel queries in one request each get their own scoped transaction (the report "waves" still run in parallel)', async () => {
    const n = load();
    await n.runAsCompany(A, () => Promise.all([n.query('SELECT 1'), n.query('SELECT 2'), n.query('SELECT 3')]));
    expect(pools[1]!.clients).toHaveLength(3);
    for (const c of pools[1]!.clients) expect(c.sql[0]).toBe(`BEGIN; SELECT set_config('app.company_id', '${A}', true)`);
  });

  test('endPools closes both pools', async () => {
    const n = load();
    await n.endPools();
    expect(pools[0]!.end).toHaveBeenCalled();
    expect(pools[1]!.end).toHaveBeenCalled();
  });
});

describe('tenantCredentials', () => {
  test('needs both values; trims the user name', () => {
    const { tenantCredentials } = load();
    expect(tenantCredentials({ DB_APP_USER: ' app ', DB_APP_PASSWORD: 'p' } as never)).toEqual({ user: 'app', password: 'p' });
    expect(tenantCredentials({ DB_APP_USER: 'app' } as never)).toBeNull();
    expect(tenantCredentials({ DB_APP_PASSWORD: 'p' } as never)).toBeNull();
    expect(tenantCredentials({} as never)).toBeNull();
  });
});
