# DB-PHASE-1.md — Backend & database redesign, Phase 1 (2026-09-19)

> [!NOTE]
> Phase 1 of the database plan. Phase 0 (`DB-PHASE-0.md`) made the data safe; Phase 1 fixes the structure. The owner approved it on 2026-09-19 as **Phase 1 only**. Phases 2–3 are outlined in §7 and each needs its own plan and approval.
>
> **Report numbers:** unchanged on today's data. 84/84 report bundles are identical to the pre-Phase-0 baseline (§5). The one approved change is the Balance Sheet "Surplus" line (§3.5). It appears only for a trial balance that balances, and none stored today does.

## 1. Why

Measured on the live database and code before starting:

| Problem | Evidence |
|---|---|
| Syncs wrote identical copies | 23 of 29 Zoho syncs (79%) changed nothing but still wrote a full new copy of the year; 92% of `tb_ledgers` rows were old copies |
| Raw Zoho JSON bloated the batch table | `tb_uploads` was 4.7 MB for 37 rows, because every raw response was stored again inside every batch |
| No stable ledger identity | Rows are re-created on every sync, so Report Builder linked ledgers **by name** and a renamed Zoho account silently lost its report line |
| Two separate write pipelines | Excel (`tb/upload`) and Zoho (`zoho.ts`, 1,611 lines) each did lock → validate → supersede → insert their own way |
| Every Balance Sheet showed "Out of Balance" | `computeBS()` never carried the period's profit into equity |

## 2. Decisions (owner, 2026-09-19)

| Topic | Decision |
|---|---|
| Scope | **Phase 1 only.** Phases 2–3 are an outline. |
| Balance Sheet profit | **Add the line**: "Surplus — profit for the period (as booked)" in Note 2 Other Equity. It is the only approved `tb-engine.ts` / Balance Sheet change. |
| Old copies | **Clean up with a safe window.** Keep the current batch, the newest 5 superseded, anything current in the last 90 days, and locked years. Nothing is deleted on main until the owner approves the dry-run list. |
| Migrations applied to main by mistake in Phase 0 | **Keep** (see `DB-PHASE-0.md` §5.1) |

## 3. What changed

### 3.1 One ingestion pipeline (`lib/ingestion/trial-balance.ts`)

`ingestTrialBalance()` is now the **only** write path for trial-balance data. Each source parses and maps its data into `NormalizedLedger[]` and hands it over. Everything that must be identical for every source happens there, in one transaction:

1. Duplicate check and the Dr/Cr summary (before the transaction).
2. Lock, year lock and "first source owns the year".
3. Same-file check.
4. Content check (§3.2).
5. Supersede the current batch.
6. Insert the batch, its ledgers and its entity rows, 500 rows per statement.
7. Store the raw payloads (§3.3).
8. Record the owning source.

It returns `{status: 'created' | 'no_change', uploadId, summary, replacedSource}`.

**Excel** (`app/api/v1/tb/upload/route.ts`) keeps only parsing, template detection and mapping. Then it calls the service.

**Zoho:** `lib/services/zoho.ts` became `lib/services/zoho/`, with no change to the public exports (`index.ts` re-exports them):

| File | Holds |
|---|---|
| `client.ts` | tokens, `callZoho`, single-flight refresh |
| `classify.ts` | the account-type classifier |
| `assemble.ts` | the pure ledger assembly (`assembleZohoLedgers`) |
| `map.ts` | name → code → normalised-name mapping, with the classifier fallback |
| `contacts.ts` | the contact directories |
| `sync.ts` | orchestration: fetch → assemble → map → **ingest** |

The ~250 lines of Zoho insert code are gone.

**New Zoho guard:** if any monthly P&L or Balance Sheet report fails, the sync now **stops without writing**, with the message "Zoho sync incomplete … The previous data was kept; the next sync will retry."
- Before, a failed month (rate limit, timeout) still replaced good data with a batch that had a hole in it.
- Sales-by-customer, bills and expenses stay non-fatal, as before.

### 3.2 Skip unchanged syncs (migration `0003`)

