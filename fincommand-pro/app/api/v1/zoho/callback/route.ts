import { NextResponse, type NextRequest } from 'next/server';
import axios from 'axios';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';
import { runAsCompany } from '@/lib/db/tenant-context';
import { ZOHO_ACCOUNTS, ZOHO_API } from '@/lib/services/zoho';
import { verifyOAuthState, bindingHash, OAUTH_BINDING_COOKIE } from '@/lib/security/oauth-state';
import { encryptToken } from '@/lib/security/token-crypto';
import { ROLE_SETS } from '@/lib/auth/permissions';

export const runtime = 'nodejs';

interface ZohoTokenResponse {
  error?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export const GET = withErrorHandling(async (req: NextRequest) => {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get('code');
  const state = searchParams.get('state') || '';
  const baseUrl = process.env.FRONTEND_URL || req.nextUrl.origin || 'http://localhost:4000';

  if (!code) return json({ error: 'No code received from Zoho' }, { status: 400 });

  const fail = (msg: string) => NextResponse.redirect(`${baseUrl}/dashboard?tab=upload&zoho_error=${encodeURIComponent(msg)}`);

  // Nothing is exchanged or stored unless the state was issued by our own
  // auth-url route, for this company, within the last 10 minutes.
  const verified = verifyOAuthState(state);
  if (!verified.ok) return fail(verified.error);
  const { companyId, dataCenter: dc, userId } = verified.value;
  // …and it is being finished by the same browser that started it.
  const binding = req.cookies.get(OAUTH_BINDING_COOKIE)?.value;
  if (!binding || !verified.value.bindingHash || bindingHash(binding) !== verified.value.bindingHash) {
    return fail('This Zoho connection must be finished in the same browser that started it. Please click "Connect Zoho Books" again.');
  }
  // …and the person who started it can still manage this company's Zoho connection.
  // (The state is signed by us, so its company is trustworthy: from here the database work runs AS that company.)
  const { rows: starter } = await runAsCompany(companyId, () => query<{ role: string }>(
    `SELECT role FROM users WHERE id=$1 AND company_id=$2 AND is_active=TRUE`, [userId, companyId]
  ));
  if (!starter.length || !(ROLE_SETS.isCFO as string[]).includes(starter[0].role)) {
    return fail('Your account can no longer connect Zoho Books for this company.');
  }
  const base = ZOHO_ACCOUNTS[dc] || ZOHO_ACCOUNTS.IN;

  try {
    const postBody = new URLSearchParams({
      code,
      client_id: process.env.ZOHO_CLIENT_ID || '',
      client_secret: process.env.ZOHO_CLIENT_SECRET || '',
      redirect_uri: process.env.ZOHO_REDIRECT_URI || '',
      grant_type: 'authorization_code',
    });

    const tokenRes = await axios.post<ZohoTokenResponse>(`${base}/oauth/v2/token`, postBody.toString(), {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (tokenRes.data.error) {
      const hint = tokenRes.data.error === 'invalid_redirect_uri' || tokenRes.data.error === 'redirect_uri_mismatch'
        ? ' — check that ZOHO_REDIRECT_URI matches exactly what is registered in the Zoho API console.'
        : '';
      return NextResponse.redirect(`${baseUrl}/dashboard?tab=upload&zoho_error=${encodeURIComponent(`Zoho OAuth error: ${tokenRes.data.error}${hint}`)}`);
    }

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    if (!access_token || !refresh_token) {
      return NextResponse.redirect(`${baseUrl}/dashboard?tab=upload&zoho_error=${encodeURIComponent('Zoho did not return access/refresh tokens. Authorization code expired or used.')}`);
    }
    const expiry = new Date(Date.now() + ((expires_in || 3600) - 60) * 1000);

    // Which organisations can the new login see? A previously saved Organisation ID that it can't
    // see (a different organisation was connected) is cleared instead of failing every sync.
    let orgIds: string[] | null = null;
    try {
      const orgRes = await axios.get<{ organizations?: { organization_id?: string }[] }>(`${ZOHO_API[dc] || ZOHO_API.IN}/organizations`, {
        headers: { Authorization: `Zoho-oauthtoken ${access_token}` }, timeout: 15000,
      });
      orgIds = (orgRes.data.organizations ?? []).map((o) => String(o.organization_id ?? '')).filter(Boolean);
    } catch { /* can't tell — keep the saved id */ }

    // Tokens are stored encrypted (lib/security/token-crypto.ts); this throws
    // — and the user sees the error — if TOKEN_ENCRYPTION_KEY is missing.
    await runAsCompany(companyId, () => query(
      `INSERT INTO zoho_config
        (company_id, access_token, refresh_token, token_expiry, data_center, is_active, last_sync_status, last_sync_error)
       VALUES ($1,$2,$3,$4,$5,TRUE,'never',NULL)
       ON CONFLICT (company_id) DO UPDATE SET
         access_token=$2, refresh_token=$3, token_expiry=$4,
         data_center=$5, is_active=TRUE, last_sync_status='never', last_sync_error=NULL, updated_at=NOW(),
         org_id = CASE WHEN $6::text[] IS NULL OR zoho_config.org_id = ANY($6::text[]) THEN zoho_config.org_id ELSE NULL END`,
      [companyId, encryptToken(access_token), encryptToken(refresh_token), expiry, dc, orgIds]
    ));

    return NextResponse.redirect(`${baseUrl}/dashboard?tab=upload&zoho=connected`);
  } catch (err) {
    console.error('[zoho/callback] connect failed:', (err as Error).message);
    return fail('Could not connect Zoho Books. Please try again.');
  }
}, { system: true });
