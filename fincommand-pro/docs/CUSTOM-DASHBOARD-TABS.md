# CUSTOM-DASHBOARD-TABS.md — Implementation Log

> [!NOTE]
> This is an implementation log, not a living reference — it records what was built, why, and how it was verified, on the date below. For the ongoing architecture reference, see `PLATFORM-REFERENCE.md` and `HANDOVER.md`. For the competitive research that motivated this feature, see `ledgerframe-integration-blueprint.md`.

**Date**: 2026-09-17
**Feature**: Custom dashboard tabs — a company can create its own named dashboard tab (beyond the 9 built-in customizable ones), add widgets to it, and attach either built-in or brand-new custom-metric formulas to those widgets. Closes the gap identified in `ledgerframe-integration-blueprint.md` §3–5 against the reference app "Ledgerframe."
**Plan followed**: `C:\Users\syamm\.claude\plans\stateful-sprouting-quilt.md` (Plan Mode, approved before implementation).

---

## 1. What was built

### 1.1 Data model

`db/schema.sql` — new table, added after `custom_metric_definitions`:

```sql
CREATE TABLE IF NOT EXISTS custom_tabs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tab_key      VARCHAR(50) NOT NULL,   -- server-generated: 'custom-' + slugify(name), deduped
  name         VARCHAR(100) NOT NULL,
  description  VARCHAR(300),
  icon         VARCHAR(10),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, tab_key)
);
CREATE INDEX IF NOT EXISTS idx_custom_tabs_company ON custom_tabs(company_id, sort_order);
```

`tab_key` is server-generated and immutable (`custom-` + slugified name, deduped with a `-2`, `-3`, … suffix on collision) — it's the same literal value later written into `dashboard_layouts.tab_key`, following the natural-key pattern `custom_metric_definitions.metric_key` already uses. Renaming a tab only ever changes `name`, never `tab_key` — this is what lets the sidebar/router address a tab by a stable string without a DB round-trip (`activeTab.startsWith('custom-')`) and guarantees no collision with any current or future fixed `TabKey` literal.

No DB foreign key from `dashboard_layouts` to `custom_tabs` — deleting a custom tab cascades its layouts in **application code** (`deleteCustomTab()`, inside a `withTransaction()`), matching the existing posture: `tab_key` already has zero DB-level integrity behind it for any of the 9 fixed customizable tabs either.

### 1.2 Engine layer — widened `TabKey`, unchanged `TAB_KEYS`

`lib/financial/dashboard-builder-engine.ts`:
```ts
export type TabKey = string;                 // was a closed union of 13 fixed literals
export type FixedTabKey = /* the original 13-value union, unchanged */;
export const TAB_KEYS: FixedTabKey[] = [ /* byte-for-byte unchanged */ ];
export function isTabKey(v: unknown): v is FixedTabKey { /* unchanged body */ }
```
`TAB_KEYS`/`isTabKey` keep meaning exactly "one of the 13 fixed tabs" — still a real, DB-free question two existing tests hard-assert against (`tests/unit/dashboard-builder-engine.test.ts`, `tests/unit/tab-customization-audit.test.ts`). Only the *type* `TabKey` widened to `string`; every file typed against it continues to compile unchanged since `string` satisfies all prior usage.

### 1.3 Query layer — `lib/db/queries/custom-tabs.ts` (new)

- `loadCustomTabs(companyId)` — list, ordered by `sort_order, created_at`.
- `resolveTabKey(companyId, tabKeyParam)` — the load-bearing existence check: fast-paths to `isTabKey()` for the 13 fixed tabs (zero DB hits), otherwise requires the key to both start with `custom-` **and** exist in `custom_tabs` for that company. Without this, any authenticated user could `PUT /dashboard-layout?tab_key=custom-anything` and silently write an orphan layout for a tab that was never created.
- `createCustomTab(companyId, userId, {name, description?, icon?})` — slugifies `name`, prepends `custom-`, dedupes against the `UNIQUE(company_id, tab_key)` constraint with bounded retry (`-2`, `-3`, … up to 30 attempts).
- `renameCustomTab(companyId, id, {name?, description?, icon?, sortOrder?})` — never touches `tab_key`.
- `countLayoutsForTab(companyId, tabKey)` — real count used by the delete-confirmation UI.
- `deleteCustomTab(companyId, id)` — transaction: delete `dashboard_layouts` rows for that `tab_key` (cascades `dashboard_widgets` via its existing FK), then the `custom_tabs` row.

### 1.4 API routes (new)

