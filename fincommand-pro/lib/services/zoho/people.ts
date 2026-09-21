/**
 * Pure: the customer / vendor / expense figures a Zoho sync derives from
 * Zoho's responses. No DB, no network — unit-tested, and replayable against
 * the raw responses stored with a batch.
 */

/** One person's (customer's or vendor's) 12 monthly amounts, April first. */
export interface PersonMonthly { id?: string; name: string; m: number[] }

/**
 * FY month index 0–11 (April = 0) of a date, relative to the year's start
 * date; -1 when the date is missing, unparseable or outside the year.
 */
export function getFyMonthIndex(dateStr: string | null | undefined, fyStartDate: string): number {
  if (!dateStr) return -1;
  const d = new Date(dateStr);
  const fyStart = new Date(fyStartDate);
  if (isNaN(d.getTime()) || isNaN(fyStart.getTime())) return -1;
  const yearDiff = d.getUTCFullYear() - fyStart.getUTCFullYear();
  const monthDiff = d.getUTCMonth() - fyStart.getUTCMonth();
  const idx = yearDiff * 12 + monthDiff;
  if (idx < 0 || idx >= 12) return -1;
  return idx;
}

// ── Sales by Customer ─────────────────────────────────────────────────────

export interface ZohoCustomerLeaf { customer_id?: string; customer_name: string; total: number; currency_code?: string }

/** The customer rows of one /reports/salesbycustomer response, whatever the array is called. */
export function extractSalesByCustomer(rawResponse: unknown): ZohoCustomerLeaf[] {
  const data = rawResponse as Record<string, unknown> | null;
  if (!data) return [];
  const candidates = [
    data.sales, data.sales_by_customers, data.salesbycustomer, data.sales_by_customer, data.customers, data.customer_summary,
  ];
  const arr = candidates.find(c => Array.isArray(c)) as Record<string, unknown>[] | undefined;
  if (!arr) return [];
  return arr
    .map((item) => {
      const name = String(item.customer_name ?? item.contact_name ?? item.name ?? '').trim();
      const idRaw = item.customer_id ?? item.contact_id ?? item.entity_id;
      const totalRaw = item.sales ?? item.total ?? item.invoiced_amount ?? item.sales_with_tax ?? item.amount ?? 0;
      const currency = item.currency_code ?? item.currency ?? undefined;
      return {
        customer_id: idRaw != null ? String(idRaw) : undefined,
        customer_name: name,
        total: parseFloat(String(totalRaw)) || 0,
        currency_code: currency != null ? String(currency).toUpperCase() : undefined,
      };
    })
    .filter((c) => c.customer_name);
}

export interface CustomerAggregate {
  rows: Map<string, PersonMonthly>;
  /** Monthly reports that failed to load. */
  fetchErrors: number;
  /** "Name (USD)" for every customer whose own currency is not the base currency — informational only. */
  otherCurrency: string[];
}

/**
 * Per-customer monthly sales from the 12 monthly reports.
 *
 * Every row counts, whatever the customer's own currency. Zoho's Sales by
 * Customer report gives each amount ALREADY in the organisation's base
 * currency — `currency_code` only says what currency that customer is
 * invoiced in. (Proved on Real Variable's real data: each USD invoice's
 * total × its exchange rate — 100,000 × 84.2, 50,000 × 85.5439, … — equals
 * the report's figure for that month to the rupee, 10 invoices out of 10;
 * and all customers together add up to 96–98% of the P&L's rupee income.)
 * This used to skip every row whose currency differed from the base
 * currency, which dropped the company's largest customer — a USD customer
 * that was 83–94% of customer sales — from Top Customers and Customer Margin.
 */
export function aggregateSalesByCustomer(
  results: { key: number; error: string | null; rawResponse?: unknown }[],
  baseCurrency: string,
): CustomerAggregate {
  const rows = new Map<string, PersonMonthly>();
  const otherCurrency = new Set<string>();
  let fetchErrors = 0;
  for (const res of results) {
    if (res.error) { fetchErrors++; continue; }
    for (const leaf of extractSalesByCustomer(res.rawResponse)) {
      if (leaf.currency_code && leaf.currency_code !== baseCurrency.toUpperCase()) otherCurrency.add(`${leaf.customer_name} (${leaf.currency_code})`);
      let entry = rows.get(leaf.customer_name);
      if (!entry) { entry = { id: leaf.customer_id, name: leaf.customer_name, m: Array(12).fill(0) }; rows.set(leaf.customer_name, entry); }
      entry.m[res.key] += leaf.total;
      if (leaf.customer_id && !entry.id) entry.id = leaf.customer_id;
    }
  }
  return { rows, fetchErrors, otherCurrency: [...otherCurrency] };
}

// ── Vendor bills ──────────────────────────────────────────────────────────

export interface VendorAggregate {
  rows: Map<string, PersonMonthly>;
  /** Foreign-currency bills counted through Zoho's own base-currency amount (bcy_total). */
  convertedForeign: number;
  /** Foreign-currency bills with no base-currency amount, left out rather than guessed. */
  skippedForeign: number;
  skippedNames: string[];
  /** Bills Zoho returned, before any were left out. */
  billsSeen: number;
}

/**
 * Per-vendor monthly spend from the year's bills. A foreign-currency bill is
 * counted through Zoho's own base-currency figure (`bcy_total`) when it has
 * one; without it, it is left out and counted — never converted with a
 * guessed rate. Base-currency bills use `total`, as before.
 */
