# CONSTRAINTS.md — Statutory Compliance & Security Guardrails

> [!IMPORTANT]
> These are non-negotiable boundaries. Where a constraint below is *not yet enforced in code* (Section 2), that's flagged explicitly — don't assume a guardrail exists just because it's listed as a principle here. Verified vs. aspirational status is called out per item.

## 1. Enforced guardrails (verified in code this session)

### ⛔ Statutory report layout preservation
**Never** alter the layout/structure of Balance Sheet, P&L, Cash Flow (IND AS 7), or Notes to Accounts (1–26).

> [!IMPORTANT]
> **Correction (2026-09-17, see `QA-AUDIT-LATENCY-FIX.md` §4.1)**: the claim that used to appear here — "no `tab_key` wiring exists for `bs`, `pl`, `cashflow`, or `notes`" — is **stale and wrong**. `BalanceSheetTab.tsx` (and presumably its siblings, not independently re-checked) does register a `tab_key` with `CustomizableTabPanel`, confirmed live. The actual guardrail is narrower and still holds: only a `supplementaryView` (KPI strip + composition visual) is passed to `CustomizableTabPanel`'s `fixedView`; the mandated Schedule III statutory table renders unconditionally, directly in the tab component, and is **never** passed to `CustomizableTabPanel` — verified live by entering customize mode and confirming the full statutory table stayed on screen throughout. Route any request to actually restructure/hide/reorder a statutory statement's own lines to Report Builder instead.

### ⛔ Sample Mode route safety
Unauthenticated `401` responses on `/api/v1/auth/me`, `/api/v1/dashboard-layout/all`, `/api/v1/custom-metrics`, `/api/v1/auth/refresh` during Sample Mode are **expected** — verified live against `localhost:4000` in Sample Data mode. Never force a login lock or treat these as errors in that mode.

### ⛔ No string-eval'd financial formulas
Custom metrics (`lib/financial/custom-metric-engine.ts`) must remain structured expression trees (`{type:'metric'|'const'|'op'}`) — verified: no `eval()`/`Function()` construction path exists in that file. Never add a "raw formula string" input path; it reopens an injection surface that was deliberately designed out.

### ⛔ Role-gated Zoho connection
Initiating a Zoho OAuth connection (`GET /api/v1/zoho/auth-url`) requires `ROLE_SETS.isCFO` — verified in `app/api/v1/zoho/auth-url/route.ts`. Don't expose "Connect Zoho Books" to roles below CFO/admin without deliberately revisiting this gate.

### ⛔ Error handling integrity
Never swallow database, auth, or Zoho API exceptions silently. The existing pattern (`withErrorHandling` wrapper, explicit `error` fields returned to the client, `console.warn`/`console.error` on partial failures like COA fetch or foreign-currency skips) should be followed for any new route — a caught-and-ignored exception is a regression, not a simplification.

## 2. Principle, not (yet) an enforced check — verify before assuming

### ⚠️ Double-entry balance equality (Σ Dr = Σ Cr)
**Status: not currently validated in code.** This is searched for and not found: no aggregate Dr/Cr equality check exists in `app/api/v1/tb/upload/route.ts` or `lib/financial/tb-engine.ts` at the time of this audit. The principle is correct — any valid trial balance must have total debits equal total credits across all 12 monthly columns plus opening balances — but the app currently **trusts the uploaded/synced data** rather than rejecting an out-of-balance file.

> [!IMPORTANT]
> This is a real gap, not a documented design decision like the Cash Flow hardcoding (see `DECISIONS.md` §3). If a validation is added later, this section should be updated to point at the actual check (file + line) rather than staying aspirational.

### ⚠️ No hardcoded layout math in exports
PDF export (`lib/exports/pdf.ts`) does use `doc.internal.pageSize.getHeight()` and `lastAutoTable.finalY` for dynamic vertical flow — verified, this part holds. Page-margin constants (e.g. `doc.line(14, …, 196, …)`) are fixed x-coordinates, which is normal for PDF margins, not the kind of brittle "assumed content height" hardcoding this constraint is meant to prevent. Treat "no hardcoded bounds" as applying to *content-dependent* positioning (table heights, row counts, section breaks), not page margins.

## 3. Domain constraints (finance/statutory, not code-enforced but must be respected in any output)

- Schedule III of the Companies Act, 2013 governs Balance Sheet and P&L format for Indian companies — line-item groupings and ordering are not stylistic choices.
- IND AS 7 governs Cash Flow statement presentation (Operating/Investing/Financing classification).
- IND AS 21 governs functional vs. presentation currency — the Trial Balance's recorded currency (set at upload time) is independent of the top-bar "presentation currency" selector; converting one does not change the other.
- IND AS 12 governs tax recognition — see `DECISIONS.md` §2 for how this platform models it given incomplete source data.
- Anything not derivable from a Trial Balance (PPE gross block/asset register, IND AS 19 actuarial DBO, ECL invoice-level ageing, IND AS 102 ESOP register, IND AS 116 lease schedules) must be disclosed as out of scope, not silently omitted or estimated — matching the Upload tab's own UI copy.
