import type { NextRequest } from 'next/server';
import { authenticate, claimedCompanyId } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import {
  getFY, loadStatementLedgers, bookedRowsOnly, loadCustomerRevenue, loadVendorExpense, loadCustomerCost, parsePeriodParams,
  loadReportDataVersion, loadReportContext, loadPreviousFYOf, loadNextFYOf, loadPreviousStatementLedgers,
  type FinancialYearRow, type ReportContext,
} from '@/lib/db/queries/reports';
import { loadZohoContacts, type ZohoContactRow } from '@/lib/db/queries/zoho-contacts';
import {
  computeMIS, computeBS, computePL, computeNotes,
  computeTreasury, computeCashFlow, computeRatios, resolvePeriod,
  computeTopCustomers, computeVendorExpense, computeCustomerMargin,
  type AggregatedNote, type MISResult, type TbLedgerRow, type CustomerRevenueInput, type VendorExpenseInput, type TreasuryResult,
  type VendorExpense, type CustomerMarginResult, type ContactInfo, type RatiosResult,
} from '@/lib/financial/tb-engine';
import { mergeCyLedgers, mergeCyCustomerRevenue, mergeCyVendorExpense } from '@/lib/financial/cy-merge';
import {
  getCachedReportShared, setCachedReport, buildReportCacheKey, hashReportDataVersion,
  getCachedReportInputs, setCachedReportInputs, buildReportInputsKey,
} from '@/lib/cache/report-cache';
import { setSharedCached } from '@/lib/cache/shared-cache';
import { afterResponse } from '@/lib/cache/after-response';
import { loadCustomMetricDefinitions } from '@/lib/db/queries/custom-metrics';
import { computeLedgerMetric, priorPeriodOf, type PeriodParams, type LedgerMetricSpec } from '@/lib/financial/tb-engine';
import type { CustomMetricDefinition } from '@/lib/financial/custom-metric-engine';
import type { CustomMetricValue, PriorPeriodBundle } from '@/lib/types/dashboard';

export const runtime = 'nodejs';

/**
 * Everything a bundle is computed from that does NOT depend on the period
 * (Annual / Q1 / H2 …): only on the year and on FY-vs-CY. That is what makes
 * it cacheable per data version (see getCachedReportInputs), so switching the
 * period view doesn't read the same rows from the database again.
 */
interface ReportInputs {
  /** FY mode: this year's ledgers. CY mode: the two years' ledgers merged into one calendar year. */
  computeLedgers: TbLedgerRow[];
  computeCustomerRev: CustomerRevenueInput[];
  computeVendorExp: VendorExpenseInput[];
  computeCustomerCost: CustomerRevenueInput[];
  cyNextFy: FinancialYearRow | null;
  /** Which FY's end_date determines the displayed "CYyyyy" label — see the note in loadReportInputs(). */
  cyLabelFy: FinancialYearRow;
  /** FY mode only: the previous year and its ledgers, for the prior-year comparatives. */
  prevFyRow: FinancialYearRow | null;
  prevYearLedgers: TbLedgerRow[];
  reportContext: ReportContext | null;
  zohoContacts: ZohoContactRow[];
  customMetricDefs: CustomMetricDefinition[];
}

