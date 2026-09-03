import type { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const { rows } = await query(
    `SELECT id, name, email, role, is_active, last_login, created_at
     FROM users WHERE company_id=$1 ORDER BY name`,
    [user.company_id]
  );
  return json(rows);
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isAdmin);

  const body = await req.json().catch(() => ({}));
  const { name, email, role, password } = body;
  if (!name || !email || !role || !password) {
    return json({ error: 'name, email, role, password required' }, { status: 400 });
  }
  const hash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS || '10'));
  try {
    const { rows } = await query(
      `INSERT INTO users (company_id,name,email,password_hash,role,email_verified)
       VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id,name,email,role,created_at`,
      [user.company_id, name, email, hash, role]
    );
    return json(rows[0], { status: 201 });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return json({ error: 'Member is already added' }, { status: 409 });
    throw err;
  }
});
