# ZOHO-RECORDS.md — the read-only mirror of Zoho Books' individual records

> Added 2026-09-21. The statement sync (`ZOHO-DATA-AUDIT.md`) reads Zoho's **reports**. This reads the **documents behind them**:
> invoices, bills, journals, payments, expenses, bank transactions, GST fields, fixed assets, orders and the master data.
> It is additive and read-only: no report code, `tb-engine.ts`, statement ingestion or existing table is touched, so report numbers cannot change.

## What is read (measured on a real org, 2026-09-21)

| Group | Modules | Read as |
|---|---|---|
| Sales | invoices, credit notes, sales orders, estimates, retainer invoices, sales receipts, delivery challans, customer payments | list + one detail call each (line items, GST, applied documents) |
| Purchases | bills, vendor credits, purchase orders, vendor payments | list + detail |
| Books | manual journals, expenses | list + detail (expense detail is opt-in: one call per expense) |
| Banking | bank accounts, bank transactions (one listing per bank account) | list only (the list row is complete) |
| Master data | chart of accounts, items, taxes, tax exemptions, currencies, users, locations, reporting tags, fixed assets, projects, recurring invoices / bills / expenses, budgets | list (fixed assets: + detail) |
| Zoho's own totals | tax summary (GST), sales by item, cash flow, receivables ageing, payables ageing | one dated snapshot per financial year |

Contacts stay in `zoho_contacts` (`contacts.ts`). **GST data** is the GST fields on each document (`gst_treatment`, `gst_no`, place of supply, HSN/SAC and tax per line, ITC eligibility on bills) plus the tax masters and the tax-summary snapshots. **Zoho's API has no GSTR-1 / GSTR-3B / GST-summary endpoints** (HTTP 404, measured), and its general-ledger report returns account totals only, so transaction-level data comes from the modules above.

## Tables (migrations `0006`, `0007`)

| Table | Holds |
|---|---|
| `zoho_records` | one row per Zoho record and company: the list row and the detail record as JSON (**everything Zoho returns**), plus typed columns to filter on (`doc_number, doc_date, due_date, status, contact_*, currency_code, exchange_rate, amount, base_amount, balance, sub_amount, tax_amount, gst_treatment, gst_no, place_of_supply, title, parent_id`) |
| `zoho_record_lines` | line items, journal legs and applied documents, with tax, HSN/SAC and ITC as columns |
| `zoho_record_history` | append-only: the previous version of any record that changed in Zoho |
| `zoho_module_state` | where each module's read has got to (pass kind, page cursor, bank-account cursor, incremental cursor, last error) |
| `zoho_api_usage` | Zoho API calls per company per day, and the "daily limit reached" block |
| `zoho_report_snapshots` | Zoho's report totals per period; same content = one row, changed content = a new row |
| `zoho_config` (+3 columns) | `api_daily_limit` (the plan), `consecutive_failures`, `next_attempt_at` (retry back-off) |

Every table has `company_id` and every query filters on it. **Nothing is ever deleted because Zoho removed it**: a complete listing flags `deleted_at`. A record that changes first has its old version copied to history.

**`base_amount` is never estimated.** It is Zoho's own base-currency figure (`bcy_total`, `bcy_amount`, `bcy_balance`), or the document's own amount when the document is in the base currency. A foreign-currency bill or credit note that carries no base figure keeps `base_amount` empty (same rule as the vendor fix in `ZOHO-DATA-AUDIT.md`).

## How a read works (`lib/services/zoho/records-sync.ts`)

- **Time-boxed slices.** A full first read is ~1,000+ calls, too long for one serverless request. `POST /api/v1/zoho/modules/sync` does one slice (40 s, `ZOHO_SLICE_MS`; set ~8000 on a plan whose functions time out at 10 s), saves where it got to, and returns `done` + `runStartedAt`. The Upload tab repeats the call until `done`; the cron carries on later. Every step is idempotent, so an interrupted slice costs only the calls it made.
- **Order:** every module's list first, then details module by module, then the report snapshots.
- **Incremental.** After a first full read, a module is asked only for records changed since its cursor (`last_modified_time`, proven on invoices, bills, expenses, journals, both payment types). Modules with no such filter (bank transactions, masters; measured) are read in full, by the cron at most once a day.
- **Detail only when needed.** A record needs its detail call when new or when Zoho's modified time moved.
- **Removals.** A *complete full* listing flags records Zoho no longer lists (never an incremental one; never when Zoho returned nothing while records are stored). The scheduler forces a full listing weekly.
- **Failure handling per module/record:** an endpoint Zoho rejects is reported once and left alone until the next run; a detail that fails is retried in later slices, three times, then left; a 404 on detail marks the record removed.

