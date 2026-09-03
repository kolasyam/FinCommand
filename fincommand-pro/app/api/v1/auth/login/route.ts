import type { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { query } from '@/lib/db/neon';
import { signAccessToken, signRefreshToken } from '@/lib/auth/jwt';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { isEmail, ValidationCollector } from '@/lib/validations/common';

export const runtime = 'nodejs';

interface UserRow {
  id: string; company_id: string; name: string; email: string; role: string;
  password_hash: string; is_active: boolean; locked_until: string | null;
  failed_attempts: number; company_name: string;
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}));
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const v = new ValidationCollector()
    .check(isEmail(email), 'email', 'Invalid email')
    .check(password.length >= 6, 'password', 'password must be at least 6 characters');
  if (!v.isEmpty()) return json({ errors: v.errors() }, { status: 422 });

  const { rows } = await query<UserRow>(
    `SELECT u.*, c.name AS company_name
     FROM users u JOIN companies c ON c.id = u.company_id
     WHERE u.email=$1`,
    [email]
  );
  const user = rows[0];

  if (!user) return json({ error: 'Invalid credentials' }, { status: 401 });
  if (!user.is_active) return json({ error: 'Account inactive' }, { status: 403 });
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return json({ error: 'Account locked. Try again later.' }, { status: 429 });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    await query(
      `UPDATE users SET failed_attempts = failed_attempts + 1,
        locked_until = CASE WHEN failed_attempts >= 4 THEN NOW() + INTERVAL '15 minutes' ELSE locked_until END
       WHERE id=$1`,
      [user.id]
    );
    return json({ error: 'Invalid credentials' }, { status: 401 });
  }

  const accessToken = signAccessToken(user.id, user.role, user.company_id);
  const refreshToken = signRefreshToken(user.id);
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
  const ua = req.headers.get('user-agent') || null;

  await Promise.all([
    query(`UPDATE users SET failed_attempts=0, locked_until=NULL, last_login=NOW() WHERE id=$1`, [user.id]),
    query(
      `INSERT INTO refresh_tokens (user_id, token, ip_address, user_agent, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [user.id, refreshToken, ip, ua, expiresAt]
    ),
    query(
      `INSERT INTO audit_trail (company_id,user_id,user_name,user_role,action,ip_address,user_agent)
       VALUES ($1,$2,$3,$4,'LOGIN',$5,$6)`,
      [user.company_id, user.id, user.name, user.role, ip, ua]
    ),
  ]);

  return json({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: 900,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      company_id: user.company_id,
      company_name: user.company_name,
    },
  });
});
