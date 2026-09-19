# PAIR_PROGRAMMING.md — The 5 High-Leverage Developer Habits

> [!IMPORTANT]
> This is the operating protocol for any AI coding assistant (or human pairing partner) working in this repo. It governs *how* work happens, not *what* the platform does — see `HANDOVER.md`, `DECISIONS.md`, `CONSTRAINTS.md`, `FLOW.md`, `VERIFICATION.md` for the "what."

## Habit 10 — Read every diff line-by-line (financial precision)
**Rule**: never approve or apply code blindly. Review every diff line-by-line before it's considered done.

**Why it matters here specifically**: financial code handles Crores/Lakhs unit conversion, 12 monthly Dr/Cr columns (`m1_dr`..`m12_cr`, verified against `lib/financial/tb-engine.ts`'s `TBRow` type — plus `op_dr`/`op_cr` for opening balances), and Schedule III classifications. A single misnamed column, inverted sign (`normal_bal: 'Dr' | 'Cr'` flips which side is "positive"), or misplaced decimal distorts the Balance Sheet, P&L, and Cash Flow statements — and because every report reads from the same `tb-engine.ts` (see `FLOW.md` §1), a silent error there propagates to every tab at once, not just one.

## Habit 11 — Plan first ("why" before "what")
**Rule**: before modifying core calculation logic (`lib/financial/tb-engine.ts`), database schemas, or API routes, write an explicit plan first — what's changing, why, and what the expected numeric/behavioral effect is.

**Why it matters here specifically**: this catches architectural and mathematical flaws in prose before 200 lines of code get written. The tax model, foreign-currency exclusions, and Cash Flow hardcoded-constants decisions (`DECISIONS.md`) all exist because someone reasoned through the tradeoff *before* implementing — the plan step is what makes that reasoning visible and reviewable ahead of the diff, not reconstructed from it afterward.

## Habit 12 — Small requests only (scope control)
**Rule**: keep every task tightly scoped to one logical component or feature — e.g. "Optimize Zoho sync batching" or "Fix Working Capital DSO calculation," not "improve the dashboard."

**Why it matters here specifically**: this platform's tabs share a single computation engine and a handful of cross-cutting systems (dashboard customization, metric catalog, exports). A multi-tab overhaul in one prompt makes it much harder to tell which part of a resulting bug came from which change. Small asks produce clean, verifiable diffs and keep `VERIFICATION.md`'s "did the actual number on screen change correctly" check meaningful — a check against a 12-file diff proves much less than the same check against a 2-file one.

## Habit 13 — Session handoff summary ritual
**Rule**: end every completed task with a concise, structured walkthrough — exact files touched, `npm test` result, `npx tsc --noEmit` result, and empirical live-app behavior (not just "tests pass").

**Minimum walkthrough shape**:
```
## Walkthrough — <task name>
**Files changed**: <list>
**Typecheck**: npx tsc --noEmit → <pass/fail>
**Tests**: npm test → <N passed / N total>
**Diagnostic script** (if DB/financial logic touched): <_diag file>, run against <company>, result: <summary>, then deleted
**Live check**: <what was navigated to on localhost:4000, what was confirmed>
```
This is the same bar `VERIFICATION.md`'s "Definition of done" sets — the walkthrough is that checklist's evidence, not a separate ritual.

## Habit 15 — Own the mental model (4-layer data traceability)
**Rule**: every metric on screen must be traceable back to its source through the platform's 4-layer architecture (full detail in `FLOW.md` §1):
1. **Layer 1 — Source**: Trial Balance — opening balances + 12 months Dr/Cr per ledger.
2. **Layer 2 — Map**: Ledger Master — 90+ IND AS Note mappings.
3. **Layer 3 — Compute**: `lib/financial/tb-engine.ts` — single source of truth.
4. **Layer 4 — Output**: statutory statements & analytics tabs.

**Why it matters here specifically**: never accept or output a financial number without knowing its exact derivation through this stack. In practice this means: before answering "why is EBITDA X," trace it to the actual `tb-engine.ts` computation (or the exact KPI card), not a plausible-sounding restatement — matching the grounding rule already in the FinCommand Pro copilot system prompt.

## Execution protocol (how these 5 habits compose into one workflow)

1. **Given a task** → explain the approach, present the plan (Habit 11). For anything non-trivial touching `tb-engine.ts`, schema, or an API route, this is a short written plan, not just a verbal intent.
2. **While editing** → keep edits minimal, precise, scoped to the task (Habit 12). Resist folding in unrelated cleanup.
3. **Before calling it done** → review the diff line-by-line (Habit 10), run `npx tsc --noEmit` and `npm test` (per `VERIFICATION.md` Steps 1–2), and — for DB/financial-logic changes — a throwaway `_diag*.ts` script plus a live check at `localhost:4000` (`VERIFICATION.md` Steps 3–4).
4. **Concluding** → post the walkthrough (Habit 13), grounded in the actual 4-layer trace for any number discussed (Habit 15).
