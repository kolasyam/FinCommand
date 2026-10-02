# FinCommand Pro — Platform Reference

A CFO/CEO financial reporting platform for Indian companies, built to Schedule III of the Companies Act, 2013 and IND AS. This document is a consolidated reference to the platform's architecture, features, and known behavior — assembled from the codebase and verified against the running app (`localhost:4000`) via live inspection. For setup/install steps, see `README.md`; this file is the "what it is and how it behaves" companion.

## 1. What this platform is

- Single deployable **Next.js 15 (App Router + TypeScript)** app, replacing an earlier Express + vanilla-JS stack.
- Runs on **port 4000** (`npm run dev` → `next dev -p 4000`).
- Stack: React 18, PostgreSQL (`pg`, Neon-ready) via `lib/db/neon.ts`, JWT auth (`jsonwebtoken` + `bcryptjs`), Chart.js for visuals, `jspdf`/`xlsx` for exports.
- Two data modes, both live in the UI at all times:
  - **Sample Data** (default, no login required) — a synthetic but internally-balanced ledger set (`lib/financial/sample-data.ts`) that runs through the *same* computation engine as real data.
  - **Live — API** — real company data after sign-in, sourced from an uploaded Trial Balance or a Zoho Books OAuth sync.
- Demo company: **Acme Technologies Ltd**, FY 2024-25, with FY24/FY23 comparatives seeded.
- Seeded roles (`db/seed.ts`): `admin`, `cfo` (`cfo@acmetech.in`), `ceo`, `auditor` — RBAC is a first-class concept in the schema, not bolted on.

## 2. The 4-layer data architecture

This is the mental model for tracing any number on screen back to its source:

1. **Layer 1 — Source (Trial Balance)**: opening balances + 12 months × Dr/Cr per ledger, uploaded as a 28-column Excel (`Ledger_Code, Ledger_Name, Opening_Dr, Opening_Cr, Apr_Dr…Mar_Cr`) or synced monthly from Zoho Books.
2. **Layer 2 — Map (Ledger Master)**: 90+ pre-seeded IND AS mappings. Every ledger resolves to a Note number + BS/P&L section + treasury type.
3. **Layer 3 — Compute (Period Engine)**: `lib/financial/tb-engine.ts` — the single source of truth for every figure in the app. Balance Sheet values are cumulative-to-date; P&L values are summed over whichever months are selected. Every period view (Monthly → Quarterly → Half-year → Annual → 3-Year) is derived from the same Trial Balance, with no re-upload.
4. **Layer 4 — Output (Reports)**: 6 statutory/analytical report families — MIS, Balance Sheet, P&L, Notes to Accounts (1–26), Cash Flow, Treasury — plus derived Ratios, Working Capital, Customer Margin, Vendor Expense, and Board Pack.

