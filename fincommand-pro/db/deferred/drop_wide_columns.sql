-- drop_tb_ledgers_wide_columns (Phase D step 3). DESTRUCTIVE: kept in db/deferred until approved - see the README there.
--
-- Now that ledger_month_amounts holds the source of truth for amounts and the app
-- correctly reads from it, we drop the legacy wide columns from tb_ledgers.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='tb_ledgers' AND column_name='m1_dr'
  ) THEN
    RAISE NOTICE 'pre-flight: wide columns already dropped';
    RETURN;
  END IF;

  ALTER TABLE tb_ledgers
    DROP COLUMN m1_dr, DROP COLUMN m1_cr,
    DROP COLUMN m2_dr, DROP COLUMN m2_cr,
    DROP COLUMN m3_dr, DROP COLUMN m3_cr,
    DROP COLUMN m4_dr, DROP COLUMN m4_cr,
    DROP COLUMN m5_dr, DROP COLUMN m5_cr,
    DROP COLUMN m6_dr, DROP COLUMN m6_cr,
    DROP COLUMN m7_dr, DROP COLUMN m7_cr,
    DROP COLUMN m8_dr, DROP COLUMN m8_cr,
    DROP COLUMN m9_dr, DROP COLUMN m9_cr,
    DROP COLUMN m10_dr, DROP COLUMN m10_cr,
    DROP COLUMN m11_dr, DROP COLUMN m11_cr,
    DROP COLUMN m12_dr, DROP COLUMN m12_cr;

  RAISE NOTICE 'done: dropped m1_dr through m12_cr from tb_ledgers';
END $$;
