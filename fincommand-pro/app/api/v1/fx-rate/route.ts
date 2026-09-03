import type { NextRequest } from 'next/server';
import { ApiError } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { getFxRate, isCurrencyCode } from '@/lib/services/currency';

export const runtime = 'nodejs';

/**
 * GET /api/v1/fx-rate?from=INR&to=USD — spot rate to convert `from` into
 * `to`, or a 502 with a clear reason if no live rate is available (never a
 * guessed rate). Deliberately unauthenticated: this is a public spot-rate
 * lookup carrying no company data (server-side cached with a 6h TTL — see
 * lib/services/currency.ts — so it can't be turned into an API-abuse vector
 * either), and a signed-out visitor previewing Sample Data must be able to
 * toggle the Presentation Currency selector too, not just logged-in users.
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const { searchParams } = req.nextUrl;
  const from = (searchParams.get('from') || '').toUpperCase();
  const to = (searchParams.get('to') || '').toUpperCase();

  // `from` (Source Currency) can legitimately be any real ISO 4217 code a
  // Zoho org is billed in (SGD, JPY, CAD, ...), not just the 5 presentation
  // options — only `to` (what the selector actually offers) is restricted.
  if (!/^[A-Z]{3}$/.test(from)) {
    throw new ApiError(400, '`from` must be a 3-letter currency code');
  }
  if (!isCurrencyCode(to)) {
    throw new ApiError(400, '`to` must be one of INR, USD, EUR, GBP, AED');
  }

  const fx = await getFxRate(from, to);
  if (!fx) {
    throw new ApiError(502, `No live FX rate available for ${from} → ${to} right now — try again shortly.`);
  }
  return json(fx);
});
