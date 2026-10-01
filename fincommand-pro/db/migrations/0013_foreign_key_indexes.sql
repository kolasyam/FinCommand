-- 0013 — an index on every foreign key that lacked one (audit item 31).
--
-- Without one, deleting or updating a parent row (a user, a financial year, a ledger account) scans the whole
-- child table to check for referencing rows, and joins on these columns can't use an index. Harmless while the
-- tables are small; this keeps it that way as they grow. Schema only - no data is touched.
-- Every statement is IF NOT EXISTS, so the file is safe to re-run.

CREATE INDEX IF NOT EXISTS idx_cmd_created_by          ON custom_metric_definitions (created_by);
CREATE INDEX IF NOT EXISTS idx_cmd_updated_by          ON custom_metric_definitions (updated_by);
CREATE INDEX IF NOT EXISTS idx_cmv_changed_by          ON custom_metric_versions (changed_by);
CREATE INDEX IF NOT EXISTS idx_cmv_company             ON custom_metric_versions (company_id);
CREATE INDEX IF NOT EXISTS idx_custom_tabs_created_by  ON custom_tabs (created_by);
CREATE INDEX IF NOT EXISTS idx_dashboard_layouts_user  ON dashboard_layouts (user_id);
CREATE INDEX IF NOT EXISTS idx_fy_locked_by            ON financial_years (locked_by);
CREATE INDEX IF NOT EXISTS idx_ledger_master_created_by ON ledger_master (created_by);
CREATE INDEX IF NOT EXISTS idx_lma_account             ON ledger_month_amounts (account_id);
CREATE INDEX IF NOT EXISTS idx_rll_account             ON report_line_ledgers (account_id);
CREATE INDEX IF NOT EXISTS idx_rsr_created_by          ON report_saved_reports (created_by);
CREATE INDEX IF NOT EXISTS idx_rsr_financial_year      ON report_saved_reports (financial_year_id);
CREATE INDEX IF NOT EXISTS idx_rsr_template            ON report_saved_reports (template_id);
CREATE INDEX IF NOT EXISTS idx_rt_cloned_from          ON report_templates (cloned_from_template_id);
CREATE INDEX IF NOT EXISTS idx_rt_created_by           ON report_templates (created_by);
CREATE INDEX IF NOT EXISTS idx_sync_logs_triggered_by  ON sync_logs (triggered_by);
CREATE INDEX IF NOT EXISTS idx_tb_cost_fy              ON tb_customer_cost (financial_year_id);
CREATE INDEX IF NOT EXISTS idx_tb_rev_fy               ON tb_customer_revenue (financial_year_id);
CREATE INDEX IF NOT EXISTS idx_tb_ledgers_fy           ON tb_ledgers (financial_year_id);
CREATE INDEX IF NOT EXISTS idx_tb_uploads_fy           ON tb_uploads (financial_year_id);
CREATE INDEX IF NOT EXISTS idx_tb_uploads_uploaded_by  ON tb_uploads (uploaded_by);
CREATE INDEX IF NOT EXISTS idx_tb_vendor_fy            ON tb_vendor_expense (financial_year_id);

DO $$
DECLARE missing int;
BEGIN
  SELECT count(*) INTO missing
  FROM pg_constraint con
  WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace AND array_length(con.conkey, 1) = 1
    AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = con.conrelid AND i.indkey[0] = con.conkey[1]);
  IF missing > 0 THEN RAISE EXCEPTION '0013 post-check: % foreign key(s) still have no index', missing; END IF;
  RAISE NOTICE '0013 done: every single-column foreign key is indexed';
END $$;
