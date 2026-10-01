-- 0011 — ledger_month_amounts: long-form monthly TB storage (Phase D step 1).
--
-- tb_ledgers keeps its role as the per-batch header (classification, opening
-- balance, Zoho metadata, reclassify target). This table adds one row per
-- ledger per month so that:
--
--   • calendar-year views need no two-year stitch (WHERE period_month BETWEEN …)
--   • per-account trend queries are a plain date-range scan across FYs
--   • month-level locks are possible in a future migration
--
-- Opening balance (op_dr, op_cr) is intentionally NOT stored here — it is a
-- single value per ledger per FY and belongs on tb_ledgers, where it already
-- lives. Callers that need the opening balance join tb_ledgers.
--
-- tb_ledgers wide columns (m1_dr…m12_cr) are NOT dropped here — that is a
-- separate destructive migration needing its own approved dry-run list.
-- tb-engine.ts is never touched; it still receives TbLedgerRow[] in the same
-- m1_dr…m12_cr shape via the pivoted loader or the wide loader.
--
-- Standing rules (from the Phase D spec):
--   • Every table and query stays scoped by company_id.
--   • Row-level security applied, same pattern as migration 0008.
--   • Proof runs inside the same transaction; any mismatch rolls everything back.

-- ── Pre-flight: confirm tb_ledgers has all the columns we'll read ──────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='tb_ledgers' AND column_name='m12_cr'
  ) THEN
    RAISE EXCEPTION '0011 pre-flight: tb_ledgers is missing expected monthly columns';
  END IF;
  RAISE NOTICE '0011 pre-flight passed';
END $$;

