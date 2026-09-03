/**
 * Financial number formatting helpers — CFO / Corporate Finance presentation
 * standard (IND AS, Schedule III): negative values in accounting
 * parentheses (never a bare minus sign), zero/near-zero as a neutral
 * em-dash, and a shared `numTone()` so every table/KPI colors positive
 * green (`up`) and negative red (`dn`) the same way.
 *
 * Every figure the engine passes in is raw ₹ (rupees); fl()/fn() convert to
 * the selected table `DisplayUnit` — Lakhs (default), Thousands, or Crores,
 * chosen via the topbar Unit Selector — see each function's comment. fc()
 * is unrelated: it auto-scales all the way up to ₹ Crore for KPI cards
 * regardless of the table unit selector, by design (a KPI card is a single
 * headline figure, not a table column sharing one stated unit).
 *
 * Presentation Currency: fl()/fn()/pct()/etc. never see a currency — they
 * only ever format a *magnitude* the caller has already converted (see
 * lib/financial/currency-convert.ts, applied once to the whole ReportBundle
 * by DashboardContext, so every existing fl()/fn() call site across all 14
 * tabs and every export needed zero changes to show correctly-converted
 * figures). The functions here that DO need to know the active currency are
 * the ones that embed a currency *symbol* directly in their own output —
 * fc(), fcPdf(), getUnitHeader(), getUnitHeaderPdf() — each takes an
 * optional `currency: CurrencyCode` parameter, defaulting to 'INR' so every
 * pre-existing call site keeps compiling and behaving exactly as before.
 */
import { getCurrencyMeta, type CurrencyCode } from '@/lib/services/currency';
export type { CurrencyCode };

const EPSILON = 0.005; // values that would round to 0.00 at 2dp display as the neutral dash, not "0.00" or "(0.00)"

/** The three table-display units the topbar Unit Selector offers. Default 'Lakhs' — this app's longstanding convention and every existing export/tab's assumption. */
export type DisplayUnit = 'Lakhs' | 'Thousands' | 'Crores';

const UNIT_DIVISOR: Record<DisplayUnit, number> = {
  Lakhs: 100000,
  Thousands: 1000,
  Crores: 10000000,
};

/** Column/badge header text for the selected unit and presentation currency, e.g. "₹ in Lakhs" or "$ in Thousands". */
export function getUnitHeader(unit: DisplayUnit = 'Lakhs', currency: CurrencyCode = 'INR'): string {
  return `${getCurrencyMeta(currency).symbol} in ${unit}`;
}

/** Same as getUnitHeader(), but the PDF-safe symbol — jsPDF's base-14 fonts silently drop any string containing ₹ or د.إ entirely (see fcPdf()'s comment), so every bespoke PDF export must use this instead when labeling the unit/currency a table is stated in. */
export function getUnitHeaderPdf(unit: DisplayUnit = 'Lakhs', currency: CurrencyCode = 'INR'): string {
  return `${getCurrencyMeta(currency).pdfSymbol} in ${unit}`;
}

const UNIT_SUFFIX: Record<DisplayUnit, string> = { Lakhs: 'L', Thousands: 'K', Crores: 'Cr' };

/** Short inline unit suffix for the selected unit, e.g. "L"/"K"/"Cr" — for text like `${fl(v)}${unitSuffix(unit)}`. */
export function unitSuffix(unit: DisplayUnit = 'Lakhs'): string {
  return UNIT_SUFFIX[unit];
}

/**
 * Formats a raw-rupee value (unconditionally divided by the selected unit's
 * divisor) as an accounting-style string: `324.80` or `(13.26)` — never a
 * bare minus sign. Null/undefined/NaN and near-zero values render as `—`.
 *
 * Every real call site across the engine (MIS, BS, P&L, Cash Flow, Notes,
 * Treasury, Ratios, ...) passes raw rupees — tb-engine.ts's ledger amounts
 * are always raw NUMERIC rupees, with no exceptions. This function used to
 * guess the unit from magnitude (only divide values past some threshold) to
 * also accommodate the couple of call sites that pass an already-Crores
 * figure (Top Customers' `revenue_cr`) — but that guess is unsound at any
 * threshold: a genuinely small *raw-rupee* movement (a ledger balance that
 * happens to net to, say, ₹292 for the period) is indistinguishable by
 * magnitude alone from an already-scaled ₹292 Lakhs figure, so it silently
 * rendered as "(292.14)" under a "₹ in Lakhs" column header — a 100,000×
 * overstatement (confirmed on the Cash Flow tab's real equity-movement line)
 * that a real finance reviewer would, rightly, refuse to believe. Use
 * frRaw() for figures that aren't raw-rupee table amounts (Top Customers'
 * revenue_cr, EPS) instead of routing them through this function — never
 * reintroduce a magnitude guess here.
 */
