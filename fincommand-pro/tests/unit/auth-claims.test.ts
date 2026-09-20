import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';
import { claimedCompanyId } from '@/lib/auth/permissions';
import { signAccessToken } from '@/lib/auth/jwt';

const req = (headers: Record<string, string> = {}) => new NextRequest('http://localhost/api/v1/reports/all', { headers });

describe('claimedCompanyId — the company a request\'s signed token was issued for (no DB, never throws)', () => {
  const prev = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = 'unit-test-secret-not-a-real-one'; });
  afterAll(() => { if (prev === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prev; });

  test('reads the company from a valid bearer token', () => {
    const token = signAccessToken('user-1', 'cfo', 'company-9');
    expect(claimedCompanyId(req({ authorization: `Bearer ${token}` }))).toBe('company-9');
  });

  test('reads it from the session cookie too, like authenticate() does', () => {
    const token = signAccessToken('user-1', 'cfo', 'company-9');
    expect(claimedCompanyId(req({ cookie: `fc_token=${token}` }))).toBe('company-9');
  });

  test('null — never a throw — for a missing, garbled, expired or wrongly signed token', () => {
    expect(claimedCompanyId(req())).toBeNull();
    expect(claimedCompanyId(req({ authorization: 'Bearer not-a-jwt' }))).toBeNull();
    const expired = jwt.sign({ sub: 'u', role: 'cfo', company_id: 'c' }, process.env.JWT_SECRET!, { expiresIn: -10 });
    expect(claimedCompanyId(req({ authorization: `Bearer ${expired}` }))).toBeNull();
    const forged = jwt.sign({ sub: 'u', role: 'cfo', company_id: 'other-company' }, 'some-other-secret');
    expect(claimedCompanyId(req({ authorization: `Bearer ${forged}` }))).toBeNull();
  });
});
