import { query } from '@/lib/db/neon';
import type { TbLedgerRow } from '@/lib/financial/tb-engine';
import { mergeCyLedgers } from '@/lib/financial/cy-merge';
import type { PeriodParams, PeriodType, YearType, Period } from '@/lib/financial/tb-engine';
import type { ReportDataVersion } from '@/lib/cache/report-cache';

export interface FinancialYearRow {
  id: string; company_id: string; label: string; short_label: string;
  start_date: string; end_date: string; year_type: string; is_locked: boolean;
}

/**
 * The one current batch for a company + FY (migration 0001's unique index
 * guarantees at most one). Every loader below reads by this batch id rather
 * than joining tb_uploads and filtering is_current — same rows, but it
 * can't mix two batches, and it goes straight to idx_tb_*_upload.
 * company_id is still filtered on the outer query too, for tenancy.
 */
const CURRENT_BATCH = `(SELECT id FROM tb_uploads WHERE company_id = $1 AND financial_year_id = $2 AND is_current = TRUE)`;

/** Loads current-upload ledgers for a company+FY — mirrors reports.js loadLedgers(). */
export async function loadLedgers(companyId: string, fyId: string): Promise<TbLedgerRow[]> {
  const { rows } = await query<TbLedgerRow>(
    `SELECT l.* FROM tb_ledgers l
     WHERE l.upload_id = ${CURRENT_BATCH} AND l.company_id = $1
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
       WHERE c.upload_id = ${CURRENT_BATCH} AND c.company_id = $1
       ORDER BY c.customer_name`,
      [companyId, fyId]
    );
    return rows;
  } catch (err) {
    if ((err as Error).message?.includes('does not exist')) return [];
    throw err;
  }
}

export interface VendorExpenseRow {
  id: string;
  vendor_name: string;
  zoho_vendor_id: string | null;
  m1: Num; m2: Num; m3: Num; m4: Num; m5: Num; m6: Num;
  m7: Num; m8: Num; m9: Num; m10: Num; m11: Num; m12: Num;
}

/**
 * Loads real per-vendor spend for the current upload — populated only by
 * Zoho sync (via /bills). Empty for Excel-uploaded Trial Balances, which
 * carry no vendor dimension — callers must treat an empty array as "not
 * available", never fall back to fabricated data. Gracefully returns [] if
 * the table doesn't exist yet (pre-migration DB) instead of throwing.
 */
export async function loadVendorExpense(companyId: string, fyId: string): Promise<VendorExpenseRow[]> {
  try {
    const { rows } = await query<VendorExpenseRow>(
      `SELECT v.id, v.vendor_name, v.zoho_vendor_id,
              v.m1,v.m2,v.m3,v.m4,v.m5,v.m6,v.m7,v.m8,v.m9,v.m10,v.m11,v.m12
       FROM tb_vendor_expense v
       WHERE v.upload_id = ${CURRENT_BATCH} AND v.company_id = $1
       ORDER BY v.vendor_name`,
      [companyId, fyId]
    );
    return rows;
  } catch (err) {
    if ((err as Error).message?.includes('does not exist')) return [];
    throw err;
  }
}

export interface CustomerCostRow {
  id: string;
  customer_name: string;
  zoho_customer_id: string | null;
  m1: Num; m2: Num; m3: Num; m4: Num; m5: Num; m6: Num;
  m7: Num; m8: Num; m9: Num; m10: Num; m11: Num; m12: Num;
}

/**
 * Loads real per-customer DIRECT cost for the current upload — populated
 * only from Zoho expenses explicitly marked billable and assigned to a
 * customer (see tb_customer_cost's schema comment: most orgs never use this
 * tagging at all). Empty is a real fact about the org's Zoho usage, not a
 * failure — callers must disclose that honestly, never treat it as zero
 * cost. Gracefully returns [] if the table doesn't exist yet.
 */
export async function loadCustomerCost(companyId: string, fyId: string): Promise<CustomerCostRow[]> {
  try {
    const { rows } = await query<CustomerCostRow>(
      `SELECT c.id, c.customer_name, c.zoho_customer_id,
              c.m1,c.m2,c.m3,c.m4,c.m5,c.m6,c.m7,c.m8,c.m9,c.m10,c.m11,c.m12
       FROM tb_customer_cost c
       WHERE c.upload_id = ${CURRENT_BATCH} AND c.company_id = $1
       ORDER BY c.customer_name`,
      [companyId, fyId]
    );
    return rows;
  } catch (err) {
    if ((err as Error).message?.includes('does not exist')) return [];
    throw err;
  }
}

/** One round trip for everything the report cache key must change with — see lib/cache/report-cache.ts. */
export async function loadReportDataVersion(companyId: string): Promise<ReportDataVersion> {
  const { rows } = await query<ReportDataVersion>(
    `SELECT
       (SELECT string_agg(id::text || '@' || COALESCE(data_changed_at::text, ''), ',' ORDER BY id)
          FROM tb_uploads WHERE company_id = $1 AND is_current = TRUE) AS batches,
       (SELECT string_agg(id::text || ':' || start_date || ':' || end_date || ':' || label || ':' || is_locked, ',' ORDER BY start_date)
          FROM financial_years WHERE company_id = $1) AS years,
       (SELECT updated_at::text FROM companies WHERE id = $1) AS company,
       (SELECT COALESCE(max(updated_at)::text, '') || '#' || count(*)
          FROM custom_metric_definitions WHERE company_id = $1) AS metrics,
       (SELECT max(synced_at)::text FROM zoho_contacts WHERE company_id = $1) AS contacts`,
    [companyId]
  );
  return rows[0];
}

/** Source currency of the year's current batch (null when the batch predates the column). */
export async function loadBatchCurrency(companyId: string, fyId: string): Promise<string | null> {
  const { rows } = await query<{ currency: string | null }>(
    `SELECT currency FROM tb_uploads WHERE company_id = $1 AND financial_year_id = $2 AND is_current = TRUE`,
    [companyId, fyId]
  );
  return rows[0]?.currency ?? null;
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

/**
 * The ledgers a report for (fy, period) is computed from, plus the prior
 * year's ledgers for comparatives — the SAME selection /api/v1/reports/all
 * makes (FY mode: this FY + the previous FY; CY mode: Jan–Mar from one FY
 * merged with Apr–Dec from the next, no comparative). Used by the
 * custom-metric preview endpoint so a draft ledger metric previews against
 * exactly the ledgers the saved metric will later be computed from.
 */
export async function loadPeriodLedgers(
  companyId: string, fy: FinancialYearRow, params: PeriodParams,
): Promise<{ ledgers: TbLedgerRow[]; prevLedgers: TbLedgerRow[] | null }> {
  const ledgers = await loadLedgers(companyId, fy.id);
  if (params.yearType === 'CY') {
    const [nextFy, prevFy] = await Promise.all([getNextFY(companyId, fy), getPreviousFY(companyId, fy)]);
    if (nextFy) return { ledgers: mergeCyLedgers(ledgers, await loadLedgers(companyId, nextFy.id)), prevLedgers: null };
    if (prevFy) return { ledgers: mergeCyLedgers(await loadLedgers(companyId, prevFy.id), ledgers), prevLedgers: null };
    return { ledgers: mergeCyLedgers(ledgers, []), prevLedgers: null };
  }
  const prevFy = await getPreviousFY(companyId, fy);
  const prevLedgers = prevFy ? await loadLedgers(companyId, prevFy.id) : [];
  return { ledgers, prevLedgers: prevLedgers.length ? prevLedgers : null };
}
