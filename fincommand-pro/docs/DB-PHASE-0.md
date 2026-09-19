# DB-PHASE-0.md — Database safety fixes (2026-09-19)

> [!NOTE]
> Phase 0 of the database improvement plan. It makes the database safe; it is not a redesign. **No report number changes.** A before/after parity check across every company, year and period view is the proof (§5). The owner approved the plan and the decisions below on 2026-09-19. The redesign (monthly rows, stable account ids, snapshots) comes in later phases, each with its own plan.

## 1. Why

A senior review of the live database found that the rules protecting the financial data existed only in application code, or nowhere. It also found secrets exposed. What was wrong:

**Data integrity**
- Nothing stopped two "current" batches for one year.
- Nothing stopped the same ledger appearing twice in one batch.
- Nothing stopped overlapping financial years.
- Three CHECK constraints accepted any value at all. They were written `IN (…, NULL)`, which is never false.
- Debits vs credits were never checked, and the difference was never recorded.

**Duplicates and races**
- `ledger_master` had no unique rule. Every `ON CONFLICT DO NOTHING` insert added a copy anyway, so there were 1,370 rows for 639 real mappings. `db:init` always failed as a result.
- Excel and Zoho overwrote each other's data for the same year.
- Nothing serialised two writers for the same year.
- Manual sync, reclassify and batch delete ignored the year lock.
- A failed sync left its status stuck on "running".

**Secrets**
- Zoho access and refresh tokens were stored in plain text. They were also sent back to the browser by `PUT /zoho/config`.
- The OAuth `state` was an unsigned company id.
- The cron endpoint was open when `CRON_SECRET` was unset.

**Runtime and caching**
- Schema changes happened at runtime: `neon.ts` ran an `ALTER TABLE` on every cold start, and `zoho.ts` had "column missing" fallbacks.
- The report cache is per server instance, so after an upload another instance could serve stale numbers for 15 minutes.

## 2. Decisions (owner, 2026-09-19)

| Topic | Decision |
|---|---|
| Debit = credit | **Warn and record.** Totals and differences are stored on every batch and shown; nothing is blocked. |
| Excel vs Zoho for one year | **The first source owns the year.** A switch needs confirmation, and the scheduled sync skips years owned by Excel. |
| Migrations | **Small built-in runner**, no new dependency. |
| Missing token key | **Hard error.** Tokens are never stored in plain text. |
| Git | Checkpoint commit first (`d2a0cf9`, branch `db-phase-0`, local only; `zoho_debug_*.json` excluded). |
| Test database | A Neon branch (`BRANCH_DATABASE_URL`). Everything runs there first, then on main. |
| `ledger_master` duplicates | **Newest wins, and the rest are backed up.** Active rows are preferred. |
| Zoho opening-balance imbalance | Fixed separately, right after Phase 0. It is meant to change numbers. |

## 3. What changed

### 3.1 Migrations (`db/`)
- **`migrate.ts`**: the CLI. It supports `--status`, `--dry-run` and `--target=branch`, and it prints no connection details.
- **`migrate-runner.ts`**: applies the migrations. Each file runs in its own transaction and is recorded in `schema_migrations` with a checksum. A file edited after it was applied is refused. The per-transaction advisory lock is safe on Neon's pooler.
- **`migrate-core.ts`**: pure helpers, unit-tested.
- **npm scripts**: `db:migrate` and `db:migrate:status`.
- **`schema.sql`** is now a frozen baseline. `db:init` runs the migrations after it, and its seed upsert now has a real unique index behind it.

**`migrations/0000_baseline.sql`** is a marker only.

**`migrations/0001_integrity.sql`** is non-destructive. It runs a pre-flight check first and stops before changing anything if existing data breaks a rule. Then it:
- makes `company_id`, `financial_year_id` and `upload_id` NOT NULL on all trial-balance tables
- adds `CHECK (start_date < end_date)` and a no-overlap `EXCLUDE` constraint to financial years (using `btree_gist`)
- adds `financial_years.data_source` (`zoho`|`excel`), backfilled from each year's current batch
- replaces the old current-batch index with **UNIQUE** `uq_tb_uploads_one_current`, so there is at most one current batch per company and year
- adds **UNIQUE** `uq_tb_ledgers_upload_ledger` on `(upload_id, lower(btrim(name)), code)`. It uses name **and** code because the standard chart legitimately has "Amortisation — Intangibles" under both 1023 (balance sheet) and 7032 (P&L).
- fixes the three `IN (…, NULL)` CHECKs to `x IS NULL OR x IN (…)`
- adds new `tb_uploads` columns: `currency`, `file_sha256`, `total_dr`, `total_cr`, `balance_diff`, `is_balanced`, `validation`, `data_changed_at`. All are backfilled from existing rows; `currency` takes the company's currency, which is what reports showed until now.