export const GET = withErrorHandling(async (req: NextRequest) => {
  // Round trips are the cost here, not compute (docs/LATENCY.md): the data
  // version is asked for at the same time as the user lookup, using the
  // company named in the request's signed token. It is used only if
  // authenticate() then confirms the same company — otherwise it is asked
  // again — so authentication itself is unchanged.
  const claimedCompany = claimedCompanyId(req);
  const earlyVersion = claimedCompany ? loadReportDataVersion(claimedCompany).catch(() => null) : null;
  const user = await authenticate(req);
  const { searchParams } = req.nextUrl;
  const fyId = searchParams.get('fy_id');
  if (!fyId) return json({ error: 'fy_id required' }, { status: 400 });

  const params = parsePeriodParams(searchParams);
  const nocache = searchParams.get('nocache') === 'true' || searchParams.get('refresh') === 'true';
  // The data version makes a bundle cached by any server instance unusable
  // the moment its inputs change (see lib/cache/report-cache.ts).
  const version = (claimedCompany === user.company_id && (await earlyVersion)) || await loadReportDataVersion(user.company_id);
  const dataVersion = hashReportDataVersion(version);
  const cacheKey = buildReportCacheKey(user.company_id, fyId, params, dataVersion);

  if (!nocache) {
    const cached = await getCachedReportShared<Record<string, unknown>>(cacheKey);
    if (cached) {
      return json(cached);
    }
  }

  const isCY = params.yearType === 'CY';

  // The database reads, kept per data version: a different PERIOD of the same
  // year (the common click) reuses them and only recomputes. A refresh
  // (nocache/refresh) always reads fresh and re-stores.
  const inputsKey = buildReportInputsKey(user.company_id, fyId, isCY, dataVersion);
  let inputs = nocache ? null : getCachedReportInputs<ReportInputs>(inputsKey);
  if (!inputs) {
    const loaded = await loadReportInputs(user.company_id, fyId, isCY);
    if ('error' in loaded) return json({ error: loaded.error }, { status: loaded.status });
    inputs = loaded.inputs;
    if (loaded.cacheable) setCachedReportInputs(inputsKey, inputs);
  }
  const {
    computeLedgers, computeCustomerRev, computeVendorExp, computeCustomerCost,
    cyNextFy, cyLabelFy, prevFyRow, prevYearLedgers, reportContext, zohoContacts, customMetricDefs,
  } = inputs;

  let prev_cashflow = null;
  let prev_bs = null;
  let prev_pl = null;
  let prev_mis: MISResult | null = null;
  let prev_notes: AggregatedNote[] | null = null;
  let prev_treasury: TreasuryResult | null = null;
  let prev_ratios: RatiosResult | null = null;
  let prev_financial_year = null;
  // Prior-year ledgers for ledger-kind custom metrics' YoY comparative —
  // same source as every prev_* figure above (FY mode only; CY mode has no
  // comparative anywhere in this bundle).
  let prevLedgersForMetrics: TbLedgerRow[] | null = null;

  if (!isCY && prevFyRow && prevYearLedgers.length) {
    const prevLedgers = prevYearLedgers;
    prev_cashflow = computeCashFlow(prevLedgers, params);
    prev_bs = computeBS(prevLedgers, params);
    prev_pl = computePL(prevLedgers, params);
    prev_mis = computeMIS(prevLedgers, params);
    const pNotesMap = computeNotes(prevLedgers, params);
    prev_notes = Object.values(pNotesMap).sort((a, b) => a.note_no - b.note_no);
    prev_treasury = computeTreasury(prevLedgers, params);
    prev_ratios = computeRatios(prevLedgers, params);
    prev_financial_year = prevFyRow;
    prevLedgersForMetrics = prevLedgers;
  }

  // mis is computed first so computeTopCustomers can size each customer's
  // revenue against the real company-wide total. Everything below is pure
  // computation on data already loaded — no database round trip.
  const mis = computeMIS(computeLedgers, params);
  const bs = computeBS(computeLedgers, params);
  const pl = computePL(computeLedgers, params);
  const notes = computeNotes(computeLedgers, params);
  const treasury = computeTreasury(computeLedgers, params);
  const cashflow = computeCashFlow(computeLedgers, params);
  const ratios = computeRatios(computeLedgers, params);
  const top_customers = computeTopCustomers(computeCustomerRev, computeLedgers, params, mis.totals.rev);
  const rawVendorExpense = computeVendorExpense(computeVendorExp, params);
  const rawCustomerMargin = computeCustomerMargin(computeCustomerRev, computeCustomerCost, params);

  const vendor_expense = attachVendorContacts(rawVendorExpense, zohoContacts);
  const customer_margin = attachCustomerContacts(rawCustomerMargin, zohoContacts);
  // Source Currency (the currency the Trial Balance ledgers were actually
  // recorded in) — real, per-company (auto-detected from the connected
  // Zoho org where available; see fetchAndStoreZohoOrgCurrency()), never
  // assumed. `presentation_currency` is the company's saved default only;
  // DashboardContext still lets a signed-in user override it for their own
  // session, same as the Unit Selector. Taken from the year's own batch
  // first: companies.currency is only the default for the NEXT upload, so
  // changing it must not re-label figures already loaded in another currency.
  const source_currency = (reportContext?.batch_currency || reportContext?.currency || 'INR').toUpperCase();
  const default_presentation_currency = reportContext?.presentation_currency?.toUpperCase() || null;
  // The Compliance tab's "Audit trail enabled" check reads a real signal — a
  // count/timestamp of this company's audit_trail rows (company-wide, not
  // FY-scoped, like the table itself). Not the log contents: app/api/v1/audit
  // returns those and stays admin/cfo/auditor-only.
  const audit_summary = {
    total_events: parseInt(reportContext?.audit_count || '0', 10),
    last_event_at: reportContext?.audit_last_at || null,
  };

  const ledgerDefs = customMetricDefs.filter(
    (d): d is CustomMetricDefinition & { ledgerSpec: LedgerMetricSpec } => d.kind === 'ledger' && !!d.ledgerSpec,
  );
  const custom_metric_values: Record<string, CustomMetricValue> = {};
  for (const def of ledgerDefs) {
    const current = computeLedgerMetric(bookedRowsOnly(computeLedgers), def.ledgerSpec, params); // books only, never the derived surplus row
    const prior = prevLedgersForMetrics ? computeLedgerMetric(bookedRowsOnly(prevLedgersForMetrics), def.ledgerSpec, params) : null;
    custom_metric_values[def.key] = {
      value: current.value,
      // A prior year in which no ledger matched has no honest comparative.
      previous: prior && prior.matchedCount > 0 ? prior.value : null,
      trend: current.trend,
      breakdown: current.breakdown,
      matchedCount: current.matchedCount,
    };
  }

  // The period immediately before the selected one — only built when some
  // custom metric compares against it (it costs a second pass of every
  // statement). Q2–Q4 / H2 come from this same year's ledgers; Q1 / H1 /
  // a whole year need the previous FY, which exists only in FY mode (CY mode
  // has no comparative anywhere in this bundle). null = not available, and
  // the metric then shows no change figure rather than a guessed one.
  let prior_period: PriorPeriodBundle | null = null;
  const pp = customMetricDefs.some((d) => d.comparison === 'prior_period') ? priorPeriodOf(params) : null;
  if (pp) {
    const ppLedgers = pp.source === 'same' ? computeLedgers : prevLedgersForMetrics;
    const ppFy = pp.source === 'same' ? cyLabelFy : prev_financial_year;
    if (ppLedgers?.length && ppFy) {
      prior_period = buildPriorPeriod(ppLedgers, pp.params, ppFy.label, ledgerDefs);
    }
  }

  const responseData = {
    financial_year: cyLabelFy,
    cy_next_financial_year: cyNextFy,
    prev_financial_year,
    period_params: params,
    period_label: resolvePeriod(params).label,
    source_currency,
    default_presentation_currency,
    mis, bs, prev_bs, pl, prev_pl,
    prev_mis,
    notes: Object.values(notes).sort((a, b) => a.note_no - b.note_no),
    prev_notes,
    treasury, prev_treasury, cashflow,
    prev_cashflow,
    ratios,
    prev_ratios,
    top_customers,
    vendor_expense,
    customer_margin,
    audit_summary,
    custom_metric_values,
    prior_period,
    generated_at: new Date().toISOString(),
  };

  setCachedReport(cacheKey, responseData);
  afterResponse(() => setSharedCached(cacheKey, responseData)); // shared cache: off unless configured; never delays the response
  return json(responseData);
});

