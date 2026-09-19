import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Signed OAuth `state` for the Zoho Books connect flow.
 *
 * The callback (/api/v1/zoho/callback) is reached by a browser redirect from
 * Zoho, so it can't authenticate the user — it has to trust `state` to know
 * which company to attach the tokens to. That state used to be the plain
 * string `${company_id}|${dc}`: anyone who knew a company's id could finish
 * an OAuth flow with their OWN Zoho account and bind it to that company,
 * feeding their data into its reports. Now the state is issued only by the
 * authenticated auth-url route, carries an expiry, and is HMAC-signed.
 *
 * Format: base64url(JSON payload) + '.' + base64url(HMAC-SHA256).
 */

const TTL_MS = 10 * 60 * 1000;
const CONTEXT = 'fincommand:zoho-oauth-state:v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StatePayload {
  /** company id */ c: string;
  /** Zoho data centre */ d: string;
  /** user who started the flow */ u: string;
  /** expiry, ms since epoch */ exp: number;
  /** nonce — makes every state unique */ n: string;
}

export interface VerifiedOAuthState { companyId: string; dataCenter: string; userId: string }

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(`${CONTEXT}.${body}`).digest('base64url');
}

function requireSecret(secret: string | undefined): string {
  if (!secret) throw new Error('JWT_SECRET is not set — cannot sign the Zoho OAuth state.');
  return secret;
}

export function signOAuthState(
  input: VerifiedOAuthState,
  secret: string | undefined = process.env.JWT_SECRET,
  now: number = Date.now(),
): string {
  const payload: StatePayload = {
    c: input.companyId, d: input.dataCenter, u: input.userId,
    exp: now + TTL_MS, n: randomBytes(12).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, requireSecret(secret))}`;
}

export function verifyOAuthState(
  state: string | null | undefined,
  secret: string | undefined = process.env.JWT_SECRET,
  now: number = Date.now(),
): { ok: true; value: VerifiedOAuthState } | { ok: false; error: string } {
  const invalid = { ok: false as const, error: 'This Zoho connection link is invalid. Please click "Connect Zoho Books" again.' };
  if (!state) return invalid;
  const dot = state.indexOf('.');
  if (dot <= 0) return invalid;
  const body = state.slice(0, dot);
  const given = Buffer.from(state.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(body, requireSecret(secret)), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return invalid;

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return invalid;
  }
  if (typeof payload.exp !== 'number' || now > payload.exp) {
    return { ok: false, error: 'The Zoho connection link expired. Please click "Connect Zoho Books" again.' };
  }
  if (!UUID_RE.test(payload.c) || !UUID_RE.test(payload.u) || typeof payload.d !== 'string') return invalid;
  return { ok: true, value: { companyId: payload.c, dataCenter: payload.d, userId: payload.u } };
}
