-- 0014 — integrity hardening (audit items 17, 32, 35 and the incomplete-batch finding).
--
--   1. audit_trail can no longer be edited or deleted, even by the owner login (item 17).
--   2. Four indexes that another index already covers are dropped (item 32).
--   3. company_id becomes NOT NULL where the column should never be empty (item 35).
--   4. A current batch that was written without totals/currency gets them filled in.
--
-- Every step checks its precondition first and raises (rolling the whole file back) rather than guessing.
-- ledger_master.company_id stays nullable on purpose: NULL marks the global default mappings.

-- ── 1. audit_trail is append-only ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION audit_trail_block_changes() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_trail is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_trail_append_only ON audit_trail;
CREATE TRIGGER audit_trail_append_only BEFORE UPDATE OR DELETE ON audit_trail
  FOR EACH ROW EXECUTE FUNCTION audit_trail_block_changes();

-- ── 2. Redundant indexes (each is covered by another index starting with the same column) ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'users_email_key')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'financial_years_company_id_label_key')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'custom_metric_definitions_company_id_metric_key_key')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'custom_metric_versions_metric_id_version_key') THEN
    RAISE EXCEPTION '0014: a covering unique index is missing - not dropping the redundant ones';
  END IF;
END $$;
DROP INDEX IF EXISTS idx_users_email;
DROP INDEX IF EXISTS idx_fy_company;
DROP INDEX IF EXISTS idx_custom_metric_definitions_company;
DROP INDEX IF EXISTS idx_custom_metric_versions_metric;

-- ── 3. company_id NOT NULL ─────────────────────────────────────────────────
DO $$
DECLARE t text; n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','zoho_config','sync_logs','audit_trail','dashboard_layouts','zoho_contacts','report_saved_reports','report_templates'] LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE company_id IS NULL', t) INTO n;
    IF n > 0 THEN RAISE EXCEPTION '0014: % has % row(s) with no company_id - fix them first', t, n; END IF;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN company_id SET NOT NULL', t);
  END LOOP;
END $$;

-- ── 4. Complete the totals of current batches written before the totals existed ──
-- Same arithmetic the importer uses: opening + the 12 months, debits and credits, from ledger_month_amounts.
UPDATE tb_uploads u SET
  total_dr     = s.dr,
  total_cr     = s.cr,
  balance_diff = s.dr - s.cr,
  is_balanced  = abs(s.dr - s.cr) <= 1,
  currency     = COALESCE(u.currency, c.currency, 'INR')
FROM (
  SELECT u2.id,
         COALESCE((SELECT sum(op_dr) FROM tb_ledgers l WHERE l.upload_id = u2.id), 0) + COALESCE((SELECT sum(a.dr) FROM ledger_month_amounts a WHERE a.batch_id = u2.id), 0) AS dr,
         COALESCE((SELECT sum(op_cr) FROM tb_ledgers l WHERE l.upload_id = u2.id), 0) + COALESCE((SELECT sum(a.cr) FROM ledger_month_amounts a WHERE a.batch_id = u2.id), 0) AS cr
  FROM tb_uploads u2 WHERE u2.total_dr IS NULL OR u2.currency IS NULL
) s, companies c
WHERE u.id = s.id AND c.id = u.company_id;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM tb_uploads WHERE total_dr IS NULL OR currency IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '0014 post-check: % batch(es) still have no totals/currency', n; END IF;
  RAISE NOTICE '0014 done';
END $$;
