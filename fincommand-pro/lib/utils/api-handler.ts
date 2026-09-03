import { NextRequest, NextResponse } from 'next/server';
import { ApiError } from '@/lib/auth/permissions';

interface PgError extends Error {
  code?: string;
  detail?: string;
  status?: number;
  statusCode?: number;
}

/**
 * Wraps a Next.js Route Handler with the same error-shaping behavior as the
 * original Express global error handler in server.js: Postgres unique/FK
 * violations become 409/400 with the same message format, ApiError carries
 * its own status, and stack traces only leak in development.
 *
 * Generic over the route context so handlers with typed dynamic params
 * (e.g. `{ params: Promise<{ id: string }> }`) keep their exact param types.
 */
export function withErrorHandling<C = { params: Promise<Record<string, never>> }>(
  handler: (req: NextRequest, ctx: C) => Promise<Response>
): (req: NextRequest, ctx: C) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      const e = err as PgError;
      console.error(`[ERROR] ${req.method} ${req.nextUrl.pathname}:`, e.message);
      if (process.env.NODE_ENV === 'development') console.error(e.stack);

      if (e.code === '23505') {
        return NextResponse.json({ error: 'Duplicate entry: ' + e.detail }, { status: 409 });
      }
      if (e.code === '23503') {
        return NextResponse.json({ error: 'Foreign key violation: ' + e.detail }, { status: 400 });
      }

      const status = (err instanceof ApiError ? err.status : e.status || e.statusCode) || 500;
      return NextResponse.json(
        {
          error: status === 500 && process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message,
          ...(process.env.NODE_ENV === 'development' ? { stack: e.stack } : {}),
        },
        { status }
      );
    }
  };
}

export function json<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}
