import { dateOnly, num, str } from './modules';

/**
 * Pure: one Zoho bank-transaction list row as the typed columns of zoho_bank_transactions
 * (migration 0009). Everything Zoho returned is kept as JSON next to them.
 *
 * A Zoho transaction id is unique only within its bank account (a transfer shows on both
 * accounts under one id), so a transaction is identified by (account, id).
 */
export const BANK_TXN_MODULE = 'banktransactions';

type Obj = Record<string, unknown>;

export interface BankTransaction {
  accountId: string;
  txnId: string;
  accountName: string | null;
  txnDate: string | null;
  amount: number | null;
  debitOrCredit: 'debit' | 'credit' | null;
  transactionType: string | null;
  status: string | null;
  payee: string | null;
  customerId: string | null;
  referenceNumber: string | null;
  description: string | null;
  offsetAccountName: string | null;
  currencyCode: string | null;
  runningBalance: number | null;
}

/** The id the API and the history table have always used for a bank transaction: "<account>:<transaction>". */
export const bankTxnRecordId = (accountId: string, txnId: string): string => `${accountId}:${txnId}`;

/** Splits "<account>:<transaction>" (Zoho ids are digits, never containing a colon); null when it is not one. */
export function parseBankTxnRecordId(id: string): { accountId: string; txnId: string } | null {
  const i = id.indexOf(':');
  if (i <= 0 || i === id.length - 1) return null;
  return { accountId: id.slice(0, i), txnId: id.slice(i + 1) };
}

/**
 * `queriedAccountId` is the bank account the page was listed for: it wins over what the row itself says.
 * Null when the row has no transaction id, or no account can be determined.
 */
export function extractBankTransaction(row: Obj, queriedAccountId?: string | null): BankTransaction | null {
  const txnId = str(row.transaction_id);
  const accountId = queriedAccountId ?? str(row.account_id);
  if (!txnId || !accountId) return null;
  const dc = str(row.debit_or_credit)?.toLowerCase();
  return {
    accountId, txnId,
    accountName: str(row.account_name),
    txnDate: dateOnly(row.date),
    amount: num(row.amount),
    debitOrCredit: dc === 'debit' || dc === 'credit' ? dc : null,
    transactionType: str(row.transaction_type),
    status: str(row.status),
    payee: str(row.payee),
    customerId: str(row.customer_id),
    referenceNumber: str(row.reference_number),
    description: str(row.description),
    offsetAccountName: str(row.offset_account_name),
    currencyCode: str(row.currency_code)?.toUpperCase() ?? null,
    runningBalance: num(row.running_balance),
  };
}
