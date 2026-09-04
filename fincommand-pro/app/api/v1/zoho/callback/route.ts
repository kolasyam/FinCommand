import { NextResponse, type NextRequest } from 'next/server';
import axios from 'axios';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';
import { ZOHO_ACCOUNTS } from '@/lib/services/zoho';

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

  const [companyId, dc] = state.split('|');
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

    await query(
      `INSERT INTO zoho_config
        (company_id, access_token, refresh_token, token_expiry, data_center, is_active, last_sync_status, last_sync_error)
       VALUES ($1,$2,$3,$4,$5,TRUE,'never',NULL)
       ON CONFLICT (company_id) DO UPDATE SET
         access_token=$2, refresh_token=$3, token_expiry=$4,
         data_center=$5, is_active=TRUE, last_sync_status='never', last_sync_error=NULL, updated_at=NOW()`,
      [companyId, access_token, refresh_token, expiry, dc]
    );

    return NextResponse.redirect(`${baseUrl}/dashboard?tab=upload&zoho=connected`);
  } catch (err) {
    return NextResponse.redirect(`${baseUrl}/dashboard?tab=upload&zoho_error=${encodeURIComponent((err as Error).message)}`);
  }
});
