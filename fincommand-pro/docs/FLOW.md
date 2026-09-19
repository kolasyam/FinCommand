# FLOW.md — 4-Layer Financial Data & OAuth Execution Paths

## 1. The 4-layer financial data architecture

```
Layer 1 — SOURCE          Layer 2 — MAP              Layer 3 — COMPUTE                Layer 4 — OUTPUT
Trial Balance          →  Ledger Master           →  tb-engine.ts Period Engine    →  Statutory Reports (UI & API)
(Excel upload or           (90+ pre-seeded             (BS = cumulative;                (MIS, BS, P&L, Notes 1-26,
 Zoho Books sync)           IND AS mappings per         P&L = summed movement;           Cash Flow, Treasury,
                            ledger → Note No +          Monthly→Q→H→Annual→3yr,          + derived Ratios/WC/
                            BS-PL section +             all from the same TB,            Customer Margin/Vendor
                            treasury type)              no re-upload needed)             Expense/Board Pack)
```

Not derivable from this pipeline (flagged in the Upload tab's UI, not silently estimated): PPE gross block/asset register, IND AS 19 actuarial DBO, ECL invoice-level ageing, IND AS 102 ESOP register, IND AS 116 lease schedules.

## 2. Zoho OAuth connect flow (verified against `app/api/v1/zoho/*`)

```
1. Browser (CFO/admin role required)
        │  clicks "Connect Zoho Books"
        ▼
2. GET /api/v1/zoho/auth-url
        │  requireRole(user, ROLE_SETS.isCFO)
        │  builds Zoho's /oauth/v2/auth URL with:
        │    scope=ZohoBooks.fullaccess.all (or ZOHO_SCOPES override)
        │    client_id, redirect_uri from env
        │    access_type=offline, prompt=consent
        │    state=`${company_id}|${data_center}`   ← round-trips company context
        ▼
3. Zoho's hosted login + consent screen (external, user-facing)
        ▼
4. Zoho redirects to GET /api/v1/zoho/callback?code=...&state=...
        │  Next.js backend exchanges `code` for access_token + refresh_token
        │  parses `state` back into company_id + data_center
        ▼
5. Neon DB — zoho_config row created/updated
        (org_id, data_center, access_token, refresh_token, token_expiry, is_active)
        ▼
6. CFO enters/saves Organisation ID (Upload tab → "Save" next to Organization ID)
        │  POST/PUT /api/v1/zoho/config
        │  calls fetchAndStoreZohoOrgCurrency() — sets companies.currency from
        │  Zoho's real org currency_code (falls back to a default only when the
        │  real one can't be confirmed). Also (re-)called opportunistically from
        │  /api/v1/reports/all and /api/v1/companies/me.
```

## 3. Zoho data sync flow (verified against `lib/services/zoho.ts::syncFromZoho`)

```
1. Browser
        │  POST /api/v1/zoho/sync  (manual "Sync Now", or vercel.json cron)
        ▼
2. syncFromZoho(companyId, ...)
        │  a. Atomically claims a "running" slot in zoho_config
        │     (rejects a second concurrent sync for the same company; a stale
        │      'running' row self-heals after 5 minutes)
        │  b. Inserts a sync_logs row (status='running')
        │  c. Ensures token is fresh (single-flight refresh if <30s from expiry)
        │  d. Fetches Chart of Accounts (non-fatal if it fails — logged, sync continues)
        ▼
3. Parallel fetch wave
        ┌─────────────────────────────┬─────────────────────────────────┐
        │ Full-year Vendor Bills       │ Monthly P&L + Balance Sheet      │
        │ + Expenses                   │ reports, batched 5-at-a-time     │
        │ (paginated, own promise,     │ (callZoho() with configOverride  │
        │  runs concurrently with →)   │  to skip redundant config reads) │
        └─────────────────────────────┴─────────────────────────────────┘
        │  Customer/Vendor contact directories fetched via Promise.allSettled
        │  (one directory failing doesn't abort the other)
        │  Foreign-currency rows in Sales-by-Customer / Vendor Bills are
        │  skipped from concentration totals and logged (base-currency mismatch)
        ▼
4. Neon DB writes
        tb_uploads (new snapshot, marked is_current)
        tb_ledgers (chunked batch insert, 50 rows/query)
        tb_customer_revenue, tb_vendor_expense
        sync_logs (status → 'success' | 'error', with details)
        zoho_config (last_sync_status, last_sync_error, updated_at)
        report-cache invalidated (invalidateReportCache(companyId))
```

**Why P&L/Balance Sheet reports, not `/reports/trialbalance`**: confirmed empirically that Zoho's `/reports/trialbalance` endpoint silently ignores `from_date`/`to_date` for this integration (a request for 2000-01-01 returns the same totals as one for 2026-03-31). `/reports/profitandloss` and `/reports/balancesheet` are used instead — both correctly vary by date. P&L leaf `total` is used directly as the period movement (already signed positive-when-normal); Balance Sheet leaf balances are cumulative-as-of-`to_date`, so each month's movement is the difference between consecutive snapshots, with one extra "Opening" snapshot (day before FY start) supplying real opening balances instead of defaulting to zero.

## 4. Report request flow (UI → API → engine)

```
Dashboard tab (client component)
        │  useDashboard() context requests /api/v1/reports/{all|bs|pl|cashflow|mis|notes|ratios|treasury|threeyear}
        ▼
Route Handler (app/api/v1/reports/**/route.ts)
        │  reads tb_uploads / tb_ledgers for the resolved period
        ▼
lib/financial/tb-engine.ts
        │  single source of truth — computes the requested statement/report
        ▼
JSON response → React tab component renders (KPI cards, Chart.js visuals, tables)
```

Sample mode short-circuits this at the client: `lib/financial/sample-data.ts` produces a `ReportBundle` locally and feeds it through the *same* rendering components, without hitting `/api/v1/reports/*` at all.
