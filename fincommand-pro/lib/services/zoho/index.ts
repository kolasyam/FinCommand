/**
 * Zoho Books integration — public entry point (import from '@/lib/services/zoho').
 *   client.ts    connection, encrypted tokens, callZoho()
 *   classify.ts  account → Schedule III classification fallback
 *   assemble.ts  pure report → trial-balance assembly (unit-tested)
 *   sync.ts      syncFromZoho() orchestration
 *   contacts.ts  customer/vendor master data
 *   modules.ts / records-sync.ts / budget.ts / usage.ts
 *                the read-only mirror of Zoho's individual records (import these directly)
 */
export { ZOHO_ACCOUNTS, ZOHO_API, zohoErrorMessage, callZoho, fetchAndStoreZohoOrgCurrency } from './client';
export {
  assembleZohoLedgers, monthEndISO, dayBeforeISO, ZOHO_EARNINGS_BF_NAME, ZOHO_EARNINGS_BF_CODE,
  type ZohoLedgerAcc, type ZohoReportInput, type ZohoReportLeaf,
} from './assemble';
export { syncFromZoho, type SyncResult, type SyncOptions } from './sync';
export { syncZohoContacts, type ZohoContactSyncResult } from './contacts';
