import axios, { type AxiosError } from 'axios';
import { query } from '@/lib/db/neon';
import { encryptToken, decryptToken } from '@/lib/security/token-crypto';

/** Zoho Books connection: data-centre URLs, OAuth tokens (encrypted at rest), and the rate-limit/refresh-aware request wrapper. */

export const ZOHO_ACCOUNTS: Record<string, string> = {
  IN: 'https://accounts.zoho.in',
  US: 'https://accounts.zoho.com',
  EU: 'https://accounts.zoho.eu',
  AU: 'https://accounts.zoho.com.au',
};
export const ZOHO_API: Record<string, string> = {
  IN: 'https://www.zohoapis.in/books/v3',
  US: 'https://www.zohoapis.com/books/v3',
  EU: 'https://www.zohoapis.eu/books/v3',
  AU: 'https://www.zohoapis.com.au/books/v3',
};

export interface ZohoConfigRow {
  company_id: string;
  org_id: string | null;
  access_token: string;
  refresh_token: string;
  token_expiry: string;
  data_center: string;
}

/**
 * zoho_config stores both tokens encrypted (lib/security/token-crypto.ts).
 * Every read of the row goes through this, so the rest of this file only
 * ever sees plain tokens in memory — never in the database.
 */
export function decryptZohoConfig<T extends { access_token: string | null; refresh_token: string | null }>(row: T): T {
  return { ...row, access_token: decryptToken(row.access_token), refresh_token: decryptToken(row.refresh_token) };
}

/** Extracts a useful message from a Zoho API error — ported verbatim. */
export function zohoErrorMessage(err: unknown): string {
  const axErr = err as AxiosError<{ message?: string; code?: number }>;
  const data = axErr.response?.data;
  if (data?.message) return `${data.message}${data.code ? ` (code ${data.code})` : ''}`;
  if (typeof data === 'string' && (data as string).trim()) return (data as string).trim();
  return (err as Error).message;
}

/** One attempt at the actual OAuth call — factored out so refreshZohoToken() can retry it without duplicating the request. Returns the raw response; never throws for an in-band `{error: ...}` response body (only for a genuine transport failure), so the caller can inspect and decide. */
async function requestZohoTokenRefresh(config: ZohoConfigRow) {
  const base = ZOHO_ACCOUNTS[config.data_center] || ZOHO_ACCOUNTS.IN;
  return axios.post(`${base}/oauth/v2/token`, null, {
    timeout: 15000,
    params: {
      refresh_token: config.refresh_token,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    },
  });
}

/**
 * Refreshes the access token, deactivating the connection (is_active=FALSE)
 * only once a SECOND consecutive attempt also fails — confirmed in
 * production on this exact company: Zoho's OAuth endpoint returned an
 * in-band error for a refresh_token that was proven, seconds later by hand,
 * to still be completely valid — twice, on different days. A single-shot
 * "any error means the token is dead" policy was silently disconnecting a
 * perfectly good integration on what was really Zoho-side flakiness (an
 * intermittent OAuth-endpoint blip, not a token-level 43/429 rate limit —
 * this app already retries those separately in callZoho() — and not a
 * transport failure either, which was never treated as "invalid" here,
 * only an in-band `{error: ...}` response body was). One retry after a
 * short delay costs nothing on the (common) success path and prevents that
 * exact false-positive disconnect; a token that's genuinely revoked will
 * still fail the retry identically and correctly deactivate.
 */
