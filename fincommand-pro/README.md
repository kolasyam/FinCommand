# FinCommand Pro — Unified Next.js App

A single Next.js (App Router + TypeScript) application replacing the original
Express backend (`backend/`) and vanilla-JS frontend (`frontend/index.html`)
with one deployable unit: React + Tailwind UI, Next.js Route Handlers for the
API, and PostgreSQL (Neon-ready) for storage.

## Getting started

```bash
npm install
cp .env.example .env         # fill in real DB_*/JWT_*/ZOHO_* values
npm run db:init               # creates schema + seeds the 90-row ledger master
npm run db:seed               # creates a demo company, FYs, and 4 demo users
npm run dev                   # runs on http://localhost:4000
```

Visit `/` for the landing page, or `/dashboard` directly. The dashboard works
immediately with **Sample Data** (no login, no database) — click "Continue
with Sample Data" in the login modal, or just do nothing; sample mode is the
default. Sign in with a seeded demo user (see `db/seed.ts`) to switch to
**Live — API** mode against your real database.

## Project layout

- `app/api/v1/**/route.ts` — all backend endpoints, 1:1 with the original
  Express routes, same paths, same request/response shapes.
- `lib/financial/tb-engine.ts` — the financial engine (BS/P&L/MIS/Treasury/
  Cash Flow/Ratios). Direct TypeScript port of `backend/services/tbEngine.js`;
  this is still the single source of truth for every calculation.
- `lib/financial/sample-data.ts` — a synthetic, internally-balanced ledger set
  that runs through the *same* `tb-engine.ts` as live data (see "What changed
  vs. the original" below).
- `lib/db/neon.ts`, `lib/auth/*`, `lib/services/zoho.ts`, `lib/audit/*`,
  `lib/rate-limit/*`, `lib/validations/*` — typed ports of the corresponding
  Express middleware/services.
- `components/dashboard/tabs/*` — the 14 dashboard tabs.
- `middleware.ts` — CORS, security headers, and rate limiting for `/api/v1/*`.
- `db/schema.sql`, `db/init.ts`, `db/seed.ts` — schema + seed scripts, ported
  from `backend/db/*.js`.

## Environment variables

Every variable name matches `backend/.env` exactly — see `.env.example`. The
original `.env` was never modified, renamed, or read for its values during
this migration; `DB_*` remains the source of truth for the database
connection, with an optional `DATABASE_URL` override for Neon's pooled
connection string workflow. `UPLOAD_DIR`/`LOG_DIR` are local-development-only:
Trial Balance uploads are parsed **in-memory** (no disk writes at all), so
nothing relies on persistent filesystem storage in Vercel's production
environment.

For Vercel deployment, configure the same variable names under **Project
Settings → Environment Variables**. `vercel.json` wires the Zoho auto-sync
Cron job to `/api/v1/internal/zoho-cron` (optionally protected by
`CRON_SECRET`).

## What changed vs. the original app

Migrating surfaced two real issues in the original app that the task
explicitly asked to fix rather than preserve:

1. **API-mode rendering was never implemented.** The original frontend's
   `renderAll()` always called `renderFromSample()` — even when logged in
   with real uploaded data, every tab showed the hardcoded sample dataset.
   Live mode here actually calls `/api/v1/reports/all` / `/threeyear` and
   renders the real response; failures show an explicit error banner with
   Retry (`components/ui/StatusBanners.tsx`), never a silent fallback to
   sample data.
2. **Most tabs were static mockup HTML.** Balance Sheet, P&L, Cash Flow,
   Notes, Treasury, and Ratios were hardcoded numbers in the original
   `index.html`, disconnected from any data model. All 14 tabs here are
   computed from `tb-engine.ts` in both sample and live mode.

Everything else — the financial formulas, period logic (annual/quarterly/
half-year/FY/CY), role permissions, JWT auth flow, audit trail, Zoho sync,
and TB upload column-detection — is preserved exactly, including two
intentional quirks carried over from `tbEngine.js` (documented in
`lib/financial/tb-engine.ts`'s header comment): the Cash Flow statement's
working-capital/capex/financing figures are hardcoded constants rather than
derived from ledger data, and the ESOP cash-flow adjustment is dead code due
to a key-prefix mismatch in the original note-aggregation logic.

## Tests

```bash
npm test
```

`tests/unit/tb-engine.test.ts` covers the financial engine's period
resolution and BS/P&L/MIS/Treasury computations.

## Deployment (Vercel + Neon)

1. Create a Neon Postgres project; copy its connection details into
   `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` (or `DATABASE_URL`)
   and set `DATABASE_SSL=true`.
2. Run `npm run db:init && npm run db:seed` against that database (locally,
   pointed at Neon, or via a one-off script).
3. Push this repo to Vercel, set all variables from `.env.example` in
   Project Settings, and deploy — `vercel.json` handles the Zoho Cron.
4. Update `ZOHO_REDIRECT_URI` to the production callback URL
   (`https://<your-domain>/api/v1/zoho/callback`) in both `.env` and the Zoho
   API console.
