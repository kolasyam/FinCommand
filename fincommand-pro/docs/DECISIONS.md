# DECISIONS.md — Financial Engine & Architectural Decision Log

> [!NOTE]
> Each entry records a decision plus its rationale, not just the outcome — the "why" is what keeps future changes from accidentally reversing a deliberate choice.

## 1. Single Source of Truth for all computation

**Decision**: every financial figure in the app is computed inside `lib/financial/tb-engine.ts` (Layer 3 of the data architecture) — no tab computes its own numbers independently.

**Rule**: Balance Sheet = point-in-time cumulative balance (opening + movements to date); P&L = summed movement over whichever months are in the selected period.

**Why**: a direct TypeScript port of the original `backend/services/tbEngine.js`, deliberately preserved as the one place BS/P&L/MIS/Treasury/Cash Flow/Ratios logic lives, so Sample and Live modes produce numbers through the identical code path — no divergent "sample renderer" vs "live renderer."

## 2. IND AS 12 tax model (modeled, not ledger-derived)

**Decision**: Tax in MIS/P&L = flat 25% Current + 1% Deferred of PBT in a profitable period, **nil** in a loss period (PBT ≤ 0).

**Why**: this Trial Balance format carries no dedicated tax-provision ledger to derive a real figure from. A flat-rate model beats guessing or omitting tax entirely, and nil-in-loss matches IND AS 12 (no company owes current tax on a loss). Applied independently each month so monthly figures sum exactly to the annual Total column, using the same current+deferred split the statutory P&L Account uses.

**Caveat to surface to users**: PAT-dependent figures are indicative for planning, not a substitute for the company's actual tax computation.

## 3. IND AS 7 Cash Flow — fixed statutory allocations, with two known limitations

**Decision**: the Cash Flow statement is presented per IND AS 7 (Operating/Investing/Financing), but two specific line-groups are **intentional carry-overs, not derived from ledger data**:
- Working-capital, capex, and financing movement figures are **hardcoded constants** (inherited from the original `tbEngine.js`).
- The ESOP cash-flow adjustment is **dead code**, caused by a key-prefix mismatch in the original note-aggregation logic.

**Why preserved rather than fixed by default**: these were carried over deliberately during the Express→Next.js migration rather than silently patched, since fixing them changes reported figures and needs its own scoped, verified change — not a side effect of an unrelated task. Treat as known technical debt, not as something to "clean up" opportunistically.

## 4. Foreign currency exclusion in concentration rankings

**Decision**: Sales-by-Customer and Vendor Bills rows are skipped from customer/vendor concentration figures when their `currency_code` differs from the company's base currency (`lib/services/zoho.ts`, Sales-by-Customer ~L858–878, Vendor Bills ~L892–926). Skipped rows and affected counterparties are logged, not silently dropped.

**Why**: Zoho's Sales-by-Customer and Bills reports don't carry an FX rate, so a foreign-currency amount can't be safely converted inline — summing it directly into an INR total would silently misstate concentration. Excluding-and-logging is safer than either converting with a guessed rate or including the raw foreign number as if it were INR.

## 5. Custom metric security model — structured trees, never `eval()`

**Decision**: user-authored custom metrics (`lib/financial/custom-metric-engine.ts`) are structured expression trees only: `{type: 'metric' | 'const' | 'op', ...}`. No string is ever parsed as an AST or passed to `eval()`/`Function()`.

**References between custom metrics** (revised 2026-09-18, see `LEDGERFRAME-PARITY.md` §1.2): a formula may reference built-in `METRIC_CATALOG` keys **and other custom metrics**. The original rule ("never another custom metric") kept the graph acyclic by construction. It is replaced by explicit, bounded checks at save time:
- `findDependencyCycle()` rejects a cycle and names the path.
- Nesting is capped at `MAX_CUSTOM_NESTING = 5`, and evaluation depth at `MAX_DEPTH = 8` per metric.
- A cycle that somehow reached storage evaluates to null instead of recursing.

The tree-only, no-`eval()` rule below is unchanged. Ledger metrics (`definition_kind = 'ledger'`) are structured filter specs, not expressions, and are validated field-by-field (`validateLedgerSpec()`).

**Why**: this is a direct injection-surface elimination. A formula engine that accepts free text is a code-execution surface; a typed expression tree is not, regardless of what a user types into the builder UI (`CustomMetricBuilder.tsx`).

## 6. Zoho sync performance architecture