async function refreshZohoToken(config: ZohoConfigRow): Promise<string> {
  let res;
  try {
    res = await requestZohoTokenRefresh(config);
  } catch (err) {
    throw new Error(`Zoho token refresh failed: ${zohoErrorMessage(err)}`);
  }

  if (res.data.error || !res.data.access_token) {
    const firstAttemptError = res.data.error || 'no access_token returned';
    console.warn(`Zoho token refresh returned an error on the first attempt (${firstAttemptError}) — retrying once before treating the connection as dead...`);
    await new Promise((r) => setTimeout(r, 1500));
    try {
      res = await requestZohoTokenRefresh(config);
    } catch (err) {
      throw new Error(`Zoho token refresh failed on retry: ${zohoErrorMessage(err)}`);
    }
  }

  if (res.data.error || !res.data.access_token) {
    await query(
      `UPDATE zoho_config SET is_active=FALSE, last_sync_status='error',
        last_sync_error=$1, updated_at=NOW() WHERE company_id=$2`,
      [`Refresh token invalid (${res.data.error || 'no access_token returned'}) after 2 attempts. Please reconnect Zoho Books.`, config.company_id]
    );
    throw new Error(`Zoho refresh token is no longer valid (${res.data.error || 'unknown reason'}) after 2 attempts. Please reconnect Zoho Books.`);
  }

  const { access_token, expires_in } = res.data;
  const expiry = new Date(Date.now() + (expires_in - 60) * 1000);
  await query(
    `UPDATE zoho_config SET access_token=$1, token_expiry=$2 WHERE company_id=$3`,
    [encryptToken(access_token), expiry, config.company_id]
  );
  // Update the caller's in-memory config too. syncFromZoho() hands one config
  // object to every callZoho() (configOverride); it used to keep the OLD
  // expiry, so every later request batch saw an "expired" token and refreshed
  // again, about 10 grants in under a minute. Zoho allows ~10 per 10 minutes,
  // so scheduled syncs (which always start with an expired token) failed, and
  // two refused refreshes then marked the connection dead. Manual syncs, run
  // with a fresh token, never hit it: that was the observed pattern.
  config.access_token = access_token;
  config.token_expiry = expiry.toISOString();
  return access_token;
}

/**
 * Single-flight de-duplication for refreshZohoToken(), keyed by company_id —
 * root-caused fix for a real, confirmed-in-production bug where unattended
 * (cron) syncs failed most of the time with "Apr: Invalid URL Passed (code
 * 5)" while manually-triggered syncs never did.
 *
 * syncFromZoho() fires up to 5 concurrent callZoho() calls per batch
 * (Promise.all), and callZoho() independently reads zoho_config and checks
 * token_expiry on every call. A manual sync almost always starts with a
 * token that's fresh (the CFO just authenticated recently in the same
 * session), so this path is rarely exercised. An unattended sync can start
 * after a long idle gap, right as the token is expiring — and when that
 * happens, 2-3 concurrent callZoho() calls in the same batch each
 * independently decide the token is expired and each call
 * refreshZohoToken() at once. Zoho's OAuth endpoint does not cleanly support
 * concurrent refresh_token grants for the same token: the racing calls can
 * each get a response, but a report request already in flight with the
 * token one racer captured before another racer's DB UPDATE lands ends up
 * using a token Zoho no longer honors — observed as a generic, misleading
 * "Invalid URL Passed (code 5)" rather than an auth error, so callZoho's
 * existing 401/code-57 auto-refresh-and-retry never catches it (see below).
 * A losing race can also make a perfectly valid refresh_token look like it
 * failed twice in a row, which used to wrongly deactivate the connection —
 * see refreshZohoToken's own doc comment for that half of the fix.
 *
 * Memoizing the in-flight refresh Promise per company means every
 * concurrent caller within the same process awaits the exact same
 * underlying Zoho call and DB update instead of racing separate ones.
 */
const inFlightTokenRefresh = new Map<string, Promise<string>>();
export function refreshZohoTokenSingleFlight(config: ZohoConfigRow): Promise<string> {
  const existing = inFlightTokenRefresh.get(config.company_id);
  if (existing) return existing;
  const p = refreshZohoToken(config).finally(() => {
    inFlightTokenRefresh.delete(config.company_id);
  });
  inFlightTokenRefresh.set(config.company_id, p);
  return p;
}

/**
 * Calls Zoho, auto-refreshing the token once on 401/INVALID_OAUTHTOKEN.
 * Ported verbatim from routes/zoho.js callZoho().
 */
/**
 * Calls Zoho, auto-refreshing the token once on 401/INVALID_OAUTHTOKEN,
 * and retrying with exponential backoff on rate-limit (Code 43 / 429).
 */
