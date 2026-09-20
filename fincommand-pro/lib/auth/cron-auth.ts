import { timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * Guard for the endpoints only a scheduler should call (Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET` itself).
 *
 * Fails closed in production: with no CRON_SECRET configured these routes used
 * to be open to anyone. Outside production an unset secret is allowed, so a
 * local scheduler or a manual curl works without setup.
 *
 * Returns null when the call may proceed, else the response to send.
 */
export function checkCronSecret(req: NextRequest, routeName: string): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.error(`[${routeName}] CRON_SECRET is not set — refusing to run.`);
      return NextResponse.json({ error: 'Cron is not configured' }, { status: 503 });
    }
    return null;
  }
  const given = Buffer.from(req.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  // Constant-time comparison (a plain !== leaks how many leading characters matched).
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
