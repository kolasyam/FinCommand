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
Must pass all suites. **Verified 2026-09-19** (after DB Phase 1, see `DB-PHASE-1.md`):
```
Test Suites: 21 passed, 21 total
Tests:       470 passed, 470 total
```
Phase 0 added `migrate-core`, `tb-validation`, `security` (token encryption + OAuth state), `report-cache-key` and `zoho-assembly`. Phase 1 added `ingestion`, `content-hash`, `period-surplus` and `script-support`.

On a machine short of memory, run `npx jest --runInBand`.

> [!NOTE]
> If a future run shows a different suite/test count than 21/470, that's a signal the codebase has moved on since this doc was written — update this section rather than treating the old numbers as ground truth.

## Step 3 — Root diagnostic script protocol (DB / financial-calculation changes only)

For any change touching the database or a computed financial figure:

1. Write a throwaway root-level `_diag*.ts` (or `.mjs`) script — this repo has an established convention of these (31 pre-existing `_diag*.ts`/`.mjs` files at the project root from prior work, verified count as of this audit).
2. Use a dedicated `new Pool(...)` from `pg` with `dotenv/config`, and **relative imports** (`./lib/...`) for pure computation functions.
3. If the script exercises app query-layer functions that use `@/lib/db/neon.ts`, call `pool.end()` (exported from `neon.ts`) at the end so the process exits. (The old 3-minute keep-alive `setInterval` that kept such scripts alive was removed in DB Phase 0.)
   - **Read-only checks:** wrap them in `BEGIN READ ONLY … ROLLBACK`. **Never** use `SET SESSION …` (e.g. `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`): `DB_HOST` is Neon's transaction-mode pooler, where a session setting stays on a shared server connection and can leak onto other clients' requests, including production writes.
4. Run it with `npx tsx _diagN_description.ts` against the real seeded company — **Acme Technologies Ltd**, user `cfo@acmetech.in`. `db/seed.ts` looks this company up by name and either reuses or creates it, so its `id` is **not a fixed constant** — resolve it at the top of your script with `SELECT id FROM companies WHERE name='Acme Technologies Ltd'` rather than hardcoding a UUID from a previous session, which may point at a different (or no-longer-existing) database.
5. **Delete the script afterward.** These are throwaway verification artifacts, not permanent fixtures.

> [!NOTE]
> Why this step exists: a real pre-existing bug (`ledger_master` missing a `UNIQUE(company_id, ledger_code)` constraint that `db/init.ts`'s `ON CONFLICT` silently depended on) was only caught this way — `tsc`/`build` passing does not prove runtime correctness against real data. (That constraint now exists — migration `0002_ledger_master_dedupe.sql` — and `db:init` works again.) Live-DB scripts also catch schema-migration-not-yet-applied issues (a new column referenced in code but not yet applied to the real DB).

**Changing the schema (since DB Phase 0, 2026-09-19)**: `db/schema.sql` is a **frozen baseline** — don't add to it. Every schema change is a new numbered file in `db/migrations/` (`NNNN_snake_case.sql`), applied once, in order, each in its own transaction, recorded in `schema_migrations` with a checksum (an edited, already-applied file is refused).

```bash
npm run db:migrate:status:branch             # applied / pending on the Neon test branch (BRANCH_DATABASE_URL)
npm run db:migrate:branch                    # 1. apply on the branch
npx tsx _diag_…ts --target=branch            # 2. prove it there (constraints + before/after parity)
npm run db:migrate:main                      # 3. only then production
```

> [!CAUTION]
> Use the named scripts above, or call `npx tsx db/migrate.ts --target=…` directly. **Don't** pass flags through `npm run … -- --flag`: Windows PowerShell's npm shim drops the `--`, so the flags never arrive.
>
> On 2026-09-19 that sent a "branch, dry run" command to production (see `DB-PHASE-0.md` §5.1). `--target` now has no default, so a lost flag fails instead of reaching main.
>
> Always read a `--status` / `--dry-run` output **before** running the apply command, never chained in the same step.

Test every migration on a Neon branch first. A migration that changes or deletes existing data needs the owner's explicit approval, and it must back up whatever it removes (see `0002`, which keeps the removed rows in `ledger_master_dedupe_backup`).

**Data clean-up scripts** (`db/scripts/retention.ts`, `db/scripts/clear-raw-zoho-months.ts`, since DB Phase 1): run `--dry-run` first and on its own. Take the printed **list id** to the owner. Only an approved id goes to `--apply --confirm=<list id>`. The script refuses if the list has changed since. Branch first, then main. See `DB-PHASE-1.md` §3.6.

**Deploy order:** apply migrations to main *before* deploying code that uses them. The old code keeps working on the new schema; the new code does not work on the old schema.

## Step 4 — Live visual check

The dev server runs at `http://localhost:4000`. Verify the actual UI, not just the API response:

1. Navigate to the relevant tab(s) — use `mcp__chrome-devtools__*` tools (`list_pages` / `new_page` / `navigate_page`, then `take_snapshot` for an interactable element tree, `take_screenshot` when you need to see layout/chart rendering).
2. **Switch period views** — Annual → Quarterly → Q1 (or whichever granularities are relevant) — and confirm figures actually recompute rather than staying static. Confirmed live in this codebase: switching Annual → Q1 changed Revenue from ₹29,457L (FY annual) to ₹6,331L and ROE from 22.6% to 4.6% on identical underlying data.
3. Check `list_console_messages` and `list_network_requests` after navigation/interaction — catch a silent client crash or an unexpected `500`/`401` instead of assuming the happy path. Remember: `401`s on auth-gated endpoints in Sample mode are expected, not failures.
4. If a *different* browser-automation tool (`claude-in-chrome` extension) is also available, prefer `chrome-devtools` for this app — the extension-controlled browser has been observed unable to reach `localhost`/`127.0.0.1` in this environment even when the server is confirmed up via `curl`.

## Definition of done

A change is done only when **all four steps pass**, in this order: typecheck → unit tests → (if DB/financial-logic touched) diagnostic script against real seeded data → live visual confirmation at `localhost:4000`. Skipping straight to "tests pass, ship it" has historically missed both DB-schema drift and rendering regressions that only show up live.