/**
 * The period-independent database reads for one year, as ONE wave of queries
 * for everything that doesn't depend on another read's result: the year, its
 * ledgers, real per-customer revenue/cost and per-vendor spend (Zoho-sourced;
 * [] for Excel uploads), the company facts, contacts and custom-metric
 * definitions — and the neighbouring years, found from the year's id in SQL.
 * Before, these were three or four sequential waves, each a full round trip.
 * CY mode then reads the neighbouring year's data (it needs that year's id)
 * and merges the two into one calendar year.
 *
 * `cacheable` is false when the custom-metric definitions failed to load:
 * that empty list must not be remembered as if it were the truth.
 */
async function loadReportInputs(
  companyId: string, fyId: string, isCY: boolean,
): Promise<{ inputs: ReportInputs; cacheable: boolean } | { error: string; status: number }> {
  let metricsLoaded = true;
  const [
    fy, ledgers, customerRevRows, vendorExpenseRows, customerCostRows,
    reportContext, zohoContacts, customMetricDefs, prevFyRow, nextFyRow, prevYearLedgers,
  ] = await Promise.all([
    getFY(companyId, fyId),
    loadStatementLedgers(companyId, fyId),
    loadCustomerRevenue(companyId, fyId),
    loadVendorExpense(companyId, fyId),
    loadCustomerCost(companyId, fyId),
    loadReportContext(companyId, fyId),
    // Real Zoho contact directory (customer AND vendor master data — email,
    // phone, GSTIN, live outstanding balance) — joined in by name onto the
    // already-computed vendor spend / customer margin, rather than threaded
    // through computeVendorExpense()/computeCustomerMargin() themselves, so
    // those stay pure functions with no DB dependency (same reasoning as
    // every other compute* function in tb-engine.ts). A vendor/customer with
    // no matching contact record (Excel-uploaded TB, or a name that doesn't
    // exactly match Zoho's contact directory) just keeps `contact`
    // undefined — never a fabricated placeholder.
    loadZohoContacts(companyId),
    // This company's custom metric definitions — only ledger-kind ones are
    // computed here (they need raw ledgers, which never leave the server).
    // A failure here must never take down the statutory reports: it's
    // logged and the bundle simply carries no custom metric values.
    loadCustomMetricDefinitions(companyId).catch((err: Error): CustomMetricDefinition[] => {
      console.error('[reports/all] custom metric definitions unavailable:', err.message);
      metricsLoaded = false;
      return [];
    }),
    loadPreviousFYOf(companyId, fyId),
    isCY ? loadNextFYOf(companyId, fyId) : Promise.resolve(null),
    // FY mode compares with the previous year; CY mode has no comparative.
    isCY ? Promise.resolve([] as TbLedgerRow[]) : loadPreviousStatementLedgers(companyId, fyId),
  ]);

  if (!fy) return { error: 'Financial year not found', status: 404 };
  if (!ledgers.length) return { error: 'No Trial Balance data found.', status: 404 };

  let computeLedgers: TbLedgerRow[] = ledgers;
  let computeCustomerRev: CustomerRevenueInput[] = customerRevRows;
  let computeVendorExp: VendorExpenseInput[] = vendorExpenseRows;
  let computeCustomerCost: CustomerRevenueInput[] = customerCostRows;
  let cyNextFy: FinancialYearRow | null = null;
  // Which FY's end_date determines the displayed "CYyyyy" label (cyYearFromFy
  // reads end_date's year) — normally the selected `fy` (it plays the
  // Jan–Mar/"prevFY" role, and CY year = its own end year). The `else if
  // (prevFy)` fallback below reassigns this: when there's no later FY to
  // supply Apr–Dec, it instead merges the *selected* fy in as the Apr–Dec
  // side of the *prior* calendar year (prevFy's), so the label must switch
  // to prevFy too — otherwise the response would return e.g. Jan–Dec 2025's
  // merged data while every "CYyyyy" label in the UI (built from this field)
  // still read "CY 2026", a confusing, confirmed mismatch since this exact
  // fallback fires by default for any company whose latest FY has no
  // successor uploaded yet (the common case right after onboarding).
  let cyLabelFy: FinancialYearRow = fy;

  if (isCY) {
    // Found in the first wave (by year id); same results as getNextFY()/getPreviousFY().
    const nextFy = nextFyRow;
    const prevFy = prevFyRow;

    if (nextFy) {
      cyNextFy = nextFy;
      const [nextFyLedgers, nextFyCustomerRev, nextFyVendorExp, nextFyCustomerCost] = await Promise.all([
        loadStatementLedgers(companyId, nextFy.id),
        loadCustomerRevenue(companyId, nextFy.id),
        loadVendorExpense(companyId, nextFy.id),
        loadCustomerCost(companyId, nextFy.id),
      ]);
      computeLedgers = mergeCyLedgers(ledgers, nextFyLedgers);
      computeCustomerRev = mergeCyCustomerRevenue(customerRevRows, nextFyCustomerRev);
      computeVendorExp = mergeCyVendorExpense(vendorExpenseRows, nextFyVendorExp);
      computeCustomerCost = mergeCyCustomerRevenue(customerCostRows, nextFyCustomerCost);
    } else if (prevFy) {
      const [prevLedgers, prevCustomerRev, prevVendorExp, prevCustomerCost] = await Promise.all([
        loadStatementLedgers(companyId, prevFy.id),
        loadCustomerRevenue(companyId, prevFy.id),
        loadVendorExpense(companyId, prevFy.id),
        loadCustomerCost(companyId, prevFy.id),
      ]);
      computeLedgers = mergeCyLedgers(prevLedgers, ledgers);
      computeCustomerRev = mergeCyCustomerRevenue(prevCustomerRev, customerRevRows);
      computeVendorExp = mergeCyVendorExpense(prevVendorExp, vendorExpenseRows);
      computeCustomerCost = mergeCyCustomerRevenue(prevCustomerCost, customerCostRows);
      cyLabelFy = prevFy;
      cyNextFy = fy; // `fy` is now supplying Apr–Dec, i.e. playing the "next FY" role relative to cyLabelFy
    } else {
      computeLedgers = mergeCyLedgers(ledgers, []);
      computeCustomerRev = mergeCyCustomerRevenue(customerRevRows, []);
      computeVendorExp = mergeCyVendorExpense(vendorExpenseRows, []);
      computeCustomerCost = mergeCyCustomerRevenue(customerCostRows, []);
    }
  }

  return {
    inputs: {
      computeLedgers, computeCustomerRev, computeVendorExp, computeCustomerCost,
      cyNextFy, cyLabelFy, prevFyRow, prevYearLedgers, reportContext, zohoContacts, customMetricDefs,
    },
    cacheable: metricsLoaded,
  };
}

