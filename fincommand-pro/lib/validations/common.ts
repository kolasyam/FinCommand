/**
 * Lightweight request validation helpers — replaces express-validator, which
 * has no Next.js Route Handler equivalent. Mirrors the original 422
 * `{ errors: [...] }` response shape used throughout backend/routes/*.js.
 */

export interface FieldError { field: string; message: string }

export class ValidationCollector {
  private errs: FieldError[] = [];

  check(condition: boolean, field: string, message: string): this {
    if (!condition) this.errs.push({ field, message });
    return this;
  }

  errors(): FieldError[] {
    return this.errs;
  }

  isEmpty(): boolean {
    return this.errs.length === 0;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// MCA CIN format: L/U + 5-digit industry code + 2-letter state code + 4-digit
// year + 3-letter ownership class + 6-digit registration number = 21 chars.
const CIN_RE = /^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/;
// Statutory PAN format: 5 letters + 4 digits + 1 letter = 10 chars.
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;

export function isUUID(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function isEmail(v: unknown): v is string {
  return typeof v === 'string' && EMAIL_RE.test(v);
}

/** Validates a 21-character CIN against the MCA registration-number format. */
export function isCIN(v: unknown): v is string {
  return typeof v === 'string' && CIN_RE.test(v.toUpperCase());
}

/** Validates a 10-character PAN. */
export function isPAN(v: unknown): v is string {
  return typeof v === 'string' && PAN_RE.test(v.toUpperCase());
}

/** True if v parses to a real calendar date that is not in the future. */
export function isNotFutureDate(v: unknown): v is string {
  if (typeof v !== 'string' || !v) return false;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() <= Date.now();
}

/** Minimum bar for provisioned account passwords: 8+ chars, at least one letter and one digit. */
export function isStrongPassword(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v);
}

export function isIn<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v);
}

/** Validates the common report-endpoint query params (fy_id, period_type, period, year_type). */
export function validateReportQuery(searchParams: URLSearchParams): FieldError[] {
  const v = new ValidationCollector();
  const fyId = searchParams.get('fy_id');
  v.check(isUUID(fyId), 'fy_id', 'fy_id must be a valid UUID');

  const periodType = searchParams.get('period_type');
  if (periodType !== null) {
    v.check(isIn(periodType, ['annual', 'quarterly', 'halfyear'] as const), 'period_type', 'period_type must be annual, quarterly, or halfyear');
  }
  const period = searchParams.get('period');
  if (period !== null) {
    v.check(isIn(period, ['Q1', 'Q2', 'Q3', 'Q4', 'H1', 'H2'] as const), 'period', 'period must be Q1-Q4 or H1/H2');
  }
  const yearType = searchParams.get('year_type');
  if (yearType !== null) {
    v.check(isIn(yearType, ['FY', 'CY'] as const), 'year_type', 'year_type must be FY or CY');
  }
  return v.errors();
}
