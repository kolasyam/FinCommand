import jwt from 'jsonwebtoken';

export interface AccessTokenPayload {
  sub: string;
  role: string;
  company_id: string;
}

export interface RefreshTokenPayload {
  sub: string;
}

/** Signs an access token — identical claim shape to the original signAccess() in routes/auth.js. */
export function signAccessToken(sub: string, role: string, companyId: string): string {
  return jwt.sign({ sub, role, company_id: companyId }, requireEnv('JWT_SECRET'), {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  } as jwt.SignOptions);
}

/** Signs a refresh token — identical claim shape to the original signRefresh() in routes/auth.js. */
export function signRefreshToken(sub: string): string {
  return jwt.sign({ sub }, requireEnv('JWT_REFRESH_SECRET'), {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, requireEnv('JWT_SECRET')) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, requireEnv('JWT_REFRESH_SECRET')) as RefreshTokenPayload;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
