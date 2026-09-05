import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { getFY, getPreviousFY, getNextFY, loadLedgers, loadCustomerRevenue, loadVendorExpense, loadCustomerCost, parsePeriodParams } from '@/lib/db/queries/reports';
import { query } from '@/lib/db/neon';
import {
  computeMIS, computeBS, computePL, computeNotes,
  computeTreasury, computeCashFlow, computeRatios, resolvePeriod,
  computeTopCustomers, computeVendorExpense, computeCustomerMargin,
  type AggregatedNote, type MISResult, type TbLedgerRow, type CustomerRevenueInput, type VendorExpenseInput, type TreasuryResult,
} from '@/lib/financial/tb-engine';
import { mergeCyLedgers, mergeCyCustomerRevenue, mergeCyVendorExpense } from '@/lib/financial/cy-merge';
import { getCachedReport, setCachedReport } from '@/lib/cache/report-cache';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const { searchParams } = req.nextUrl;
  const fyId = searchParams.get('fy_id');
  if (!fyId) return json({ error: 'fy_id required' }, { status: 400 });

  const params = parsePeriodParams(searchParams);
  const nocache = searchParams.get('nocache') === 'true' || searchParams.get('refresh') === 'true';
  const cacheKey = `${user.company_id}:${fyId}:${params.periodType}:${params.period || 'all'}:${params.yearType}`;

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
    loadLedgers(user.company_id, fyId),
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
  let prev_financial_year = null;

  if (isCY) {
    const [nextFy, prevFy] = await Promise.all([
      getNextFY(user.company_id, fy),
      getPreviousFY(user.company_id, fy),
    ]);

    if (nextFy) {
      cyNextFy = nextFy;
      const [nextFyLedgers, nextFyCustomerRev, nextFyVendorExp, nextFyCustomerCost] = await Promise.all([
        loadLedgers(user.company_id, nextFy.id),
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
        loadLedgers(user.company_id, prevFy.id),
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
      const prevLedgers = await loadLedgers(user.company_id, prevFy.id);
      if (prevLedgers.length) {
        prev_cashflow = computeCashFlow(prevLedgers, params);
        prev_bs = computeBS(prevLedgers, params);
        prev_pl = computePL(prevLedgers, params);
        prev_mis = computeMIS(prevLedgers, params);
        const pNotesMap = computeNotes(prevLedgers, params);
        prev_notes = Object.values(pNotesMap).sort((a, b) => a.note_no - b.note_no);
        prev_treasury = computeTreasury(prevLedgers, params);
        prev_financial_year = prevFy;
      }
    }
  }

  // mis is computed first (synchronously) so computeTopCustomers can size
  // each customer's revenue against the real company-wide total.
  const mis = computeMIS(computeLedgers, params);
  const [bs, pl, notes, treasury, cashflow, ratios, companyRows, auditRows] = await Promise.all([
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
  ]);
  const top_customers = computeTopCustomers(computeCustomerRev, computeLedgers, params, mis.totals.rev);
  const vendor_expense = computeVendorExpense(computeVendorExp, params);
  const customer_margin = computeCustomerMargin(computeCustomerRev, computeCustomerCost, params);
  // Source Currency (the currency the Trial Balance ledgers were actually
  // recorded in) — real, per-company (auto-detected from the connected
  // Zoho org where available; see fetchAndStoreZohoOrgCurrency()), never
  // assumed. `presentation_currency` is the company's saved default only;
  // DashboardContext still lets a signed-in user override it for their own
  // session, same as the Unit Selector.
  const source_currency = (companyRows.rows[0]?.currency || 'INR').toUpperCase();
  const default_presentation_currency = companyRows.rows[0]?.presentation_currency?.toUpperCase() || null;
  const audit_summary = {
    total_events: parseInt(auditRows.rows[0]?.count || '0', 10),
    last_event_at: auditRows.rows[0]?.last_at || null,
  };

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
    top_customers,
    vendor_expense,
    customer_margin,
    audit_summary,
    generated_at: new Date().toISOString(),
  };

  setCachedReport(cacheKey, responseData);
  return json(responseData);
});
