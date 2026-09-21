-- 0008 — the database itself enforces company separation (row-level security).
--
-- Until now every query carried "WHERE company_id = $1" and nothing else stopped a
-- missed filter from leaking another company's rows. This adds, for a NEW
-- restricted login (fincommand_app), a policy on every table: a row is visible or
-- writable only when its company_id equals the company the request was made for.
--
--   app_company_id()   the company of the current transaction, read from the setting
--                      app.company_id. Unset = NULL = NO rows (fails closed).
--   fincommand_app     the restricted role: not an owner, no BYPASSRLS, DML only.
--
-- INERT until the app logs in as fincommand_app: neondb_owner (the login the app
-- uses today) owns the tables and bypasses row-level security, so applying this
-- changes nothing by itself. The password is never in git; the owner sets it
-- (db/scripts/set-app-role-password.ts), then sets DB_APP_USER / DB_APP_PASSWORD.
-- Unsetting those two variables switches enforcement off again.
--
-- Rules for every FUTURE migration that creates a table: enable row-level
-- security, add the same policy, GRANT the app role what it needs. There are no
-- default privileges on purpose - a new table is closed to the app role until a
-- migration opens it (tests/unit/rls-coverage.test.ts fails otherwise).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fincommand_app') THEN
    CREATE ROLE fincommand_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO fincommand_app;
REVOKE CREATE ON SCHEMA public FROM fincommand_app;

CREATE OR REPLACE FUNCTION app_company_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.company_id', true), '')::uuid
$$;
GRANT EXECUTE ON FUNCTION app_company_id() TO fincommand_app;

-- ── Tables owned by a company: company_id = the request's company ──────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'custom_metric_definitions', 'custom_metric_versions', 'custom_tabs', 'dashboard_layouts', 'financial_years',
    'ledger_accounts', 'raw_payloads', 'report_saved_reports', 'report_templates', 'sync_logs',
    'tb_customer_cost', 'tb_customer_revenue', 'tb_ledgers', 'tb_uploads', 'tb_vendor_expense',
    'users', 'zoho_api_usage', 'zoho_config', 'zoho_contacts', 'zoho_module_state',
    'zoho_record_history', 'zoho_record_lines', 'zoho_records', 'zoho_report_snapshots'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO fincommand_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO fincommand_app', t);
  END LOOP;
END $$;

-- The audit trail is append-only for the app role: it can add and read entries, never change or remove them.
ALTER TABLE audit_trail ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_trail;
CREATE POLICY tenant_isolation ON audit_trail FOR ALL TO fincommand_app
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON audit_trail TO fincommand_app;

-- A company can read and update its own record; creating one (signup) is a system action.
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON companies;
CREATE POLICY tenant_isolation ON companies FOR ALL TO fincommand_app
  USING (id = app_company_id()) WITH CHECK (id = app_company_id());
GRANT SELECT, UPDATE ON companies TO fincommand_app;

-- The ledger master has shared rows (company_id NULL, is_global): everyone may read those, nobody changes them.
ALTER TABLE ledger_master ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON ledger_master;
DROP POLICY IF EXISTS tenant_insert ON ledger_master;
DROP POLICY IF EXISTS tenant_update ON ledger_master;
DROP POLICY IF EXISTS tenant_delete ON ledger_master;
CREATE POLICY tenant_read   ON ledger_master FOR SELECT TO fincommand_app
  USING (company_id = app_company_id() OR (company_id IS NULL AND is_global));
CREATE POLICY tenant_insert ON ledger_master FOR INSERT TO fincommand_app
  WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant_update ON ledger_master FOR UPDATE TO fincommand_app
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant_delete ON ledger_master FOR DELETE TO fincommand_app
  USING (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON ledger_master TO fincommand_app;

-- ── Child tables without a company_id: through their parent ────────────────
ALTER TABLE dashboard_widgets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dashboard_widgets;
CREATE POLICY tenant_isolation ON dashboard_widgets FOR ALL TO fincommand_app
  USING (EXISTS (SELECT 1 FROM dashboard_layouts l WHERE l.id = dashboard_widgets.layout_id AND l.company_id = app_company_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM dashboard_layouts l WHERE l.id = dashboard_widgets.layout_id AND l.company_id = app_company_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON dashboard_widgets TO fincommand_app;

ALTER TABLE report_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON report_lines;
CREATE POLICY tenant_isolation ON report_lines FOR ALL TO fincommand_app
  USING (EXISTS (SELECT 1 FROM report_templates t WHERE t.id = report_lines.template_id AND t.company_id = app_company_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM report_templates t WHERE t.id = report_lines.template_id AND t.company_id = app_company_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON report_lines TO fincommand_app;

ALTER TABLE report_line_ledgers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON report_line_ledgers;
CREATE POLICY tenant_isolation ON report_line_ledgers FOR ALL TO fincommand_app
  USING (EXISTS (SELECT 1 FROM report_lines rl JOIN report_templates t ON t.id = rl.template_id
                  WHERE rl.id = report_line_ledgers.line_id AND t.company_id = app_company_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM report_lines rl JOIN report_templates t ON t.id = rl.template_id
                       WHERE rl.id = report_line_ledgers.line_id AND t.company_id = app_company_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON report_line_ledgers TO fincommand_app;

ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON refresh_tokens;
CREATE POLICY tenant_isolation ON refresh_tokens FOR ALL TO fincommand_app
  USING (EXISTS (SELECT 1 FROM users u WHERE u.id = refresh_tokens.user_id AND u.company_id = app_company_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = refresh_tokens.user_id AND u.company_id = app_company_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO fincommand_app;

ALTER TABLE upload_raw_payloads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON upload_raw_payloads;
CREATE POLICY tenant_isolation ON upload_raw_payloads FOR ALL TO fincommand_app
  USING (EXISTS (SELECT 1 FROM tb_uploads u WHERE u.id = upload_raw_payloads.upload_id AND u.company_id = app_company_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM tb_uploads u WHERE u.id = upload_raw_payloads.upload_id AND u.company_id = app_company_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON upload_raw_payloads TO fincommand_app;

-- ── Closed to the app role altogether (system tables and an old backup) ─────
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_master_dedupe_backup ENABLE ROW LEVEL SECURITY;

-- ── Post-checks: nothing left open, and the role really is restricted ──────
DO $$
DECLARE open_tables text; r record;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO open_tables
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND NOT c.relrowsecurity;
  IF open_tables IS NOT NULL THEN RAISE EXCEPTION '0008 post-check: row-level security is off on: %', open_tables; END IF;

  SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole INTO r FROM pg_roles WHERE rolname = 'fincommand_app';
  IF r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole THEN
    RAISE EXCEPTION '0008 post-check: fincommand_app has too many privileges';
  END IF;
  IF has_table_privilege('fincommand_app', 'schema_migrations', 'SELECT') OR has_table_privilege('fincommand_app', 'ledger_master_dedupe_backup', 'SELECT') THEN
    RAISE EXCEPTION '0008 post-check: fincommand_app can read a system table';
  END IF;
  IF has_table_privilege('fincommand_app', 'audit_trail', 'UPDATE') OR has_table_privilege('fincommand_app', 'audit_trail', 'DELETE') THEN
    RAISE EXCEPTION '0008 post-check: fincommand_app can change the audit trail';
  END IF;
END $$;