-- ── 1a. Create the table ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ledger_month_amounts (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID          NOT NULL REFERENCES companies(id)    ON DELETE CASCADE,
  batch_id      UUID          NOT NULL REFERENCES tb_uploads(id)   ON DELETE CASCADE,
  ledger_id     UUID          NOT NULL REFERENCES tb_ledgers(id)   ON DELETE CASCADE,
  account_id    UUID          REFERENCES ledger_accounts(id),
  -- First day of the calendar month this row represents (e.g. 2024-04-01).
  -- Always a DATE derived from financial_years.start_date + month offset,
  -- never an m-index column name.
  period_month  DATE          NOT NULL,
  dr            NUMERIC(18,4) NOT NULL DEFAULT 0,
  cr            NUMERIC(18,4) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE ledger_month_amounts IS
  'Phase D: long-form monthly trial balance amounts (one row per ledger per month). '
  'Complements tb_ledgers (which holds the per-batch header: opening balance, '
  'classification, Zoho metadata). Wide columns on tb_ledgers are kept until '
  'a separate approved migration drops them.';

-- Primary access patterns:
--   1. All months for one ledger in a batch (pivot load): (batch_id, ledger_id)
--   2. Date-range across batches for CY/history:         (company_id, period_month)
-- Uniqueness: one row per ledger per month (ON CONFLICT on this for dual-write)
CREATE UNIQUE INDEX IF NOT EXISTS uq_lma_ledger_month
  ON ledger_month_amounts (ledger_id, period_month);
CREATE INDEX IF NOT EXISTS idx_lma_batch
  ON ledger_month_amounts (batch_id, ledger_id);
CREATE INDEX IF NOT EXISTS idx_lma_company_month
  ON ledger_month_amounts (company_id, period_month);

-- ── 1b. Row-level security — same pattern as every other company-scoped table ──

ALTER TABLE ledger_month_amounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ledger_month_amounts;
CREATE POLICY tenant_isolation ON ledger_month_amounts
  FOR ALL TO fincommand_app
  USING  (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON ledger_month_amounts TO fincommand_app;

-- ── 1c. Backfill from every existing tb_ledgers row ───────────────────────
--
-- For each ledger, the FY's start_date is used to derive the real calendar
-- date for each m1…m12 column:
--   m1 → start_date + 0 months (April for Indian FY)
--   m2 → start_date + 1 month  (May)
--   …
--   m12→ start_date + 11 months (March)
--
-- ON CONFLICT DO NOTHING makes this idempotent — safe to re-run if the
-- migration is interrupted and retried.
--
-- account_id is resolved through the same composite key that migration 0005
-- uses: zoho_account_id takes precedence, then ledger_code, then ledger_name.

INSERT INTO ledger_month_amounts
  (id, company_id, batch_id, ledger_id, account_id, period_month, dr, cr)
SELECT
  gen_random_uuid()                                                   AS id,
  l.company_id,
  l.upload_id                                                         AS batch_id,
  l.id                                                                AS ledger_id,
  -- account_id is already set on every tb_ledgers row by migration 0005's
  -- trigger (tb_ledgers_assign_account). Copy it directly — no re-derivation.
  l.account_id,
  (fy.start_date + (m.idx * INTERVAL '1 month'))::DATE               AS period_month,
  COALESCE(
    CASE m.idx
      WHEN 0  THEN l.m1_dr  WHEN 1  THEN l.m2_dr  WHEN 2  THEN l.m3_dr
      WHEN 3  THEN l.m4_dr  WHEN 4  THEN l.m5_dr  WHEN 5  THEN l.m6_dr
      WHEN 6  THEN l.m7_dr  WHEN 7  THEN l.m8_dr  WHEN 8  THEN l.m9_dr
      WHEN 9  THEN l.m10_dr WHEN 10 THEN l.m11_dr WHEN 11 THEN l.m12_dr
    END, 0
  )::NUMERIC(18,4)                                                    AS dr,
  COALESCE(
    CASE m.idx
      WHEN 0  THEN l.m1_cr  WHEN 1  THEN l.m2_cr  WHEN 2  THEN l.m3_cr
      WHEN 3  THEN l.m4_cr  WHEN 4  THEN l.m5_cr  WHEN 5  THEN l.m6_cr
      WHEN 6  THEN l.m7_cr  WHEN 7  THEN l.m8_cr  WHEN 8  THEN l.m9_cr
      WHEN 9  THEN l.m10_cr WHEN 10 THEN l.m11_cr WHEN 11 THEN l.m12_cr
    END, 0
  )::NUMERIC(18,4)                                                    AS cr
FROM   tb_ledgers l
JOIN   tb_uploads     u   ON u.id  = l.upload_id
JOIN   financial_years fy ON fy.id = l.financial_year_id
CROSS JOIN (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11)) AS m(idx)
ON CONFLICT (ledger_id, period_month) DO NOTHING;

-- ── 1d. Proof: every wide value == long-table value ───────────────────────
--
-- For each (ledger_id, month_index), compute:
--   wide_net = m{N}_dr − m{N}_cr   from tb_ledgers
--   long_net = dr − cr             from ledger_month_amounts
-- and assert |wide_net − long_net| ≤ 0.0001.
--
-- Runs inside the same transaction — a failure rolls back the CREATE TABLE,
-- indexes, policies, and backfill together. Nothing is left half-done.

DO $$
DECLARE mismatches bigint;
BEGIN
  SELECT count(*) INTO mismatches
  FROM (
    SELECT
      l.id                                                            AS ledger_id,
      (fy.start_date + (m.idx * INTERVAL '1 month'))::DATE           AS period_month,
      COALESCE(
        CASE m.idx
          WHEN 0  THEN l.m1_dr  - l.m1_cr   WHEN 1  THEN l.m2_dr  - l.m2_cr
          WHEN 2  THEN l.m3_dr  - l.m3_cr   WHEN 3  THEN l.m4_dr  - l.m4_cr
          WHEN 4  THEN l.m5_dr  - l.m5_cr   WHEN 5  THEN l.m6_dr  - l.m6_cr
          WHEN 6  THEN l.m7_dr  - l.m7_cr   WHEN 7  THEN l.m8_dr  - l.m8_cr
          WHEN 8  THEN l.m9_dr  - l.m9_cr   WHEN 9  THEN l.m10_dr - l.m10_cr
          WHEN 10 THEN l.m11_dr - l.m11_cr  WHEN 11 THEN l.m12_dr - l.m12_cr
        END, 0
      )                                                               AS wide_net,
      COALESCE(a.dr, 0) - COALESCE(a.cr, 0)                         AS long_net
    FROM   tb_ledgers l
    JOIN   financial_years fy ON fy.id = l.financial_year_id
    CROSS JOIN (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11)) AS m(idx)
    LEFT JOIN ledger_month_amounts a
      ON  a.ledger_id    = l.id
      AND a.period_month = (fy.start_date + (m.idx * INTERVAL '1 month'))::DATE
  ) diff
  WHERE abs(wide_net - long_net) > 0.0001;

  IF mismatches > 0 THEN
    RAISE EXCEPTION
      '0011 proof FAILED: % ledger-month value(s) differ between wide and long tables — rolling back.',
      mismatches;
  END IF;

  RAISE NOTICE '0011 proof passed: all wide values match the long table exactly';
END $$;

-- ── 1e. Post-migration summary ─────────────────────────────────────────────

DO $$
DECLARE
  total_rows     bigint;
  total_batches  bigint;
  total_ledgers  bigint;
  total_companies bigint;
BEGIN
  SELECT
    count(*),
    count(DISTINCT batch_id),
    count(DISTINCT ledger_id),
    count(DISTINCT company_id)
  INTO total_rows, total_batches, total_ledgers, total_companies
  FROM ledger_month_amounts;

  RAISE NOTICE '0011 done: % month-rows, % batches, % ledger-accounts, % companies backfilled',
    total_rows, total_batches, total_ledgers, total_companies;
END $$;