## API budget (`budget.ts`, `usage.ts`)

Zoho Books allows a fixed number of calls a day per organisation (Free 1,000 · Standard 2,000 · Professional 5,000 · Premium/Elite/Ultimate 10,000) and 100 a minute.
- Owner decision (2026-09-21): record reads may use **up to 80% of the day's allowance, counting every Zoho call that day**; the rest always covers a statement sync. `zoho_config.api_daily_limit` holds the plan (default 1,000; set from the Upload tab).
- Pacing ≤ 80 calls/min. `callZoho` counts each call in memory and writes the day's total once per slice.
- Zoho's own daily-limit answer (code 45) is final: no retry, the company is blocked for an hour, then one probe.
- **A failing sync retries with back-off** (15 min → 1 h → 6 h → 24 h) instead of every cron tick. Before, a stuck company retried each tick at ~40 calls: up to ~3,800 a day of a 5,000 allowance.
- **Frequency cost:** one statement sync is ~45 calls, so a 15-minute schedule is ~4,300 calls a day (86% of Professional). The Upload tab shows the projected cost and warns from 50%.

## Scheduling (`/api/v1/internal/zoho-records-cron`, `vercel.json` every 30 min)

Only companies whose admin has already started a first read are touched. A tick reads what has gone stale (hourly, or daily for a daily schedule), carries on an open pass, and reads pending detail. A lost connection backs the company off like a failing statement sync.

## Who can do what

- **Read** stored records / status / snapshots: `admin, cfo, ceo, auditor` (`ROLE_SETS.zohoRecords`). Bank transactions, contact and user details are in there.
- **Start** a read, change the plan: `admin, cfo`.

## Files

`lib/services/zoho/`: `modules.ts` (registry + pure extraction) · `records-sync.ts` (engine) · `records-cron.ts` · `budget.ts` · `usage.ts` · `health.ts`. `lib/ingestion/zoho-records.ts` (the one write path) · `lib/db/queries/zoho-records.ts`. Routes under `app/api/v1/zoho/{modules/sync,modules/status,records,report-snapshots}` and `app/api/v1/internal/zoho-records-cron`. UI: `components/dashboard/ZohoDataPanel.tsx` (Upload tab). Tests: `zoho-modules`, `zoho-records-ingest`, `zoho-records-sync`, `zoho-records-cron`, `zoho-budget`, `zoho-health`.

## Deploying

`0006` and `0007` are applied on main (2026-09-21); apply them before the new code on any other database (dry run alone first; the old code keeps working on the new schema). Then set the Zoho plan on the Upload tab (Real Variable: Professional) and start the first read from the panel. The new build encrypts the stored Zoho token when it next refreshes: do not run the old and new builds against one database after that.

## Verification (2026-09-21, real org "Real Variable", read into the Neon test branch)

**Counts equal Zoho's own totals** — 6,721 records in 18 modules (bank transactions 3,341 · expenses 2,041 · bills 417 · vendor payments 322 · chart of accounts 299 · journals 214 · invoices 24 · customer payments 15 · …), 2,935 line rows, 12 report snapshots, 22 MB with indexes. The first full read took ~1,100 calls; a second full read of everything changed **0 rows** and used 55 calls.

**Checked against figures Zoho produced independently of the records:**

