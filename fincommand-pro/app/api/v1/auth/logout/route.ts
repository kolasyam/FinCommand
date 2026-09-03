import type { NextRequest } from 'next/server';
import { query } from '@/lib/db/neon';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';

export const runtime = 'nodejs';

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const body = await req.json().catch(() => ({}));
  const refresh_token = body.refresh_token as string | undefined;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;

  const tasks: Promise<unknown>[] = [
    query(
      `INSERT INTO audit_trail (company_id,user_id,user_name,user_role,action,ip_address)
       VALUES ($1,$2,$3,$4,'LOGOUT',$5)`,
      [user.company_id, user.id, user.name, user.role, ip]
    ),
  ];

  if (refresh_token) {
    tasks.push(
      query(`UPDATE refresh_tokens SET revoked_at=NOW() WHERE token=$1 AND user_id=$2`, [refresh_token, user.id])
    );
  }

  await Promise.all(tasks);
  return json({ message: 'Logged out successfully' });
});
