# CONSTRAINTS.md — Statutory Compliance & Security Guardrails

> [!IMPORTANT]
> These are non-negotiable boundaries. Where a constraint below is *not yet enforced in code* (Section 2), that's flagged explicitly — don't assume a guardrail exists just because it's listed as a principle here. Verified vs. aspirational status is called out per item.

## 1. Enforced guardrails (verified in code this session)

### ⛔ Statutory report layout preservation
**Never** alter the layout/structure of Balance Sheet, P&L, Cash Flow (IND AS 7), or Notes to Accounts (1–26).

> [!IMPORTANT]
> **Correction (2026-09-17, see `QA-AUDIT-LATENCY-FIX.md` §4.1)**: the claim that used to appear here — "no `tab_key` wiring exists for `bs`, `pl`, `cashflow`, or `notes`" — is **stale and wrong**. `BalanceSheetTab.tsx` (and presumably its siblings, not independently re-checked) does register a `tab_key` with `CustomizableTabPanel`, confirmed live. The actual guardrail is narrower and still holds: only a `supplementaryView` (KPI strip + composition visual) is passed to `CustomizableTabPanel`'s `fixedView`; the mandated Schedule III statutory table renders unconditionally, directly in the tab component, and is **never** passed to `CustomizableTabPanel` — verified live by entering customize mode and confirming the full statutory table stayed on screen throughout. Route any request to actually restructure/hide/reorder a statutory statement's own lines to Report Builder instead.

### ⛔ Sample Mode route safety
Unauthenticated `401` responses on `/api/v1/auth/me`, `/api/v1/dashboard-layout/all`, `/api/v1/custom-metrics`, `/api/v1/auth/refresh` during Sample Mode are **expected** — verified live against `localhost:4000` in Sample Data mode. Never force a login lock or treat these as errors in that mode.

### ⛔ No string-eval'd financial formulas
Custom metrics (`lib/financial/custom-metric-engine.ts`) must remain structured expression trees (`{type:'metric'|'const'|'op'}`) — verified: no `eval()`/`Function()` construction path exists in that file. Never add a "raw formula string" input path; it reopens an injection surface that was deliberately designed out.

### ⛔ Role-gated Zoho connection
Initiating a Zoho OAuth connection (`GET /api/v1/zoho/auth-url`) requires `ROLE_SETS.isCFO` — verified in `app/api/v1/zoho/auth-url/route.ts`. Don't expose "Connect Zoho Books" to roles below CFO/admin without deliberately revisiting this gate.

### ⛔ Error handling integrity
Never swallow database, auth, or Zoho API exceptions silently. The existing pattern (`withErrorHandling` wrapper, explicit `error` fields returned to the client, `console.warn`/`console.error` on partial failures like COA fetch or foreign-currency skips) should be followed for any new route — a caught-and-ignored exception is a regression, not a simplification.

