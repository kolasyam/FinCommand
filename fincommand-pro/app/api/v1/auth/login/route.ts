import type { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { query } from '@/lib/db/neon';
import { signAccessToken, signRefreshToken, hashRefreshToken } from '@/lib/auth/jwt';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { isEmail, ValidationCollector } from '@/lib/validations/common';

export const runtime = 'nodejs';

// A real bcrypt hash of a random string: compared against when the email is unknown.
const DUMMY_HASH = '$2a$10$P7yPnXSyHyZqrn0.mw96h.p4VGAqZ6KMNfjjwYStLH1Qvfd8n2ozO';

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
    `SELECT u.id, u.name, u.email, u.role, u.company_id, u.is_active,
            u.password_hash, u.locked_until, u.failed_attempts,
            c.name AS company_name
     FROM users u JOIN companies c ON c.id = u.company_id
     WHERE u.email=$1`,
    [email]
  );
  const user = rows[0];

  // Same work and same answer whether or not the account exists, so neither the
  // wording nor the response time says which emails are registered.
  const match = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user) return json({ error: 'Invalid credentials' }, { status: 401 });

  // While locked the answer is the same whatever password was sent — otherwise the lock would tell an
  // attacker when a guess is right. (It only reveals that an account exists after 5 failures against it.)
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return json({ error: 'Account locked. Try again later.' }, { status: 429 });
  }

  if (!match) {
    // A lock that has run out starts a fresh count; before, the old count stayed and one more miss re-locked at once.
    await query(
      `UPDATE users SET
         failed_attempts = CASE WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1 ELSE failed_attempts + 1 END,
         locked_until = CASE
           WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN NULL
           WHEN failed_attempts >= 4 THEN NOW() + INTERVAL '15 minutes'
           ELSE locked_until END
       WHERE id=$1`,
      [user.id]
    );
    return json({ error: 'Invalid credentials' }, { status: 401 });
  }

  // Only someone who proved they know the password is told why they can't get in.
  if (!user.is_active) return json({ error: 'Account inactive' }, { status: 403 });

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
      [user.id, hashRefreshToken(refreshToken), ip, ua, expiresAt]
    ),
    query(
      `INSERT INTO audit_trail (company_id,user_id,user_name,user_role,action,ip_address,user_agent)
       VALUES ($1,$2,$3,$4,'LOGIN',$5,$6)`,
      [user.company_id, user.id, user.name, user.role, ip, ua]
    ),
  ]);

  // Housekeeping: refresh-token rows were never deleted, only revoked or left
  // to expire. Anything dead for 30+ days is dropped. Fire-and-forget — it
  // must never slow down or fail a login — but a failure is logged.
  query(
    `DELETE FROM refresh_tokens
     WHERE expires_at < NOW() - INTERVAL '30 days' OR revoked_at < NOW() - INTERVAL '30 days'`
  ).catch((err: Error) => console.error('[auth/login] refresh-token cleanup failed:', err.message));

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
}, { system: true });
