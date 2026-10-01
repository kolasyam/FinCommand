import type { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';
import { logAudit } from '@/lib/audit/audit';
import { isEmail, isStrongPassword } from '@/lib/validations/common';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isCFOorCEO);
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
  const { name, role, password } = body;
  // Login looks accounts up by the lower-cased email, so it must be stored that way.
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!name || !email || !role || !password) {
    return json({ error: 'name, email, role, password required' }, { status: 400 });
  }
  if (!isEmail(email)) return json({ error: 'Invalid email address' }, { status: 422 });
  
  const ALLOWED_ROLES = ['cfo', 'ceo', 'auditor', 'manager', 'viewer'];
  if (!ALLOWED_ROLES.includes(role)) {
    return json({ error: `Role must be one of: ${ALLOWED_ROLES.join(', ')}` }, { status: 422 });
  }
  if (!isStrongPassword(password)) {
    return json({ error: 'Password must be at least 8 characters and contain at least one letter and one number' }, { status: 422 });
  }
  const hash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS || '10'));
  try {
    const { rows } = await query(
      `INSERT INTO users (company_id,name,email,password_hash,role,email_verified)
       VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id,name,email,role,created_at`,
      [user.company_id, name, email, hash, role]
    );
    logAudit(req, user, 'USER_CREATE', 'user', rows[0].id, { email, role });
    return json(rows[0], { status: 201 });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return json({ error: 'Member is already added' }, { status: 409 });
    throw err;
  }
});
