import type { NormalizedLedger } from '@/lib/ingestion/trial-balance';
import type { ZohoLedgerAcc } from './assemble';
import { classifyZohoLedger, sanitizeSection, sanitizeTreasuryType } from './classify';

/** A ledger_master mapping row (company or global). */
export interface LedgerMasterMapping {
  ledger_code: string | null;
  ledger_name: string;
  note_no: number;
  note_name: string;
  section: string;
  treasury_type: string | null;
  normal_bal: string;
}

/** What Zoho's chart of accounts says about an account, keyed by lowercased name. */
export interface ChartOfAccountsInfo { account_type: string; account_code?: string }

/**
 * Pure: Zoho ledgers → mapped NormalizedLedger rows for the ingestion pipeline.
 *
 * Lookup order per ledger: ledger_master by name → by code → by name with
 * punctuation stripped; failing all three, the Zoho classifier (account type,
 * chart-of-accounts type, keywords) — and that auto-classification is returned
 * in `autoMappings` so the sync remembers it for next time. `lmRows` must be
 * ordered global rows first, company rows last: later rows win, so a
 * company's own mapping (e.g. a reclassification) beats the global default.
 */
export function mapZohoLedgers(
  ledgerMap: Record<string, ZohoLedgerAcc>,
  lmRows: LedgerMasterMapping[],
  coaMap: Map<string, ChartOfAccountsInfo>,
): { ledgers: NormalizedLedger[]; mapped: number; autoMappings: LedgerMasterMapping[] } {
  const lmByName = new Map(lmRows.map(r => [r.ledger_name.toLowerCase().trim(), r]));
  const lmByCode = new Map(lmRows.filter(r => r.ledger_code).map(r => [r.ledger_code!.trim(), r]));
  const normalizeStr = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const lmByNorm = new Map(lmRows.map(r => [normalizeStr(r.ledger_name), r]));

  let mapped = 0;
  const autoMappings: LedgerMasterMapping[] = [];

  const ledgers: NormalizedLedger[] = Object.values(ledgerMap).map((row) => {
    const nameKey = row.name.toLowerCase().trim();
    const codeKey = row.code.trim();
    const normKey = normalizeStr(row.name);

    let lm = lmByName.get(nameKey) || (codeKey ? lmByCode.get(codeKey) : undefined) || lmByNorm.get(normKey);
    if (!lm) {
      const coaInfo = coaMap.get(nameKey);
      const fallback = classifyZohoLedger(nameKey, row.zoho_account_type || coaInfo?.account_type || '');
      if (fallback) {
        lm = {
          ledger_code: row.code || coaInfo?.account_code || null,
          ledger_name: row.name,
          note_no: fallback.note_no,
          note_name: fallback.note_name,
          section: fallback.section,
          treasury_type: fallback.treasury_type || null,
          normal_bal: fallback.normal_bal,
        };
        autoMappings.push(lm);
      }
    }
    if (lm && lm.note_no && lm.section) mapped++;

    return {
      // The stable account (Zoho account id, else code) is assigned by the
      // database on insert — see ledger_account_key(), migration 0005.
      code: row.code,
      name: row.name,
      note_no: lm?.note_no || null,
      note_name: lm?.note_name || null,
      section: sanitizeSection(lm?.section),
      treasury_type: sanitizeTreasuryType(lm?.treasury_type),
      normal_bal: lm?.normal_bal || 'Dr',
      op_dr: row.op_dr,
      op_cr: row.op_cr,
      months: row.m,
      zoho_account_id: row.zoho_account_id || null,
      zoho_account_type: row.zoho_account_type || null,
      depth: row.depth ?? 0,
      is_child_present: row.is_child_present ?? false,
    };
  });

  return { ledgers, mapped, autoMappings };
}