- `tb_uploads.content_sha256` holds a SHA-256 of the batch's **content**: every amount rounded to paise, independent of row order, plus the customer/vendor rows (`lib/ingestion/content-hash.ts`, pure and tested).
- A batch that predates the column is hashed from its stored rows the first time it's compared, then cached. No SQL backfill was needed.
- **Same content as the current batch:**
  - **Zoho:** no new batch. The sync log says `no_change`, `zoho_config` records a successful sync (so the schedule keeps working), and the report cache is kept. The UI says "Zoho Books is up to date — nothing changed since the last sync".
  - **Excel:** 409 `NO_CHANGE`, "exactly the same figures as the current Trial Balance". This is on top of the byte-level `DUPLICATE_FILE` check.
- Expected effect: about 80% fewer batches from now on.

### 3.3 Raw Zoho responses stored once (migration `0004`)

- **`raw_payloads`:** one row per distinct response per company (`UNIQUE(company_id, sha256)`, with the hash computed by Postgres over the canonical JSONB).
- **`upload_raw_payloads`:** which responses a batch used, under which label (`P&L Apr`, `BS Opening`, …), period and fetch time.
- **The migration copied** all 1,158 existing entries, then checked that each one is reachable with identical JSON. The old `raw_zoho_months` column was left as it was.
- **New syncs** no longer write `raw_zoho_months`. Zoho's volatile `page_context` access timestamps are stripped before hashing, so an unchanged month really is stored only once.
- **Reading:** `loadBatchRawPayloads()` reads the store, and falls back to the old column for a batch that has no links.

### 3.4 Stable account identity (migration `0005`)

- **`ledger_accounts`:** one row per real account per company and source. `ledger_account_key()` defines the identity once, in SQL:

  | Source | Identity |
  |---|---|
  | Zoho | the Zoho account id; the Phase 0 brought-forward line uses `ZOHO-RE-BF` |
  | Excel | the ledger code, else `name:` + the lowercased, trimmed name |

- **`tb_ledgers.account_id`** is **NOT NULL**. It was backfilled for every existing row, and the trigger `trg_tb_ledgers_assign_account` assigns it on every insert. That covers every writer: the pipeline, `seed.ts`, and the old code still deployed.
  - A rename in Zoho just updates the account's name.
  - On main: 263 accounts.
- **Report Builder links** (`report_line_ledgers.account_id`):
  - A link is resolved to an account when exactly one of the company's accounts has that name. Ambiguous names stay name-only, as before.
  - A link is read back as the account's **current** name, so a renamed Zoho account keeps its report line.
  - On main: all 4 existing links were resolved.
  - **Link order is now defined** (found in the 2026-09-20 end-to-end test, `LATENCY.md` §7). The links table has no sequence column, so the order of a line's ledgers was always whatever plan the database picked, and the `LEFT JOIN` above changed it by accident. Both loaders now order by the ledger's current name, then id. Verified on main: the same links as the old query (as a set, duplicates included), identical order on repeated runs, and the Report Builder run's numbers unchanged.
- **Reclassify** targets rows by `account_id` instead of `ledger_code`. That also covers Excel ledgers without a code.

### 3.5 Balance Sheet: "Surplus — profit for the period (as booked)"