**`migrations/0002_ledger_master_dedupe.sql`** is **destructive, and approved**. It keeps one row per company + code (or company + name when there is no code): active first, then latest `updated_at`, then latest `created_at`, then highest id. It copies every other row into `ledger_master_dedupe_backup` (with `kept_id`) before deleting it. It then adds partial unique indexes `uq_ledger_master_code` (NULLS NOT DISTINCT, so global rows are covered) and `uq_ledger_master_name_without_code`. A post-check aborts the migration if the remaining count isn't exactly the number kept.

**`lib/db/neon.ts`**:
- The startup `ALTER TABLE dashboard_widgets …` is removed. Its list was identical to `schema.sql` and to the live constraint, checked before removal.
- The 3-minute keep-alive ping is removed, so Neon can scale to zero. The connection timeout is now 30 s on both configurations, to cover a cold start.

**`zoho.ts`**: the "retry without column X" fallbacks are removed, because migrations guarantee those columns.

### 3.2 Write paths

**Shared pieces**
- `lib/financial/tb-validation.ts` (pure, tested):
  - `summarizeTrialBalance()`: sums in whole paise, same arithmetic as the 0001 backfill
  - `describeImbalance()`
  - `decideSourceOwnership()`
  - `findDuplicateLedgers()`
- `lib/db/queries/tb-batches.ts`:
  - `lockTrialBalanceWrite()` takes a per-transaction advisory lock for the company + year, with a 15 s `lock_timeout`, then re-reads the year `FOR UPDATE`.
  - Also `assertYearUnlocked()`, `setYearDataSource()` and `TB_UPLOAD_PUBLIC_COLUMNS`.

**Excel upload** (`tb/upload`)
- Duplicate ledgers in the file → 422, listing them.
- Takes the lock and re-checks the year lock.
- A Zoho-owned year → 409 `SOURCE_OWNED`, unless the user confirmed the replacement.
- The same file as the current batch → 409 `DUPLICATE_FILE`.
- Stores currency, hash, totals and validation on the batch.
- Inserts ledgers with a multi-row insert, 500 per statement, instead of one query per row.
- The mapping now prefers **company rows over global ones**. It used to prefer global rows, so reclassifications never stuck for Excel.

**Zoho sync** (`syncFromZoho`)
- The year-lock and ownership checks run **before** the "running" slot is claimed.
- A scheduled sync skips an Excel-owned year. A manual sync gets `SOURCE_OWNED`.
- Takes the lock inside the transaction.
- Stores totals, validation and currency on the batch.
- The mapping order is fixed, with company rows winning.
- `.catch(() => {})` is removed from the `ledger_master` insert.
- **Any failure after the claim marks both `zoho_config` and `sync_logs` as error.** Before, a failure inside the transaction left both stuck on "running".
- The sync route no longer overwrites `zoho_config` for rejections, which used to clobber the status of a sync that was genuinely running.
- The cron query leaves out Excel-owned years.

**Reclassify**
- Runs as one transaction and locks every affected year, in a fixed order.
- A locked year → 403. Only **current** batches of **unlocked** years change. Before, it rewrote every batch in every year, locked ones included.
- The mapping is an upsert that reactivates the row.
- Bumps `data_changed_at` and writes a `TB_RECLASSIFY` audit entry with old and new values.

**Smaller routes**
- Batch delete: lock check plus a `TB_UPLOAD_DELETE` audit entry with the deleted batch's details.
- FY POST: friendly overlap and bad-date messages.
- `GET /tb`, `/tb/current`, `/tb/:id/ledgers`: explicit columns, so `raw_zoho_months` is no longer sent to the browser. `/tb` uses a `LEFT JOIN` to users, so scheduled-sync batches show.

**Errors**
- `ApiError` carries a `code`, and `withErrorHandling` returns it.
- Friendly messages for `23P01` (overlap), `23514` (rule) and `55P03` (busy → 409 `BUSY`).

**UI (`UploadTab`)**
- A confirm dialog for `SOURCE_OWNED`, on both upload and sync.
- Shows the balance warning after an upload, and in the sync toast.

