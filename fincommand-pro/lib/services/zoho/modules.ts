/**
 * Pure: which Zoho Books modules are mirrored, how to read each one, and how a
 * Zoho record becomes a typed row. No DB, no network - unit-tested.
 *
 * Adding a module = adding an entry to ZOHO_MODULES. Everything Zoho returns is
 * kept as JSON; the typed fields below are only what queries filter on.
 */

export type DetailMode = 'lines' | 'optional' | 'none';
export type LineKind = 'item' | 'journal' | 'applied';

export interface FieldMap {
  id: string;
  /** A name for master records (an account, item, tax, location ...) that have no document number. */
  title?: string[];
  /** The record this one belongs to (the bank account of a bank transaction). */
  parent?: string[];
  number?: string[]; date?: string[]; due?: string[]; status?: string[];
  contactId?: string[]; contactName?: string[];
  currency?: string[]; rate?: string[];
  amount?: string[]; base?: string[]; balance?: string[];
  sub?: string[]; tax?: string[];
  gstTreatment?: string[]; gstNo?: string[]; placeOfSupply?: string[];
  modified?: string[];
  /** Tax = total - total-without-tax when Zoho gives no tax figure (expenses only: exact there). */
  deriveTax?: boolean;
}

export interface LineSpec {
  key: string;
  kind: LineKind;
  /** applied: which fields name the document a payment was applied to. */
  refIdKey?: string; refNumberKey?: string; amountKeys?: string[];
}

export interface ModuleDef {
  key: string;
  label: string;
  phase: 'A' | 'B';
  path: string;
  listKey: string;
  detailKey?: string;
  detail: DetailMode;
  incremental: boolean;
  /** One list read per parent record (e.g. bank transactions per bank account). */
  fanOut?: { parentModule: string; param: string };
  fields: FieldMap;
  lines?: LineSpec[];
}

/** A Zoho report kept as a dated snapshot (Zoho's own totals, for reconciliation). */
export interface ReportDef {
  key: string;
  label: string;
  path: string;
  /** 'fy': from the year's start to its end (or today); 'asof': as at that date. */
  period: 'fy' | 'asof';
}

// Not kept: trialbalance (Zoho's endpoint ignores its dates for this integration - see the statement sync) and
// generalledger (account totals only, no transactions).
export const ZOHO_REPORTS: ReportDef[] = [
  { key: 'taxsummary', label: 'Tax summary (GST)', path: '/reports/taxsummary', period: 'fy' },
  { key: 'salesbyitem', label: 'Sales by item', path: '/reports/salesbyitem', period: 'fy' },
  { key: 'cashflow', label: 'Cash flow', path: '/reports/cashflow', period: 'fy' },
  { key: 'aragingsummary', label: 'Receivables ageing', path: '/reports/aragingsummary', period: 'asof' },
  { key: 'apagingsummary', label: 'Payables ageing', path: '/reports/apagingsummary', period: 'asof' },
];

const DOC_FIELDS = {
  currency: ['currency_code'], rate: ['exchange_rate'], modified: ['last_modified_time'],
  sub: ['sub_total'], tax: ['tax_total'],
  gstTreatment: ['gst_treatment'], gstNo: ['gst_no'], placeOfSupply: ['place_of_supply', 'source_of_supply'],
};
const ITEM_LINES: LineSpec[] = [{ key: 'line_items', kind: 'item' }];

