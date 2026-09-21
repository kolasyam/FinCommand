-- 0010 — indexes that match the order the bank-transaction list is shown in.
--
-- The list is "newest first, blanks last, then account and id" (txn_date DESC NULLS LAST, account_id, txn_id) -
-- a total order, so paging is stable even though a Zoho transaction id repeats across accounts.
-- The two indexes made in 0009 were plain "txn_date DESC", which puts blanks FIRST, so Postgres could not use
-- them for that order and read and sorted the WHOLE company for every page (measured: 135 ms for page 1 and
-- 312 ms for page 400 at 200,000 rows, growing with the row count). These match exactly, so a page is read
-- straight off the index and stops after its 50 rows. They also serve the date-range and per-account queries the
-- two old indexes served, so those are dropped (nothing else uses them).
--
-- Schema only; no data is touched. Replaces indexes created by 0009 (never applied to production before this).

CREATE INDEX IF NOT EXISTS idx_zoho_bank_txn_list
  ON zoho_bank_transactions (company_id, txn_date DESC NULLS LAST, account_id, txn_id);
CREATE INDEX IF NOT EXISTS idx_zoho_bank_txn_account_list
  ON zoho_bank_transactions (company_id, account_id, txn_date DESC NULLS LAST, txn_id);

DROP INDEX IF EXISTS idx_zoho_bank_txn_date;
DROP INDEX IF EXISTS idx_zoho_bank_txn_account_date;

DO $$
DECLARE n int; old int;
BEGIN
  SELECT count(*) INTO n FROM pg_indexes
   WHERE tablename = 'zoho_bank_transactions' AND indexname IN ('idx_zoho_bank_txn_list', 'idx_zoho_bank_txn_account_list');
  IF n <> 2 THEN RAISE EXCEPTION '0010 post-check: expected the 2 new indexes, found %', n; END IF;
  SELECT count(*) INTO old FROM pg_indexes
   WHERE tablename = 'zoho_bank_transactions' AND indexname IN ('idx_zoho_bank_txn_date', 'idx_zoho_bank_txn_account_date');
  IF old <> 0 THEN RAISE EXCEPTION '0010 post-check: the superseded indexes are still there'; END IF;
  -- every partition must carry the new indexes too (they are created on the parent and cascade)
  SELECT count(*) INTO n FROM pg_indexes WHERE tablename ~ '^zoho_bank_transactions_p[0-9]+$' AND indexdef LIKE '%txn_date DESC NULLS LAST%';
  IF n <> 32 THEN RAISE EXCEPTION '0010 post-check: expected 32 partition indexes (2 x 16), found %', n; END IF;
END $$;
