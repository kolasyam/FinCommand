/**
 * Presentation-currency support: the 5 currencies the top-bar selector
 * offers, and a live FX rate lookup (open.er-api.com — exchangerate-api.com's
 * free tier: no API key, updates ~daily, and is the one free provider that
 * actually covers all 5 of these — the more commonly-used Frankfurter/ECB
 * feed was checked and does NOT list AED). Rates are cached server-side
 * (module-level, since this runs in a long-lived Node process) with a
 * six-hour TTL — matching the provider's own ~daily refresh cadence, so
 * this never hammers a free public API on every report load, while still
 * being far fresher than needed for a "spot rate as of {date}, for
 * reference" disclosure (this is a presentation convenience, not a
 * transaction-level FX booking).
 */
import axios from 'axios';

export type CurrencyCode = 'INR' | 'USD' | 'EUR' | 'GBP' | 'AED';
export const SUPPORTED_CURRENCIES: CurrencyCode[] = ['INR', 'USD', 'EUR', 'GBP', 'AED'];

export interface CurrencyMeta {
  /** One of the 5 CurrencyCode options for a real entry in CURRENCY_META, or the bare unrecognized ISO code for getCurrencyMeta()'s fallback. */
  code: string;
  name: string;
  /** Symbol for on-screen / Excel use (browsers and Excel both render these correctly). */
  symbol: string;
  /**
   * PDF-safe symbol. jsPDF's base-14 fonts (Helvetica, under WinAnsiEncoding)
   * have no glyph for ₹ or د.إ and silently drop the *entire* string
   * containing them (confirmed empirically for ₹ — see fcPdf()'s comment in
   * lib/utils/format.ts); € and £ ARE in WinAnsiEncoding and render fine, so
   * only INR and AED need an ASCII fallback for PDF text.
   */
  pdfSymbol: string;
  /** Locale for toLocaleString() digit grouping — India's 2-2-3 lakh/crore grouping ("12,34,567") is specific to INR; every other presentation currency here uses standard international 3-digit grouping ("1,234,567"). */
  locale: string;
  /** Whitespace between `pdfSymbol` and the number in fcPdf() — a word-style symbol ("Rs.", "AED") reads right with a space ("Rs. 500"); a single glyph ($/€/£) hugs the number, same convention fc() already uses on-screen ("$500"). */
  pdfSpacer: string;
}

export const CURRENCY_META: Record<CurrencyCode, CurrencyMeta> = {
  INR: { code: 'INR', name: 'Indian Rupee', symbol: '₹', pdfSymbol: 'Rs.', locale: 'en-IN', pdfSpacer: ' ' },
  USD: { code: 'USD', name: 'US Dollar', symbol: '$', pdfSymbol: '$', locale: 'en-US', pdfSpacer: '' },
  EUR: { code: 'EUR', name: 'Euro', symbol: '€', pdfSymbol: '€', locale: 'en-IE', pdfSpacer: '' },
  GBP: { code: 'GBP', name: 'British Pound', symbol: '£', pdfSymbol: '£', locale: 'en-GB', pdfSpacer: '' },
  AED: { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', pdfSymbol: 'AED', locale: 'en-AE', pdfSpacer: ' ' },
};

/**
 * Safe metadata lookup for ANY currency code, not just the 5 presentation
 * options — a connected Zoho org's real Source Currency can be something
 * this app never offers as a presentation choice (SGD, JPY, CAD, ...).
 * `CURRENCY_META[code]` would be `undefined` for those and crash the first
 * `.symbol` access; this instead falls back to showing the bare ISO code
 * as its own "symbol" (e.g. "SGD 1,234.00") — honest and crash-safe, never
 * a silently wrong symbol borrowed from an unrelated currency.
 */
export function getCurrencyMeta(code: string): CurrencyMeta {
  if (isCurrencyCode(code)) return CURRENCY_META[code];
  const upper = code.toUpperCase();
  return { code: upper, name: upper, symbol: `${upper} `, pdfSymbol: `${upper} `, locale: 'en-US', pdfSpacer: '' };
}

export function isCurrencyCode(v: unknown): v is CurrencyCode {
  return typeof v === 'string' && (SUPPORTED_CURRENCIES as string[]).includes(v);
}

export interface FxRate {
  /** The Source Currency — any real ISO 4217 code, e.g. a Zoho org billed in SGD/JPY/CAD, not just the 5 CurrencyCode presentation options. */
  from: string;
  to: CurrencyCode;
  rate: number;
  /** ISO timestamp the provider last updated this rate — always shown alongside any converted figure, same disclosure standard as every other estimate in this engine. */
  as_of: string;
  provider: string;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const rateCache = new Map<string, { data: FxRate; fetchedAt: number }>();
// One in-flight request per currency pair, however many callers ask for it
// at once (e.g. several tabs re-rendering together) — avoids a stampede of
// identical outbound calls to the free API.
const inFlight = new Map<string, Promise<FxRate | null>>();

const FX_API_BASE = 'https://open.er-api.com/v6/latest';
const FX_TIMEOUT_MS = 8000;

interface FxApiResponse {
  result: string;
  base_code: string;
  time_last_update_utc: string;
  rates: Record<string, number>;
}

async function fetchRateFromProvider(from: string, to: CurrencyCode): Promise<FxRate | null> {
  try {
    const res = await axios.get<FxApiResponse>(`${FX_API_BASE}/${from}`, { timeout: FX_TIMEOUT_MS });
    if (res.data.result !== 'success' || !res.data.rates || typeof res.data.rates[to] !== 'number') {
      console.warn(`FX rate lookup ${from}->${to}: provider returned no usable rate.`);
      return null;
    }
    return {
      from, to,
      rate: res.data.rates[to],
      as_of: new Date(res.data.time_last_update_utc).toISOString(),
      provider: 'exchangerate-api.com (open.er-api.com)',
    };
  } catch (err) {
    console.warn(`FX rate lookup ${from}->${to} failed:`, (err as Error).message);
    return null;
  }
}

/**
 * Returns the current spot rate to convert an amount in `from` (the
 * company's real Source Currency — any ISO 4217 code Zoho reports, not
 * limited to the 5 presentation options) into `to` (one of the 5
 * presentation currencies), or `null` if no rate is available right now
 * (provider unreachable, rate limit, unsupported pair) — callers must treat
 * `null` as "conversion unavailable" and say so honestly (e.g. fall back to
 * showing source-currency figures with a clear notice), never guess a rate.
 */
export async function getFxRate(from: string, to: CurrencyCode): Promise<FxRate | null> {
  if (from === to) {
    return { from, to, rate: 1, as_of: new Date().toISOString(), provider: 'identity (same currency)' };
  }
  const key = `${from}:${to}`;
  const cached = rateCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const fresh = await fetchRateFromProvider(from, to);
    if (fresh) {
      rateCache.set(key, { data: fresh, fetchedAt: Date.now() });
    } else if (cached) {
      // Provider is down but we have a stale-but-real rate — better to serve
      // that (clearly timestamped, so the UI can show its real age) than to
      // show nothing at all for a transient outage. Never fabricate a rate
      // that was never actually fetched, though — an empty cache stays null.
      console.warn(`FX rate ${from}->${to}: provider unavailable, serving cached rate from ${cached.data.as_of}.`);
      return cached.data;
    }
    return fresh;
  })();
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}
