import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which company the current request is for, carried through every await without
 * being passed around. lib/db/neon.ts reads it: with a company (and the restricted
 * database login configured) each query runs inside a transaction that first says
 * "this is company X", and the database's row-level security (migration 0008) then
 * shows and accepts only that company's rows. With no company (login, signup, token
 * refresh, cron) queries use the system connection.
 *
 * The company always comes from a SIGNATURE-VERIFIED token or from server code that
 * already chose it - never from a request body.
 */
interface TenantContext { companyId: string }

const storage = new AsyncLocalStorage<TenantContext | null>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id in canonical lower-case form; throws for anything that is not a UUID (it is placed into SQL text). */
export function assertCompanyId(id: string): string {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Invalid company id for a database request');
  return id.toLowerCase();
}

export function isCompanyId(id: unknown): id is string {
  return typeof id === 'string' && UUID.test(id);
}

/** The company the current work runs for, or null (system work). */
export function currentCompanyId(): string | null {
  return storage.getStore()?.companyId ?? null;
}

/** Runs `fn` (and everything it awaits) as this company. */
export function runAsCompany<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ companyId: assertCompanyId(companyId) }, fn);
}

/** Runs `fn` on the system connection even when called from inside a company's request. */
export function runAsSystem<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run(null, fn);
}
