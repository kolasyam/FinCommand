# CUSTOM-METRICS-UPGRADE.md — Implementation Log

> [!NOTE]
> This is an implementation log, not a living reference — it records what was built, why, and how it was verified, on the date below. For the ongoing architecture reference, see `fincommand-readme.md` and `HANDOVER.md`. For the competitive research that motivated this feature, see `ledgerframe-integration-blueprint.md` §3.2 item 1 and §3.2.2 ("used by" guard).

**Date**: 2026-09-17
**Feature**: Closes the two real gaps `ledgerframe-integration-blueprint.md` identified in the existing custom-metric builder: (1) the formula builder was hard-capped at exactly two operands (`Metric A [op] Metric B`), and (2) there was no way to browse, edit, or safely delete a saved custom metric anywhere in the app.

---

## 1. What was built

### 1.1 Chaining beyond two operands — engine change was unnecessary

`lib/financial/custom-metric-engine.ts`'s `FormulaExpr` already supported arbitrarily nested trees (`MAX_DEPTH = 6`, `MAX_NODES = 30`) before this work — `validateExpr()`/`evaluateExpr()` walk any nested `{type:'op', args:[...]}` shape recursively. The two-operand limit lived entirely in `CustomMetricBuilder.tsx`'s UI, which only ever constructed `{type:'op', op, args:[A, B]}`. Confirmed this by reading the engine before writing any UI code, the same discipline `CUSTOM-DASHBOARD-TABS.md` §2 used for `CustomizableTabPanel.tsx`.

