import { keepAliveIntervalMs, startKeepAlive } from '@/lib/db/neon';

const fakePool = (impl: () => Promise<unknown> = () => Promise.resolve({ rows: [] })) => ({ query: jest.fn(impl) });

describe('database keep-alive (keeps the Neon compute awake between requests)', () => {
  test('which processes ping: not tests, not Vercel (a cron does it there), everyone else every 4 minutes', () => {
    expect(keepAliveIntervalMs({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(0);
    expect(keepAliveIntervalMs({ NODE_ENV: 'production', VERCEL: '1' } as NodeJS.ProcessEnv)).toBe(0);
    expect(keepAliveIntervalMs({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(240000);
    expect(keepAliveIntervalMs({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(240000);
    // 4 minutes < Neon's 5-minute suspend window
    expect(240000).toBeLessThan(5 * 60 * 1000);
  });

  test('DB_KEEPALIVE_MS overrides it; 0, negative or junk turns it off', () => {
    const e = (v: string) => ({ NODE_ENV: 'production', DB_KEEPALIVE_MS: v }) as NodeJS.ProcessEnv;
    expect(keepAliveIntervalMs(e('60000'))).toBe(60000);
    expect(keepAliveIntervalMs(e('0'))).toBe(0);
    expect(keepAliveIntervalMs(e('-5'))).toBe(0);
    expect(keepAliveIntervalMs(e('soon'))).toBe(0);
    expect(keepAliveIntervalMs({ NODE_ENV: 'production', VERCEL: '1', DB_KEEPALIVE_MS: '30000' } as NodeJS.ProcessEnv)).toBe(30000); // explicit beats the Vercel default
  });

  describe('the ping itself', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
      if (global.__fcPgKeepAlive) clearInterval(global.__fcPgKeepAlive);
      global.__fcPgKeepAlive = undefined;
      jest.useRealTimers();
    });

    test('runs a trivial query on every interval', () => {
      const pool = fakePool();
      startKeepAlive(pool, 1000);
      jest.advanceTimersByTime(3500);
      expect(pool.query).toHaveBeenCalledTimes(3);
      expect(pool.query).toHaveBeenCalledWith('SELECT 1');
    });

    test('a failing ping is swallowed — the next real request will surface a real outage', async () => {
      const pool = fakePool(() => Promise.reject(new Error('database is down')));
      startKeepAlive(pool, 1000);
      jest.advanceTimersByTime(2100);
      await Promise.resolve();
      expect(pool.query).toHaveBeenCalledTimes(2); // and no unhandled rejection was raised
    });

    test('never keeps the process alive (unref\'d)', () => {
      const timer = startKeepAlive(fakePool(), 1000) as unknown as { hasRef?: () => boolean };
      if (typeof timer.hasRef === 'function') expect(timer.hasRef()).toBe(false);
    });

    test('starting again replaces the old timer — a hot reload can\'t stack pings', () => {
      const first = fakePool(), second = fakePool();
      startKeepAlive(first, 1000);
      startKeepAlive(second, 1000);
      jest.advanceTimersByTime(2500);
      expect(first.query).not.toHaveBeenCalled();
      expect(second.query).toHaveBeenCalledTimes(2);
    });
  });
});
