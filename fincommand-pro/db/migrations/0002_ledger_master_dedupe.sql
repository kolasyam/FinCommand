-- 0002 — one mapping per ledger in ledger_master (DB Phase 0).
--
-- ledger_master had no unique rule, so every `ON CONFLICT DO NOTHING` insert
-- (Zoho sync, the ledger-master API, seed.ts) inserted a copy anyway and
-- db:init's `ON CONFLICT (company_id, ledger_code)` always failed. Which copy
-- a sync or upload used depended on row order.
--
-- DESTRUCTIVE (approved 2026-09-19, "newest wins, back up the rest"): keeps
-- one row per company + ledger code — active first, then most recently
-- updated, then most recently created, then highest id — and moves every
-- other copy into ledger_master_dedupe_backup before deleting it. Global rows
-- (company_id NULL) are deduplicated among themselves the same way. Nothing
-- references ledger_master.id, so no other table is affected.
--
-- Uniqueness is by CODE, not name: "Amortisation — Intangibles" is
-- legitimately two ledgers (1023 balance sheet / 7032 P&L). Rows without a
-- code (none today) are unique by name instead.

CREATE TABLE IF NOT EXISTS ledger_master_dedupe_backup (LIKE ledger_master);
ALTER TABLE ledger_master_dedupe_backup
  ADD COLUMN IF NOT EXISTS kept_id    UUID,
  ADD COLUMN IF NOT EXISTS deduped_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TEMP TABLE _lm_rank ON COMMIT DROP AS
SELECT id,
       first_value(id) OVER w AS kept_id,
       row_number()    OVER w AS rn
  FROM ledger_master
WINDOW w AS (
  PARTITION BY company_id,
               CASE WHEN ledger_code IS NULL THEN 'name:' || lower(btrim(ledger_name)) ELSE 'code:' || ledger_code END
  ORDER BY is_active DESC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
);

DO $$
DECLARE before_total bigint; keep bigint;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE rn = 1) INTO before_total, keep FROM _lm_rank;
  RAISE NOTICE '0002: % ledger_master rows, keeping %, backing up and removing %', before_total, keep, before_total - keep;
END $$;

INSERT INTO ledger_master_dedupe_backup
       (id, company_id, ledger_code, ledger_name, note_no, note_name, section, treasury_type,
        normal_bal, is_global, is_active, created_by, created_at, updated_at, kept_id, deduped_at)
SELECT lm.id, lm.company_id, lm.ledger_code, lm.ledger_name, lm.note_no, lm.note_name, lm.section, lm.treasury_type,
       lm.normal_bal, lm.is_global, lm.is_active, lm.created_by, lm.created_at, lm.updated_at, r.kept_id, NOW()
  FROM ledger_master lm
  JOIN _lm_rank r ON r.id = lm.id
 WHERE r.rn > 1;

DELETE FROM ledger_master lm
 USING _lm_rank r
 WHERE r.id = lm.id AND r.rn > 1;

-- NULLS NOT DISTINCT so global rows (company_id NULL) are covered too.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_master_code
  ON ledger_master (company_id, ledger_code) NULLS NOT DISTINCT
  WHERE ledger_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_master_name_without_code
  ON ledger_master (company_id, lower(btrim(ledger_name))) NULLS NOT DISTINCT
  WHERE ledger_code IS NULL;

DO $$
DECLARE after_total bigint; expected bigint; backed_up bigint;
BEGIN
  SELECT count(*) INTO after_total FROM ledger_master;
  SELECT count(*) INTO expected FROM _lm_rank WHERE rn = 1;
  SELECT count(*) INTO backed_up FROM ledger_master_dedupe_backup;
  IF after_total <> expected THEN
    RAISE EXCEPTION '0002 post-check: expected % rows to remain, found %', expected, after_total;
  END IF;
  RAISE NOTICE '0002 done: % rows remain, % rows in ledger_master_dedupe_backup', after_total, backed_up;
END $$;