export const ZOHO_MODULES: ModuleDef[] = [
  // ── Sales ──
  { key: 'invoices', label: 'Invoices', phase: 'A', path: '/invoices', listKey: 'invoices', detailKey: 'invoice', detail: 'lines', incremental: true,
    fields: { ...DOC_FIELDS, id: 'invoice_id', number: ['invoice_number'], date: ['date'], due: ['due_date'], status: ['status'], contactId: ['customer_id'], contactName: ['customer_name'], amount: ['total'], base: ['bcy_total'], balance: ['balance'] },
    lines: ITEM_LINES },
  { key: 'creditnotes', label: 'Credit notes', phase: 'A', path: '/creditnotes', listKey: 'creditnotes', detailKey: 'creditnote', detail: 'lines', incremental: true,
    fields: { ...DOC_FIELDS, id: 'creditnote_id', number: ['creditnote_number'], date: ['date'], status: ['status'], contactId: ['customer_id'], contactName: ['customer_name'], amount: ['total'], base: ['bcy_total'], balance: ['balance'] },
    lines: [...ITEM_LINES, { key: 'invoices_credited', kind: 'applied', refIdKey: 'invoice_id', refNumberKey: 'invoice_number', amountKeys: ['credited_amount', 'amount_applied', 'amount'] }] },
  { key: 'salesorders', label: 'Sales orders', phase: 'A', path: '/salesorders', listKey: 'salesorders', detailKey: 'salesorder', detail: 'lines', incremental: true,
    fields: { ...DOC_FIELDS, id: 'salesorder_id', number: ['salesorder_number'], date: ['date'], due: ['shipment_date'], status: ['status'], contactId: ['customer_id'], contactName: ['customer_name'], amount: ['total'], base: ['bcy_total'] },
    lines: ITEM_LINES },
  { key: 'estimates', label: 'Estimates / quotes', phase: 'A', path: '/estimates', listKey: 'estimates', detailKey: 'estimate', detail: 'lines', incremental: true,
    fields: { ...DOC_FIELDS, id: 'estimate_id', number: ['estimate_number'], date: ['date'], due: ['expiry_date'], status: ['status'], contactId: ['customer_id'], contactName: ['customer_name'], amount: ['total'], base: ['bcy_total'] },
    lines: ITEM_LINES },
  { key: 'customerpayments', label: 'Customer payments', phase: 'A', path: '/customerpayments', listKey: 'customerpayments', detailKey: 'payment', detail: 'lines', incremental: true,
    fields: { ...DOC_FIELDS, id: 'payment_id', number: ['payment_number'], date: ['date'], status: ['payment_status', 'status'], contactId: ['customer_id'], contactName: ['customer_name'], amount: ['amount'], base: ['bcy_amount'], balance: ['unused_amount'], sub: [], tax: ['tax_amount_withheld'] },
    lines: [{ key: 'invoices', kind: 'applied', refIdKey: 'invoice_id', refNumberKey: 'invoice_number', amountKeys: ['amount_applied', 'applied_amount'] }] },
  // ── Purchases ──
  { key: 'bills', label: 'Vendor bills', phase: 'A', path: '/bills', listKey: 'bills', detailKey: 'bill', detail: 'lines', incremental: true,
    fields: { ...DOC_FIELDS, id: 'bill_id', number: ['bill_number'], date: ['date'], due: ['due_date'], status: ['status'], contactId: ['vendor_id'], contactName: ['vendor_name'], amount: ['total'], base: ['bcy_total'], balance: ['balance'] },
    lines: ITEM_LINES },
  { key: 'vendorcredits', label: 'Vendor credits', phase: 'A', path: '/vendorcredits', listKey: 'vendor_credits', detailKey: 'vendor_credit', detail: 'lines', incremental: true,
    fields: { ...DOC_FIELDS, id: 'vendor_credit_id', number: ['vendor_credit_number'], date: ['date'], status: ['status'], contactId: ['vendor_id'], contactName: ['vendor_name'], amount: ['total'], base: ['bcy_total'], balance: ['balance'] },
    lines: [...ITEM_LINES, { key: 'bills', kind: 'applied', refIdKey: 'bill_id', refNumberKey: 'bill_number', amountKeys: ['amount_applied', 'credited_amount', 'amount'] }] },
  { key: 'purchaseorders', label: 'Purchase orders', phase: 'A', path: '/purchaseorders', listKey: 'purchaseorders', detailKey: 'purchaseorder', detail: 'lines', incremental: true,
    fields: { ...DOC_FIELDS, id: 'purchaseorder_id', number: ['purchaseorder_number'], date: ['date'], due: ['delivery_date', 'expected_delivery_date'], status: ['status'], contactId: ['vendor_id'], contactName: ['vendor_name'], amount: ['total'], base: ['bcy_total'] },
    lines: ITEM_LINES },
  { key: 'vendorpayments', label: 'Vendor payments', phase: 'A', path: '/vendorpayments', listKey: 'vendorpayments', detailKey: 'payment', detail: 'lines', incremental: true,
    fields: { ...DOC_FIELDS, id: 'payment_id', number: ['payment_number'], date: ['date'], status: ['status'], contactId: ['vendor_id'], contactName: ['vendor_name'], amount: ['amount'], base: ['bcy_amount'], balance: ['balance'], sub: [], tax: ['tax_amount_withheld'] },
    lines: [{ key: 'bills', kind: 'applied', refIdKey: 'bill_id', refNumberKey: 'bill_number', amountKeys: ['amount_applied', 'applied_amount'] }] },
  // ── Books ──
  { key: 'journals', label: 'Manual journals', phase: 'A', path: '/journals', listKey: 'journals', detailKey: 'journal', detail: 'lines', incremental: true,
    fields: { ...DOC_FIELDS, id: 'journal_id', number: ['entry_number'], date: ['journal_date'], status: ['status'], amount: ['total'], base: ['bcy_total'], sub: [], tax: [] },
    lines: [{ key: 'line_items', kind: 'journal' }] },
  // Expenses carry their GST breakdown only in the detail record (2,000+ extra calls for a busy
  // org), so the line-level read is opt-in; the list row already has every amount.
  { key: 'expenses', label: 'Expenses', phase: 'A', path: '/expenses', listKey: 'expenses', detailKey: 'expense', detail: 'optional', incremental: true,
    fields: { ...DOC_FIELDS, id: 'expense_id', number: ['reference_number'], date: ['date'], status: ['status'], contactId: ['vendor_id'], contactName: ['vendor_name'], amount: ['total'], base: ['bcy_total'], sub: ['sub_total', 'total_without_tax'], tax: ['tax_amount', 'tax_total'], deriveTax: true },
    lines: ITEM_LINES },

  // ── Phase B: the chart of accounts, banking, master data and everything else Zoho keeps ──
  // These endpoints have no modified-time filter (measured), so each read is a complete listing; that is also
  // what notices removals. They are small except bank transactions, so scheduled runs read them daily.
  { key: 'chartofaccounts', label: 'Chart of accounts', phase: 'B', path: '/chartofaccounts', listKey: 'chartofaccounts', detail: 'none', incremental: false,
    fields: { id: 'account_id', title: ['account_name'], number: ['account_code'], status: ['is_active'], currency: ['currency_code'], parent: ['parent_account_id'], modified: ['last_modified_time'] } },
  { key: 'bankaccounts', label: 'Bank accounts', phase: 'B', path: '/bankaccounts', listKey: 'bankaccounts', detail: 'none', incremental: false,
    fields: { id: 'account_id', title: ['account_name'], number: ['account_code'], status: ['is_active'], currency: ['currency_code'], amount: ['balance'], balance: ['bank_balance'], base: ['bcy_balance'] } },
  { key: 'banktransactions', label: 'Bank transactions', phase: 'B', path: '/banktransactions', listKey: 'banktransactions', detail: 'none', incremental: false,
    fanOut: { parentModule: 'bankaccounts', param: 'account_id' },
    fields: { id: 'transaction_id', title: ['account_name'], parent: ['account_id'], number: ['reference_number'], date: ['date'], status: ['status'], contactId: ['customer_id'], contactName: ['payee'], currency: ['currency_code'], amount: ['amount'] } },
  { key: 'items', label: 'Items', phase: 'B', path: '/items', listKey: 'items', detail: 'none', incremental: false,
    fields: { id: 'item_id', title: ['name'], number: ['sku'], status: ['status'], amount: ['rate'] } },
  { key: 'taxes', label: 'Taxes', phase: 'B', path: '/settings/taxes', listKey: 'taxes', detail: 'none', incremental: false,
    fields: { id: 'tax_id', title: ['tax_display_name', 'tax_name'], status: ['status'], modified: ['last_modified_time'] } },
  { key: 'taxexemptions', label: 'Tax exemptions', phase: 'B', path: '/settings/taxexemptions', listKey: 'tax_exemptions', detail: 'none', incremental: false,
    fields: { id: 'tax_exemption_id', title: ['exemption_name'], number: ['tax_exemption_code'] } },
  { key: 'currencies', label: 'Currencies', phase: 'B', path: '/settings/currencies', listKey: 'currencies', detail: 'none', incremental: false,
    fields: { id: 'currency_id', title: ['currency_name'], number: ['currency_code'], currency: ['currency_code'], rate: ['exchange_rate'] } },
  { key: 'users', label: 'Users', phase: 'B', path: '/users', listKey: 'users', detail: 'none', incremental: false,
    fields: { id: 'user_id', title: ['name'], number: ['user_role'], status: ['status'] } },
  { key: 'locations', label: 'Locations / branches', phase: 'B', path: '/locations', listKey: 'locations', detail: 'none', incremental: false,
    fields: { id: 'location_id', title: ['location_name'], status: ['is_location_active'] } },
  { key: 'tags', label: 'Reporting tags', phase: 'B', path: '/settings/tags', listKey: 'reporting_tags', detail: 'none', incremental: false,
    fields: { id: 'tag_id', title: ['tag_name'], status: ['status'] } },
  { key: 'fixedassets', label: 'Fixed assets', phase: 'B', path: '/fixedassets', listKey: 'fixedassets', detailKey: 'fixed_asset', detail: 'lines', incremental: false,
    fields: { id: 'fixed_asset_id', title: ['asset_name'], number: ['asset_number'], date: ['asset_purchase_date', 'purchase_date'], status: ['status'], amount: ['asset_cost', 'cost'], currency: ['currency_code'], modified: ['last_modified_time'] } },
  { key: 'projects', label: 'Projects', phase: 'B', path: '/projects', listKey: 'projects', detail: 'none', incremental: false,
    fields: { id: 'project_id', title: ['project_name'], status: ['status'], contactId: ['customer_id'], contactName: ['customer_name'], modified: ['last_modified_time'] } },
  { key: 'retainerinvoices', label: 'Retainer invoices', phase: 'B', path: '/retainerinvoices', listKey: 'retainerinvoices', detailKey: 'retainerinvoice', detail: 'lines', incremental: true,
    fields: { ...DOC_FIELDS, id: 'retainerinvoice_id', number: ['retainerinvoice_number'], date: ['date'], due: ['due_date'], status: ['status'], contactId: ['customer_id'], contactName: ['customer_name'], amount: ['total'], base: ['bcy_total'], balance: ['balance'] },
    lines: ITEM_LINES },
  { key: 'deliverychallans', label: 'Delivery challans', phase: 'B', path: '/deliverychallans', listKey: 'deliverychallans', detailKey: 'deliverychallan', detail: 'lines', incremental: true,
    fields: { ...DOC_FIELDS, id: 'deliverychallan_id', number: ['deliverychallan_number'], date: ['date'], status: ['status'], contactId: ['customer_id'], contactName: ['customer_name'], amount: ['total'] },
    lines: ITEM_LINES },
  { key: 'salesreceipts', label: 'Sales receipts', phase: 'B', path: '/salesreceipts', listKey: 'sales_receipts', detailKey: 'sales_receipt', detail: 'lines', incremental: true,
    fields: { ...DOC_FIELDS, id: 'salesreceipt_id', number: ['receipt_number'], date: ['date'], status: ['status'], contactId: ['customer_id'], contactName: ['customer_name'], amount: ['total'], base: ['bcy_total'] },
    lines: ITEM_LINES },
  { key: 'recurringinvoices', label: 'Recurring invoices', phase: 'B', path: '/recurringinvoices', listKey: 'recurring_invoices', detail: 'none', incremental: false,
    fields: { id: 'recurring_invoice_id', title: ['recurrence_name'], status: ['status'], contactId: ['customer_id'], contactName: ['customer_name'], amount: ['total'], currency: ['currency_code'], modified: ['last_modified_time'] } },
  { key: 'recurringbills', label: 'Recurring bills', phase: 'B', path: '/recurringbills', listKey: 'recurring_bills', detail: 'none', incremental: false,
    fields: { id: 'recurring_bill_id', title: ['recurrence_name'], status: ['status'], contactId: ['vendor_id'], contactName: ['vendor_name'], amount: ['total'], currency: ['currency_code'], modified: ['last_modified_time'] } },
  { key: 'recurringexpenses', label: 'Recurring expenses', phase: 'B', path: '/recurringexpenses', listKey: 'recurring_expenses', detail: 'none', incremental: false,
    fields: { id: 'recurring_expense_id', title: ['recurrence_name'], status: ['status'], contactId: ['vendor_id'], contactName: ['vendor_name'], amount: ['total'], currency: ['currency_code'], modified: ['last_modified_time'] } },
  { key: 'budgets', label: 'Budgets', phase: 'B', path: '/budgets', listKey: 'budgets', detail: 'none', incremental: false,
    fields: { id: 'budget_id', title: ['name', 'budget_name'], status: ['status'] } },
];

