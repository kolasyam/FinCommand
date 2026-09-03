/**
 * Shared helper for report API routes — resolves ledgers for a given FY request.
 * In CY mode (year_type=CY), merges prevFY + nextFY ledgers via mergeCyLedgers().
 * In FY mode, returns the ledgers as-is.
 */
import { getFY, getNextFY, loadLedgers } from '@/lib/db/queries/reports';
import { mergeCyLedgers } from '@/lib/financial/cy-merge';
import type { TbLedgerRow } from '@/lib/financial/tb-engine';
import type { FinancialYearRow } from '@/lib/db/queries/reports';
import { json } from '@/lib/utils/api-handler';

export interface ResolvedLedgers {
  fy: FinancialYearRow;
  ledgers: TbLedgerRow[];
  cyNextFy: FinancialYearRow | null;
}

/**
 * Load and (for CY mode) merge ledgers.
 * Returns null + a JSON error response if data is missing — caller should return that response.
 */
export async function resolveReportLedgers(
  companyId: string,
  fyId: string,
  yearType: string,
): Promise<{ data: ResolvedLedgers } | { error: Response }> {
  const fy = await getFY(companyId, fyId);
  if (!fy) return { error: json({ error: 'Financial year not found' }, { status: 404 }) };

  const ledgers = await loadLedgers(companyId, fyId);
  if (!ledgers.length) return { error: json({ error: 'No Trial Balance data found.' }, { status: 404 }) };

  if (yearType !== 'CY') {
    return { data: { fy, ledgers, cyNextFy: null } };
  }

  // CY mode: stitch Jan–Mar from prevFY (ledgers) + Apr–Dec from nextFY
  const nextFy = await getNextFY(companyId, fy);
  const nextFyLedgers = nextFy ? await loadLedgers(companyId, nextFy.id) : [];
  const merged = mergeCyLedgers(ledgers, nextFyLedgers);

  return { data: { fy, ledgers: merged, cyNextFy: nextFy ?? null } };
}
