import { randomBytes } from 'crypto';
import { encryptToken, decryptToken, isEncryptedToken } from '@/lib/security/token-crypto';
import { signOAuthState, verifyOAuthState } from '@/lib/security/oauth-state';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');

describe('token-crypto — Zoho tokens encrypted at rest', () => {
  test('round trip, and the stored value never contains the token', () => {
    const token = '1000.abcdef0123456789.fedcba9876543210';
    const stored = encryptToken(token, KEY);
    expect(isEncryptedToken(stored)).toBe(true);
    expect(stored).not.toContain('abcdef0123456789');
    expect(decryptToken(stored, KEY)).toBe(token);
  });

  test('every encryption is different (random IV)', () => {
    expect(encryptToken('same', KEY)).not.toBe(encryptToken('same', KEY));
  });

  test('legacy plain-text tokens pass through unchanged; null stays null', () => {
    expect(decryptToken('1000.plain.token', KEY)).toBe('1000.plain.token');
    expect(decryptToken(null, KEY)).toBeNull();
  });

  test('a tampered value or the wrong key is refused, not silently decrypted', () => {
    const stored = encryptToken('secret-token', KEY);
    const parts = stored.split(':');
    const ct = Buffer.from(parts[4], 'base64url');
    ct[0] ^= 1;
    const tampered = [...parts.slice(0, 4), ct.toString('base64url')].join(':');
    expect(() => decryptToken(tampered, KEY)).toThrow(/could not be decrypted/);
    expect(() => decryptToken(stored, OTHER_KEY)).toThrow(/could not be decrypted/);
    expect(() => decryptToken('enc:v1:only-two:parts', KEY)).toThrow(/malformed/);
  });

  test('no key → refuses to store (never falls back to plain text)', () => {
    expect(() => encryptToken('x', undefined)).toThrow(/TOKEN_ENCRYPTION_KEY is not set/);
    expect(() => encryptToken('x', Buffer.from('short').toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('oauth-state — signed, expiring Zoho connect state', () => {
  const SECRET = 'test-jwt-secret';
  const input = {
    companyId: '3d7441a5-33d2-4cf1-a32d-22acf06020dd',
    dataCenter: 'IN',
    userId: '11111111-2222-4333-8444-555555555555',
  };

  test('a state we issued verifies and returns who/what it was for', () => {
    const now = 1_700_000_000_000;
    const state = signOAuthState(input, SECRET, now);
    expect(verifyOAuthState(state, SECRET, now + 60_000)).toEqual({ ok: true, value: input });
  });

  test('the old forgeable format ("<company_id>|IN") is rejected', () => {
    expect(verifyOAuthState(`${input.companyId}|IN`, SECRET).ok).toBe(false);
    expect(verifyOAuthState('', SECRET).ok).toBe(false);
    expect(verifyOAuthState(null, SECRET).ok).toBe(false);
  });

  test('changing the company inside a signed state breaks the signature', () => {
    const state = signOAuthState(input, SECRET);
    const [body, sig] = state.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    payload.c = '99999999-9999-4999-8999-999999999999';
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    expect(verifyOAuthState(forged, SECRET).ok).toBe(false);
    expect(verifyOAuthState(state, 'another-secret').ok).toBe(false);
  });

  test('expires after 10 minutes', () => {
    const now = 1_700_000_000_000;
    const state = signOAuthState(input, SECRET, now);
    const late = verifyOAuthState(state, SECRET, now + 10 * 60_000 + 1);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error).toMatch(/expired/);
  });

  test('refuses to sign without a secret', () => {
    expect(() => signOAuthState(input, undefined)).toThrow(/JWT_SECRET/);
  });
});
