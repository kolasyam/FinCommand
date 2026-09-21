const mockGeneric = jest.fn(async () => ({ received: 1, created: 1, updated: 0, unchanged: 0, skipped: 0 }));
const mockBank = jest.fn(async () => ({ received: 1, created: 1, updated: 0, unchanged: 0, skipped: 0 }));
jest.mock('@/lib/db/neon', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('@/lib/ingestion/zoho-records', () => ({ upsertListPage: (...a: unknown[]) => mockGeneric(...(a as [])), writeDetail: jest.fn(), saveSnapshot: jest.fn() }));
jest.mock('@/lib/ingestion/zoho-bank-transactions', () => ({ upsertBankTransactionsPage: (...a: unknown[]) => mockBank(...(a as [])) }));

import { pgStore } from '@/lib/services/zoho/records-sync';
import { getModule } from '@/lib/services/zoho/modules';

const ctx = { baseCurrency: 'INR' };
beforeEach(() => { mockGeneric.mockClear(); mockBank.mockClear(); });

describe('which table a page of records is written to', () => {
  test('a bank-transaction page goes to the bank table writer, with its account', async () => {
    const input = { companyId: 'co1', def: getModule('banktransactions')!, rows: [{ transaction_id: 't1' }], ctx, parentId: 'a1' };
    await pgStore.upsertPage(input);
    expect(mockBank).toHaveBeenCalledWith(input);
    expect(mockGeneric).not.toHaveBeenCalled();
  });

  test('every other module goes to the generic writer', async () => {
    for (const key of ['bills', 'invoices', 'bankaccounts', 'chartofaccounts', 'journals']) {
      await pgStore.upsertPage({ companyId: 'co1', def: getModule(key)!, rows: [], ctx });
    }
    expect(mockGeneric).toHaveBeenCalledTimes(5);
    expect(mockBank).not.toHaveBeenCalled();
  });
});
