/**
 * Reading values out of an Excel sheet without losing data.
 *
 * ExcelJS hands back more than numbers and strings: formulas ({ result }),
 * rich text ({ richText: [...] }), hyperlinks ({ text }), errors ({ error }) and
 * dates. And amounts are often typed as TEXT ("1,234.50", "(500)", "₹ 2,00,000",
 * "500 Cr"). parseFloat() turned "1,234.50" into 1 and "(500)" into 0, silently.
 */

/** A cell's plain value: formula result, rich text joined, hyperlink text. */
export function cellPlainValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'object' || val instanceof Date) return val;
  const o = val as Record<string, unknown>;
  if ('result' in o) return cellPlainValue(o.result);
  if (Array.isArray(o.richText)) return o.richText.map((p) => String((p as { text?: unknown }).text ?? '')).join('');
  if ('text' in o) return cellPlainValue(o.text);
  if ('error' in o) return null;
  return String(val);
}

/** Display text for a name/code cell — never "[object Object]". */
export function cellText(val: unknown): string {
  const v = cellPlainValue(val);
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * An amount cell → number. Blank → 0. Numbers pass through. Text is cleaned:
 * thousands separators (also Indian 2,00,000), currency symbols/codes, "(500)" and
 * "-500" negatives, trailing "Dr"/"Cr" (Cr = negative). Anything else → null, so
 * the caller can refuse the file instead of storing a wrong figure.
 */
export function parseAmount(val: unknown): number | null {
  const v = cellPlainValue(val);
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v instanceof Date) return null;
  let s = String(v).trim();
  if (s === '' || s === '-' || s === '–') return 0;

  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  const suffix = /\s*(dr|cr)\.?$/i.exec(s);
  if (suffix) { if (suffix[1].toLowerCase() === 'cr') negative = !negative; s = s.slice(0, suffix.index).trim(); }
  s = s.replace(/^(₹|rs\.?|inr|usd|eur|gbp|aed|\$|€|£)\s*/i, '');
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1).trim(); }
  else if (s.startsWith('+')) s = s.slice(1).trim();
  s = s.replace(/,/g, '').replace(/\s/g, '');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = parseFloat(s);
  return negative ? -n : n;
}