**Decisions** (all verified in `lib/services/zoho.ts`):
- **Full-year, paginated, parallel fetch** for `/bills` and `/expenses` instead of one request per month — launched concurrently with the monthly report batch, not after it.
- **`callZoho()` config caching**: the `zoho_config` row is fetched once per sync run and passed through as `configOverride` to every subsequent `callZoho()` call, instead of each call re-querying the database independently.
- **Batch size 5** (`BATCH_SIZE = 5`) for concurrent monthly report requests, to stay under Zoho's per-second rate limit (Code 43) while still parallelizing.
- **`Promise.allSettled()`** for customer/vendor contact directory fetches, so a failure in one directory doesn't abort the other.
- **Single-flight token refresh** (`refreshZohoTokenSingleFlight`, `Map`-keyed by `company_id`): a root-caused fix for a confirmed production bug where unattended (cron) syncs failed intermittently with a misleading "Invalid URL Passed (code 5)" error, because concurrent batched calls each independently decided the token was expiring and raced separate `refresh_token` grants against an endpoint that doesn't support that cleanly.

**Why documented together**: these five choices compound — parallelizing without config caching would have multiplied DB round-trips by the batch factor; batching without single-flight refresh would have reintroduced the race the moment a batch's token happened to be expiring.

> [!IMPORTANT]
> Inline comments in `zoho.ts` near the batching logic (e.g. "batched in groups of **3**") are **stale** relative to the actual `BATCH_SIZE = 5` constant. Don't trust the prose comment over the code when the two disagree — and prefer fixing the comment over leaving the drift for the next reader.

## 7. Dashboard customization — generalized engine, statutory tabs excluded on purpose

**Decision**: the widget/metric customization system (`dashboard-builder-engine.ts`, `CustomizableTabPanel.tsx`, `tab_key` column) covers 9 tabs (My Dashboard + Overview, MIS, Ratios, Treasury, Working Capital, Customer Margin, Vendor Expense, Board Pack), each wrapping its original fixed-view JSX unchanged as a `fixedView` fallback.

