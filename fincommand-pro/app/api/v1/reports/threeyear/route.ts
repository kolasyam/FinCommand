import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { isIn } from '@/lib/validations/common';
import { query } from '@/lib/db/neon';
import { loadLedgers } from '@/lib/db/queries/reports';
import {
  computeMIS, computePL, computeTreasury, computeRatios, computeCashFlow, computeBS,
  type YearType,
} from '@/lib/financial/tb-engine';
import type { FinancialYearRow } from '@/lib/db/queries/reports';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const { searchParams } = req.nextUrl;

  const fyIdsRaw = searchParams.get('fy_ids') || '';
  const fyIds = fyIdsRaw.split(',').map(s => s.trim()).filter(Boolean);
  if (!fyIdsRaw || fyIds.length === 0) {
    return json({ errors: [{ field: 'fy_ids', message: 'fy_ids (comma-separated UUIDs) required' }] }, { status: 422 });
  }

  const yearTypeParam = searchParams.get('year_type');
  if (yearTypeParam !== null && !isIn(yearTypeParam, ['FY', 'CY'] as const)) {
    return json({ errors: [{ field: 'year_type', message: 'year_type must be FY or CY' }] }, { status: 422 });
  }

  if (fyIds.length > 3) {
    return json({ error: 'Provide at most 3 fy_ids for comparison' }, { status: 400 });
  }

  const { rows: fys } = await query<FinancialYearRow>(
    `SELECT * FROM financial_years WHERE id = ANY($1) AND company_id = $2 ORDER BY start_date`,
    [fyIds, user.company_id]
  );
  if (fys.length === 0) return json({ error: 'Financial years not found' }, { status: 404 });

  // Source Currency — same fact as /reports/all's source_currency, needed
  // here too: DashboardContext has no ReportBundle to read it from while
  // viewing the 3-Year Frame (rawBundle is null in that mode), so without
  // this its FX conversion would silently assume 'INR' regardless of what
  // this company's books are actually recorded in.
  const { rows: companyRows } = await query<{ currency: string }>(
    `SELECT currency FROM companies WHERE id=$1`, [user.company_id]
  );
  const source_currency = (companyRows[0]?.currency || 'INR').toUpperCase();

  const yearType = (yearTypeParam as YearType) || 'FY';

  interface CfSummary {
    ocf: number; icf: number; fcf: number;
    net_change: number; opening_cash: number; closing_cash: number; ocf_to_pat: number | null;
  }
  interface BsSummary {
    total_assets: number; equity: number; ncl: number; cl: number;
    nca: number; ca: number; balanced: boolean;
  }
  interface YearResult {
    financial_year: FinancialYearRow;
    no_data?: boolean;
    mis?: ReturnType<typeof computeMIS>['totals'];
    pl?: ReturnType<typeof computePL>;
    treasury?: { total: number; cash: number; fd: number; mf: number };
    ratios?: ReturnType<typeof computeRatios>;
    cashflow?: CfSummary;
    bs_summary?: BsSummary;
    yoy?: { revenue_growth: number | null; ebitda_growth: number | null; pat_growth: number | null };
  }

  const results: YearResult[] = [];

  for (const fy of fys) {
    const ledgers = await loadLedgers(user.company_id, fy.id);
    if (!ledgers.length) {
      results.push({ financial_year: fy, no_data: true });
      continue;
    }
    const params = { periodType: 'annual' as const, period: null, yearType };
    const [mis, pl, treasury, ratios, cf, bs] = await Promise.all([
      computeMIS(ledgers, params),
      computePL(ledgers, params),
      computeTreasury(ledgers, params),
      computeRatios(ledgers, params),
      computeCashFlow(ledgers, params),
      computeBS(ledgers, params),
    ]);

    const cfOp = cf.operating as Record<string, unknown>;
    const cfInv = cf.investing as Record<string, unknown>;
    const cfFin = cf.financing as Record<string, unknown>;

    results.push({
      financial_year: fy,
      mis: mis.totals,
      pl,
      treasury: { total: treasury.total, cash: treasury.total_cash_and_bank, fd: treasury.total_fd, mf: treasury.total_mf },
      ratios,
      cashflow: {
        ocf: cfOp.total as number,
        icf: cfInv.total as number,
        // Textbook Free Cash Flow = OCF − Capex, not OCF + full Investing
        // total — the latter would also sweep in FD/MF treasury movements
        // (moving cash between forms, not spending it) as if they reduced
        // free cash flow. Use computeCashFlow()'s own free_cash_flow field
        // so this matches the one definition already used elsewhere
        // (RatiosResult.cashflow.free_cash_flow) instead of a second,
        // looser one computed inline here.
        fcf: cf.free_cash_flow,
        net_change: cf.net_change as number ?? 0,
        opening_cash: cf.opening_cash as number ?? 0,
        closing_cash: cf.closing_cash as number ?? 0,
        ocf_to_pat: cf.ocf_to_pat,
      },
      bs_summary: {
        total_assets: bs.assets.total,
        equity: bs.equity_liabilities.total_equity,
        ncl: bs.equity_liabilities.total_ncl,
        cl: bs.equity_liabilities.total_cl,
        nca: bs.assets.total_nca,
        ca: bs.assets.total_ca,
        balanced: bs.balanced,
      },
    });
  }

  const withGrowth = results.map((r, i) => {
    if (i === 0 || !results[i - 1].mis || !r.mis) return r;
    const prev = results[i - 1].mis!;
    const cur = r.mis!;
    return {
      ...r,
      yoy: {
        revenue_growth: prev.rev > 0 ? +((cur.rev - prev.rev) / prev.rev * 100).toFixed(1) : null,
        ebitda_growth: prev.pbt > 0 ? +((cur.pbt - prev.pbt) / prev.pbt * 100).toFixed(1) : null,
        pat_growth: prev.pat > 0 ? +((cur.pat - prev.pat) / prev.pat * 100).toFixed(1) : null,
      },
    };
  });

  let cagr: { revenue: number | null; pat: number | null } | null = null;
  const withDataResults = withGrowth.filter(r => !r.no_data);
  if (withDataResults.length >= 2) {
    const first = withDataResults[0].mis!;
    const last = withDataResults[withDataResults.length - 1].mis!;
    const n = withDataResults.length - 1;
    cagr = {
      revenue: first.rev > 0 ? +((Math.pow(last.rev / first.rev, 1 / n) - 1) * 100).toFixed(1) : null,
      pat: first.pat > 0 ? +((Math.pow(last.pat / first.pat, 1 / n) - 1) * 100).toFixed(1) : null,
    };
  }

  return json({ years: withGrowth, cagr, generated_at: new Date().toISOString(), source_currency });
});
