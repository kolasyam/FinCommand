# Deferred migrations

Files here are **not** run by `db/migrate.ts` (it only reads `db/migrations/`). They are destructive and wait for an explicit go-ahead.

## drop_wide_columns.sql
Drops `tb_ledgers.m1_dr … m12_cr` (the monthly figures now live in `ledger_month_amounts`, migration 0011).

Apply ONLY after: 0011 is on main, the new code is deployed, and reports are confirmed working on the deployed app.
Then copy it into `db/migrations/` with the next free number (after the last file in db/migrations) and run the migration runner.
