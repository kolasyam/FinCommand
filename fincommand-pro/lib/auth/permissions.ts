import type { NextRequest } from 'next/server';
import { query } from '@/lib/db/neon';
import { verifyAccessToken } from '@/lib/auth/jwt';

export type Role = 'admin' | 'cfo' | 'ceo' | 'auditor' | 'manager' | 'viewer';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  company_id: string;
  is_active: boolean;
  permissions: Record<string, unknown>;
  company_name: string;
}

/** Thrown by route handlers on auth/authorization failure; caught by withErrorHandling(). */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Pre-built role sets — identical to middleware/auth.js
export const ROLE_SETS = {
  isAdmin: ['admin'] as Role[],
  isCFO: ['admin', 'cfo'] as Role[],
  isCFOorCEO: ['admin', 'cfo', 'ceo'] as Role[],
  canWrite: ['admin', 'cfo', 'manager'] as Role[],
  canRead: ['admin', 'cfo', 'ceo', 'auditor', 'manager', 'viewer'] as Role[],
};

/**
 * Verifies the bearer JWT and loads the user from the DB — the Next.js
 * equivalent of the `authenticate` Express middleware. Throws ApiError(401)
 * on any failure so callers can just `await authenticate(req)` and let
 * withErrorHandling() turn it into a JSON error response.
 */
export async function authenticate(req: NextRequest): Promise<AuthUser> {
  const header = req.headers.get('authorization');
  let token: string | undefined;

  if (header?.startsWith('Bearer ')) {
    token = header.slice(7);
  } else {
    token = req.cookies.get('fc_token')?.value || req.cookies.get('token')?.value;
  }

  if (!token) {
    throw new ApiError(401, 'Authentication required. Please sign in to continue.');
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (e) {
    const name = (e as Error).name;
    throw new ApiError(401, name === 'TokenExpiredError' ? 'Session expired. Please sign in again.' : 'Invalid authentication token');
  }

  const { rows } = await query<AuthUser>(
    `SELECT u.id, u.name, u.email, u.role, u.company_id,
            u.is_active, u.permissions, c.name AS company_name
     FROM users u JOIN companies c ON c.id = u.company_id
     WHERE u.id = $1`,
    [payload.sub]
  );
  if (!rows.length || !rows[0].is_active) {
    throw new ApiError(401, 'User not found or inactive');
  }
  return rows[0];
}

/** Throws ApiError(403) if the user's role isn't in the allowed set. */
export function requireRole(user: AuthUser, roles: Role[]): void {
  if (!roles.includes(user.role)) {
    throw new ApiError(403, `Access denied. Required role: ${roles.join(' or ')} (your role: ${user.role})`);
  }
}
