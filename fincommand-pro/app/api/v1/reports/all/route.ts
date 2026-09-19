import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import {
  getFY, getPreviousFY, getNextFY, loadStatementLedgers, bookedRowsOnly, loadCustomerRevenue, loadVendorExpense, loadCustomerCost, parsePeriodParams,
  loadReportDataVersion, loadBatchCurrency,
} from '@/lib/db/queries/reports';
import { loadZohoContacts, type ZohoContactRow } from '@/lib/db/queries/zoho-contacts';
import { query } from '@/lib/db/neon';
import {
  computeMIS, computeBS, computePL, computeNotes,
  computeTreasury, computeCashFlow, computeRatios, resolvePeriod,
  computeTopCustomers, computeVendorExpense, computeCustomerMargin,
  type AggregatedNote, type MISResult, type TbLedgerRow, type CustomerRevenueInput, type VendorExpenseInput, type TreasuryResult,
  type VendorExpense, type CustomerMarginResult, type ContactInfo, type RatiosResult,
} from '@/lib/financial/tb-engine';
import { mergeCyLedgers, mergeCyCustomerRevenue, mergeCyVendorExpense } from '@/lib/financial/cy-merge';
import { getCachedReport, setCachedReport, buildReportCacheKey, hashReportDataVersion } from '@/lib/cache/report-cache';
import { loadCustomMetricDefinitions } from '@/lib/db/queries/custom-metrics';
import { computeLedgerMetric, priorPeriodOf, type PeriodParams, type LedgerMetricSpec } from '@/lib/financial/tb-engine';
import type { CustomMetricDefinition } from '@/lib/financial/custom-metric-engine';
import type { CustomMetricValue, PriorPeriodBundle } from '@/lib/dashboard/types';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const { searchParams } = req.nextUrl;
  const fyId = searchParams.get('fy_id');
  if (!fyId) return json({ error: 'fy_id required' }, { status: 400 });

  const params = parsePeriodParams(searchParams);
  const nocache = searchParams.get('nocache') === 'true' || searchParams.get('refresh') === 'true';
  // The data version makes a bundle cached by any server instance unusable
  // the moment its inputs change (see lib/cache/report-cache.ts).
  const dataVersion = hashReportDataVersion(await loadReportDataVersion(user.company_id));
  const cacheKey = buildReportCacheKey(user.company_id, fyId, params, dataVersion);

  if (!nocache) {
    const cached = getCachedReport<Record<string, unknown>>(cacheKey);
    if (cached) {
      return json(cached);
    }
  }

  // Parallel fetch: get active FY metadata, Trial Balance ledgers, and real
  // per-customer revenue/cost and per-vendor spend (all Zoho-sourced; [] for
  // Excel uploads) concurrently
  const [fy, ledgers, customerRevRows, vendorExpenseRows, customerCostRows] = await Promise.all([
    getFY(user.company_id, fyId),
    loadStatementLedgers(user.company_id, fyId),
    loadCustomerRevenue(user.company_id, fyId),
    loadVendorExpense(user.company_id, fyId),
    loadCustomerCost(user.company_id, fyId),
  ]);

  if (!fy) return json({ error: 'Financial year not found' }, { status: 404 });
  if (!ledgers.length) return json({ error: 'No Trial Balance data found.' }, { status: 404 });

  const isCY = params.yearType === 'CY';
  let computeLedgers: TbLedgerRow[] = ledgers;
  let computeCustomerRev: CustomerRevenueInput[] = customerRevRows;
  let computeVendorExp: VendorExpenseInput[] = vendorExpenseRows;
  let computeCustomerCost: CustomerRevenueInput[] = customerCostRows;
  let cyNextFy = null;
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
  let cyLabelFy = fy;

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

  if (isCY) {
    const [nextFy, prevFy] = await Promise.all([
      getNextFY(user.company_id, fy),
      getPreviousFY(user.company_id, fy),
    ]);

    if (nextFy) {
      cyNextFy = nextFy;
      const [nextFyLedgers, nextFyCustomerRev, nextFyVendorExp, nextFyCustomerCost] = await Promise.all([
        loadStatementLedgers(user.company_id, nextFy.id),
        loadCustomerRevenue(user.company_id, nextFy.id),
        loadVendorExpense(user.company_id, nextFy.id),
        loadCustomerCost(user.company_id, nextFy.id),
      ]);
      computeLedgers = mergeCyLedgers(ledgers, nextFyLedgers);
      computeCustomerRev = mergeCyCustomerRevenue(customerRevRows, nextFyCustomerRev);
      computeVendorExp = mergeCyVendorExpense(vendorExpenseRows, nextFyVendorExp);
      computeCustomerCost = mergeCyCustomerRevenue(customerCostRows, nextFyCustomerCost);
    } else if (prevFy) {
      const [prevLedgers, prevCustomerRev, prevVendorExp, prevCustomerCost] = await Promise.all([
        loadStatementLedgers(user.company_id, prevFy.id),
        loadCustomerRevenue(user.company_id, prevFy.id),
        loadVendorExpense(user.company_id, prevFy.id),
        loadCustomerCost(user.company_id, prevFy.id),
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
  } else {
    const prevFy = await getPreviousFY(user.company_id, fy);
    if (prevFy) {
      const prevLedgers = await loadStatementLedgers(user.company_id, prevFy.id);
      if (prevLedgers.length) {
        prev_cashflow = computeCashFlow(prevLedgers, params);
        prev_bs = computeBS(prevLedgers, params);
        prev_pl = computePL(prevLedgers, params);
        prev_mis = computeMIS(prevLedgers, params);
        const pNotesMap = computeNotes(prevLedgers, params);
        prev_notes = Object.values(pNotesMap).sort((a, b) => a.note_no - b.note_no);
        prev_treasury = computeTreasury(prevLedgers, params);
        prev_ratios = computeRatios(prevLedgers, params);
        prev_financial_year = prevFy;
        prevLedgersForMetrics = prevLedgers;
      }
    }
  }

  // mis is computed first (synchronously) so computeTopCustomers can size
  // each customer's revenue against the real company-wide total.
  const mis = computeMIS(computeLedgers, params);
  // zohoContacts is fetched in this same wave, not as a separate awaited
  // round trip afterward — it has zero dependency on bs/pl/notes/etc. (it's
  // only joined onto vendor_expense/customer_margin below by name), so
  // sequencing it after this Promise.all was a pure, unnecessary extra
  // network round trip on every single report load.
  const [bs, pl, notes, treasury, cashflow, ratios, companyRows, auditRows, zohoContacts, customMetricDefs, batchCurrency] = await Promise.all([
    computeBS(computeLedgers, params),
    computePL(computeLedgers, params),
    computeNotes(computeLedgers, params),
    computeTreasury(computeLedgers, params),
    computeCashFlow(computeLedgers, params),
    computeRatios(computeLedgers, params),
    query<{ currency: string | null; presentation_currency: string | null }>(
      `SELECT currency, presentation_currency FROM companies WHERE id=$1`, [user.company_id]
    ),
    // Real signal for the Compliance tab's "Audit trail enabled" check —
    // previously an unconditional hardcoded 'ok' regardless of whether this
    // company actually had any audit_trail rows. Company-wide (not
    // FY-scoped, same as the table itself), so this is safe to compute once
    // here without a role check: it's just a count/timestamp, not the log
    // contents (app/api/v1/audit/route.ts, which returns the actual rows,
    // stays admin/cfo/auditor-only).
    query<{ count: string; last_at: string | null }>(
      `SELECT COUNT(*) AS count, MAX(created_at) AS last_at FROM audit_trail WHERE company_id=$1`, [user.company_id]
    ),
    // Real Zoho contact directory (customer AND vendor master data — email,
    // phone, GSTIN, live outstanding balance) — joined in below by name onto
    // the already-computed vendor spend / customer margin, rather than
    // threaded through computeVendorExpense()/computeCustomerMargin()
    // themselves, so those stay pure functions with no DB dependency (same
    // reasoning as every other compute* function in tb-engine.ts). A vendor/
    // customer with no matching contact record (Excel-uploaded TB, or a name
    // that doesn't exactly match Zoho's contact directory) just keeps
    // `contact` undefined — never a fabricated placeholder.
    loadZohoContacts(user.company_id),
    // This company's custom metric definitions — only ledger-kind ones are
    // computed here (they need raw ledgers, which never leave the server).
    // A failure here must never take down the statutory reports: it's
    // logged and the bundle simply carries no custom metric values.
    loadCustomMetricDefinitions(user.company_id).catch((err: Error): CustomMetricDefinition[] => {
      console.error('[reports/all] custom metric definitions unavailable:', err.message);
      return [];
    }),
    loadBatchCurrency(user.company_id, fyId),
  ]);
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
  const source_currency = (batchCurrency || companyRows.rows[0]?.currency || 'INR').toUpperCase();
  const default_presentation_currency = companyRows.rows[0]?.presentation_currency?.toUpperCase() || null;
  const audit_summary = {
    total_events: parseInt(auditRows.rows[0]?.count || '0', 10),
    last_event_at: auditRows.rows[0]?.last_at || null,
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
  return json(responseData);
});

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