export function fl(n: number | null | undefined, decimals = 2, unit: DisplayUnit = 'Lakhs'): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const scaled = n / UNIT_DIVISOR[unit];
  if (Math.abs(scaled) < EPSILON) return '—';

  const formatted = Math.abs(scaled).toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return scaled < 0 ? `(${formatted})` : formatted;
}

/** Table-cell alias for fl() — kept as a distinct name at call sites for readability ("fn" = financial number, accounting-formatted). */
export function fn(n: number | null | undefined, decimals = 2, unit: DisplayUnit = 'Lakhs'): string {
  return fl(n, decimals, unit);
}

/**
 * Formats a YoY/period change value with an explicit '+' prefix for positive
 * numbers — for the many `chg >= 0 ? `+${fn(chg)}` : fn(chg)` call sites
 * scattered across the tabs and exporters. Prepending '+' unconditionally
 * whenever `chg >= 0` is unsound: a tiny positive floating-point residual
 * (e.g. 0.000001, left over from raw ledger subtraction) still satisfies
 * `chg >= 0`, but fn() rounds anything under EPSILON down to the neutral
 * dash '—' — so the naive ternary produced the nonsensical '+—' instead of
 * a plain '—'. This checks fn()'s actual *output*, not the raw sign, before
 * deciding whether a '+' belongs in front of it.
 */
export function formatChg(
  n: number | null | undefined,
  decimals = 2,
  unit: DisplayUnit = 'Lakhs'
): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const text = fn(n, decimals, unit);
  if (text === '—') return '—';
  return n > 0 ? `+${text}` : text;
}

/**
 * Accounting-style formatter for a value that's *not* a raw-rupee table
 * figure — same parens/dash conventions as fl(), but with no unit
 * conversion applied, regardless of the selected table DisplayUnit. Two
 * real uses: Top Customers' `revenue_cr` (computed directly in Crores —
 * table-unit-independent by design, see OverviewTab's comment) and EPS
 * (a ₹-per-share figure, not a table amount — the Lakhs/Thousands/Crores
 * selector governs *table* units and has no meaning for "rupees per
 * share"; before this function existed, PLTab's EPS rows relied on fl()'s
 * old magnitude-based auto-detect happening to skip small values like
 * -2.10 — once that guess was removed as unsound, EPS needed its own
 * explicit no-conversion path instead of silently rendering "—").
 * Use this instead of fl()/fn() for any figure that isn't a raw-rupee
 * table amount.
 */
export function frRaw(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (Math.abs(n) < EPSILON) return '—';
  const formatted = Math.abs(n).toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return n < 0 ? `(${formatted})` : formatted;
}

/** Shared by fc()/fcPdf(): the adaptive magnitude + unit suffix, with no symbol or sign — e.g. "3.25 Cr" / "450.20 K" / null when negligible/absent. */
function fcMagnitude(n: number | null | undefined, currency: CurrencyCode): { magnitude: string; isNeg: boolean } | null {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const absVal = Math.abs(n);
  if (absVal < EPSILON) return null;
  const isNeg = n < 0;

  let magnitude: string;
  if (currency === 'INR') {
    if (absVal >= 10000000) {
      magnitude = `${(absVal / 10000000).toFixed(2)} Cr`;
    } else if (absVal >= 100000) {
      magnitude = `${(absVal / 100000).toFixed(2)} Lakhs`;
    } else if (absVal >= 100) {
      // Already in Lakhs (e.g. 721.74 Lakhs = ₹7.21 Cr)
      magnitude = `${(absVal / 100).toFixed(2)} Cr`;
    } else {
      magnitude = `${absVal.toFixed(2)} Lakhs`;
    }
  } else {
    // International convention — Lakh/Crore has no meaning to a non-INR
    // presentation currency's reader.
    if (absVal >= 1_000_000_000) {
      magnitude = `${(absVal / 1_000_000_000).toFixed(2)} B`;
    } else if (absVal >= 1_000_000) {
      magnitude = `${(absVal / 1_000_000).toFixed(2)} M`;
    } else if (absVal >= 1_000) {
      magnitude = `${(absVal / 1_000).toFixed(2)} K`;
    } else {
      magnitude = absVal.toFixed(2);
    }
  }
  return { magnitude, isNeg };
}

/**
 * KPI-card formatter with smart adaptive units: `₹3.25 Cr`, `₹45.20 Lakhs`,
 * or `(₹1.19 Lakhs)` for negative — INR's Lakh/Crore convention when
 * `currency` is 'INR' (the default, and every pre-existing call site's
 * behavior, unchanged). For a non-INR presentation currency, this switches
 * to the international Thousand/Million/Billion convention instead
 * (`$3.25 M`, `€450.20 K`), with the target currency's own symbol.
 */