### ⛔ Double-entry balance (Σ Dr = Σ Cr) — recorded and warned, never blocking (DB Phase 0, 2026-09-19)
Every trial-balance batch stores `total_dr`, `total_cr`, `balance_diff`, `is_balanced` and a `validation` breakdown: the opening difference plus each of the 12 months. This happens for Excel uploads and Zoho syncs alike, in the one ingestion pipeline (`lib/ingestion/trial-balance.ts`, since DB Phase 1), using one function, `summarizeTrialBalance()` in `lib/financial/tb-validation.ts`. "Balanced" means the opening and every month are each within ₹1.
- An unbalanced file is **saved and flagged** ("warn and record", the owner's decision), not rejected. The uploader sees the warning.
- Existing batches were backfilled by migration `0001`; `DB-PHASE-0.md` §5 has the counts. The Zoho batches were off only in the opening balance and month 1. The cause was a one-day-early opening snapshot plus a missing "earnings brought forward" line. Both are fixed in the sync (`DB-PHASE-0.md` §3.6) and take effect on each year's next sync.
- **The Balance Sheet carries the period's profit** (DB Phase 1, approved by the owner). For a trial balance that balances, the statements add one line in Note 2 Other Equity: "Surplus — profit for the period (as booked)" (`withPeriodSurplus()` in `tb-engine.ts`, code `SYS-PL-SURPLUS`).
  - It is the **only** addition to the statutory layout. Don't add others without the owner's approval.
  - It is **never** added to an unbalanced trial balance, so a real difference stays visible as "Out of Balance".
  - It is **never** stored. Custom metrics, Report Builder and the raw ledger APIs don't see it (`loadStatementLedgers()` vs `loadLedgers()`).
  - Cash Flow ignores it, so profit isn't counted twice.
  - See `DB-PHASE-1.md` §3.5.

### ⛔ Trial-balance writes — one writer, locked years untouchable, first source owns the year
- **One writer per company + year.** Excel upload, Zoho sync, reclassify and batch delete each take `lockTrialBalanceWrite()` (`lib/db/queries/tb-batches.ts`) inside their transaction. A second writer waits up to 15 s, then gets a 409 "in progress".
- **Locked years can't be changed.** The year lock is re-checked under that write lock for every one of those four writes. Sync, reclassify and delete used to ignore it.
- **The database backs these rules up:**
  - at most one current batch per year
  - no ledger twice in a batch (same name + code)
  - no overlapping years, and every year's start is before its end
  - every ledger row carries its company, year and batch
- **Whichever source (Excel or Zoho) loads a year first owns it** (`financial_years.data_source`). Switching needs a person's confirmation. The scheduled sync never switches a year.
- **One write path** (DB Phase 1). Every source writes through `ingestTrialBalance()` (`lib/ingestion/trial-balance.ts`). A new source must not write `tb_uploads` / `tb_ledgers` itself.
- **Every ledger row has a stable account** (`tb_ledgers.account_id`, NOT NULL, set by a trigger). Don't bypass or disable `trg_tb_ledgers_assign_account`.
- **Old data is deleted only through an approved list.** `db/scripts/retention.ts` and `clear-raw-zoho-months.ts` apply only a dry-run list id the owner approved. Never delete batches or raw payloads by hand.

### ⛔ Zoho customer figures are base-currency amounts — never skip a customer for its currency
Zoho's Sales by Customer report gives every amount already in the organisation's base currency; `currency_code` only names the customer's own invoicing currency (proved against Zoho's invoices, `ZOHO-DATA-AUDIT.md` §3). A foreign-currency customer must be counted, not skipped. Skipping one hid the company's largest customer from Top Customers and Customer Margin. Bills are the opposite case: a foreign-currency bill's `total` is in its own currency, so it is counted only through Zoho's `bcy_total`, never a guessed rate. Anything non-fatal that limits a sync must be reported (`buildSyncNotes`), never silent.

### ⛔ Mirrored Zoho records — read-only, additive, never guessed (2026-09-21, `ZOHO-RECORDS.md`)
- **Reads only.** Nothing is ever written to Zoho, and nothing in the mirror (`zoho_records`, `zoho_record_lines`, `zoho_record_history`, `zoho_module_state`, `zoho_api_usage`, `zoho_report_snapshots`) feeds `tb-engine.ts`, a report loader or a statement. Keep it that way until a separate, approved plan says otherwise, with a before/after parity proof.
- **`base_amount` is Zoho's own base-currency figure or the document's own amount in the base currency. Never `amount × exchange_rate`.** A foreign-currency document with no base figure keeps it empty.
- **Removals are flagged (`deleted_at`), never deleted; a changed record's old version goes to `zoho_record_history`.** Only a *complete full* listing may flag removals, and never when Zoho returned nothing while records are stored.
- **All Zoho calls go through `callZoho`** so they are counted against the day's allowance, and record reads stay within **80% of it** (`api_daily_limit`, owner decision). Zoho's daily-limit answer (code 45) is final: no retry, block for an hour.
- **A failing sync is retried with back-off** (`health.ts`), not on every scheduler tick.
- **Read access is `admin, cfo, ceo, auditor`; starting a read is `admin, cfo`.** The records include bank transactions and contact and user details. Every query filters on `company_id` taken from the authenticated user, never from the request.
- The scheduler touches only companies whose admin already started a first read.

