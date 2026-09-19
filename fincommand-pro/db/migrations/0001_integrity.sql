-- 0001 — integrity rules for trial-balance data (DB Phase 0).
--
-- Non-destructive: adds constraints the data already satisfies (checked
-- first, below — the migration stops with a clear message otherwise), fixes
-- three CHECKs that never checked anything, and adds new tb_uploads columns
-- filled from existing rows. No existing value is changed.

-- ── Pre-flight: stop before touching anything if existing data would break a rule ──
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM tb_ledgers WHERE upload_id IS NULL OR company_id IS NULL OR financial_year_id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '0001 pre-flight: % tb_ledgers row(s) are missing upload/company/year', n; END IF;
  SELECT count(*) INTO n FROM tb_customer_revenue WHERE upload_id IS NULL OR company_id IS NULL OR financial_year_id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '0001 pre-flight: % tb_customer_revenue row(s) are missing upload/company/year', n; END IF;
  SELECT count(*) INTO n FROM tb_vendor_expense WHERE upload_id IS NULL OR company_id IS NULL OR financial_year_id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '0001 pre-flight: % tb_vendor_expense row(s) are missing upload/company/year', n; END IF;
  SELECT count(*) INTO n FROM tb_customer_cost WHERE upload_id IS NULL OR company_id IS NULL OR financial_year_id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '0001 pre-flight: % tb_customer_cost row(s) are missing upload/company/year', n; END IF;
  SELECT count(*) INTO n FROM tb_uploads WHERE company_id IS NULL OR financial_year_id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '0001 pre-flight: % tb_uploads row(s) are missing company/year', n; END IF;
  SELECT count(*) INTO n FROM financial_years WHERE company_id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '0001 pre-flight: % financial_years row(s) have no company', n; END IF;

  SELECT count(*) INTO n FROM financial_years WHERE start_date >= end_date;
  IF n > 0 THEN RAISE EXCEPTION '0001 pre-flight: % financial year(s) start on or after their end date', n; END IF;
  SELECT count(*) INTO n FROM financial_years a JOIN financial_years b
    ON a.company_id = b.company_id AND a.id < b.id
   AND daterange(a.start_date, a.end_date, '[]') && daterange(b.start_date, b.end_date, '[]');
  IF n > 0 THEN RAISE EXCEPTION '0001 pre-flight: % pair(s) of financial years overlap', n; END IF;

  SELECT count(*) INTO n FROM (
    SELECT 1 FROM tb_uploads WHERE is_current = TRUE GROUP BY company_id, financial_year_id HAVING count(*) > 1) x;
  IF n > 0 THEN RAISE EXCEPTION '0001 pre-flight: % company/year(s) have more than one current batch', n; END IF;

  SELECT count(*) INTO n FROM (
    SELECT 1 FROM tb_ledgers GROUP BY upload_id, lower(btrim(ledger_name)), COALESCE(ledger_code, '') HAVING count(*) > 1) x;
  IF n > 0 THEN RAISE EXCEPTION '0001 pre-flight: % ledger(s) appear twice in the same batch', n; END IF;

  SELECT count(*) INTO n FROM tb_ledgers
   WHERE (section IS NOT NULL AND section NOT IN ('anc','ac','eq','lnc','lc','inc','exp'))
      OR (treasury_type IS NOT NULL AND treasury_type NOT IN ('cash','bank_ca','bank_sb','fd','mf'));
  IF n > 0 THEN RAISE EXCEPTION '0001 pre-flight: % tb_ledgers row(s) have an unknown section/treasury_type', n; END IF;
  SELECT count(*) INTO n FROM ledger_master
   WHERE treasury_type IS NOT NULL AND treasury_type NOT IN ('cash','bank_ca','bank_sb','fd','mf');
  IF n > 0 THEN RAISE EXCEPTION '0001 pre-flight: % ledger_master row(s) have an unknown treasury_type', n; END IF;

  RAISE NOTICE '0001 pre-flight passed';
END $$;

-- Needed for the "no overlapping years" rule (equality on a uuid inside a GiST index).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── Every row belongs to a company, a year and (for ledger data) a batch ──
ALTER TABLE tb_ledgers
  ALTER COLUMN upload_id SET NOT NULL,
  ALTER COLUMN company_id SET NOT NULL,
  ALTER COLUMN financial_year_id SET NOT NULL;
ALTER TABLE tb_customer_revenue
  ALTER COLUMN upload_id SET NOT NULL,
  ALTER COLUMN company_id SET NOT NULL,
  ALTER COLUMN financial_year_id SET NOT NULL;
ALTER TABLE tb_vendor_expense
  ALTER COLUMN upload_id SET NOT NULL,
  ALTER COLUMN company_id SET NOT NULL,
  ALTER COLUMN financial_year_id SET NOT NULL;