### 3.3 Read path and cache
- The report loaders read by `upload_id = (current batch id)` and keep the `company_id` filter. The rows are identical (§5).
- `reports/all` takes `source_currency` from the **batch**. Changing the company currency now only affects the next upload, instead of re-labelling history.
- The cache key includes a **data version**, computed in one query over:
  - current batches and their `data_changed_at`
  - years: dates, labels and locks
  - `companies.updated_at`
  - custom metrics: latest update + count
  - latest Zoho contact sync
- `audit_summary` is deliberately left out. Every login writes an audit row, so including it would defeat the cache; its up-to-15-minute staleness is existing behaviour.
- Expired cache entries are swept when a new entry is stored.

### 3.4 Security
- `lib/security/token-crypto.ts`: AES-256-GCM, format `enc:v1:iv:tag:ct`.
  - Encrypts at both write sites (callback, token refresh) and decrypts at every read (`decryptZohoConfig`).
  - Old plain-text values still read.
  - A missing key is an error.
- `db/scripts/encrypt-existing-zoho-tokens.ts`: a one-off with dry run and a round-trip check. It prints counts only.
- `PUT /zoho/config` returns explicit columns and **no tokens**.
- `lib/security/oauth-state.ts`: HMAC-signed state that expires after 10 minutes. The callback verifies it **before** exchanging the code, and checks that the user who started the flow is still an admin or CFO of that company.
- `/internal/zoho-cron` fails closed in production without `CRON_SECRET`.
- `.env.example` documents `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET` and `BRANCH_DATABASE_URL`. The local `.env` got a generated key, which was never printed.

### 3.5 Housekeeping
- Login deletes refresh-token rows that have been expired or revoked for 30+ days. It's fire-and-forget, and a failure is logged.
- `db/scripts/retention-report.ts` was **read-only**. It listed superseded batches older than N days in unlocked years, with their size. Today (90 days) there are none; everything is from Aug–Sep 2026. *(Replaced in Phase 1.6 by `db/scripts/retention.ts --dry-run`, which prints the exact list; see `DB-PHASE-1.md`.)*

### 3.6 Zoho sync — why its trial balances didn't balance, and a failing scheduler (found 2026-09-19)

These were found while checking the review's "investigate the Zoho difference" item. Each was proven against the raw Zoho responses already stored in `tb_uploads.raw_zoho_months` (read-only).