/** Every statement for one earlier period, plus its ledger-metric values. Notes carry totals only — the ledger detail is never read from a prior period and would double the payload. */
function buildPriorPeriod(
  ledgers: TbLedgerRow[], params: PeriodParams, fyLabel: string,
  ledgerDefs: (CustomMetricDefinition & { ledgerSpec: LedgerMetricSpec })[],
): PriorPeriodBundle {
  const values: Record<string, CustomMetricValue> = {};
  for (const def of ledgerDefs) {
    const r = computeLedgerMetric(bookedRowsOnly(ledgers), def.ledgerSpec, params);
    values[def.key] = { value: r.matchedCount > 0 ? r.value : null, previous: null, trend: [], breakdown: [], matchedCount: r.matchedCount };
  }
  return {
    label: resolvePeriod(params).label,
    financial_year_label: fyLabel,
    mis: computeMIS(ledgers, params),
    bs: computeBS(ledgers, params),
    pl: computePL(ledgers, params),
    cashflow: computeCashFlow(ledgers, params),
    treasury: computeTreasury(ledgers, params),
    ratios: computeRatios(ledgers, params),
    notes: Object.values(computeNotes(ledgers, params))
      .map((n) => ({ ...n, ledgers: [] }))
      .sort((a, b) => a.note_no - b.note_no),
    custom_metric_values: values,
  };
}