| Check | Result |
|---|---|
| Every journal: debits = credits | 214 of 214 (2,083 legs). One journal's Zoho *header* total (−7.3M) disagrees with its legs; the legs balance |
| Invoice and bill line items add up to the document's sub-total | 24 of 24 and 417 of 417 |
| GST: document tax = sum of its line taxes | 24 of 24 invoices, 417 of 417 bills (input tax on 228 GST bills ₹19.4 lakh) |
| Base amounts never guessed | every INR document: base = amount; 20 of 20 foreign invoices carry Zoho's own `bcy_total`; the one foreign credit note with no base figure stays empty |
| **Zoho's Sales by Customer report (read live) vs invoices − credit notes, FY 2025-26** | **all 12 months tie to the paisa** (FY total 40,419,095 − 7,943,508.42 = 32,475,586.58); the two months that differ from invoices alone are exactly the two credit notes (6,450,000 and AED 64,000 × 23.336069) |
| **Payables ageing as at today vs stored bill balances** | **exact for all 12 vendors** (1,183,756.78) |
| Receivables ageing as at today vs stored invoice balances | 2 of 3 customers exact (the USD one within 0.01); one differs by 80,317.00 — not an invoice: the customer's own outstanding receivable in Zoho equals the ageing, so it is a customer-level item (opening balance or a journal against the customer). **The later ageing work must include those.** |
| Bank: latest running balance vs Zoho's book balance, and the sum of transactions | equal for all 8 accounts that have transactions, to the paisa |
| Expense line detail (sample of 43) | all with GST treatment and per-line ITC eligibility; line sub-totals and taxes match the document, 0 mismatches |

**Through the real route handlers, in-process** (42 checks): status/records/report-snapshots refuse manager and viewer (403) and anonymous (401); CEO and auditor can read but not start a read; another company's admin sees 0 bills and gets 404 for this company's bill by id; a hostile search string is just a search; a plan limit that is not a Zoho plan is refused (400) and changing only the plan makes no Zoho call; no token appears in any response; a CFO-started incremental read with nothing changed made 1 call and changed 0 rows; a cron tick with nothing due made 0 Zoho calls.

**Two defects found by this live run and fixed** (both invisible to unit tests, both now covered by them):
1. **Bank transactions collided.** The same `transaction_id` appears under several bank accounts (a transfer is one id on both sides; one id was under six accounts), so keying by id alone overwrote 279 of 3,341 rows. Fan-out records are now keyed by parent **and** id. (History had kept the overwritten versions.)
2. **A timestamp precision bug.** `pg` returns `Date` objects, and `Date.parse(date)` drops milliseconds, so the first module read in a run looked "not yet read" and was listed twice. State is now normalised to ISO strings on load.
And one design gap: as-at reports (ageing) were only read as at each year's end; they are now also read as at **today** when no financial year covers today.

**A false disconnect, found on production and fixed.** At 07:45 UTC the old build still running on `:4000` tried to refresh the expired Zoho access token in its scheduled sync, was refused twice, and marked Real Variable's connection inactive ("not connected" from then on). Zoho still accepted the same refresh token minutes later (HTTP 200), so nothing was revoked. Zoho refuses refresh requests when it sees too many (~10 per 10 minutes) — the client's own comment records the same false disconnect happening before — and my test scripts, each of which requested a fresh access token in memory, may have added to that volume around then; I can't rule it out. `refreshZohoToken` now keeps the connection when the refusal is a rate limit ("Access Denied … too many requests") and deactivates only when the token itself is rejected (`invalid_code`…). **The production config row was not changed**: it is still inactive with a valid refresh token; reconnecting from the Upload tab, or reactivating the row, restores it. Do that after `:4000` runs the new build, otherwise the old build resumes its failing 15-minute retries.

**Tests:** 36 suites / 669 tests (was 27 / 519); the Zoho record suites add 175 (registry and extraction, the write path with a fake database, the reading engine with a fake store/HTTP/clock, the cron, the quota and back-off arithmetic, `callZoho` limits, the usage counter, state normalisation). Type-check of every file this feature touches is clean.

**Build:** the whole-project `tsc --noEmit` is clean, and `next build` compiles successfully (78 s, with Next's own type validation). It then ran out of memory in the last step, "Generating static pages (0/53)", because the machine had under 0.1 GB of RAM free — a machine limit, not a code error, but the build has therefore not run to completion. **Not verified here:** the Upload-tab panel in a browser (no server could be built to serve it). Do both when memory is free (`VERIFICATION.md`).

## Not done here (next plan)

Using the data: invoice/bill drill-down under customers and vendors, AR/AP ageing from balances, GST input/output summary, bank register, fixed-asset register, and reconciliation checks against the statements. Contacts remain joined to reports by name (`DB-PHASE-1.md`).
