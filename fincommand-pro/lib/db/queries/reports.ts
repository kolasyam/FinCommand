import { query } from '@/lib/db/neon';
import type { TbLedgerRow } from '@/lib/financial/tb-engine';
import type { PeriodParams, PeriodType, YearType, Period } from '@/lib/financial/tb-engine';

export interface FinancialYearRow {
  id: string; company_id: string; label: string; short_label: string;
  start_date: string; end_date: string; year_type: string; is_locked: boolean;
}

/** Loads current-upload ledgers for a company+FY — mirrors reports.js loadLedgers(). */
export async function loadLedgers(companyId: string, fyId: string): Promise<TbLedgerRow[]> {
  const { rows } = await query<TbLedgerRow>(
    `SELECT l.* FROM tb_ledgers l
     JOIN tb_uploads u ON u.id = l.upload_id
     WHERE l.company_id = $1 AND l.financial_year_id = $2 AND u.is_current = TRUE
     ORDER BY l.ledger_name`,
    [companyId, fyId]
  );
  return rows;
}

export interface CustomerRevenueRow {
  id: string;
  customer_name: string;
  zoho_customer_id: string | null;
  m1: Num; m2: Num; m3: Num; m4: Num; m5: Num; m6: Num;
  m7: Num; m8: Num; m9: Num; m10: Num; m11: Num; m12: Num;
}
type Num = number | string | null;

/**
 * Loads real per-customer revenue for the current upload — populated only by
 * Zoho sync (via /reports/salesbycustomer). Empty for Excel-uploaded Trial
 * Balances, which carry no customer dimension — callers must treat an empty
 * array as "not available", never fall back to fabricated data.
 * Gracefully returns [] if the table doesn't exist yet (pre-migration DB)
 * instead of throwing, so this is safe to call unconditionally.
 */
export async function loadCustomerRevenue(companyId: string, fyId: string): Promise<CustomerRevenueRow[]> {
  try {
    const { rows } = await query<CustomerRevenueRow>(
      `SELECT c.id, c.customer_name, c.zoho_customer_id,
              c.m1,c.m2,c.m3,c.m4,c.m5,c.m6,c.m7,c.m8,c.m9,c.m10,c.m11,c.m12
       FROM tb_customer_revenue c
       JOIN tb_uploads u ON u.id = c.upload_id
       WHERE c.company_id = $1 AND c.financial_year_id = $2 AND u.is_current = TRUE
       ORDER BY c.customer_name`,
      [companyId, fyId]
    );
    return rows;
  } catch (err) {
    if ((err as Error).message?.includes('does not exist')) return [];
    throw err;
  }
}

/** Verifies FY access — mirrors reports.js getFY(). */
export async function getFY(companyId: string, fyId: string): Promise<FinancialYearRow | null> {
  const { rows } = await query<FinancialYearRow>(
    `SELECT id, company_id, label, short_label, start_date::text AS start_date, end_date::text AS end_date, year_type, is_locked
     FROM financial_years WHERE id=$1 AND company_id=$2`,
    [fyId, companyId]
  );
  return rows[0] || null;
}

/** Gets the previous financial year for a given company and FY. */
export async function getPreviousFY(companyId: string, currentFy: FinancialYearRow): Promise<FinancialYearRow | null> {
  const { rows } = await query<FinancialYearRow>(
    `SELECT id, company_id, label, short_label, start_date::text AS start_date, end_date::text AS end_date, year_type, is_locked
     FROM financial_years
     WHERE company_id = $1 AND start_date < $2
     ORDER BY start_date DESC LIMIT 1`,
    [companyId, currentFy.start_date]
  );
  return rows[0] || null;
}

/**
 * Gets the next financial year (chronologically) for CY mode.
 * For CY YYYY: prevFY = FY ending Mar YYYY, nextFY = FY starting Apr YYYY.
 * If nextFY has not been uploaded yet, returns null and Apr–Dec will be zero.
 */
export async function getNextFY(companyId: string, currentFy: FinancialYearRow): Promise<FinancialYearRow | null> {
  const { rows } = await query<FinancialYearRow>(
    `SELECT id, company_id, label, short_label, start_date::text AS start_date, end_date::text AS end_date, year_type, is_locked
     FROM financial_years
     WHERE company_id = $1 AND start_date > $2
     ORDER BY start_date ASC LIMIT 1`,
    [companyId, currentFy.end_date]
  );
  return rows[0] || null;
}

/** Parses common period params from a URLSearchParams — mirrors reports.js parsePeriodParams(). */
export function parsePeriodParams(searchParams: URLSearchParams): PeriodParams {
  return {
    periodType: (searchParams.get('period_type') as PeriodType) || 'annual',
    period: (searchParams.get('period') as Period) || null,
    yearType: (searchParams.get('year_type') as YearType) || 'FY',
  };
}