export function aggregateVendorBills(bills: Record<string, unknown>[], fyStartDate: string, baseCurrency: string): VendorAggregate {
  const rows = new Map<string, PersonMonthly>();
  const skippedNames = new Set<string>();
  let convertedForeign = 0, skippedForeign = 0;
  const base = baseCurrency.toUpperCase();
  for (const item of bills) {
    const vendorName = String(item.vendor_name ?? '').trim();
    if (!vendorName) continue;
    const vendorId = item.vendor_id != null ? String(item.vendor_id) : undefined;
    const currency = item.currency_code != null ? String(item.currency_code).toUpperCase() : undefined;
    let amount: number;
    if (currency && currency !== base) {
      const bcy = item.bcy_total != null ? parseFloat(String(item.bcy_total)) : NaN;
      if (!Number.isFinite(bcy)) { skippedForeign++; skippedNames.add(`${vendorName} (${currency})`); continue; }
      amount = bcy;
      convertedForeign++;
    } else {
      amount = parseFloat(String(item.total ?? 0)) || 0;
    }
    const mi = getFyMonthIndex(String(item.date ?? item.bill_date ?? ''), fyStartDate);
    if (mi < 0 || mi >= 12) continue;
    let entry = rows.get(vendorName);
    if (!entry) { entry = { id: vendorId, name: vendorName, m: Array(12).fill(0) }; rows.set(vendorName, entry); }
    entry.m[mi] += amount;
    if (vendorId && !entry.id) entry.id = vendorId;
  }
  return { rows, convertedForeign, skippedForeign, skippedNames: [...skippedNames], billsSeen: bills.length };
}

// ── Customer-tagged direct cost ───────────────────────────────────────────

/** Per-customer monthly direct cost from expenses explicitly tagged to a customer (base-currency amount). */
export function aggregateCustomerCost(expenses: Record<string, unknown>[], fyStartDate: string): Map<string, PersonMonthly> {
  const rows = new Map<string, PersonMonthly>();
  for (const item of expenses) {
    if (item.customer_id == null || String(item.customer_id).trim() === '') continue;
    const customerId = String(item.customer_id);
    const name = String(item.customer_name ?? '').trim();
    if (!name) continue;
    const total = parseFloat(String(item.bcy_total ?? item.total ?? 0)) || 0;
    const mi = getFyMonthIndex(String(item.date ?? item.expense_date ?? ''), fyStartDate);
    if (mi < 0 || mi >= 12) continue;
    let entry = rows.get(name);
    if (!entry) { entry = { id: customerId, name, m: Array(12).fill(0) }; rows.set(name, entry); }
    entry.m[mi] += total;
    if (customerId && !entry.id) entry.id = customerId;
  }
  return rows;
}

// ── Paging ────────────────────────────────────────────────────────────────

/**
 * Reads every page of a paged Zoho list. `truncated` is true only if the cap
 * was hit while Zoho still said there was more — never silently.
 */
export async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<{ items: T[]; hasMore: boolean }>,
  maxPages = 50,
): Promise<{ items: T[]; truncated: boolean }> {
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { items, hasMore } = await fetchPage(page);
    all.push(...items);
    if (!hasMore) return { items: all, truncated: false };
  }
  return { items: all, truncated: true };
}

// ── What to tell the person who ran the sync ──────────────────────────────

export interface SyncNoteInput {
  coaTruncated: boolean;
  coaError: string | null;
  customers: { fetchErrors: number; totalMonths: number; count: number };
  bills: { error: string | null; agg: VendorAggregate };
  expensesError: string | null;
}

/**
 * Plain-language notes about anything non-fatal that limits what this sync
 * brought in. A successful sync used to say nothing when, for example, the
 * bills could not be fetched — the Vendor Expense report simply came out
 * empty with no trace of why. Empty list = nothing to report.
 */
export function buildSyncNotes(i: SyncNoteInput): string[] {
  const notes: string[] = [];
  if (i.coaError) notes.push(`Chart of accounts could not be read (${i.coaError}); ledgers were classified from the report layout instead.`);
  if (i.coaTruncated) notes.push('Chart of accounts has more pages than the sync reads; some accounts were classified from the report layout instead.');
  if (i.customers.fetchErrors > 0) notes.push(`Sales by Customer: ${i.customers.fetchErrors} of ${i.customers.totalMonths} monthly reports failed, so customer revenue is incomplete.`);
  else if (i.customers.count === 0) notes.push('Sales by Customer returned no customers for this year.');
  if (i.bills.error) notes.push(`Vendor bills could not be fetched (${i.bills.error}); the Vendor Expense report is empty for this sync.`);
  else {
    if (i.bills.agg.skippedForeign > 0) notes.push(`${i.bills.agg.skippedForeign} foreign-currency vendor bill(s) had no base-currency amount and were left out (${i.bills.agg.skippedNames.slice(0, 5).join(', ')}${i.bills.agg.skippedNames.length > 5 ? ', …' : ''}).`);
    if (i.bills.agg.billsSeen === 0) notes.push('Zoho returned no vendor bills for this year.');
  }
  if (i.expensesError) notes.push(`Expenses could not be fetched (${i.expensesError}); customer direct cost is unavailable for this sync.`);
  return notes;
}