- `GET/POST /api/v1/custom-tabs` — `GET` is `authenticate()`-only (any role may read the list, matching `GET /api/v1/custom-metrics`'s precedent); `POST` requires `ROLE_SETS.isCFO` (admin, cfo).
- `PUT/DELETE /api/v1/custom-tabs/[id]` — both `ROLE_SETS.isCFO`. Both audit-logged (`custom_tab.create`, `custom_tab.rename`, `custom_tab.delete`).

### 1.5 Existing routes fixed to recognize custom tabs

- `app/api/v1/dashboard-layout/route.ts` — `requireTabKey` became `async`, now calls `resolveTabKey()` instead of only checking `isTabKey()`. All 3 handlers (GET/PUT/DELETE) updated.
- `app/api/v1/dashboard-layout/company-default/route.ts` — same fix, after the existing `requireRole(user, ROLE_SETS.canWrite)`.
- `app/api/v1/dashboard-layout/all/route.ts` — **the actual pre-existing-shaped bug this feature would otherwise have hit**: this route only ever looped the static `TAB_KEYS` array to build its response, so a saved custom-tab layout would have been silently dropped from the batch endpoint the dashboard shell uses on load. Fixed by also looping `loadCustomTabs(companyId)` and appending each resolved tab state.

### 1.6 Client layer (new)

- `lib/client/custom-tabs-api.ts` — thin `apiFetch` wrappers (`fetchCustomTabs`, `createCustomTab`, `renameCustomTab`, `deleteCustomTab`).
- `lib/client/CustomTabsContext.tsx` — sibling to `TabCustomizationsContext.tsx`; fetches once per session, fails silently toward `[]` (same convention), optimistic local updates on create/rename/delete.
- `components/dashboard/tabs/CustomTab.tsx` — thin wrapper around `CustomizableTabPanel` (`defaultWidgets={[]}`, `fixedView={null}`), with one addition beyond the trivial case (`MyDashboardTab.tsx`): a distinct "This custom tab was removed" message when the tab list has loaded and the requested key isn't in it — a deliberate departure from the usual silent-fail-toward-empty convention, because that convention is right for a *network* failure and wrong for "this entity no longer exists."
- `components/dashboard/ManageCustomTabsModal.tsx` — the single list-and-create surface (deliberately not split into two flows) that avoids the exact "eight abandoned Untitled-dashboard entries, no list view" failure mode found live in Ledgerframe during the audit phase: the create form POSTs nothing until an explicit "Create" click, and every existing tab is listed with a real `layoutCount` next to its name so deleting a tab several teammates have personalized isn't a silent surprise.
- `app/dashboard/page.tsx` — `renderTab()` gained a fallback branch (`activeTab.startsWith('custom-') ? <CustomTab tabKey={activeTab} /> : null`), `CustomTabsProvider` added to the provider tree, `ManageCustomTabsModal` wired to a new `manageCustomTabsOpen` state.
- `components/dashboard/SidebarNav.tsx` — new "🧩 CUSTOM TABS" group, always rendered (even at zero custom tabs, so the first one a company creates isn't a chicken-and-egg discovery problem), with a "Manage custom tabs" / "View custom tabs" entry whose label itself signals the viewer's permission level.

### 1.7 RBAC layering (as designed and verified live — §3.6)

| Action | Role gate |
|---|---|
| Create / rename / delete the tab **entity** | `admin`, `cfo` (`ROLE_SETS.isCFO`) |
| Add/configure widgets on a tab, incl. attaching a custom-metric formula | any authenticated role (unchanged `canWrite`-or-looser personal-layout behavior) |
| Set a custom tab's **company-default** layout | `admin`, `cfo`, `manager` (`ROLE_SETS.canWrite`, unchanged) |

A viewer/auditor can build their own widget layout on a CFO-created custom tab; only admin/cfo can create the tab or delete it out from under everyone.

---

## 2. What was deliberately *not* changed

- **`CustomizableTabPanel.tsx`, `WidgetPicker.tsx`, `CustomMetricBuilder.tsx`, `custom-metric-engine.ts`** — zero code changes. Confirmed by direct reading (before implementation) that `CustomizableTabPanel` has no internal switch/lookup keyed on `tabKey`; it was already fully generic via props.
- **`custom_metric_definitions`** — zero schema changes. It has no `tab_key`/`layout_id`/`widget_id` column by original design (a custom metric is a definition, not a personal display preference), so it needed no retrofit to be usable from a brand-new custom tab — confirmed live in §3.4 below, not just by reading the schema.

Both were flagged in the plan as the two things most likely to need rearchitecting, and both turned out to need none — the gap was purely "no way to create the *tab entity* itself," not a limitation in the widget/metric machinery.

---

## 3. Verification

### 3.1 Static checks

```
npx tsc --noEmit         → 0 errors
npm test                 → Test Suites: 7 passed, 7 total / Tests: 236 passed, 236 total
```
Both run fresh as part of this implementation pass (not reused from a prior session). The 236 includes the two suites that hard-assert the exact 13-value `TAB_KEYS` array, confirming the `TabKey` type-widening didn't alter runtime behavior for any existing tab.

### 3.2 DB-layer diagnostic scripts (throwaway, deleted after use per repo convention)

- `_diag71_custom_tabs_ddl.ts` — applied the `custom_tabs` DDL to the live DB; confirmed `UNIQUE(company_id, tab_key)` fires correctly on a duplicate insert.
- `_diag72_custom_tabs_query_layer.ts` — 18/18 checks passed across all 6 query-layer functions, including: dedup suffixing on a colliding name (`-2`, `-3`), and a direct proof that `deleteCustomTab()` actually removes a seeded `dashboard_layouts` row for that `tab_key` (not just the happy path).

### 3.3 Live HTTP end-to-end test (curl + `node -e` for JSON parsing, backgrounded — task `b3016ryjg`)

13/13 checks passed, including:
- A made-up `custom-does-not-exist` tab key correctly `400`s on `PUT /dashboard-layout` both before and after a real custom tab with a similar prefix exists (proves `resolveTabKey()`'s DB check, not just its fast path).
- `GET /dashboard-layout/all` correctly includes a saved custom tab's layout (the fix in §1.5) — verified present with `source:"personal"` and the saved widget, not silently dropped.
- RBAC: an auditor-role token got `403` on both `POST /custom-tabs` and `DELETE /custom-tabs/[id]`; a CFO-role token succeeded on both.

### 3.4 Live browser "quiz" — chrome-devtools MCP against the running app at `localhost:4000`

Performed as company **Real Variable**, user **Arun (admin)**, per the explicit instruction to quiz the running platform rather than only the API:

1. **Create** — via "Manage custom tabs" → "+ New custom tab", created tab "Board Metrics" (icon 📈). Confirmed: nothing posted until the explicit Create click (non-eager-creation, the deliberate anti-Ledgerframe-bug design); on success, auto-navigated straight into the new empty tab; sidebar's "🧩 CUSTOM TABS" group updated immediately with the new entry.
2. **Add a built-in-metric widget** — "+ Add widget" → Bar chart → picked "Revenue from Operations" + "Cost of Services" (2/4 series). Result: a real bar chart rendered, live TB-derived monthly values (Apr–Nov, ₹-Lakhs scale ~20–120), identical rendering pipeline to every fixed tab — zero special-casing needed, confirming §2's "no widget-layer changes needed" claim empirically, not just by reading code.
3. **Create a brand-new custom-metric formula on this new tab** — "+ Add widget" → Stat card → "+ New custom metric…" → built `Employee Cost % of Revenue` = `Employee Benefits ÷ Revenue from Operations × 100` (operator "% of"). Live preview computed **51.4%** correctly before saving; slug auto-generated (`employee_cost_of_revenue`). Saved — it immediately appeared under a new "CUSTOM METRICS" section of the metric picker, selected it, added the widget. Result: a Stat card rendered **51.4%** with a real YoY comparison (`(10.1%) YoY`), computed from the same live company data as every other metric on the platform.
4. **Save + persistence** — clicked Save (toolbar showed "Saving…"), then did a **full page reload** (not just a re-render) and re-navigated into "Board Metrics" via the sidebar. Both widgets — the bar chart and the custom-metric stat card — were intact, page now read "Your customized view." (the read-only/saved state), confirming the layout genuinely round-tripped through the database, not just held in client state.
5. **Rename** — via "Manage custom tabs" → ✎, renamed to "Board Metrics (Renamed)". Modal row, sidebar entry, and the tab's own page header all updated live; toast read "Tab renamed"; `tab_key` was confirmed unchanged (the rename only ever touches `name`, per §1.3).
6. **Delete** — clicked 🗑; `ConfirmModal` correctly read *"This removes the tab and 1 saved view teammates have personalized on it. This can't be undone."* — the **real** `layoutCount` (1), not a generic warning. Confirmed delete: toast read *""Board Metrics (Renamed)" deleted — 1 saved view removed with it"*; the modal's list correctly fell back to "No custom tabs yet — create one above."; and — because the tab was open behind the modal at the time of deletion — the page live-updated to `CustomTab.tsx`'s dedicated empty-state message: *"This custom tab was removed. Pick another tab from the sidebar."* (not the usual silent-fail-toward-empty grid), all without a manual reload.
7. **DB-level cascade confirmation** (not just UI) — a follow-up diagnostic query against the live database confirmed, post-delete: `custom_tabs` = 0 rows for the company, `dashboard_layouts` = 0 rows for `tab_key = 'custom-board-metrics'`. This is a real cascade delete in application code, not a soft/UI-only removal.
8. **RBAC — visual check as a non-CFO role** — logged out, signed in as `auditor@acmetech.in` (company Acme Technologies Ltd). Sidebar correctly showed **"View custom tabs"** (not "Manage") — the client-side `CAN_CREATE_CUSTOM_TABS_ROLES` gate mirroring `ROLE_SETS.isCFO`. Opening it showed the modal with **no "+ New custom tab" button** and (implicitly, via `canManage`) no rename/delete affordances would show on any row either — verified against a screenshot, not just the accessibility tree, after an initial false negative caused by a stale snapshot during page-load timing (see §4).

No cleanup was left behind: the test tab was deleted as the last live step, consistent with this repo's "no data left behind" discipline for test/diagnostic artifacts (diag scripts, Ledgerframe test dashboards) established earlier in this project's history.

### 3.5 Production build

```
npx tsc --noEmit   → clean
npm test           → 236/236
npm run build      → ✓ Compiled successfully in 57s, ✓ Generating static pages (46/46), exit code 0
```
Run sequentially with the dev server stopped first (see §4 for why). Route manifest confirms both new endpoints registered: `ƒ /api/v1/custom-tabs` and `ƒ /api/v1/custom-tabs/[id]`, both 265 B / 103 kB First Load JS — identical footprint to every other API route, no bundle-size anomaly. `/dashboard` itself: 439 kB / 546 kB First Load JS (static, prerendered) — this route already carried the full dashboard-builder bundle before this feature; the custom-tabs UI added to it is client components reusing existing `CustomizableTabPanel`/`WidgetPicker` code, not a new heavy dependency.

### 3.6 Explicitly out of scope for this pass

- PDF/Excel export of a custom tab's widget layout — a custom tab inherits the same "customized view exports the original fixed-format report" limitation already documented in `HANDOVER.md` §5 for the 9 built-in customizable tabs; there is no "original fixed-format report" for a custom tab to fall back to, so this needs its own scoped follow-up, not a silent gap.
- Re-ordering/drag-and-drop of custom tabs relative to each other in the sidebar (`sort_order` exists in the schema and the rename API accepts it, but no UI currently sets it to anything other than creation order).

---

## 4. Incident during this session — dev-server corruption from a concurrent build

Earlier in this implementation pass, `npm run build` was started while `npm run dev` was still serving on the same `.next` directory (Windows/OneDrive path) — this corrupted the build cache (`EPERM` on `.next/trace`) and then caused the **live** dev server to start returning HTTP 500 on every route, including `/api/v1/health`.

**Recovery**: stopped the build task; found the dev server's real PID via `Get-NetTCPConnection -LocalPort 4000` → `Get-CimInstance Win32_Process` (confirmed it was genuinely `next dev`, not a stray process, before killing it); `Stop-Process -Force`; removed the corrupted `.next` folder; restarted `npm run dev` cleanly; confirmed recovery via `curl http://localhost:4000/api/v1/health` → `200 OK`. No database or application-code impact — purely a build-cache issue.

**Lesson carried forward, applied for real in §3.5 above**: `next build` and `next dev` must never run concurrently against the same `.next` folder. Before running this pass's production build, the dev server's PID was located and stopped first (`Stop-Process -Id 4384 -Force`, confirmed via `Get-CimInstance Win32_Process` to be the real Next.js server process before killing it), and the build was run only after that — sequentially, not concurrently. This incident and its fix are also worth carrying into `HANDOVER.md` or a shared team note if this repo moves to CI, since a CI runner building while a preview/dev instance is live on the same filesystem would hit the identical failure mode.

A secondary, unrelated observation during this same live-quiz pass: an initial pair of clicks on "View custom tabs" (§3.4 step 8) appeared not to open the modal per the accessibility-tree snapshot, which briefly looked like a real RBAC-path bug. A direct DOM check (`document.body.innerText.includes('Custom tabs')`) proved the modal *had* opened — the false negative was a snapshot-timing artifact around the page's own data-loading state, not a defect in the feature. Recorded here so a future reader doesn't mistake "the automation snapshot looked empty" for "the feature didn't work" without a second, lower-level check.
