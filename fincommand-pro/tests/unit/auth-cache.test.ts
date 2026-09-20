import { NextRequest } from 'next/server';
import { authenticate, invalidateAuthCache, ApiError, type AuthUser } from '@/lib/auth/permissions';
import { signAccessToken } from '@/lib/auth/jwt';
import { query } from '@/lib/db/neon';

jest.mock('@/lib/db/neon', () => ({ query: jest.fn() }));
const mockQuery = query as unknown as jest.Mock;

const env = process.env as Record<string, string | undefined>;
const bearer = (userId: string) => new NextRequest('http://localhost/api/v1/fy', {
  headers: { authorization: `Bearer ${signAccessToken(userId, 'cfo', 'c1')}` },
});
const userRow = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: 'u1', name: 'Ada', email: 'ada@example.com', role: 'cfo', company_id: 'c1',
  is_active: true, permissions: { tabs: ['bs'] }, company_name: 'Acme', ...over,
});
const found = (row: AuthUser) => mockQuery.mockResolvedValue({ rows: [row] });

describe('authenticate() — short-lived cache of the user lookup', () => {
  const saved = { secret: env.JWT_SECRET, ttl: env.AUTH_CACHE_TTL_MS, node: env.NODE_ENV };
  beforeEach(() => {
    env.JWT_SECRET = 'unit-test-secret-not-a-real-one';
    delete env.AUTH_CACHE_TTL_MS;
    env.NODE_ENV = 'test';
    mockQuery.mockReset();
    invalidateAuthCache();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    env.JWT_SECRET = saved.secret; env.AUTH_CACHE_TTL_MS = saved.ttl; env.NODE_ENV = saved.node;
    if (saved.secret === undefined) delete env.JWT_SECRET;
    if (saved.ttl === undefined) delete env.AUTH_CACHE_TTL_MS;
  });

  test('a burst of requests from one user costs one lookup', async () => {
    found(userRow());
    const a = await authenticate(bearer('u1'));
    const b = await authenticate(bearer('u1'));
    const c = await authenticate(bearer('u1'));
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect([a.role, b.role, c.role]).toEqual(['cfo', 'cfo', 'cfo']);
    expect(b).toEqual(a);
  });

  test('every caller gets its own copy — changing one can\'t change what the next request sees', async () => {
    found(userRow());
    await authenticate(bearer('u1'));
    const first = await authenticate(bearer('u1'));
    first.role = 'admin';
    (first.permissions as Record<string, unknown>).tabs = ['everything'];
    const second = await authenticate(bearer('u1'));
    expect(second.role).toBe('cfo');
    expect(second.permissions).toEqual({ tabs: ['bs'] });
  });

  test('it expires: after 30 s the database is asked again and its answer wins', async () => {
    found(userRow());
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    await authenticate(bearer('u1'));
    clock.mockReturnValue(now + 29_000);
    await authenticate(bearer('u1'));
    expect(mockQuery).toHaveBeenCalledTimes(1);

    found(userRow({ role: 'viewer' }));
    clock.mockReturnValue(now + 31_000);
    expect((await authenticate(bearer('u1'))).role).toBe('viewer');
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  test('a user who is deactivated elsewhere keeps access only until it expires — the accepted trade-off, and no longer', async () => {
    found(userRow());
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    await authenticate(bearer('u1'));

    found(userRow({ is_active: false }));           // deactivated on another instance
    clock.mockReturnValue(now + 10_000);
    await expect(authenticate(bearer('u1'))).resolves.toMatchObject({ id: 'u1' }); // still served (within the TTL)
    clock.mockReturnValue(now + 30_001);
    await expect(authenticate(bearer('u1'))).rejects.toMatchObject({ status: 401 }); // …and refused once it expires
  });

  test('on the instance that makes the change it takes effect at once (invalidateAuthCache)', async () => {
    found(userRow());
    await authenticate(bearer('u1'));
    found(userRow({ is_active: false }));
    invalidateAuthCache('u1');
    await expect(authenticate(bearer('u1'))).rejects.toMatchObject({ status: 401, message: 'User not found or inactive' });
  });

  test('a failed lookup is never cached — an unknown or inactive user is checked against the database every time', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(authenticate(bearer('ghost'))).rejects.toBeInstanceOf(ApiError);
    await expect(authenticate(bearer('ghost'))).rejects.toBeInstanceOf(ApiError);
    expect(mockQuery).toHaveBeenCalledTimes(2);

    found(userRow({ id: 'u2', is_active: false }));
    await expect(authenticate(bearer('u2'))).rejects.toMatchObject({ status: 401 });
    found(userRow({ id: 'u2' }));                    // reactivated: works immediately, nothing stale was kept
    await expect(authenticate(bearer('u2'))).resolves.toMatchObject({ id: 'u2' });
  });

  test('users don\'t share entries', async () => {
    mockQuery.mockImplementation(async (_sql: string, [id]: string[]) => ({ rows: [userRow({ id, name: `User ${id}` })] }));
    expect((await authenticate(bearer('u1'))).name).toBe('User u1');
    expect((await authenticate(bearer('u2'))).name).toBe('User u2');
    expect((await authenticate(bearer('u1'))).name).toBe('User u1');
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  test('the token is still verified on every request, cached user or not', async () => {
    found(userRow());
    await authenticate(bearer('u1'));
    mockQuery.mockClear();
    await expect(authenticate(new NextRequest('http://localhost/x', { headers: { authorization: 'Bearer not-a-token' } })))
      .rejects.toMatchObject({ status: 401, message: 'Invalid authentication token' });
    await expect(authenticate(new NextRequest('http://localhost/x'))).rejects.toMatchObject({ status: 401 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('AUTH_CACHE_TTL_MS=0 turns it off, and so does development', async () => {
    found(userRow());
    env.AUTH_CACHE_TTL_MS = '0';
    await authenticate(bearer('u1')); await authenticate(bearer('u1'));
    expect(mockQuery).toHaveBeenCalledTimes(2);

    delete env.AUTH_CACHE_TTL_MS; invalidateAuthCache(); mockQuery.mockClear();
    env.NODE_ENV = 'development';
    await authenticate(bearer('u1')); await authenticate(bearer('u1'));
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  test('AUTH_CACHE_TTL_MS sets the lifetime', async () => {
    found(userRow());
    env.AUTH_CACHE_TTL_MS = '5000';
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    await authenticate(bearer('u1'));
    clock.mockReturnValue(now + 4_000);
    await authenticate(bearer('u1'));
    expect(mockQuery).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + 5_001);
    await authenticate(bearer('u1'));
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});