export function getModule(key: string): ModuleDef | undefined {
  return ZOHO_MODULES.find((m) => m.key === key);
}

export function modulesForPhases(phases: Array<'A' | 'B'>): ModuleDef[] {
  return ZOHO_MODULES.filter((m) => phases.includes(m.phase));
}

/** Whether a module's detail records are read when nothing says otherwise. */
export function detailDefault(def: ModuleDef): boolean {
  return def.detail === 'lines';
}

// ── Value helpers ─────────────────────────────────────────────────────────

export function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** 'YYYY-MM-DD' when the value starts with a real calendar date, else null. */
export function dateOnly(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Zoho timestamps look like 2026-09-01T10:15:30+0530; returns ISO UTC, or null. */
export function parseZohoTimestamp(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  let fixed = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  if (!/(?:[zZ]|[+-]\d{2}:\d{2})$/.test(fixed)) fixed += 'Z';
  const t = Date.parse(fixed);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** The format Zoho's last_modified_time filter takes: 2026-09-20T00:00:00+0000. */
export function formatZohoModifiedTime(at: Date | string): string {
  const d = at instanceof Date ? at : new Date(at);
  return `${d.toISOString().slice(0, 19)}+0000`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

type Obj = Record<string, unknown>;

function pick(sources: Array<Obj | null | undefined>, keys: string[] | undefined): unknown {
  if (!keys) return undefined;
  for (const src of sources) {
    if (!src) continue;
    for (const k of keys) {
      const v = src[k];
      if (v != null && v !== '') return v;
    }
  }
  return undefined;
}

// ── Record extraction ─────────────────────────────────────────────────────

export interface ExtractCtx { baseCurrency: string }

export interface ExtractedRecord {
  zohoId: string;
  title: string | null; parentId: string | null;
  docNumber: string | null; docDate: string | null; dueDate: string | null; status: string | null;
  contactId: string | null; contactName: string | null;
  currencyCode: string | null; exchangeRate: number | null;
  amount: number | null; baseAmount: number | null; balance: number | null;
  subAmount: number | null; taxAmount: number | null;
  gstTreatment: string | null; gstNo: string | null; placeOfSupply: string | null;
  modifiedAt: string | null;
}

/**
 * The typed columns of one Zoho record. Reads the detail record first (a
 * superset of the list row) and falls back to the list row. Null when the row
 * has no id - such a row cannot be stored.
 *
 * base_amount is never estimated: it is Zoho's own base-currency figure, or the
 * document's own amount when the document is in the base currency.
 */
export function extractRecord(def: ModuleDef, row: Obj, ctx: ExtractCtx, detail?: Obj | null, queriedParent?: string | null): ExtractedRecord | null {
  const f = def.fields;
  const src = [detail, row];
  const rawId = str(row[f.id] ?? detail?.[f.id]);
  if (!rawId) return null;

  // A fan-out record is listed once per parent, and the SAME id can appear under several parents (a transfer
  // between two bank accounts is one transaction id on both sides, with different balances). The record is
  // therefore identified by parent AND id; keyed by id alone, each parent overwrote the previous one's row.
  let zohoId = rawId;
  let parentId = str(pick(src, f.parent));
  if (def.fanOut) {
    parentId = queriedParent ?? parentId;
    if (!parentId) return null;
    zohoId = `${parentId}:${rawId}`;
  }

  const currencyCode = str(pick(src, f.currency))?.toUpperCase() ?? null;
  const amount = num(pick(src, f.amount));
  let baseAmount = num(pick(src, f.base));
  if (baseAmount == null && amount != null && currencyCode && currencyCode === ctx.baseCurrency.toUpperCase()) baseAmount = amount;

  const subAmount = num(pick(src, f.sub));
  let taxAmount = num(pick(src, f.tax));
  if (taxAmount == null && f.deriveTax && amount != null && subAmount != null) taxAmount = round2(amount - subAmount);

  const statusRaw = pick(src, f.status);
  return {
    zohoId,
    title: str(pick(src, f.title)),
    parentId,
    docNumber: str(pick(src, f.number)),
    docDate: dateOnly(pick(src, f.date)),
    dueDate: dateOnly(pick(src, f.due)),
    // Masters flag "active" as a boolean; a document has a status word.
    status: typeof statusRaw === 'boolean' ? (statusRaw ? 'active' : 'inactive') : str(statusRaw),
    contactId: str(pick(src, f.contactId)),
    contactName: str(pick(src, f.contactName)),
    currencyCode,
    exchangeRate: num(pick(src, f.rate)),
    amount, baseAmount, balance: num(pick(src, f.balance)),
    subAmount, taxAmount,
    gstTreatment: str(pick(src, f.gstTreatment)),
    gstNo: str(pick(src, f.gstNo)),
    placeOfSupply: str(pick(src, f.placeOfSupply)),
    modifiedAt: parseZohoTimestamp(pick(src, f.modified)),
  };
}

// ── Line extraction ───────────────────────────────────────────────────────

export interface LineRow {
  lineNo: number; kind: LineKind;
  accountId: string | null; accountName: string | null; accountCode: string | null;
  itemId: string | null; itemName: string | null; description: string | null;
  quantity: number | null; rate: number | null; amount: number | null; baseAmount: number | null;
  debitOrCredit: 'debit' | 'credit' | null;
  taxId: string | null; taxName: string | null; taxPercentage: number | null; taxAmount: number | null;
  hsnOrSac: string | null; gstTreatmentCode: string | null; itcEligibility: string | null;
  refId: string | null; refNumber: string | null;
  taxes: unknown[] | null;
}

function emptyLine(lineNo: number, kind: LineKind): LineRow {
  return {
    lineNo, kind, accountId: null, accountName: null, accountCode: null, itemId: null, itemName: null, description: null,
    quantity: null, rate: null, amount: null, baseAmount: null, debitOrCredit: null,
    taxId: null, taxName: null, taxPercentage: null, taxAmount: null, hsnOrSac: null, gstTreatmentCode: null, itcEligibility: null,
    refId: null, refNumber: null, taxes: null,
  };
}

/** Line-level tax: the sum of the line's own tax entries, else its plain tax_amount. */
function lineTax(line: Obj): { taxAmount: number | null; taxes: unknown[] | null } {
  const entries = Array.isArray(line.line_item_taxes) ? (line.line_item_taxes as Obj[]) : [];
  if (entries.length) {
    let sum = 0; let any = false;
    for (const t of entries) { const a = num(t.tax_amount); if (a != null) { sum += a; any = true; } }
    return { taxAmount: any ? round2(sum) : null, taxes: entries };
  }
  return { taxAmount: num(line.tax_amount), taxes: null };
}

/**
 * Line items, journal legs and applied documents of a detail record - the rows
 * GST and drill-downs query. Empty when the record has no detail.
 */
export function extractLines(def: ModuleDef, detail: Obj | null | undefined): LineRow[] {
  if (!detail || !def.lines) return [];
  const out: LineRow[] = [];
  for (const spec of def.lines) {
    const arr = detail[spec.key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr as Obj[]) {
      if (!item || typeof item !== 'object') continue;
      const line = emptyLine(out.length + 1, spec.kind);
      if (spec.kind === 'applied') {
        line.refId = str(item[spec.refIdKey ?? 'invoice_id']);
        line.refNumber = str(item[spec.refNumberKey ?? 'invoice_number']);
        line.amount = num(pick([item], spec.amountKeys ?? ['amount_applied', 'amount']));
        line.taxAmount = num(item.tax_amount_withheld);
      } else {
        const tax = lineTax(item);
        line.accountId = str(item.account_id);
        line.accountName = str(item.account_name);
        line.accountCode = str(item.account_code);
        line.description = str(item.description);
        line.taxId = str(item.tax_id);
        line.taxName = str(item.tax_name);
        line.taxPercentage = num(item.tax_percentage);
        line.taxAmount = tax.taxAmount;
        line.taxes = tax.taxes;
        line.hsnOrSac = str(item.hsn_or_sac);
        line.gstTreatmentCode = str(item.gst_treatment_code);
        if (spec.kind === 'journal') {
          line.amount = num(item.amount);
          line.baseAmount = num(item.bcy_amount);
          const dc = str(item.debit_or_credit)?.toLowerCase();
          line.debitOrCredit = dc === 'debit' || dc === 'credit' ? dc : null;
          line.refId = str(item.customer_id);
          line.refNumber = str(item.customer_name);
        } else {
          line.itemId = str(item.item_id);
          line.itemName = str(item.name ?? item.item_name);
          line.quantity = num(item.quantity);
          line.rate = num(item.rate);
          line.amount = num(item.item_total ?? item.amount);
          line.itcEligibility = str(item.itc_eligibility);
        }
      }
      out.push(line);
    }
  }
  return out;
}

// ── Reading a list response ───────────────────────────────────────────────

/** The rows of a list response: the module's key, else the first array Zoho sent. */
export function listRows(def: ModuleDef, data: unknown): Obj[] {
  const d = data as Obj | null;
  if (!d || typeof d !== 'object') return [];
  const direct = d[def.listKey];
  if (Array.isArray(direct)) return direct as Obj[];
  for (const [k, v] of Object.entries(d)) if (k !== 'page_context' && Array.isArray(v)) return v as Obj[];
  return [];
}

export function hasMorePages(data: unknown): boolean {
  const pc = (data as { page_context?: { has_more_page?: unknown } } | null)?.page_context;
  return Boolean(pc?.has_more_page);
}

/** The detail record of a `GET /module/{id}` response. */
export function detailRecord(def: ModuleDef, data: unknown): Obj | null {
  const d = data as Obj | null;
  if (!d || typeof d !== 'object') return null;
  const direct = def.detailKey ? d[def.detailKey] : undefined;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct as Obj;
  for (const [k, v] of Object.entries(d)) {
    if (k !== 'page_context' && v && typeof v === 'object' && !Array.isArray(v)) return v as Obj;
  }
  return null;
}
