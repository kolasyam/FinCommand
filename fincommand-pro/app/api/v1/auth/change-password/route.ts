import type { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { query } from '@/lib/db/neon';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { ValidationCollector } from '@/lib/validations/common';

export const runtime = 'nodejs';

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const body = await req.json().catch(() => ({}));
  const current_password = typeof body.current_password === 'string' ? body.current_password : '';
  const new_password = typeof body.new_password === 'string' ? body.new_password : '';

  const v = new ValidationCollector()
    .check(current_password.length > 0, 'current_password', 'required')
    .check(new_password.length >= 8, 'new_password', 'must be at least 8 characters')
    .check(/[A-Z]/.test(new_password), 'new_password', 'must contain an uppercase letter')
    .check(/[0-9]/.test(new_password), 'new_password', 'must contain a digit');
  if (!v.isEmpty()) return json({ errors: v.errors() }, { status: 422 });

  const { rows } = await query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1', [user.id]);
  const match = await bcrypt.compare(current_password, rows[0].password_hash);
  if (!match) return json({ error: 'Current password incorrect' }, { status: 400 });

  const hash = await bcrypt.hash(new_password, parseInt(process.env.BCRYPT_ROUNDS || '10'));
  await query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, user.id]);
  await query('UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [user.id]);

  return json({ message: 'Password changed successfully. Please login again.' });
});
