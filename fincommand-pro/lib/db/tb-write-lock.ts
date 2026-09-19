/**
 * Advisory-lock key that serialises every write to one company + year's
 * trial balance (lockTrialBalanceWrite in lib/db/queries/tb-batches.ts).
 * No DB imports, so the maintenance scripts in db/scripts can take the very
 * same lock against whichever database they target.
 */
export const tbWriteLockKey = (companyId: string, fyId: string): string => `tb:${companyId}:${fyId}`;