export function fc(n: number | null | undefined, currency: CurrencyCode = 'INR'): string {
  const m = fcMagnitude(n, currency);
  if (!m) return '—';
  const formatted = `${getCurrencyMeta(currency).symbol}${m.magnitude}`;
  return m.isNeg ? `(${formatted})` : formatted;
}

/** Accounting-style percentage: `45.2%` or `(0.4%)`. Null/undefined/NaN render as `—`. */
export function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (Math.abs(n) < EPSILON) return '—';
  const abs = Math.abs(n).toFixed(digits);
  return n < 0 ? `(${abs}%)` : `${abs}%`;
}

/** Signed-change percentage for YoY/period deltas: `+12.5%` or `(3.2%)` — distinct from pct() by always showing an explicit '+' on positive/zero. */
export function signedPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (Math.abs(n) < EPSILON) return '0.0%';
  return n < 0 ? pct(n, digits) : `+${pct(n, digits)}`;
}

/**
 * Shared tone class for any raw financial number: 'up' (green, positive),
 * 'dn' (red, negative), or '' (neutral, zero/near-zero/null) — pair with
 * fl()/fn()/fc()/pct() so a value's color always matches its sign:
 *   <td className={`num ${numTone(v)}`}>{fn(v)}</td>
 */
export function numTone(n: number | null | undefined): 'up' | 'dn' | '' {
  if (n === null || n === undefined || Number.isNaN(n) || Math.abs(n) < EPSILON) return '';
  return n < 0 ? 'dn' : 'up';
}

/** Same sign logic as numTone(), but always returns a value — for the `<Kpi tone>` prop, which has no empty/neutral-string variant (its neutral state is the literal 'neu'). */
export function kpiTone(n: number | null | undefined): 'up' | 'dn' | 'neu' {
  return numTone(n) || 'neu';
}

/** Accounting-style multiple (ratios): `2.50x` or `(0.80x)`. Null/undefined/NaN render as `—`. */
export function fx(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (Math.abs(n) < EPSILON) return '—';
  const abs = Math.abs(n).toFixed(digits);
  return n < 0 ? `(${abs}x)` : `${abs}x`;
}

/**
 * PDF-safe currency formatter. jsPDF's base-14 standard fonts (Helvetica/
 * Times/Courier under WinAnsiEncoding) have no glyph for ₹ (U+20B9, added to
 * Unicode in 2010 — long after these font encodings were fixed) or for
 * Arabic script (د.إ, AED's symbol) — and critically, jsPDF doesn't
 * substitute a blank glyph, it silently drops the *entire* text string
 * containing an unsupported character. Confirmed empirically: `doc.text('₹500', ...)`
 * renders nothing at all, not even the "500". Every PDF export (lib/exports/
 * pdf.ts, overview-pdf.ts) must use this instead of fc() for any text handed
 * to doc.text()/autoTable — the on-screen UI and Excel exports are unaffected
 * (browsers and Excel both render every symbol here correctly, including
 * د.إ) and should keep using fc(). € and £ ARE in WinAnsiEncoding and need
 * no substitution — only INR and AED do.
 */
export function fcPdf(n: number | null | undefined, currency: CurrencyCode = 'INR'): string {
  const m = fcMagnitude(n, currency);
  if (!m) return '—';
  const meta = getCurrencyMeta(currency);
  const formatted = `${meta.pdfSymbol}${meta.pdfSpacer}${m.magnitude}`;
  return m.isNeg ? `(${formatted})` : formatted;
}

export function formatDate(iso: string | undefined | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function cyYearFromFy(fy: { start_date?: string; end_date?: string } | null | undefined): number {
  if (!fy) return 2026;
  if (fy.end_date) return parseInt(fy.end_date.slice(0, 4), 10);
  if (fy.start_date) return parseInt(fy.start_date.slice(0, 4), 10) + 1;
  return 2026;
}

export function getFyLabel(
  fy: { label?: string; short_label?: string; start_date?: string; end_date?: string } | null | undefined,
  yearType?: string
): string {
  if (!fy) return '';
  if (yearType === 'CY') {
    return `CY ${cyYearFromFy(fy)}`;
  }
  return fy.label || '';
}

export function getFyShortLabel(
  fy: { label?: string; short_label?: string; start_date?: string; end_date?: string } | null | undefined,
  yearType?: string
): string {
  if (!fy) return '';
  if (yearType === 'CY') {
    return `CY${cyYearFromFy(fy)}`;
  }
  return fy.short_label || fy.label || '';
}
