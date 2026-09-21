# ROW-LEVEL-SECURITY.md — the database keeps companies apart

> Added 2026-09-21 (migration `0008`). Until now every query carried `WHERE company_id = $1` and nothing else stopped a **missed filter** from leaking another company's rows. Now, when switched on, **the database itself** shows and accepts only the rows of the company a request was made for.

## What it does

- A new restricted database login, **`fincommand_app`**: not an owner, no `BYPASSRLS`, no `CREATE`, data changes only (`SELECT/INSERT/UPDATE/DELETE`; the audit trail is append-only; it cannot create companies; `schema_migrations` and the old dedupe backup are closed to it).
- Every table has a policy: a row is visible/writable only when its `company_id` equals `app_company_id()`, the company named in the current transaction (`set_config('app.company_id', …, true)`). **Nothing set = no rows** (fails closed). A malformed value is an error, never rows.
- Tables without `company_id` go through their parent (`dashboard_widgets`→layout, `report_lines`→template, `report_line_ledgers`→line→template, `refresh_tokens`→user, `upload_raw_payloads`→batch). `companies` by `id`. `ledger_master` has shared rows (`company_id IS NULL AND is_global`): everyone reads them, nobody changes them.
- **Inert until switched on.** The login the app uses today (`neondb_owner`) owns the tables and bypasses row-level security, so applying `0008` changes nothing by itself.

## How the app uses it (`lib/db/neon.ts`, `lib/db/tenant-context.ts`, `lib/utils/api-handler.ts`)

- **Two connections.** The **system** connection is the owner login (login, signup, token refresh, cron company listing, migrations, scripts). The **tenant** connection logs in as `fincommand_app`; it exists only when `DB_APP_USER` and `DB_APP_PASSWORD` are both set.
- **The company follows the request** (`AsyncLocalStorage`). `withErrorHandling` reads the company from the **signature-verified** token (no database access) and runs the handler inside it. `query()` then sends `BEGIN; set_config(…, true)`, the statement, `COMMIT`; `withTransaction()` scopes from its first statement (no extra round trip). Routes needed **no edits** — all 52 authenticated routes pick this up.
- **System routes opt out explicitly** with `withErrorHandling(handler, { system: true })`: login, signup, refresh, the Zoho OAuth callback, keepalive, both cron routes. A stale token in the browser must not narrow a login. The callback and the cron loops then run each company's work **as that company** (`runAsCompany`).
- **Fail-safe defaults:** no tenant credentials = everything on the system connection, exactly as before; a company id is only ever a validated UUID (it is placed into SQL text).

## Switching it on and off (owner steps)

1. Apply `0008` on the target database (done on main 2026-09-21, dry run first).
2. Set the role's password without anyone seeing it: `npx tsx db/scripts/set-app-role-password.ts --target=main --generate` puts a new random password on your **clipboard** (never printed).
3. In **Vercel → Settings → Environment Variables** add `DB_APP_USER = fincommand_app` and `DB_APP_PASSWORD = <paste>`, then redeploy.
4. **Off again:** delete those two variables and redeploy (or `--disable` removes the password). The migration can stay.
- Keep it **off in local development**: the owner login is faster (each tenant query costs ~2 extra round trips; from India that is ~0.5 s).

## What it costs (measured, from India to Neon `us-east-1`)

The same 287 route responses took **153 s** on the owner login and **362 s** on the restricted login (≈2.4×): the extra round trips. In production, functions sit in `iad1` next to Neon (≈1–3 ms a round trip), so the extra cost per query is a few milliseconds. Parallel queries stay parallel (each gets its own scoped transaction).

## Proof (branch, 2026-09-21)

- **Leak test** `db/scripts/rls-check.ts --target=branch`: **310 of 310** checks over all 34 tables, from both companies' side — sees exactly its own rows (39 checks with real data, e.g. 6,721 of 6,721 Zoho records, 2,059 ledger rows), 0 rows of the other company, cannot UPDATE/DELETE the other company's rows, cannot INSERT for it, sees nothing with no company set, closed tables refuse it, the audit trail is append-only, a malformed setting fails closed.
- **Route parity**: 287 real responses (all 84 report views per company-year, the 3-year cases incl. "own year + another company's year", ~30 read endpoints) **identical on both logins** — 0 differ.
- **Write paths as the restricted role**: 28 of 28 — signup (system), login (system, finds the user across companies), create a year, ingestion (locks, batch, ledgers, the account-id trigger), the same figures again recognised, reports, reclassify, Zoho config, a records read, logout, password change; another company's ledgers/reports by id → 404; the throw-away company was removed.

- **After the partitioned bank-transactions table (`0009`, 2026-09-21):** the leak test is **320 of 320** (35 tables; the new one sees exactly its own 3,381 rows, 0 of the other company's, cannot write across). The restricted login has **no privilege on any of the 16 partitions** (checked with `has_table_privilege`), and their row-level security is on, so a partition cannot be reached around the parent's policy. Query plans under the restricted login are the same as the owner's: 1 of 16 partitions, index scans (the policy adds one `Result` node; aggregates over a 200,000-row company cost 30–60 ms more; page reads are unchanged). Route parity after the change: every response identical to the pre-change baseline except the audit trail's own count/last-event (the move script wrote its audit row), which was proved by rewinding only that row and re-hashing (71 of 71 identical).

## Rules for the future

- **A partitioned table** gets `ENABLE ROW LEVEL SECURITY` on the parent **and every partition**, and the policy and `GRANT` on the **parent only**. `rls-coverage.test.ts` ignores partitions (they are only reached through the parent) but the migration's post-check fails if any table, partition included, is left without row-level security.

- **Every new table** needs `ENABLE ROW LEVEL SECURITY`, a policy and a `GRANT` in its own migration. There are **no default privileges on purpose**: a new table is closed to the app role until a migration opens it. `tests/unit/rls-coverage.test.ts` reads `db/schema.sql` and every migration and fails if any table is left uncovered; `0008` also refuses to apply if a table is open.
- **A new route that does not authenticate a company** must pass `{ system: true }`.
- Server-started work for one company should run inside `runAsCompany(id, …)`.
- Re-run `rls-check.ts` and the route parity after any change to policies, grants or the connection layer.

## What it does not cover

Work on the system connection (cron's company listing, signup, migrations, scripts) is not narrowed by the database — it names a company explicitly. The app's own `company_id` filters stay as the first line of defence; this is the second.
