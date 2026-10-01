import type { NextRequest } from 'next/server';
import { query } from '@/lib/db/neon';
import { signAccessToken, signRefreshToken, verifyRefreshToken, hashRefreshToken } from '@/lib/auth/jwt';
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

  const tokenHash = hashRefreshToken(refresh_token);

  // Atomically claim the token: of two simultaneous requests with the same
  // refresh token exactly one UPDATE matches, the other gets no row.
  const { rows } = await query<RefreshRow>(
    `UPDATE refresh_tokens rt SET revoked_at = NOW()
       FROM users u
      WHERE rt.token = $1 AND u.id = rt.user_id
        AND rt.revoked_at IS NULL AND rt.expires_at > NOW()
      RETURNING rt.user_id, u.role, u.company_id, u.is_active`,
    [tokenHash]
  );
  if (!rows.length) {
    // A token that was already used a while ago is being replayed — someone
    // else may hold a copy, so end every session of that user. A replay within
    // a few seconds is just two tabs refreshing together and is only refused.
    await query(
      `UPDATE refresh_tokens SET revoked_at = NOW()
        WHERE revoked_at IS NULL AND user_id = (
          SELECT user_id FROM refresh_tokens WHERE token = $1 AND revoked_at < NOW() - INTERVAL '10 seconds')`,
      [tokenHash]
    );
    return json({ error: 'Token revoked or expired' }, { status: 401 });
  }
  if (!rows[0].is_active) return json({ error: 'Account inactive' }, { status: 403 });

  const newAccess = signAccessToken(rows[0].user_id, rows[0].role, rows[0].company_id);
  const newRefresh = signRefreshToken(rows[0].user_id);
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
  const ua = req.headers.get('user-agent') || null;

  await query(
    `INSERT INTO refresh_tokens (user_id, token, ip_address, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [rows[0].user_id, hashRefreshToken(newRefresh), ip, ua, expiresAt]
  );

  return json({ access_token: newAccess, refresh_token: newRefresh, token_type: 'Bearer', expires_in: 900 });
}, { system: true });
