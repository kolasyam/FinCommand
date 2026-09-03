import type { NextRequest } from 'next/server';
import { query } from '@/lib/db/neon';
import { signAccessToken, verifyRefreshToken } from '@/lib/auth/jwt';
import { withErrorHandling, json } from '@/lib/utils/api-handler';

export const runtime = 'nodejs';

interface RefreshRow {
  user_id: string; role: string; company_id: string; is_active: boolean;
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}));
  const refresh_token = body.refresh_token as string | undefined;
  if (!refresh_token) return json({ error: 'refresh_token required' }, { status: 400 });

  try {
    verifyRefreshToken(refresh_token);
  } catch {
    return json({ error: 'Invalid or expired refresh token' }, { status: 401 });
  }

  const { rows } = await query<RefreshRow>(
    `SELECT rt.*, u.role, u.company_id, u.is_active
     FROM refresh_tokens rt JOIN users u ON u.id=rt.user_id
     WHERE rt.token=$1 AND rt.revoked_at IS NULL AND rt.expires_at > NOW()`,
    [refresh_token]
  );
  if (!rows.length) return json({ error: 'Token revoked or expired' }, { status: 401 });
  if (!rows[0].is_active) return json({ error: 'Account inactive' }, { status: 403 });

  const newAccess = signAccessToken(rows[0].user_id, rows[0].role, rows[0].company_id);
  return json({ access_token: newAccess, token_type: 'Bearer', expires_in: 900 });
});