ALTER TABLE tb_customer_cost
  ALTER COLUMN upload_id SET NOT NULL,
  ALTER COLUMN company_id SET NOT NULL,
  ALTER COLUMN financial_year_id SET NOT NULL;
ALTER TABLE tb_uploads
  ALTER COLUMN company_id SET NOT NULL,
  ALTER COLUMN financial_year_id SET NOT NULL;
ALTER TABLE financial_years
  ALTER COLUMN company_id SET NOT NULL;

-- ── Financial years: real date ranges that never overlap within a company ──
ALTER TABLE financial_years DROP CONSTRAINT IF EXISTS financial_years_dates_check;
ALTER TABLE financial_years ADD CONSTRAINT financial_years_dates_check CHECK (start_date < end_date);
ALTER TABLE financial_years DROP CONSTRAINT IF EXISTS financial_years_no_overlap;
ALTER TABLE financial_years ADD CONSTRAINT financial_years_no_overlap
  EXCLUDE USING gist (company_id WITH =, daterange(start_date, end_date, '[]') WITH &&);

-- Which source owns the year's data ("first source owns the year"). NULL =
-- nothing loaded yet; the first Excel upload or Zoho sync claims it.
ALTER TABLE financial_years ADD COLUMN IF NOT EXISTS data_source VARCHAR(10);
ALTER TABLE financial_years DROP CONSTRAINT IF EXISTS financial_years_data_source_check;
ALTER TABLE financial_years ADD CONSTRAINT financial_years_data_source_check
  CHECK (data_source IS NULL OR data_source IN ('zoho','excel'));
UPDATE financial_years fy
   SET data_source = u.source
  FROM tb_uploads u
 WHERE u.financial_year_id = fy.id AND u.company_id = fy.company_id
   AND u.is_current = TRUE AND u.source IN ('zoho','excel')
   AND fy.data_source IS NULL;

-- ── At most one current batch per company + year ──
-- Replaces the plain partial index from schema.sql (same columns, same predicate, now UNIQUE).
DROP INDEX IF EXISTS idx_tb_uploads_current_partial;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tb_uploads_one_current
  ON tb_uploads (company_id, financial_year_id) WHERE is_current = TRUE;

-- ── No ledger twice in one batch ──
-- Name AND code: the seeded chart legitimately has one name under two codes
-- ("Amortisation — Intangibles" is 1023, balance sheet, and 7032, P&L).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tb_ledgers_upload_ledger
  ON tb_ledgers (upload_id, lower(btrim(ledger_name)), COALESCE(ledger_code, ''));

-- ── Fix CHECKs written as IN (…, NULL): x IN (…, NULL) is NULL, never FALSE, so they accepted anything ──
ALTER TABLE tb_ledgers DROP CONSTRAINT IF EXISTS tb_ledgers_section_check;
ALTER TABLE tb_ledgers ADD CONSTRAINT tb_ledgers_section_check
  CHECK (section IS NULL OR section IN ('anc','ac','eq','lnc','lc','inc','exp'));
ALTER TABLE tb_ledgers DROP CONSTRAINT IF EXISTS tb_ledgers_treasury_type_check;
ALTER TABLE tb_ledgers ADD CONSTRAINT tb_ledgers_treasury_type_check
  CHECK (treasury_type IS NULL OR treasury_type IN ('cash','bank_ca','bank_sb','fd','mf'));
ALTER TABLE ledger_master DROP CONSTRAINT IF EXISTS ledger_master_treasury_type_check;
ALTER TABLE ledger_master ADD CONSTRAINT ledger_master_treasury_type_check
  CHECK (treasury_type IS NULL OR treasury_type IN ('cash','bank_ca','bank_sb','fd','mf'));

-- ── Batch facts recorded at write time ──
--   currency         the batch's own source currency (was only on companies, so changing it re-labelled history)
--   file_sha256      Excel file fingerprint, to catch an identical re-upload
--   total_dr/cr      opening + all 12 months; balance_diff = total_dr - total_cr
--   is_balanced      opening and every month balance within ₹1 (warn only — never blocks a load)
--   validation       {tolerance, opening_diff, month_diffs[12], closing_diff}
--   data_changed_at  bumped when a batch's rows change after load (reclassify) — part of the report cache key
ALTER TABLE tb_uploads
  ADD COLUMN IF NOT EXISTS currency        CHAR(3),
  ADD COLUMN IF NOT EXISTS file_sha256     VARCHAR(64),
  ADD COLUMN IF NOT EXISTS total_dr        NUMERIC(20,2),
  ADD COLUMN IF NOT EXISTS total_cr        NUMERIC(20,2),
  ADD COLUMN IF NOT EXISTS balance_diff    NUMERIC(20,2),
  ADD COLUMN IF NOT EXISTS is_balanced     BOOLEAN,
  ADD COLUMN IF NOT EXISTS validation      JSONB,
  ADD COLUMN IF NOT EXISTS data_changed_at TIMESTAMPTZ DEFAULT NOW();

