import { fl, fn, frRaw, getUnitHeader, unitSuffix, formatChg, signedPct } from '@/lib/utils/format';

describe('fl/fn — Display Unit Selector', () => {
  test('defaults to Lakhs when no unit is passed (backward compatible)', () => {
    expect(fl(32475586.58)).toBe('324.76');
  });

  test('divides unconditionally — no magnitude-based guessing', () => {
    // Regression test for a real bug found on the Cash Flow tab: the old
    // fl() only divided values past a size threshold, so a genuinely small
    // raw-rupee movement (₹292.14) rendered as "(292.14)" under a "₹ in
    // Lakhs" header — read by a reviewer as ₹2.92 Crore, a 100,000×
    // overstatement. Every real raw-rupee value must always be divided by
    // the selected unit's divisor, regardless of its size.
    expect(fl(-292.14, 2, 'Lakhs')).toBe('—'); // negligible in Lakhs terms
    expect(fl(-292.14, 2, 'Thousands')).toBe('(0.29)'); // -292.14 / 1000
  });

  test('Lakhs / Thousands / Crores divide by the right factor, same raw rupees', () => {
    const raw = 32475586.58; // ₹3.25 Cr
    expect(fl(raw, 2, 'Lakhs')).toBe('324.76');
    expect(fn(raw, 2, 'Thousands')).toBe('32,475.59');
    expect(fn(raw, 2, 'Crores')).toBe('3.25');
  });

  test('negative values keep accounting parentheses in every unit', () => {
    expect(fl(-1326000, 2, 'Lakhs')).toBe('(13.26)');
    expect(fl(-1326000, 2, 'Thousands')).toBe('(1,326.00)');
    expect(fl(-1326000, 2, 'Crores')).toBe('(0.13)');
  });

  test('null/undefined/NaN render as em-dash regardless of unit', () => {
    expect(fl(null, 2, 'Crores')).toBe('—');
    expect(fl(undefined, 2, 'Thousands')).toBe('—');
    expect(fl(NaN, 2, 'Lakhs')).toBe('—');
  });

  test('getUnitHeader() and unitSuffix() match the selected unit', () => {
    expect(getUnitHeader('Lakhs')).toBe('₹ in Lakhs');
    expect(getUnitHeader('Thousands')).toBe('₹ in Thousands');
    expect(getUnitHeader('Crores')).toBe('₹ in Crores');
    expect(unitSuffix('Lakhs')).toBe('L');
    expect(unitSuffix('Thousands')).toBe('K');
    expect(unitSuffix('Crores')).toBe('Cr');
  });
});

describe('frRaw — no unit conversion', () => {
  test('formats a real EPS figure without dividing it', () => {
    // Regression test for a real bug: PLTab's EPS rows used to rely on the
    // old fl()'s magnitude-based auto-detect happening to skip small values
    // like -2.10. Once that guess was removed as unsound (see fl()'s own
    // regression test above), a real negative EPS silently rendered as "—"
    // instead of "(2.10)" — frRaw() must format it as-is, in every case.
    expect(frRaw(-2.10)).toBe('(2.10)');
    expect(frRaw(4.55)).toBe('4.55');
  });

  test('is unaffected by the selected table unit (Top Customers revenue_cr, EPS)', () => {
    expect(frRaw(0.65, 2)).toBe('0.65'); // e.g. ₹0.65 Cr customer revenue — never divided further
  });

  test('null/undefined/NaN/near-zero render as em-dash', () => {
    expect(frRaw(null)).toBe('—');
    expect(frRaw(undefined)).toBe('—');
    expect(frRaw(NaN)).toBe('—');
    expect(frRaw(0.001)).toBe('—');
  });
});

describe('formatChg — YoY change with explicit + prefix', () => {
  test('regression: a tiny positive floating-point residual must never render "+—"', () => {
    // Root cause of the real bug: `chg >= 0 ? `+${fn(chg)}` : fn(chg)` only
    // checks the raw sign of `chg`. A near-zero residual left over from raw
    // ledger subtraction (e.g. 0.000001) still satisfies `chg >= 0`, but
    // fn() rounds anything under EPSILON down to the neutral dash "—" — so
    // the naive ternary prepended "+" onto a dash it never should have.
    expect(formatChg(0.000001, 2, 'Lakhs')).toBe('—');
    expect(formatChg(0.000001, 2, 'Lakhs')).not.toBe('+—');
    expect(formatChg(-0.000001, 2, 'Lakhs')).toBe('—');
  });

  test('prepends + only for a real positive change', () => {
    expect(formatChg(1326000, 2, 'Lakhs')).toBe('+13.26');
    expect(formatChg(32475586.58, 2, 'Crores')).toBe('+3.25');
  });

  test('keeps accounting parentheses for a real negative change, no + prefix', () => {
    expect(formatChg(-1326000, 2, 'Lakhs')).toBe('(13.26)');
  });

  test('zero and exactly-zero change render as the plain dash, never "+0.00" or "+—"', () => {
    expect(formatChg(0, 2, 'Lakhs')).toBe('—');
  });

  test('null/undefined/NaN render as em-dash, not "+—"', () => {
    expect(formatChg(null)).toBe('—');
    expect(formatChg(undefined)).toBe('—');
    expect(formatChg(NaN)).toBe('—');
  });

  test('defaults to Lakhs, 2 decimals when unit/decimals are omitted', () => {
    expect(formatChg(32475586.58)).toBe('+324.76');
  });
});

describe('signedPct — same +— guard, for percentage-point YoY changes', () => {
  test('regression: a tiny positive percentage residual must never render "+—"', () => {
    // Same failure mode as formatChg(), but for the `(chg >= 0 ? '+' : '') +
    // pct(chg)` pattern used for percentage-point YoY changes (e.g. MIS/
    // Overview/Treasury KPI cards) — pct() also collapses near-zero to "—".
    expect(signedPct(0.0001)).toBe('0.0%');
    expect(signedPct(0.0001)).not.toBe('+—');
  });

  test('prepends + for a real positive % change, parens for negative', () => {
    expect(signedPct(12.5)).toBe('+12.5%');
    expect(signedPct(-3.2)).toBe('(3.2%)');
  });

  test('null/undefined/NaN render as em-dash', () => {
    expect(signedPct(null)).toBe('—');
    expect(signedPct(undefined)).toBe('—');
    expect(signedPct(NaN)).toBe('—');
  });
});
