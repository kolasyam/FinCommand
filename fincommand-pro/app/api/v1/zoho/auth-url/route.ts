import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { ZOHO_ACCOUNTS } from '@/lib/services/zoho';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isCFO);

  const dc = req.nextUrl.searchParams.get('data_center') || 'IN';
  const base = ZOHO_ACCOUNTS[dc] || ZOHO_ACCOUNTS.IN;
  const params = new URLSearchParams({
    scope: process.env.ZOHO_SCOPES || 'ZohoBooks.fullaccess.all',
    client_id: process.env.ZOHO_CLIENT_ID || '',
    response_type: 'code',
    redirect_uri: process.env.ZOHO_REDIRECT_URI || '',
    access_type: 'offline',
    prompt: 'consent',
    state: `${user.company_id}|${dc}`,
  });
  return json({ auth_url: `${base}/oauth/v2/auth?${params}` });
});