-- Backfill from each batch's own ledger rows (same arithmetic as
-- lib/financial/tb-validation.ts::summarizeTrialBalance).
WITH s AS (
  SELECT upload_id,
         sum(COALESCE(op_dr,0))  AS op_dr,  sum(COALESCE(op_cr,0))  AS op_cr,
         ARRAY[
           sum(COALESCE(m1_dr,0))  - sum(COALESCE(m1_cr,0)),
           sum(COALESCE(m2_dr,0))  - sum(COALESCE(m2_cr,0)),
           sum(COALESCE(m3_dr,0))  - sum(COALESCE(m3_cr,0)),
           sum(COALESCE(m4_dr,0))  - sum(COALESCE(m4_cr,0)),
           sum(COALESCE(m5_dr,0))  - sum(COALESCE(m5_cr,0)),
           sum(COALESCE(m6_dr,0))  - sum(COALESCE(m6_cr,0)),
           sum(COALESCE(m7_dr,0))  - sum(COALESCE(m7_cr,0)),
           sum(COALESCE(m8_dr,0))  - sum(COALESCE(m8_cr,0)),
           sum(COALESCE(m9_dr,0))  - sum(COALESCE(m9_cr,0)),
           sum(COALESCE(m10_dr,0)) - sum(COALESCE(m10_cr,0)),
           sum(COALESCE(m11_dr,0)) - sum(COALESCE(m11_cr,0)),
           sum(COALESCE(m12_dr,0)) - sum(COALESCE(m12_cr,0))
         ]::numeric[] AS month_diffs,
         sum(COALESCE(op_dr,0) + COALESCE(m1_dr,0) + COALESCE(m2_dr,0) + COALESCE(m3_dr,0) + COALESCE(m4_dr,0)
           + COALESCE(m5_dr,0) + COALESCE(m6_dr,0) + COALESCE(m7_dr,0) + COALESCE(m8_dr,0)
           + COALESCE(m9_dr,0) + COALESCE(m10_dr,0) + COALESCE(m11_dr,0) + COALESCE(m12_dr,0)) AS total_dr,
         sum(COALESCE(op_cr,0) + COALESCE(m1_cr,0) + COALESCE(m2_cr,0) + COALESCE(m3_cr,0) + COALESCE(m4_cr,0)
           + COALESCE(m5_cr,0) + COALESCE(m6_cr,0) + COALESCE(m7_cr,0) + COALESCE(m8_cr,0)
           + COALESCE(m9_cr,0) + COALESCE(m10_cr,0) + COALESCE(m11_cr,0) + COALESCE(m12_cr,0)) AS total_cr
    FROM tb_ledgers
   GROUP BY upload_id
)
UPDATE tb_uploads u
   SET total_dr     = round(s.total_dr, 2),
       total_cr     = round(s.total_cr, 2),
       balance_diff = round(s.total_dr - s.total_cr, 2),
       is_balanced  = abs(s.op_dr - s.op_cr) <= 1
                      AND (SELECT bool_and(abs(d) <= 1) FROM unnest(s.month_diffs) d),
       validation   = jsonb_build_object(
                        'tolerance', 1,
                        'opening_diff', round(s.op_dr - s.op_cr, 2),
                        'month_diffs', (SELECT jsonb_agg(round(d, 2) ORDER BY i) FROM unnest(s.month_diffs) WITH ORDINALITY AS t(d, i)),
                        'closing_diff', round(s.total_dr - s.total_cr, 2))
  FROM s
 WHERE s.upload_id = u.id AND u.total_dr IS NULL;

-- Today every report labels a batch with the company's current currency, so
-- that is exactly the value to freeze onto existing batches.
UPDATE tb_uploads u
   SET currency = c.currency
  FROM companies c
 WHERE c.id = u.company_id AND u.currency IS NULL;

UPDATE tb_uploads SET data_changed_at = uploaded_at WHERE uploaded_at IS NOT NULL;

DO $$
DECLARE total bigint; balanced bigint; owned bigint;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE is_balanced) INTO total, balanced FROM tb_uploads;
  SELECT count(*) INTO owned FROM financial_years WHERE data_source IS NOT NULL;
  RAISE NOTICE '0001 done: % batches (% balanced), % financial years now have an owning source', total, balanced, owned;
END $$;
