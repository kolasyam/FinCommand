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

/** The three table-display units the topbar Unit Selector offers. Default 'Crores'. */
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

export function fl(n: number | null | undefined, decimals = 2, unit: DisplayUnit = 'Lakhs'): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (Math.abs(n) < 1e-9) return '—';
  const scaled = n / UNIT_DIVISOR[unit];

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
  if (Math.abs(n) < 1e-9) return '—';
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
  if (absVal < 1e-9) return null;
  const isNeg = n < 0;

  let magnitude: string;
  if (currency === 'INR') {
    // Unconditional real-magnitude ladder — no "this figure is probably
    // already expressed in Lakhs" guess. A prior version special-cased
    // 100 <= absVal < 100000 as "must already be Lakhs, divide by 100 for
    // Cr" instead of the honest "divide by 1,00,000 for Lakhs" every other
    // branch (and fl()/fn() unconditionally, per their own regression test)
    // uses — the exact "no magnitude-based guessing" rule format.test.ts
    // pins for fl()/fn() was being silently violated here, and only here.
    // That guess existed only to paper over lib/financial/sample-data.ts
    // authoring its demo figures in Lakhs without converting to real raw
    // rupees; now that sample-data.ts does that conversion itself (see its
    // own LAKH constant), this function no longer needs to guess — and
    // removing the guess is what makes it agree with the Period Summary/
    // YoY Variance tables directly below every KPI card instead of quietly
    // fabricating a plausible-looking-but-wrong Cr figure for any real
    // company whose Trial Balance was, in fact, entered in Lakhs by mistake.
    if (absVal >= 10000000) {
      magnitude = `${(absVal / 10000000).toFixed(2)} Cr`;
    } else {
      magnitude = `${(absVal / 100000).toFixed(2)} Lakhs`;
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
  if (Math.abs(n) < 1e-9) return '—';
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

/**
 * Tone for a ratio/percentage/day-count metric that has a real benchmark —
 * never derive this from the value's raw sign. A positive Debt/Equity of
 * 3.0x is still unfavorable (target 1.0, lower_is_better); a positive-but-
 * below-target ROE is still unfavorable. This is the one canonical
 * implementation both widget-renderers.tsx's toneForMetric() (its threshold
 * branch delegates here) and any hand-coded benchmark comparison — the
 * Financial Health & Solvency card's Current Ratio/ROE/Debt-Equity, in both
 * OverviewTab.tsx's fixed view and its FinancialHealthWidget mirror — must
 * go through, so the two can never drift the way they did before this fix:
 * Current Ratio and Debt/Equity carried no tone at all, and ROE used plain
 * sign-based numTone() instead of comparing against its real 15% target (a
 * hypothetical +8% ROE, genuinely below benchmark, would have shown up as
 * green/favorable).
 */
export function benchmarkTone(
  value: number | null | undefined,
  target: number,
  direction: 'higher_is_better' | 'lower_is_better',
): 'up' | 'dn' | '' {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  const healthy = direction === 'higher_is_better' ? value >= target : value <= target;
  return healthy ? 'up' : 'dn';
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

/**
 * PDF-safe KPI-card formatter that IS unit-selector-responsive (unlike
 * fcPdf(), which auto-scales to Lakh/Crore or K/M/B regardless of the
 * topbar Unit Selector — see fcPdf()'s own doc comment: that's correct for
 * an auxiliary "quick glance" figure, but every bespoke PDF export's own
 * headline KPI cards are the primary restatement of a number the matching
 * on-screen tab already shows unit-scaled via fl()/fn() — fcPdf() there
 * made the PDF's big bolded figure silently stop tracking the Unit
 * Selector, so a "Total Assets" card could read "Rs. 9.92 Cr" while the
 * live tab (and the very same PDF's own comparison table two inches below)
 * showed "992.08" under "Rs. in Lakhs"). This instead applies the SAME
 * Lakhs/Thousands/Crores-scaled magnitude fl() produces for every table
 * cell, with the currency symbol and the unit's short suffix around it —
 * e.g. "Rs. 324.76L", "$3.91K" — so a PDF KPI card always shows the
 * identical number, at the identical scale, as its on-screen counterpart.
 * Same symbol+fl()+unitSuffix() shape BoardPackTab.tsx's own highlight
 * sentences and bs-pdf.ts's "out of balance" line already use.
 */
export function fcUnitPdf(n: number | null | undefined, unit: DisplayUnit = 'Lakhs', currency: CurrencyCode = 'INR'): string {
  const formatted = fl(n, 2, unit);
  if (formatted === '—') return '—';
  const meta = getCurrencyMeta(currency);
  return `${meta.pdfSymbol}${meta.pdfSpacer}${formatted}${unitSuffix(unit)}`;
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
