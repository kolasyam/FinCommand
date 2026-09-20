import { NextRequest } from 'next/server';
import { checkCronSecret } from '@/lib/auth/cron-auth';

const req = (authorization?: string) =>
  new NextRequest('http://localhost/api/v1/internal/keepalive', { headers: authorization ? { authorization } : {} });

describe('checkCronSecret — who may call the scheduler-only endpoints', () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { secret: env.CRON_SECRET, node: env.NODE_ENV };
  afterEach(() => { env.CRON_SECRET = saved.secret; env.NODE_ENV = saved.node; jest.restoreAllMocks(); });

  test('with a secret set: only the exact bearer token passes', async () => {
    env.CRON_SECRET = 'correct-horse';
    expect(checkCronSecret(req('Bearer correct-horse'), 't')).toBeNull();
    for (const bad of [undefined, '', 'Bearer wrong', 'Bearer correct-hors', 'Bearer correct-horsee', 'correct-horse', 'bearer correct-horse']) {
      const denied = checkCronSecret(req(bad), 't');
      expect(denied?.status).toBe(401);
    }
  });

  test('production with no secret configured fails closed (503), and says why in the log', () => {
    delete env.CRON_SECRET;
    env.NODE_ENV = 'production';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(checkCronSecret(req(), 'keepalive')?.status).toBe(503);
    expect(spy.mock.calls[0][0]).toMatch(/keepalive.*CRON_SECRET is not set/);
  });

  test('outside production with no secret, a local scheduler or curl is allowed', () => {
    delete env.CRON_SECRET;
    env.NODE_ENV = 'development';
    expect(checkCronSecret(req(), 't')).toBeNull();
  });
});