**Explicitly excluded**: Balance Sheet, P&L, Cash Flow, Notes (Schedule III compliance risk if reflowed into a KPI grid) and Compliance/Scenario Planner (don't fit the KPI-grid model at all).

**Why**: a statutory financial statement has a legally-defined layout; letting a user drag-and-drop its structure would mean the exported PDF is no longer a valid Schedule III statement. The customization engine was deliberately scoped to analytical/KPI tabs only, never touching the four statutory ones.

## 8. Custom dashboard tabs — immutable server-generated `tab_key`, app-code cascade, tiered RBAC

**Decision** (2026-09-17, full log in `CUSTOM-DASHBOARD-TABS.md`): a company can create its own named dashboard tab beyond the 9 fixed customizable ones. Three sub-decisions, each deliberate:

1. **`tab_key` is server-generated (`custom-` + slugified name, deduped) and immutable after creation** — renaming a tab changes only `name`, never `tab_key`. This is what lets the UI route `activeTab.startsWith('custom-')` without a DB round-trip on every navigation, and guarantees no collision with any current or future fixed `TabKey` literal, without needing a reserved-word blocklist.
2. **No DB foreign key from `dashboard_layouts` to `custom_tabs`; cascade delete is enforced in application code** (`deleteCustomTab()`, inside a `withTransaction()`). This matches the existing posture rather than introducing a new one — `tab_key` already has zero DB-level integrity behind it for any of the 9 fixed tabs either.
3. **Tiered RBAC, not a single gate**: creating/renaming/deleting the tab *entity* requires `ROLE_SETS.isCFO` (admin, cfo); adding/configuring widgets on a tab (including attaching a custom-metric formula) stays open to any authenticated role, unchanged from existing personal-layout behavior; setting a custom tab's *company-default* layout requires `ROLE_SETS.canWrite` (admin, cfo, manager), also unchanged. A viewer/auditor can personalize their own layout on a CFO-created tab; only admin/cfo can create the tab or delete it out from under everyone.

**Why**: a competitive audit (`ledgerframe-integration-blueprint.md`) found this capability live in a reference app, alongside a concrete failure mode to avoid — that app creates a new dashboard record the instant "New dashboard" is clicked, before any content exists, leaving abandoned "Untitled dashboard" rows with no list view to manage them. This feature's create flow (`ManageCustomTabsModal.tsx`) posts nothing until an explicit "Create" click, and the same modal is the one list-and-manage surface for every custom tab, showing each one's real saved-view count before deletion — a direct design response to that observed bug, not a generic best practice applied blind.

**What needed zero changes**: `CustomizableTabPanel.tsx`, `WidgetPicker.tsx`, `CustomMetricBuilder.tsx`, and `custom_metric_definitions` (already company-wide, not tab-scoped, per decision §5 above) — confirmed both by reading the code before implementation and by live-testing a brand-new custom-metric formula on a brand-new custom tab after implementation.

## 9. Ledgerframe parity — where each new capability is computed

**Decision** (2026-09-18/19, full log in `LEDGERFRAME-PARITY.md`):
1. **Ledger metrics are computed on the server only**, inside `/reports/all`, from the same ledger array the statements use. Raw ledgers never reach the browser, and a ledger metric can never disagree with the statements about the period.
2. **Warn level and comparison live on the metric definition, not the widget**, so a metric reads the same colour and the same change figure on every tab and in every export. There is one judgement function, `thresholdStatus()`.
3. **The previous-period bundle is built only when some metric asks for it**, because it costs a second pass of every statement (about 180 KB here). An unavailable previous period is null, never estimated.
4. **Exports never compute a figure.** They format the same resolved metrics the grid rendered (`buildLayoutExportModel()`). The heavy libraries (pptxgenjs, html-to-image) are loaded only when someone exports.

## 10. Database Phase 0 — safety before redesign

**Decision** (2026-09-19, by the owner; implementation log in `DB-PHASE-0.md`). No redesign in this phase and no report number changes. Before/after parity is the proof.

1. **Versioned SQL migrations with a small built-in runner** (`db/migrate.ts`, no new dependency). `schema.sql` is frozen. Every change is a numbered file, tried on a Neon branch first. The app never changes schema at runtime any more (the `neon.ts` startup `ALTER TABLE` is gone).
2. **Debit = credit: warn and record, never block.** Rejecting a real company's unbalanced books would stop them seeing anything. Storing the difference per batch and showing it is more useful. See `CONSTRAINTS.md`.
3. **First source owns the year.** Excel and Zoho used to overwrite each other's data for the same year silently, every 15 minutes. Now the first to load a year owns it. A person must confirm a switch, and the scheduler never switches.
4. **`ledger_master` duplicates: newest wins, the rest are backed up.** One mapping per company + ledger code: active first, then latest updated. The 731 removed copies stay in `ledger_master_dedupe_backup`. Uniqueness is by code, not name: "Amortisation — Intangibles" is genuinely two ledgers (1023 and 7032).
5. **Zoho tokens encrypted; a missing key is a hard error.** AES-256-GCM with `TOKEN_ENCRYPTION_KEY`. There's no silent plain-text fallback for new writes. Old plain-text values are still readable until they're re-encrypted.
6. **Signed OAuth state, not a bare company id.** The Zoho callback can't authenticate the user, so the state it trusts must come from our own authenticated auth-url route and must be recent.
7. **The report cache key includes a data version.** The cache is per server instance. Without the version, one instance could serve another's stale numbers for 15 minutes after an upload.
8. **The Zoho opening-balance imbalance is a separate change**, made right after this phase, because it is the one fix that is *meant* to change numbers.

## 11. Database Phase 1 — one pipeline, stable identities, a balancing Balance Sheet

**Decision** (2026-09-19, by the owner; implementation log in `DB-PHASE-1.md`). The approval covers Phase 1 only. Report numbers are unchanged on today's data (parity 84/84).

1. **One write path for every source** (`lib/ingestion/trial-balance.ts`). Sources only parse and map. Locking, validation, supersede and insert happen once, in one transaction, for Excel, Zoho and future sources alike.
2. **Unchanged data writes nothing.** A content hash (amounts to the paisa, order-independent) is compared with the current batch. Zoho records `no_change`; Excel gets 409 `NO_CHANGE`. 79% of past syncs were identical copies.
3. **Raw source responses are kept, but stored once** (`raw_payloads` + `upload_raw_payloads`). They are the proof of what Zoho returned, so they aren't dropped; they just stop being duplicated inside every batch.
4. **Every ledger row has a stable account** (`ledger_accounts`): the Zoho account id, else the code, else the name. It is assigned by a database trigger, so no writer can skip it. The identity is **per source**, because Zoho ids and Excel codes can't be matched safely. The CY merge and the contact joins deliberately stay as they were (`DB-PHASE-1.md` §6).
5. **The Balance Sheet carries the period's profit** as one Other Equity line, "Surplus — profit for the period (as booked)". The line is added only when the trial balance itself balances, so a genuinely broken upload still shows "Out of Balance". It is the only `tb-engine.ts` change, and Cash Flow ignores it, so profit isn't counted twice.
6. **Old copies go only through an approved list.** The retention policy keeps the current batch, the newest 5 superseded, anything current in the last 90 days, and locked years. A dry run prints the exact list and its id, and only that id can be applied. The same gate covers emptying the old raw column (done on 2026-09-20 with the owner's approval — §12).

## 13. Zoho data audit — what we read, and whether it is right (2026-09-21)

**Decision** (audit requested by the owner; full write-up and evidence in `ZOHO-DATA-AUDIT.md`).
1. **The platform reads Zoho's financial statements plus customer and vendor summaries, not every record.** That is intentional for the Ind AS statements; the list of what is not read is in the audit, each a separately planned addition.
2. **The statements are proven complete against Zoho's own totals** (24 P&L months and 26 Balance Sheet snapshots reconcile). Zoho's own Balance Sheet summary row ("Current Year Earnings") is unreliable and is deliberately not used.
3. **Customer amounts are base-currency and every customer counts** (the old rule dropped the dominant USD customer). Fixed; takes effect on each year's next sync.
4. **A limited sync must say so.** Non-fatal problems (bills not fetched, no bills, skipped foreign bills, failed customer months, a partial chart of accounts) are recorded on the sync log and returned as the sync's warning; the year's bills and expenses are kept with the batch. (The empty vendor report was exactly such a silent failure: the old build's timestamp `date_start` was rejected by Zoho with HTTP 400 and swallowed.)
5. **The chart of accounts is read in full** (all pages).

## 14. Reading every kind of Zoho record (2026-09-21)

**Decision** (owner request: "read all data from Zoho whatever it will give"; design and evidence in `ZOHO-RECORDS.md`).
1. **A read-only mirror in new tables, not a change to the statement pipeline.** Report numbers cannot change; using the data (ageing, GST summary, drill-downs) is a separate, later plan.
2. **Everything Zoho returns is kept as JSON; typed columns exist only to filter on** (owner chose "full JSON + typed columns + a line table" over a typed table per module). A new Zoho field needs no migration; a new module is one registry entry.
3. **GST data means the GST fields on each document plus the tax masters and the tax-summary report.** Zoho's API has no GSTR endpoints (measured), so a GSTR-style report would have to be computed from the stored lines later.
4. **Incremental by `last_modified_time` where Zoho supports it** (proved on the big modules); modules without it are read in full, by the scheduler at most daily. A complete full listing (forced weekly) is the only thing that flags a record as removed in Zoho.
5. **Time-boxed, resumable slices**, because a full first read (~1,000+ calls) does not fit one serverless request. The Upload tab drives it; a cron continues and refreshes it.
6. **API budget: up to 80% of the day's allowance (owner choice)**, counting every Zoho call that day, with the rest reserved for a statement sync. The plan's real allowance is set on the Upload tab.
7. **Access: admin, CFO, CEO and auditor read; admin and CFO start a read** (owner choice; the records include bank and contact details).
8. **Two waste problems fixed on the way:** a failing statement sync used to retry on every scheduler tick (~40 calls each — up to ~3,800 a day of a 5,000 allowance); it now backs off 15 min → 1 h → 6 h → 24 h. And the 15-minute frequency costs ~4,300 calls a day, so the Upload tab shows each frequency's projected cost and warns from 50%.
10. **A rate-limit refusal of a token refresh no longer disconnects the connection.** Only a rejected token (`invalid_code` …) deactivates it. A healthy production connection was deactivated this way on 2026-09-21 (Zoho accepted the same refresh token minutes later).
9. **Expense line detail (GST/ITC per line) is opt-in**: it costs one call per expense (2,041 for the reference org); the list row already carries every amount.

## 12. Latency — round trips are the cost (2026-09-20)

**Decision** (by the owner; measurements and proofs in `LATENCY.md`). Report content does not change: 84/84 `/reports/all` and 28/28 `/reports/threeyear` responses are identical before and after.

1. **Fewer sequential database round trips, not faster queries.** Queries take under 1 ms and the engine 33–44 ms; one round trip from India to Neon `us-east-1` is ~247 ms. So: one wave of independent reads, the user lookup alongside the data-version check, and the 3-Year view in one wave.
2. **The database reads behind a bundle are cached per data version** (clone on read, 12 entries), so switching Annual → Q1 → H2 doesn't re-read them. It has the same contract as the bundle cache: a change shows when the data version changes, which every application write path does; hand-run SQL doesn't.
3. **Idle database connections are kept for 5 minutes** (was 30 s): opening one costs ~5 round trips.
4. **Keep the Neon compute awake — accepted, costs compute hours.** A first request after a quiet spell no longer waits for the database to wake. Ping in long-lived servers, cron on Vercel; `DB_KEEPALIVE_MS=0` undoes it.
5. **A 30-second cache of the user lookup — accepted security trade-off.** A user deactivated or re-roled on another server instance keeps the old access for up to 30 s. Cleared at once on the instance that changes it; failed lookups are never cached; the token is verified every time. `AUTH_CACHE_TTL_MS=0` undoes it.
6. **Functions pinned to `iad1`**, next to the database. Moving the database and the functions both to Mumbai is faster for Indian users but a migration project of its own, not started.
7. **The old raw-data column was emptied on production** (list `426d3108cea5`, approved), after each entry was verified in the new store. Nothing was lost.
