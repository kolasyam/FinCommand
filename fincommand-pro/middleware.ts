import { NextResponse, type NextRequest } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit/rate-limit';

const API = process.env.API_PREFIX || '/api/v1';

/**
 * Global request middleware for all /api/v1/** routes — replaces the
 * Express-level helmet()/cors()/express-rate-limit() stack from server.js.
 *
 * - CORS: origin reflected + credentials, same permissive policy as the
 *   original `cors({ origin: true, credentials: true, ... })`.
 * - Rate limiting: RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX globally, with a
 *   tighter 20-req/15min window on /auth/login, matching server.js. Health
 *   check is exempt, also matching the original `skip` rule.
 * - Basic security headers, replacing helmet()'s defaults.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (req.method === 'OPTIONS') {
    return withCors(req, new NextResponse(null, { status: 204 }));
  }

  if (pathname !== `${API}/health`) {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
    const isLogin = pathname === `${API}/auth/login`;
    const windowMs = isLogin ? 900000 : parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000');
    const max = isLogin ? 20 : parseInt(process.env.RATE_LIMIT_MAX || '200');
    const key = isLogin ? `login:${ip}` : `global:${ip}`;

    const result = checkRateLimit(key, windowMs, max);
    if (!result.allowed) {
      const message = isLogin ? 'Too many login attempts' : 'Too many requests. Please try again later.';
      return withCors(req, NextResponse.json({ error: message }, { status: 429 }));
    }
  }

  return withCors(req, addSecurityHeaders(NextResponse.next()));
}

function withCors(req: NextRequest, res: NextResponse): NextResponse {
  const origin = req.headers.get('origin');
  if (origin) res.headers.set('Access-Control-Allow-Origin', origin);
  res.headers.set('Access-Control-Allow-Credentials', 'true');
  res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Company-ID');
  return res;
}

function addSecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('X-XSS-Protection', '0');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

export const config = {
  matcher: '/api/v1/:path*',
};