export async function callZoho<T>(
  companyId: string,
  requestFn: (token: string) => Promise<T>,
  retriesLeft = 2,
  configOverride?: ZohoConfigRow
): Promise<T> {
  let cfg = configOverride;
  if (!cfg) {
    const { rows } = await query<ZohoConfigRow>(
      `SELECT * FROM zoho_config WHERE company_id=$1 AND is_active=TRUE AND refresh_token IS NOT NULL`,
      [companyId]
    );
    if (!rows.length) throw new Error('Zoho Books not connected. Please authenticate first by clicking "Connect Zoho Books".');
    cfg = decryptZohoConfig(rows[0]);
  }

  let token = new Date(cfg.token_expiry) <= new Date() ? await refreshZohoTokenSingleFlight(cfg) : cfg.access_token;

  try {
    return await requestFn(token);
  } catch (err) {
    const axErr = err as AxiosError<{ code?: number }>;
    const status = axErr.response?.status;
    const zohoCode = axErr.response?.data?.code;

    // Handle Zoho Rate Limit (Code 43 or HTTP 429) with automatic backoff retry
    const isRateLimit = status === 429 || zohoCode === 43;
    if (isRateLimit && retriesLeft > 0) {
      const delayMs = (3 - retriesLeft) * 800; // 800ms, 1600ms backoff
      await new Promise(r => setTimeout(r, delayMs));
      return callZoho(companyId, requestFn, retriesLeft - 1, cfg);
    }

    const isAuthError = status === 401 || zohoCode === 57; /* INVALID_OAUTHTOKEN */
    if (!isAuthError) {
      const e = new Error(zohoErrorMessage(err)) as Error & { status?: number };
      e.status = status;
      throw e;
    }
    try {
      token = await refreshZohoTokenSingleFlight(cfg);
    } catch (refreshErr) {
      const e = new Error(
        `Zoho re-authentication failed: ${zohoErrorMessage(refreshErr)}. ` +
        `You may need to reconnect Zoho Books from the integrations page.`
      ) as Error & { status?: number };
      e.status = 401;
      throw e;
    }
    try {
      return await requestFn(token);
    } catch (retryErr) {
      const retryAxErr = retryErr as AxiosError<{ code?: number }>;
      const retryZohoCode = retryAxErr.response?.data?.code;
      if ((retryAxErr.response?.status === 429 || retryZohoCode === 43) && retriesLeft > 0) {
        await new Promise(r => setTimeout(r, 1000));
        return callZoho(companyId, requestFn, retriesLeft - 1, cfg);
      }
      const e = new Error(zohoErrorMessage(retryErr)) as Error & { status?: number };
      e.status = retryAxErr.response?.status;
      throw e;
    }
  }
}

/**
 * Fetches the connected Zoho organization's real base currency
 * (`GET /organizations/{org_id}`, response field `currency_code`) and
 * stores it as this company's Source Currency — called right after the CFO
 * saves an Organisation ID (see app/api/v1/zoho/config/route.ts), so
 * `companies.currency` reflects the org's actual currency instead of
 * silently staying at its 'INR' column default for a non-INR org. Returns
 * the detected code, or `null` (never throws) if Zoho couldn't be reached —
 * this must never block saving the org_id itself, and must never guess a
 * currency when the real one couldn't be confirmed.
 */
export async function fetchAndStoreZohoOrgCurrency(companyId: string, orgId: string): Promise<string | null> {
  try {
    const { rows: cfgRows } = await query<{ data_center: string }>(`SELECT data_center FROM zoho_config WHERE company_id=$1`, [companyId]);
    if (!cfgRows.length) return null;
    const apiBase = ZOHO_API[cfgRows[0].data_center] || ZOHO_API.IN;

    const res = await callZoho(companyId, (token) =>
      axios.get(`${apiBase}/organizations/${orgId}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        timeout: 15000,
      })
    );
    const code = res.data?.organization?.currency_code;
    if (typeof code !== 'string' || code.length !== 3) return null;

    await query(`UPDATE companies SET currency=$1, updated_at=NOW() WHERE id=$2`, [code.toUpperCase(), companyId]);
    return code.toUpperCase();
  } catch (err) {
    console.warn(`Could not auto-detect Zoho org currency for company ${companyId}, org ${orgId}:`, (err as Error).message);
    return null;
  }
}
