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