**Explicitly out of scope** (not derivable from a Trial Balance, and flagged as such in the Upload tab's own UI): PPE gross block / asset register, IND AS 19 actuarial DBO, ECL invoice-level ageing, IND AS 102 ESOP register, IND AS 116 lease schedules.

### Known, documented quirks
These are intentional carry-overs from the original `tbEngine.js`, not bugs to be silently patched:
- **Cash Flow statement**: working-capital/capex/financing figures are **hardcoded constants**, not derived from ledger data.
- **ESOP cash-flow adjustment**: dead code, due to a key-prefix mismatch in the original note-aggregation logic.
- **Tax in MIS/P&L**: modeled, not ledger-derived — flat 25% Current + 1% Deferred of PBT in a profitable period, nil in a loss period (per IND AS 12), because this Trial Balance carries no dedicated tax-provision ledger. Treat PAT-dependent figures as indicative for planning under this model.

## 3. Feature / tab inventory

Verified live against the running app (`localhost:4000/dashboard`, Sample Data mode):

| Group | Tabs |
|---|---|
| Financial Statements | Executive Overview · Balance Sheet · P&L Account · Cash Flow (IND AS 7) · Notes to Accounts |
| Analytics & Performance | MIS Report (monthly grid + trend chart) · Ratio Analysis · Working Capital (DSO/DPO/CCC) · Treasury |
| Counterparty Intelligence | Customer Margin (Zoho-sourced) · Vendor Expense (Zoho-sourced) |
| Governance & Planning | Scenario Planner · Smart Alerts · Compliance |
| Data & Tools | Board Pack · Report Builder (requires a signed-in company + real data; gated with an explanatory message in Sample mode) · Upload / Architecture (the 4-layer explainer, TB upload, Zoho OAuth panel) |

**Global controls** present on every tab (top bar / period bar): FY selector (FY25/FY24/FY23) · display unit (₹ Lakhs / Thousands / Crores) · presentation currency (INR/USD/EUR/GBP/AED, IND AS 21-aware) · view mode (Annual / 3 Years / H1-H2 / Quarterly with Q1–Q4 drill-down) · per-tab PDF/Excel export · global "All Excel" / "Annual Report PDF".

Live check confirmed these controls actually recompute data in place — e.g. switching Annual → Q1 (Apr–Jun) changed Revenue from ₹29,457L (FY annual) to ₹6,331L and ROE from 22.6% to 4.6% on the same underlying ledger data, with chart/table titles updating to match.

## 4. Dashboard customization system

- `lib/financial/dashboard-builder-engine.ts::METRIC_CATALOG` is the curated, typed catalog of every bindable metric (grouped: Revenue & Profitability, Balance Sheet, Cash Flow, Treasury, Notes, Customers & Vendors, etc.), each with a `key`, `label`, `group`, and a resolver against a `ReportBundle`.
- `CustomizableTabPanel.tsx` (via a `tab_key` column on `dashboard_layouts`) extends customization to 9 tabs: My Dashboard + Overview, MIS, Ratios, Treasury, Working Capital, Customer Margin, Vendor Expense, Board Pack. Each wraps its original fixed-view JSX unchanged as a `fixedView` fallback, so a user who never opts in sees zero behavior change.
- **Deliberately excluded from customization**: Balance Sheet, P&L, Cash Flow, Notes (Schedule III compliance risk if reflowed), and Compliance/Scenario Planner (don't fit a KPI-grid model).
- Custom metrics (`lib/financial/custom-metric-engine.ts`) use **structured expression trees only** (`{type:'metric'|'const'|'op', ...}`) — never string-eval'd. A custom metric may reference built-in catalog keys but never another custom metric, which keeps the graph cycle-free by construction.
- Layout resolution is 3-tier: personal → company default → system starter.

## 5. API surface

`app/api/v1/**` mirrors the report families 1:1:
- `reports/{all,bs,pl,cashflow,mis,notes,ratios,treasury,threeyear}`
- `auth/{login,logout,me,refresh,change-password,signup-wizard}`
- `zoho/{auth-url,callback,config,status,sync,disconnect,logs}`
- `tb`, `ledger-master`, `dashboard-layout`, `custom-metrics`, `companies`, `fy`, `fx-rate`, `audit`, `health`

`middleware.ts` applies CORS, rate limiting (20 requests/15min on login, 200/15min global), and security headers to `/api/v1/*` only — page routes are unauthenticated at the edge, with auth enforced per-route instead.

## 6. Operating notes for anyone (human or AI) working on this repo

- **Verification discipline**: run `npm run typecheck`, `npm test`, and `npm run build` before calling any change done. For anything touching the database or computed financial figures, write a throwaway root-level `_diag_*.ts` script that exercises real DB operations against the seeded "Acme Technologies Ltd" company, run it with `npx tsx`, then delete it — this is an established convention in this repo (see the many pre-existing `_diag*.ts`/`.mjs` files).
- **Sample vs Live mode while debugging**: in Sample mode, `401`s on `/api/v1/auth/me`, `/dashboard-layout/all`, `/custom-metrics`, and `/auth/refresh` are *correct behavior*, not bugs — there's no session to authorize.
- **Statutory-fixed tabs**: don't restructure Balance Sheet, P&L, Cash Flow, or Notes layouts — route customization requests to Report Builder or one of the 9 customizable tabs instead.
- **Live visual verification**: the dev server runs at `localhost:4000`. When a question is about current rendering or behavior (not just "what does the code say"), verify against the running app directly (e.g. via Chrome DevTools automation — navigate, snapshot/screenshot, check console and network requests) rather than reasoning from source alone.

## 7. Keeping this file current

This is a living reference, not a one-time snapshot. Whenever new, non-obvious understanding of this platform is built up — a newly discovered quirk, a verified architectural detail, a feature confirmed live that wasn't documented yet — it belongs here, not only in chat history that evaporates at the end of a session.

- **Update, don't duplicate**: edit the relevant section above in place rather than appending a redundant new one.
- **This file vs. `README.md`**: `README.md` is the human-facing setup/install guide (env vars, `npm run dev`, deployment). This file is the deeper architecture/behavior reference — what the platform actually does and why, verified against both the code and the running app.
- **Write trigger**: something the next reader (human or AI) would otherwise have to re-derive by reading code or re-testing the live app — not every trivial question.

---
*Compiled from repository inspection (`package.json`, `README.md`, `lib/financial/*`, `app/api/v1/**`, `middleware.ts`, `db/seed.ts`) and live verification against `localhost:4000` (Executive Overview, MIS Report, Working Capital, Report Builder, Upload/Architecture tabs; Annual/Quarterly/Q1 period-drill-down interaction).*