Two new pure helpers added to the engine (unit-testable, following the file's existing style):
- `buildChainExpr(first: Operand, steps: ChainStep[]): FormulaExpr` — left-folds a first operand and an ordered list of `{op, operand}` steps into a nested tree: `((first op1 b) op2 c) op3 d …`.
- `flattenChain(expr): {first, steps} | null` — reverses it for editing. Only ever needs to recognize the exact left-associative shape `buildChainExpr` produces, since `CustomMetricBuilder.tsx` is the only writer of custom-metric expressions anywhere in the codebase — returns `null` (not a guess) for anything else.
- `describeExpr(expr): string` — recursive human-readable formula string for the live-preview caption (e.g. `"(Revenue from Operations − Employee Benefits) ÷ Revenue from Operations) × 100"`), replacing the old two-operand-only inline string builder.

Also added `min`/`max` as new N-ary operators (`applyOp`'s `Math.min(...args)`/`Math.max(...args)`), matching two of Ledgerframe's named helper functions cheaply — `add`/`multiply`/`min`/`max` all reduce over any number of args; `subtract`/`divide`/`safe_divide`/`percent_of` stay exactly-2-arg and order-sensitive, unchanged.

**Why this matters for correctness**: because chaining is just nested 2-arg `op` nodes — exactly what the engine already validated — there was **zero risk** of reopening the "no string-eval" injection-surface guarantee `DECISIONS.md` §5 documents. `CustomMetricBuilder.tsx`'s UI was rewritten to build `firstOperand` + `steps: ChainStep[]` (a "+ Add another operand" button, capped at 6 steps = `MAX_DEPTH`) instead of a fixed `metricA/op/metricB`, but every UI-constructed expression still round-trips through the same `validateExpr()` server-side check as before.

### 1.2 "Manage custom metrics" — the missing list/edit/delete surface

New sidebar section (`📐 CUSTOM METRICS`, mirroring the existing `🧩 CUSTOM TABS` group in `SidebarNav.tsx` byte-for-byte in structure), opening `components/dashboard/ManageCustomMetricsModal.tsx` (new) — a list + inline create form + edit + delete-with-`ConfirmModal`, same shape as `ManageCustomTabsModal.tsx`:

- **Edit** opens `CustomMetricBuilder` pre-filled via a new optional `editing?: CustomMetricDefinition` prop — `flattenChain()` reconstructs the step-based UI state from the stored expression, the `key` field becomes read-only (immutable after creation, same precedent as `custom_tabs.tab_key`).
- **Delete** is deliberately **non-blocking** even when the metric is in use — matches `deleteCustomTab()`'s own convention (informational, not a hard guard): a widget still bound to a deleted metric key shows "no data", never a crash (`resolveAnyMetric()` already returns `null` gracefully for an unrecognized key). What changed is that the user is no longer flying blind: the list shows a real `usageCount` per metric, and the delete confirmation reads *"Used by N widget(s) — they'll show 'no data' after this"* when non-zero.
- **Role gate**: `CAN_MANAGE_CUSTOM_METRICS_ROLES = ['admin','cfo','manager']`, mirroring the API's own `ROLE_SETS.canWrite` — deliberately **not** `SidebarNav.tsx`'s existing CFO-only `CAN_CREATE_CUSTOM_TABS_ROLES` constant, since custom metrics and custom tabs use two different role sets server-side.

The inline "+ New custom metric…" entry point inside `WidgetPicker.tsx` (opened from any customizable tab while placing a widget) is untouched and still works exactly as before — `CustomMetricBuilder` is now mounted twice in the app (once inside `CustomizableTabPanel.tsx` for that inline flow, once inside the new modal for the manage flow), each with independent `open`/`editing` state.

### 1.3 "Used by" count — first JSONB-array query in this codebase

`lib/db/queries/custom-metrics.ts`'s `loadCustomMetrics()` now `LEFT JOIN LATERAL`s a per-metric usage count:

```sql
SELECT cmd.*, COALESCE(usage.usage_count, 0)::int AS usage_count
FROM custom_metric_definitions cmd
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS usage_count
  FROM dashboard_widgets dw
  JOIN dashboard_layouts dl ON dl.id = dw.layout_id
  WHERE dl.company_id = cmd.company_id
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(dw.series) elem WHERE elem->>'metricKey' = cmd.metric_key)
) usage ON true
WHERE cmd.company_id=$1 ORDER BY cmd.label
```

`dashboard_widgets.series` has no FK to `custom_metric_definitions` (it's an opaque JSONB array validated only at the API layer), so this is a scan, not a join on a real key — acceptable given both tables are company-scoped and small. A standalone `countMetricUsage()` (same shape) backs the DELETE route's audit log independent of the list endpoint.

New `CustomMetricListItem` type (`CustomMetricDefinition & {usageCount: number}`) is defined in `custom-metric-engine.ts`, not in the query file, specifically so client components (`ManageCustomMetricsModal.tsx`) can import the type without pulling server-only DB code into the client bundle. It's structurally a superset of `CustomMetricDefinition`, so every existing caller of `loadCustomMetrics()` (widget resolution, `dashboard-layout` route's key validation) kept compiling unchanged.

### 1.4 Lightweight edit history — no new table

`lib/audit/audit.ts`'s `logAudit()` gained two new **optional, trailing** parameters (`oldValues`, `newValues`) that populate `audit_trail.old_values`/`new_values` — columns that existed in the schema from the start but that no caller had ever populated (`INSERT` didn't even list them). `app/api/v1/custom-metrics/route.ts`'s `POST` handler now looks up the metric's prior definition via a new `getCustomMetricByKey()` before the upsert overwrites it, and passes both old and new snapshots through. Every pre-existing `logAudit()` call site (5- or 6-argument, positional) kept compiling unchanged since the new parameters are optional and appended at the end.

This gives a real, queryable before/after trail on every metric save without a dedicated versions table — deliberately **not** attempting Ledgerframe's full version-history-with-rollback UI (§4.2 of the blueprint), which is a materially bigger feature (a changelog textbox, an archived-version list, a "USED BY" panel populated from real reverse-dependency data) than what was asked for in this pass.

---

## 2. What was deliberately *not* changed

- **`dashboard-builder-engine.ts`'s `METRIC_CATALOG`** — zero changes. Custom metrics still compose only built-in catalog keys, never other custom metrics (unchanged, cycle-free-by-construction guarantee from `DECISIONS.md` §5).
- **No free-text formula box** — the blueprint's own §3.1 recommendation ("extend the existing structured builder to support chaining, rather than introducing a free-text box — same direction Ledgerframe went, avoided the same way") was followed exactly.
- **No full version-history UI** (§1.4 above) — scoped out as a materially larger, separate effort.
- **`custom_metric_definitions` schema** — zero migration. `usageCount` is computed at query time, not stored.

---

## 3. A real bug found via live testing, not caught by the first diagnostic script

The first `_diag_custom_metrics.ts` script (real `pg` Pool against the seeded Acme company, per this repo's own convention) inserted a throwaway `dashboard_widgets` row with `series = [{"metric_key": "…"}]` (snake_case) to test the new usage-count query — and it passed, because the query at the time also checked `elem->>'metric_key'`. Both were wrong in the same way, so the script couldn't catch it.

**Live browser testing did catch it**: after binding the real `ManageCustomMetricsModal` → `WidgetPicker` flow to a widget on Executive Overview and reopening the manage modal, the usage count read **0**, not 1. Inspecting the actual DB row the app had written (`SELECT series FROM dashboard_widgets …`) showed `[{"metricKey": "diag_chained_margin"}]` — **camelCase**. `WidgetSeriesBinding` (`dashboard-builder-engine.ts`) has always been camelCase (`metricKey`, `label?`, `color?`, `renderAs?`); the query and the first diag script both independently guessed snake_case and happened to agree with each other, not with reality.

**Fix**: both the `loadCustomMetrics()` LATERAL join and `countMetricUsage()` corrected to `elem->>'metricKey'`. Re-verified with a corrected diag script (real camelCase insert) — 5/5 checks passed (0 → 1 → 0 across bind/unbind, `countMetricUsage()` agreeing independently) — then re-verified live in the browser: usage count showed **1**, the delete confirmation read *"Used by 1 widget — it'll show 'no data' after this"*, and after confirming delete the orphaned widget degraded to *"No data for this metric yet."* with no console error.

**Lesson**: a diagnostic script that fabricates its own test fixture can silently validate against a wrong assumption if the query under test shares that same wrong assumption. Cross-checking against a row the *application itself* wrote (not the diag script) is what surfaced this one — worth doing for any future JSONB-shape-dependent query in this codebase, since this is the first one and there's no established convention yet to check "what does the real column actually contain" against.

---

## 4. Verification

### 4.1 Static checks

```
npx tsc --noEmit   → 0 errors
npm test           → Test Suites: 7 passed, 7 total / Tests: 249 passed, 249 total
```
41 new tests in `tests/unit/custom-metric-engine.test.ts`: `min`/`max` (n-ary, not binary), `buildChainExpr`/`flattenChain` round-tripping exactly, a 6-level chain sitting exactly at the `MAX_DEPTH` boundary, `describeExpr` against a simple formula / a chained formula / a `min`/`max` call.

### 4.2 DB-layer diagnostic script (throwaway, deleted after use)

`_diag_custom_metrics2.ts` (the corrected version, per §3 above) — 5/5 checks passed against the real seeded Acme Technologies Ltd company: chained-metric creation, usage count 0→1→0 across a real bind/unbind cycle using the actual camelCase `series` shape, `countMetricUsage()` agreeing independently, and clean deletion.

### 4.3 Live browser walkthrough — chrome-devtools MCP against `localhost:4000`

As **CFO — Ramesh** (Acme Technologies Ltd, Live — API mode):

1. Opened "Manage custom metrics" → "+ New custom metric" → built a genuine 3-operand chain: `Revenue from Operations` − `Employee Benefits`, then `% of` `Revenue from Operations`. Live preview description read exactly `((Revenue from Operations − Employee Benefits) ÷ Revenue from Operations) × 100`; live value **76.0%**, matching the underlying EBITDA-margin-shaped figure independently visible elsewhere on the same tab.
2. Saved — appeared in the list with the correct formula description and `0 widgets`.
3. Bound it to a Stat card widget on Executive Overview via the existing `WidgetPicker` flow, saved the layout.
4. Reopened "Manage custom metrics" — usage count now **1** (after the JSON-key fix in §3; **0** before it, which is how the bug was caught).
5. Clicked delete — `ConfirmModal` read the real usage-aware copy; confirmed. The orphaned widget on Executive Overview showed **"No data for this metric yet."**, no console error, no crash.
6. Cleaned up: reset Executive Overview's layout to default via "Reset to default" so no test artifact was left on the demo company's saved view.

### 4.4 Production build

```
npx tsc --noEmit   → clean
npm test           → 249/249
npm run build      → ✓ Compiled successfully, ✓ Generating static pages (46/46)
```