function toContactInfo(c: ZohoContactRow, balanceField: 'outstanding_payable_amount_bcy' | 'outstanding_receivable_amount_bcy'): ContactInfo {
  return {
    email: c.email,
    phone: c.phone || c.mobile,
    gstNo: c.gst_no,
    outstandingBalance: parseFloat(String(c[balanceField])) || 0,
  };
}

function attachVendorContacts(vendors: VendorExpense[], contacts: ZohoContactRow[]): VendorExpense[] {
  if (contacts.length === 0) return vendors;
  const byName = new Map(contacts.filter((c) => c.contact_type === 'vendor').map((c) => [c.contact_name, c]));
  return vendors.map((v) => {
    const c = byName.get(v.vendor);
    return c ? { ...v, contact: toContactInfo(c, 'outstanding_payable_amount_bcy') } : v;
  });
}

function attachCustomerContacts(result: CustomerMarginResult, contacts: ZohoContactRow[]): CustomerMarginResult {
  if (contacts.length === 0) return result;
  const byName = new Map(contacts.filter((c) => c.contact_type === 'customer').map((c) => [c.contact_name, c]));
  return {
    ...result,
    entries: result.entries.map((e) => {
      const c = byName.get(e.customer);
      return c ? { ...e, contact: toContactInfo(c, 'outstanding_receivable_amount_bcy') } : e;
    }),
  };
}
