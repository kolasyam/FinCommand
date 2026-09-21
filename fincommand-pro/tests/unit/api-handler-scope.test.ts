const mockClaim = jest.fn();
jest.mock('@/lib/auth/permissions', () => ({
  ApiError: class ApiError extends Error { status = 500; code?: string; extra?: unknown; },
  claimedCompanyId: (...a: unknown[]) => mockClaim(...a),
}));

import type { NextRequest } from 'next/server';
import { withErrorHandling } from '@/lib/utils/api-handler';
import { currentCompanyId } from '@/lib/db/tenant-context';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const req = { method: 'GET', nextUrl: { pathname: '/x' } } as unknown as NextRequest;
const respond = () => new Response('ok');

beforeEach(() => { mockClaim.mockReset(); jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe('withErrorHandling puts a request in its company\'s scope', () => {
  test('the company from the verified token is what the handler and everything it awaits run as', async () => {
    mockClaim.mockReturnValue(A);
    const seen: Array<string | null> = [];
    await withErrorHandling(async () => {
      seen.push(currentCompanyId());
      await new Promise((r) => setTimeout(r, 1));
      seen.push(currentCompanyId());
      return respond();
    })(req, {} as never);
    expect(seen).toEqual([A, A]);
    expect(currentCompanyId()).toBeNull();
  });

  test('no token: no company (the handler decides; authenticate() will refuse)', async () => {
    mockClaim.mockReturnValue(null);
    let seen: string | null = 'unset';
    await withErrorHandling(async () => { seen = currentCompanyId(); return respond(); })(req, {} as never);
    expect(seen).toBeNull();
  });

  test('a claim that is not a UUID is ignored rather than trusted', async () => {
    mockClaim.mockReturnValue(`${A}'; DROP TABLE users; --`);
    let seen: string | null = 'unset';
    await withErrorHandling(async () => { seen = currentCompanyId(); return respond(); })(req, {} as never);
    expect(seen).toBeNull();
  });

  test('{ system: true } routes (login, signup, refresh, cron ...) ignore even a valid token, and never read it', async () => {
    mockClaim.mockReturnValue(A);
    let seen: string | null = 'unset';
    await withErrorHandling(async () => { seen = currentCompanyId(); return respond(); }, { system: true })(req, {} as never);
    expect(seen).toBeNull();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  test('errors are still shaped as before, and the scope is left afterwards', async () => {
    mockClaim.mockReturnValue(A);
    const res = await withErrorHandling(async () => { throw Object.assign(new Error('bad'), { status: 418 }); })(req, {} as never);
    expect(res.status).toBe(418);
    expect(currentCompanyId()).toBeNull();
  });
});
