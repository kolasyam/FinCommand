# VERIFICATION.md — Financial Audit & Testing Protocol

> [!IMPORTANT]
> All four steps are required before any change is called "done" — passing 1–2 but skipping 3–4 has previously let real bugs through (see the historical example in Step 3). None of these steps are optional for a change that touches computed financial figures.

## Step 1 — TypeScript type check

```bash
npx tsc --noEmit
```
Must pass with **0 errors**. This repo uses `npm run typecheck` as the equivalent script.

## Step 2 — Jest unit test suite

```bash
npm test
```
Must pass all suites. **Verified 2026-09-17** (see `CUSTOM-METRICS-UPGRADE.md`, `QA-AUDIT-LATENCY-FIX.md`):
```
Test Suites: 7 passed, 7 total
Tests:       249 passed, 249 total
Time:        ~5s
```
Suites: `note-catalog.test.ts`, `report-builder-engine.test.ts`, `custom-metric-engine.test.ts`, `dashboard-builder-engine.test.ts`, `tab-customization-audit.test.ts`, `tb-engine.test.ts`, `format.test.ts`.

> [!NOTE]
> If a future run shows a different suite/test count than 7/249, that's a signal the codebase has moved on since this doc was written — update this section rather than treating the old numbers as ground truth.

## Step 3 — Root diagnostic script protocol (DB / financial-calculation changes only)

For any change touching the database or a computed financial figure:

1. Write a throwaway root-level `_diag*.ts` (or `.mjs`) script — this repo has an established convention of these (31 pre-existing `_diag*.ts`/`.mjs` files at the project root from prior work, verified count as of this audit).
2. Use a dedicated `new Pool(...)` from `pg` with `dotenv/config`, and **relative imports** (`./lib/...`) for pure computation functions.
3. **Do not** use `@/lib/db/neon.ts`'s shared `query()` for a script that must exit naturally — it has a non-`unref()`'d keep-alive `setInterval` that prevents the Node process from exiting. If the script must exercise app query-layer functions that do use `neon.ts`, call `process.exit()` explicitly at the end instead.
4. Run it with `npx tsx _diagN_description.ts` against the real seeded company — **Acme Technologies Ltd**, user `cfo@acmetech.in`. `db/seed.ts` looks this company up by name and either reuses or creates it, so its `id` is **not a fixed constant** — resolve it at the top of your script with `SELECT id FROM companies WHERE name='Acme Technologies Ltd'` rather than hardcoding a UUID from a previous session, which may point at a different (or no-longer-existing) database.
5. **Delete the script afterward.** These are throwaway verification artifacts, not permanent fixtures.

> [!NOTE]
> Why this step exists: a real pre-existing bug (`ledger_master` missing a `UNIQUE(company_id, ledger_code)` constraint that `db/init.ts`'s `ON CONFLICT` silently depended on) was only caught this way — `tsc`/`build` passing does not prove runtime correctness against real data. Live-DB scripts also catch schema-migration-not-yet-applied issues (a new column referenced in code but not yet run against the real DB via `db:init` or a direct `schema.sql` apply).

**Applying a schema migration to the real DB**: `db/schema.sql` is idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP INDEX IF EXISTS` + recreate) — safe to re-run directly via a one-off `pool.query(fs.readFileSync('db/schema.sql','utf8'))`. Don't run the full `npm run db:init` for this; its `ledger_master` reseed step has a pre-existing, unrelated bug that always fails and exits 1, obscuring whether the schema portion actually succeeded.

## Step 4 — Live visual check

The dev server runs at `http://localhost:4000`. Verify the actual UI, not just the API response:

1. Navigate to the relevant tab(s) — use `mcp__chrome-devtools__*` tools (`list_pages` / `new_page` / `navigate_page`, then `take_snapshot` for an interactable element tree, `take_screenshot` when you need to see layout/chart rendering).
2. **Switch period views** — Annual → Quarterly → Q1 (or whichever granularities are relevant) — and confirm figures actually recompute rather than staying static. Confirmed live in this codebase: switching Annual → Q1 changed Revenue from ₹29,457L (FY annual) to ₹6,331L and ROE from 22.6% to 4.6% on identical underlying data.
3. Check `list_console_messages` and `list_network_requests` after navigation/interaction — catch a silent client crash or an unexpected `500`/`401` instead of assuming the happy path. Remember: `401`s on auth-gated endpoints in Sample mode are expected, not failures.
4. If a *different* browser-automation tool (`claude-in-chrome` extension) is also available, prefer `chrome-devtools` for this app — the extension-controlled browser has been observed unable to reach `localhost`/`127.0.0.1` in this environment even when the server is confirmed up via `curl`.

## Definition of done

A change is done only when **all four steps pass**, in this order: typecheck → unit tests → (if DB/financial-logic touched) diagnostic script against real seeded data → live visual confirmation at `localhost:4000`. Skipping straight to "tests pass, ship it" has historically missed both DB-schema drift and rendering regressions that only show up live.