`withPeriodSurplus(ledgers)` in `tb-engine.ts` adds one system row: code `SYS-PL-SURPLUS`, Note 2 Other Equity, Cr, `is_system: true`, opening 0.
- **Monthly movement:** each month's booked P&L result (income Cr − expense Dr). The engine's modelled tax isn't in the books, so it isn't included; hence "as booked".
- **Only for a genuine pre-closing trial balance**, i.e. opening and every month Dr = Cr within ₹1 (`summarizeTrialBalance`).
  - **Sample data** already balances without it (its equity includes profit, so it isn't Dr = Cr) and is left alone.
  - **An unbalanced upload** keeps its real "Out of Balance" warning. It isn't masked.
- **Applied per financial year, before the CY merge,** through `loadStatementLedgers()` (`lib/db/queries/reports.ts`). The report routes use it, and so does `compute-local.ts` for Sample mode.
  - Custom metrics get `bookedRowsOnly()`.
  - Report Builder and the raw ledger APIs keep `loadLedgers()`.
  - So a system row is never seen outside the statements.
- **Engine changes, the only ones:** `computeCashFlow` ignores system rows in the equity movement (otherwise profit would count twice), and `TbLedgerRow` gains the optional `is_system`.
- **Effect today:** none. 0 of 37 stored batches balance, so no line is added (parity 84/84).
- **Effect after Zoho is reconnected** and each year re-syncs with the Phase 0 fixes: the Balance Sheet balances in every period view.
  - It changes: the Balance Sheet, Note 2, and equity-based ratios (ROE, debt/equity).
  - It doesn't change: P&L, MIS, Cash Flow, Treasury, customers or vendors.

### 3.6 Old copies and the old raw column — behind an approval gate

Two scripts share one gate (`db/scripts/script-support.ts`):
- `--target` is required, and so is one of `--dry-run` / `--apply`.
- The dry run prints the exact list and a **list id**, a fingerprint of that list.
- `--apply --confirm=<list id>` recomputes the list inside one transaction, under the app's trial-balance write locks (`lib/db/tb-write-lock.ts` is the shared key). **A list that changed since the dry run is refused.**
- Row counts are checked, and every change is audited in `audit_trail` (one row per company, user "Maintenance script").

**`db/scripts/retention.ts`** deletes superseded batches outside the policy (`--days=90`, `--keep=5` by default).
- **A batch's age** is counted from when it was *replaced*, i.e. when the next batch was uploaded. No batch is ever made current again.
- **Cascades:** ledger, customer and vendor rows, and raw-payload links. Stored responses that nothing links to any more are removed too.
- **Never removed:** ledger accounts.
- It replaces the read-only `retention-report.ts`.

**`db/scripts/clear-raw-zoho-months.ts`** empties the old column for a batch only if **every** entry is in the new store with the same JSON, label, period and fetch time, and the entry holds nothing else.
- Locked years are skipped.
- The column itself stays; dropping it is a later migration.

```bash
npx tsx db/scripts/retention.ts --target=branch --dry-run
npx tsx db/scripts/retention.ts --target=branch --apply --confirm=<list id>
npx tsx db/scripts/clear-raw-zoho-months.ts --target=main --dry-run
```

> [!CAUTION]
> As with migrations: call these with `npx tsx` directly, never through `npm run … --`. Always read the dry run on its own before any apply.

**Status on main (2026-09-19):**

| Script | Dry-run result on main | Next step |
|---|---|---|
| Retention | Nothing is due. Everything is from Aug–Sep 2026, so the first deletions become possible from late November 2026. | Nothing to apply today. |
| Old-column clear | 31 batches (2 current), 1,158 entries, all verified. List id `426d3108cea5`. | ✅ **Approved by the owner and applied on 2026-09-20** (re-checked first: the dry run still gave exactly that id). All 37 batches read back identical raw responses afterwards; `tb_uploads` 4.7 MB → 232 kB. See `LATENCY.md` §5.4. |

## 4. Deploying

1. Migrations `0003`–`0005` are **already live on main**, applied after the branch test.
   - The deployed (old) code works with them: `account_id` is filled by trigger, and the new columns are optional.
2. The Phase 0 prerequisites still stand, and Phase 1 ships with them:
   1. In Vercel, set `TOKEN_ENCRYPTION_KEY` (the same value as `.env`) and `CRON_SECRET`.
   2. Deploy.
   3. Encrypt the stored token on main (`encrypt-existing-zoho-tokens.ts --target=main`, dry run first).
   4. Reconnect Zoho, so each year re-syncs with the Phase 0 opening fix. From then on, the Surplus line balances those years' Balance Sheets.
3. ~~Clear the old raw column on main~~ — **done 2026-09-20** with the owner's approval of list `426d3108cea5` (`LATENCY.md` §5.4).
4. **Added by the latency pass** (`LATENCY.md` §5): `vercel.json` now pins the function region to `iad1` and runs a keep-alive cron every 4 minutes (needs a Vercel plan that allows it, and costs Neon compute hours). It uses the same `CRON_SECRET` as the Zoho cron.

## 5. Verification

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ 0 errors |
| `next build` (into a separate `NEXT_DIST_DIR`, so the running :4000 server was untouched) | ✅ compiled in 84 s; 47/47 pages generated |
| `npm test` (`--runInBand`) | ✅ 21 suites, 470 tests. Phase 1 added `ingestion`, `content-hash`, `period-surplus` and `script-support`. |
| 1.1 Pipeline refactor: replay of stored Zoho responses through the new path | ✅ 0 mapping and 0 amount differences; 203 vs 202 rows, the extra one being the Phase 0 brought-forward line |
| 1.1 Live API smoke test on the branch | ✅ 18/18 (the Phase 0 list, rerun on the new pipeline) |
| 1.2 Same content twice | ✅ second run `no_change`, nothing written; a stored batch's hash equals the incoming hash |
| 1.3 Raw payload copy (`0004`) | ✅ every entry reachable with identical JSON; a replayed sync stored 37 responses once, then 0 new |
| 1.4 Accounts (`0005`) | ✅ every ledger row has an account (263 on main); 4/4 Report Builder links resolved; a simulated rename keeps the account id and the report line |
| 1.5 Surplus line: replay of FY 2025-26 with the correct opening | ✅ Balance Sheet difference 0.00 in all 7 FY views (annual, Q1–Q4, H1–H2); P&L, MIS and Cash Flow identical with or without the line |
| 1.5 Calendar-year views | ✅ unit test on two balanced years: the CY merge carries the surplus across 31 March |
| **Parity on main after all of Phase 1** | ✅ **84/84 bundles identical** to the pre-Phase-0 baseline; loader rows identical |
| 1.6 Gate | ✅ a wrong list id, a missing id or no mode are all refused, and nothing changes |
| 1.6 Branch run, with a tighter **test-only** policy (1 day / keep 2) to exercise deletion | ✅ 29 batches (5,699 ledger rows) and 950 unused responses deleted; 3 old columns cleared; `tb_uploads` 4.8 MB → 232 kB |
| 1.6 After the branch run | ✅ 84/84 bundles identical; the 19 surviving batches read identical raw responses; 0 ledgers without an account; 0 orphans; every year still has exactly one current batch; 2 audit rows |
| 1.6 Main | Dry runs only (§3.6) |

## 6. Design notes (deliberate choices)

- **Account identity is per source.** A year switched from Zoho to Excel gets Excel account identities. Zoho ids and Excel codes aren't comparable, and guessing a match would be worse than a clean break.
- **The CY merge still keys by code or name, not `account_id`.** A calendar year can span a Zoho year and an Excel year, whose account ids differ. The existing key is proven by parity; switching would risk splitting one account into two lines.
- **Contacts are still joined to customers and vendors by name** in `reports/all`. The engine output doesn't carry the vendor/customer id yet. This is a Phase 2 item.
- **Deleting a superseded batch in the app** (`DELETE /tb/:id`) leaves its stored raw responses behind if nothing else uses them. `retention.ts` sweeps those up, so the app route stays a single-year operation.
- **The old `raw_zoho_months` column is emptied, not dropped.** Dropping it waits until no deployed code could still write it.

## 7. Known leftovers and next phases

- **The Acme demo data is itself unbalanced** (Excel seed). Correcting it changes data, so the owner's decision is pending. Until then, Acme's Balance Sheet keeps its real "Out of Balance".
- `db/init.ts` still re-applies two `UPDATE tb_ledgers SET note_no=…` statements that touch every batch.
- **OAuth state isn't bound to the browser.**
- **Phase 2, monthly ledger** (own plan):
  - `ledger_period_balances` keyed by real dates;
  - versioned `account_mappings`, so reclassify records a version instead of rewriting rows;
  - dual-write, then switch reads over;
  - `cy-merge.ts` retired;
  - contacts joined by id.
- **Phase 3, audit-grade:**
  - report snapshots on year lock and board-pack publish;
  - month locks;
  - row-level security on `company_id`;
  - shared rate limiting and cache;
  - a document store for the AI assistant;
  - Tally and QuickBooks sources.