1. **The opening snapshot was taken one day early.** `pg` returns a DATE as a JS Date at *local* midnight. On a machine in India (UTC+5:30), 1 April is 31 March in UTC, so "the day before" became **30 March**.
   - The stored opening dates are 2024-03-30 and 2025-03-30. Every year-end entry dated 31 March was missing from the opening and landed in April instead.
   - For FY 2025-26, the Balance Sheet gap moves by exactly **94,249.53** between 30 and 31 March, which is exactly April's imbalance.
   - The same mistake bucketed vendor bills and expenses one month late (March's were dropped), and sent `date_start` to Zoho as a timestamp.
   - **Fix:** dates are read as `YYYY-MM-DD` text, and `dayBeforeISO()` works on that text.
2. **The earnings brought forward were missing.** Zoho shows profit not yet closed into an account as "Current Year Earnings", a computed row with no `account_id`, so it was never a ledger. The opening trial balance was short by exactly that amount.
   - **Fix:** one ledger, "Retained Earnings — brought forward (Zoho opening)" (code `ZOHO-RE-BF`, Note 2 Other Equity, reclassifiable). Its value is the opening snapshot's leaf Assets − (Liabilities + Equity), the only figure that balances the opening. Nothing is estimated.
3. **29 February was lost in leap years.** Month ends were a fixed list with `'02-28'`. They are now computed (`monthEndISO()`).
4. **Scheduled syncs failed with "Invalid URL Passed (code 5)", then "not connected".** After a token refresh, the sync kept using its stale in-memory config (old expiry). So every later request batch refreshed again: about 10 token grants in under a minute, where Zoho allows about 10 per 10 minutes.
   - Evidence: all 72 code-5 failures and all 18 "not connected" failures were scheduled runs, and 24 of the 28 successes were manual syncs, which start with a fresh token.
   - **Fix:** `refreshZohoToken()` updates the caller's config in place. *(This is a strong match for the evidence, but it can only be confirmed once Zoho is reconnected and the scheduler runs.)*

The ledger building moved into a pure, unit-tested function, `assembleZohoLedgers()`.

**Proof (replay of the stored responses):**
- **Refactor fidelity:** with the same inputs, the new function reproduces **every** stored amount. There are 0 mismatches over 233 + 202 ledgers × 26 amount columns; the only addition is the brought-forward line.
- **FY 2025-26 with the correct 31-March opening:**
  - Before: opening 1,788,324.47, April −94,249.53, closing 1,694,074.94.
  - After: opening, every month and closing are all **0.00**, so Dr = Cr.
- **Effect on the Balance Sheet (engine, before → after):**
  - Annual: the difference goes from 74,532.00 to 1,768,606.94. That is **exactly −profit** for the year.
  - Q1: the difference becomes **exactly −profit before tax**; the engine's modelled tax isn't in the ledgers.
  - So the one thing still keeping the Balance Sheet "Out of Balance" is that `computeBS()` doesn't add the period's profit into equity. That's a `tb-engine.ts` / Balance Sheet presentation change, which needs the owner's approval (§6).
- **Stored batches are not changed.** Each year is rebuilt correctly by its next sync once Zoho is reconnected. FY 2024-25 can't be repaired offline, because its 31-March-2024 snapshot was never fetched.

## 4. Deploying (order matters)

1. ~~`npm run db:migrate:main`~~ **Done** (§5.1).
   - The currently deployed (old) code is compatible with the new schema: it doesn't use the new columns, and it already satisfies every new rule.
   - The new code is **not** compatible with the old schema.
2. In Vercel, set:
   - `TOKEN_ENCRYPTION_KEY`: the **same** value as the local `.env`, because both read the same database.
   - `CRON_SECRET`, if it isn't already set there.
3. Deploy the code.
4. Only then run `npx tsx db/scripts/encrypt-existing-zoho-tokens.ts` on main. Until production runs the new code with the key, an encrypted token would be unreadable to it.
   - Also, until then, **don't reconnect Zoho from a local new-code server against main**: it would store encrypted tokens the old production code can't read.

## 5. Verification

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ 0 errors |
| `npm test` | ✅ 17 suites, 434 tests (+47: `migrate-core`, `tb-validation`, `security`, `report-cache-key`, `zoho-assembly`) |
| Zoho replay (§3.6) | ✅ 0 amount mismatches; FY 2025-26 Dr = Cr to the paisa with the correct opening |
| Baseline parity snapshot, main, before any change | ✅ 6 company-years × 14 period views = 84 report bundles. A second run was identical, so the snapshot is deterministic. |
| New loader SQL vs old, on main | ✅ rows byte-identical for ledgers, customer revenue, vendor expense and customer cost; 84/84 bundles identical |
| Mapping impact of the dedupe + ordering fix | ✅ 0 of 475 current ledgers would be classified differently on the next upload or sync |
| Retention report (read-only) | ✅ runs; none older than 90 days |
| Neon test branch created (`db-phase-0-test`) | ✅ separate endpoint; exact copy of main (same counts, same ledger fingerprint); pre-migration parity 84/84 identical to main's |
| **Migrations on main** | ⚠️ **Applied by mistake, before the branch test** (2026-09-19 10:52 UTC). See §5.1. |
| Parity on main, before vs after the migrations | ✅ 84/84 bundles identical; loader rows identical; `tb_ledgers` untouched (same 6,194 rows, same fingerprint) |
| `ledger_master` dedupe on main | ✅ 1,370 → 639 rows; all 731 removed rows in `ledger_master_dedupe_backup` |
| Owner's decision on main | **Keep** (2026-09-19) |
| Migrations on the branch | ✅ applied, so main and branch are in the same state (same migrations, indexes, fingerprint, 639 mappings / 731 backed up) |
| Backfill result | All 37 batches have totals; **0 of 37 balance** (the known Zoho and Acme-seed issues); each year's owning source recorded |
| Parity on the branch, before vs after | ✅ 84/84 identical; branch = main after |
| Constraint probes on the branch (all rolled back) | ✅ 15/15: second current batch, duplicate ledger, NULL company, bad section/treasury, overlapping or backwards year, bad `data_source`, duplicate company or global mapping, the three ON CONFLICT paths, and a second writer timing out |
| Token encryption on the branch | ✅ 1 row encrypted, decrypts correctly. **Main stays plain text until the new code is deployed with the key (§4).** |
| Live API smoke test on the branch (18 checks) | ✅ 18/18 — see the list below |
| Live UI on the branch | ✅ Acme (Excel) and Real Variable (Zoho): every main tab renders, no console errors; Balance Sheet shows the known "Out of Balance" (§6) |

**The 18 smoke checks.** Run on a dev server pointed at the branch, as the Acme CFO:
- Login and reports: numbers match the snapshot.
- The batch list sends no raw Zoho JSON.
- Uploads:
  - An unbalanced upload is saved with a warning, and its totals, hash and currency are stored.
  - An identical re-upload returns 409 `DUPLICATE_FILE`.
  - A file listing a ledger twice returns 422 `DUPLICATE_LEDGERS`.
  - Excel into a Zoho-owned year returns 409 `SOURCE_OWNED`; once confirmed it goes through, and the year becomes Excel-owned.
- Reclassify:
  - It changes only current data, is audited, and bumps the cache version.
  - The mapping sticks: the next upload used it.
- A locked year refuses upload, reclassify and delete. Deleting a superseded batch in an unlocked year is audited.
- Errors: a too-long value gives a clear 400; an overlapping year gives a clear 409.
- Zoho and cron:
  - Saving the Zoho config returns no tokens.
  - `auth-url` issues a signed state, and a forged state is refused.
  - The cron refuses a call without the secret.
| `npm run build` | ✅ verified after Phase 1 (`DB-PHASE-1.md` §5), built into a separate `NEXT_DIST_DIR` so the running :4000 server was untouched |

### 5.1 Incident: migrations reached production before the branch test (2026-09-19)

**What happened.**
- The intended command was `npm run db:migrate -- --target=branch --dry-run`, a dry run on the test branch.
- In Windows PowerShell, npm's `.ps1` shim drops the `--`, so neither flag reached the script. npm treated `--dry-run` as its own flag.
- The runner then used its default target, which was **main**, without a dry run. It applied `0000`–`0002` to production at 10:52 UTC.
- The status command run just before had already printed `Target: main`. It was chained in the same step as the apply, so nobody read it first.

**Impact (verified right after).**
- Financial data: untouched. `tb_ledgers` has the same 6,194 rows and the same fingerprint.
- Reports: every one of the 84 report bundles is identical to the pre-change snapshot.
- `0001` added only rules, and new columns filled from existing rows.
- `0002` removed 731 duplicate mapping rows from `ledger_master`. All of them are kept in `ledger_master_dedupe_backup`, and 0 of the 475 current ledgers classify differently because of it.
- The deployed (old) code is compatible with the new schema (§4).

**What was changed so it can't recur.**
- `--target` has **no default** any more, so a lost flag makes every script refuse to run.
- There are named npm scripts per target (`db:migrate:branch`, `db:migrate:main`), so no flags need to pass through npm.
- `--status` no longer creates anything; it created an empty table on the branch once, which was removed.
- `VERIFICATION.md` now says to read status/dry-run output before applying, never chained in the same step.

**Rollback, if the owner wants it.** Either:
- Neon **Restore** of the production branch to just before 10:52 UTC 2026-09-19 (within Neon's restore window), or
- a reverse script: put back the 731 rows from the backup table, then drop the new rules, columns and `schema_migrations`.

The test branch is untouched and holds the exact pre-migration state for comparison.

## 6. Known leftovers (not in this phase)

> [!NOTE]
> **Update:** Phase 1 (`DB-PHASE-1.md`) has since dealt with:
> - the Balance Sheet profit line (approved);
> - raw payloads and skipping unchanged syncs;
> - stable account ids;
> - retention deletes.

- **The Balance Sheet doesn't include the period's profit in equity** (`computeBS()` sums ledger balances only). Every Balance Sheet view today, for every company, shows "Out of Balance". After §3.6, the Zoho years' difference is exactly −profit.
  - The fix is a "Profit for the period" line in Other Equity, i.e. Surplus in the Statement of P&L under Schedule III.
  - It changes `tb-engine.ts` and the Balance Sheet presentation, so it **needs the owner's approval** first.
- **The Acme demo data is itself unbalanced** (the Excel seed: opening −84,980, movements −21,214). It is fixture data; correcting it means changing data, so it needs the owner's approval.
- `db/init.ts` still re-applies two `UPDATE tb_ledgers SET note_no=17/18 …` statements on every run. They are idempotent, but they touch every batch, locked years included. They should become a migration or be removed.
- **OAuth state isn't bound to the browser** (e.g. by a cookie). A leaked state could be replayed within 10 minutes. Signing already stops forging one for any other company.
- Later phases:
  - a raw-payload table and skipping unchanged syncs
  - stable account ids
  - monthly-row storage
  - snapshots and month locks
  - RLS
  - retention deletes
  - refresh-token hashing and rotation
  - purging `zoho_debug_*.json` from git history