### ⛔ The database keeps companies apart — row-level security (2026-09-21, `ROW-LEVEL-SECURITY.md`)
- **Every new table** gets `ENABLE ROW LEVEL SECURITY`, a `company_id = app_company_id()` policy (with `WITH CHECK`) and a `GRANT` to `fincommand_app` in its own migration. No default privileges, on purpose. `tests/unit/rls-coverage.test.ts` fails otherwise.
- **A route that does not authenticate a company** (login, signup, refresh, OAuth callback, cron) passes `{ system: true }` to `withErrorHandling`; server-started work for one company runs inside `runAsCompany(id, …)`. A company id placed into SQL must pass `assertCompanyId` (UUID only).
- The restricted role is never given `BYPASSRLS`, ownership, `CREATE`, or DML on the audit trail beyond `INSERT`/`SELECT`. Its password is set with `db/scripts/set-app-role-password.ts` (clipboard, never printed) and lives only in Vercel's environment.
- The app's own `company_id` filters stay; row-level security is the second line, not a replacement.

### ⛔ Secrets and tenancy (DB Phase 0)
- Zoho tokens are **encrypted at rest** (`lib/security/token-crypto.ts`, `TOKEN_ENCRYPTION_KEY`), and no API response ever includes them.
- The Zoho connect `state` is **signed and expires** (`lib/security/oauth-state.ts`).
- `/internal/zoho-cron` and `/internal/keepalive` **refuse to run in production without `CRON_SECRET`**, and compare the bearer token in constant time (`lib/auth/cron-auth.ts`, the one shared check — don't copy it into a new route).
- **The user lookup in `authenticate()` is cached for 30 s** (`AUTH_CACHE_TTL_MS`; owner-accepted trade-off, 2026-09-20). Rules that must keep holding: the token is verified on every request; a failed lookup (unknown or inactive user) is **never** cached; every caller gets a copy; and any new route that changes a user's role, name or active flag must call `invalidateAuthCache(userId)` after the update. Until it expires, a user deactivated or re-roled on a *different* server instance keeps the old access.
- Every report loader filters on `company_id` **and** the company's own current batch id.

## 2. Principle, not (yet) an enforced check — verify before assuming

### ⚠️ No hardcoded layout math in exports
PDF export (`lib/client/exports/pdf.ts`) does use `doc.internal.pageSize.getHeight()` and `lastAutoTable.finalY` for dynamic vertical flow — verified, this part holds. Page-margin constants (e.g. `doc.line(14, …, 196, …)`) are fixed x-coordinates, which is normal for PDF margins, not the kind of brittle "assumed content height" hardcoding this constraint is meant to prevent. Treat "no hardcoded bounds" as applying to *content-dependent* positioning (table heights, row counts, section breaks), not page margins.

## 3. Domain constraints (finance/statutory, not code-enforced but must be respected in any output)

- Schedule III of the Companies Act, 2013 governs Balance Sheet and P&L format for Indian companies — line-item groupings and ordering are not stylistic choices.
- IND AS 7 governs Cash Flow statement presentation (Operating/Investing/Financing classification).
- IND AS 21 governs functional vs. presentation currency — the Trial Balance's recorded currency (set at upload time) is independent of the top-bar "presentation currency" selector; converting one does not change the other.
- IND AS 12 governs tax recognition — see `DECISIONS.md` §2 for how this platform models it given incomplete source data.
- Anything not derivable from a Trial Balance (PPE gross block/asset register, IND AS 19 actuarial DBO, ECL invoice-level ageing, IND AS 102 ESOP register, IND AS 116 lease schedules) must be disclosed as out of scope, not silently omitted or estimated — matching the Upload tab's own UI copy.
