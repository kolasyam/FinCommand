import { NextRequest, NextResponse } from 'next/server';
import { ApiError, claimedCompanyId } from '@/lib/auth/permissions';
import { isCompanyId, runAsCompany } from '@/lib/db/tenant-context';

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
  handler: (req: NextRequest, ctx: C) => Promise<Response>,
  options: { system?: boolean } = {},
): (req: NextRequest, ctx: C) => Promise<Response> {
  return async (req, ctx) => {
    try {
      // The company this request is for, from its signature-verified token (no database access). Everything the
      // handler awaits then runs as that company: with the restricted database login configured, the database
      // itself shows and accepts only that company's rows (migration 0008, lib/db/tenant-context.ts).
      //
      // Routes that do not authenticate a company (login, signup, token refresh, the OAuth callback, cron) pass
      // { system: true }: they must see across companies, and a stale token in the browser must not narrow them.
      const companyId = options.system ? null : claimedCompanyId(req);
      if (isCompanyId(companyId)) return await runAsCompany(companyId, () => handler(req, ctx));
      return await handler(req, ctx);
    } catch (err) {
      const e = err as PgError;
      // Internals (stack, raw 500 messages) only ever go back to a developer's own machine, never from Vercel.
      const localDev = process.env.NODE_ENV === 'development' && !process.env.VERCEL;
      console.error(`[ERROR] ${req.method} ${req.nextUrl.pathname}:`, e.message);
      if (process.env.NODE_ENV === 'development') console.error(e.stack);

      if (e.code === '23505') {
        return NextResponse.json({ error: 'That already exists.' }, { status: 409 });
      }
      if (e.code === '23503') {
        return NextResponse.json({ error: 'This refers to something that does not exist, or is still in use.' }, { status: 400 });
      }
      // Database rules added in DB Phase 0 (db/migrations/0001_integrity.sql).
      if (e.code === '23P01') {
        return NextResponse.json({ error: 'This overlaps an existing record (for example, two financial years covering the same dates).' }, { status: 409 });
      }
      if (e.code === '23514') {
        return NextResponse.json({ error: 'A value failed a data rule. Please check the values and try again.' }, { status: 400 });
      }
      if (e.code === '22001') {
        return NextResponse.json({ error: 'A value is longer than allowed.' }, { status: 400 });
      }
      if (e.code === '55P03') {
        return NextResponse.json(
          { error: 'Another upload or sync for this year is in progress — try again in a moment.', code: 'BUSY' },
          { status: 409 }
        );
      }

      const status = (err instanceof ApiError ? err.status : e.status || e.statusCode) || 500;
      const apiCode = err instanceof ApiError ? err.code : undefined;
      return NextResponse.json(
        {
          error: status === 500 && !localDev ? 'Internal server error' : e.message,
          ...(apiCode ? { code: apiCode } : {}),
          ...(err instanceof ApiError && err.extra ? err.extra : {}),
          ...(localDev ? { stack: e.stack } : {}),
        },
        { status }
      );
    }
  };
}

export function json<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}
