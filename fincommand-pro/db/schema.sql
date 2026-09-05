-- ═══════════════════════════════════════════════════════════
--  FinCommand Pro — PostgreSQL Schema (Neon-compatible)
--  IND AS · Schedule III · CFO/CEO Financial Dashboard
--  Ported verbatim from backend/db/schema.sql — no changes.
-- ═══════════════════════════════════════════════════════════

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────
--  COMPANIES (multi-entity support)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(255) NOT NULL,
  cin               VARCHAR(50),
  pan               VARCHAR(20),
  gstin             VARCHAR(20),
  registered_address TEXT,
  logo_url          TEXT,
  date_of_incorporation DATE,
  fiscal_year_start INTEGER DEFAULT 4,  -- 4 = April (Indian FY), 1 = January (CY)
  currency          CHAR(3) DEFAULT 'INR',
  reporting_standard VARCHAR(20) DEFAULT 'IND_AS', -- IND_AS, IGAAP
  is_active         BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotent migration guard: adds the column to a pre-existing companies
-- table (schema.sql is re-run on every db:init, CREATE TABLE IF NOT EXISTS
-- alone would silently skip a table that already exists without this column).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS date_of_incorporation DATE;

-- Presentation Currency: the currency the dashboard/exports DISPLAY figures
-- in, independent of `currency` above (the Source/Functional Currency the
-- Trial Balance ledgers are actually recorded in). NULL = "same as source
-- currency" (the default, and the only state that needs no FX conversion).
-- A per-company default so the CFO doesn't have to re-pick it on every
-- login — DashboardContext.tsx still lets a signed-in user override it for
-- their own session via localStorage, same pattern as the Unit Selector.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS presentation_currency CHAR(3);

-- ─────────────────────────────────────────────
--  USERS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID REFERENCES companies(id) ON DELETE CASCADE,
  name              VARCHAR(255) NOT NULL,
  email             VARCHAR(255) UNIQUE NOT NULL,
  password_hash     VARCHAR(255) NOT NULL,
  role              VARCHAR(20) DEFAULT 'viewer'
                    CHECK (role IN ('admin','cfo','ceo','auditor','manager','viewer')),
  permissions       JSONB DEFAULT '{}',
  is_active         BOOLEAN DEFAULT TRUE,
  email_verified    BOOLEAN DEFAULT FALSE,
  last_login        TIMESTAMPTZ,
  failed_attempts   INTEGER DEFAULT 0,
  locked_until      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
--  REFRESH TOKENS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  token       VARCHAR(600) UNIQUE NOT NULL,
  ip_address  INET,
  user_agent  TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
--  FINANCIAL YEARS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financial_years (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID REFERENCES companies(id) ON DELETE CASCADE,
  label           VARCHAR(30) NOT NULL,    -- e.g. 'FY 2024-25'
  short_label     VARCHAR(10) NOT NULL,    -- e.g. 'FY25'
  start_date      DATE NOT NULL,           -- 2024-04-01
  end_date        DATE NOT NULL,           -- 2025-03-31
  year_type       CHAR(2) DEFAULT 'FY'    -- FY or CY
                  CHECK (year_type IN ('FY','CY')),
  is_locked       BOOLEAN DEFAULT FALSE,   -- locked after audit sign-off
  locked_by       UUID REFERENCES users(id),
  locked_at       TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, label)
);

-- ─────────────────────────────────────────────
--  TRIAL BALANCE UPLOADS (metadata)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tb_uploads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID REFERENCES companies(id) ON DELETE CASCADE,
  financial_year_id UUID REFERENCES financial_years(id),
  uploaded_by       UUID REFERENCES users(id),
  source            VARCHAR(20) DEFAULT 'excel'
                    CHECK (source IN ('excel','zoho','tally','sap','api')),
  filename          VARCHAR(255),
  file_size_kb      INTEGER,
  ledger_count      INTEGER DEFAULT 0,
  mapped_count      INTEGER DEFAULT 0,
  unmatched_count   INTEGER DEFAULT 0,
  unmatched_ledgers JSONB DEFAULT '[]',
  coverage_pct      NUMERIC(5,2),
  has_monthly_cols  BOOLEAN DEFAULT TRUE,
  status            VARCHAR(20) DEFAULT 'processing'
                    CHECK (status IN ('processing','complete','error','superseded')),
  error_message     TEXT,
  is_current        BOOLEAN DEFAULT TRUE,  -- latest upload for this FY
  -- Raw Zoho API responses stored for audit / reprocessing (one entry per month)
  raw_zoho_months   JSONB,  -- [{month:'Apr', from_date, to_date, raw_response, fetched_at}]
  uploaded_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
--  TB LEDGERS (core financial data)
--  One row per ledger per upload.
--  Monthly columns: m1=Apr(FY)/Jan(CY) ... m12=Mar(FY)/Dec(CY)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tb_ledgers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id         UUID REFERENCES tb_uploads(id) ON DELETE CASCADE,
  company_id        UUID REFERENCES companies(id) ON DELETE CASCADE,
  financial_year_id UUID REFERENCES financial_years(id),
  ledger_code       VARCHAR(50),
  ledger_name       VARCHAR(300) NOT NULL,
  -- IND AS Schedule III mapping (from Ledger Master)
  note_no           INTEGER,
  note_name         VARCHAR(100),
  section           VARCHAR(10)   -- anc,ac,eq,lnc,lc,inc,exp
                    CHECK (section IN ('anc','ac','eq','lnc','lc','inc','exp',NULL)),
  treasury_type     VARCHAR(10)   -- cash,bank_ca,bank_sb,fd,mf
                    CHECK (treasury_type IN ('cash','bank_ca','bank_sb','fd','mf',NULL)),
  normal_bal        CHAR(2) DEFAULT 'Dr' CHECK (normal_bal IN ('Dr','Cr')),
  -- Opening balances
  op_dr             NUMERIC(18,2) DEFAULT 0,
  op_cr             NUMERIC(18,2) DEFAULT 0,
  -- Monthly MOVEMENTS (Dr and Cr separately, NOT cumulative)
  -- m1 = April (FY) or January (CY)
  m1_dr  NUMERIC(18,2) DEFAULT 0,  m1_cr  NUMERIC(18,2) DEFAULT 0,
  m2_dr  NUMERIC(18,2) DEFAULT 0,  m2_cr  NUMERIC(18,2) DEFAULT 0,
  m3_dr  NUMERIC(18,2) DEFAULT 0,  m3_cr  NUMERIC(18,2) DEFAULT 0,
  m4_dr  NUMERIC(18,2) DEFAULT 0,  m4_cr  NUMERIC(18,2) DEFAULT 0,
  m5_dr  NUMERIC(18,2) DEFAULT 0,  m5_cr  NUMERIC(18,2) DEFAULT 0,
  m6_dr  NUMERIC(18,2) DEFAULT 0,  m6_cr  NUMERIC(18,2) DEFAULT 0,
  m7_dr  NUMERIC(18,2) DEFAULT 0,  m7_cr  NUMERIC(18,2) DEFAULT 0,
  m8_dr  NUMERIC(18,2) DEFAULT 0,  m8_cr  NUMERIC(18,2) DEFAULT 0,
  m9_dr  NUMERIC(18,2) DEFAULT 0,  m9_cr  NUMERIC(18,2) DEFAULT 0,
  m10_dr NUMERIC(18,2) DEFAULT 0,  m10_cr NUMERIC(18,2) DEFAULT 0,
  m11_dr NUMERIC(18,2) DEFAULT 0,  m11_cr NUMERIC(18,2) DEFAULT 0,
  m12_dr NUMERIC(18,2) DEFAULT 0,  m12_cr NUMERIC(18,2) DEFAULT 0,
  -- Zoho-specific metadata (preserved from raw API response)
  zoho_account_id   VARCHAR(100),   -- Zoho's internal account_id
  zoho_account_type VARCHAR(50),    -- Zoho account group: expense, income, asset, liability, equity
  depth             INTEGER DEFAULT 0,          -- Hierarchy depth (0=leaf, 1+=parent group)
  is_child_present  BOOLEAN DEFAULT FALSE,      -- Whether Zoho shows sub-accounts under this
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotent migration guards for pre-existing tables
ALTER TABLE tb_uploads ADD COLUMN IF NOT EXISTS raw_zoho_months JSONB;
ALTER TABLE tb_ledgers ADD COLUMN IF NOT EXISTS zoho_account_id VARCHAR(100);
ALTER TABLE tb_ledgers ADD COLUMN IF NOT EXISTS zoho_account_type VARCHAR(50);
ALTER TABLE tb_ledgers ADD COLUMN IF NOT EXISTS depth INTEGER DEFAULT 0;
ALTER TABLE tb_ledgers ADD COLUMN IF NOT EXISTS is_child_present BOOLEAN DEFAULT FALSE;

-- ─────────────────────────────────────────────
--  TB CUSTOMER REVENUE (real per-customer revenue, source-agnostic —
--  currently populated only by Zoho sync via /reports/salesbycustomer;
--  empty for Excel-uploaded Trial Balances, which carry no customer
--  dimension). One row per customer per upload. Feeds the Executive
--  Overview "Top Customers" table — replaces the old fabricated
--  ledger-name-guessing fallback with real Zoho sales-by-customer data.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tb_customer_revenue (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id         UUID REFERENCES tb_uploads(id) ON DELETE CASCADE,
  company_id        UUID REFERENCES companies(id) ON DELETE CASCADE,
  financial_year_id UUID REFERENCES financial_years(id),
  zoho_customer_id  VARCHAR(100),
  customer_name     VARCHAR(300) NOT NULL,
  -- Monthly revenue (single signed amount per month — Zoho's Sales by
  -- Customer report already nets this out; no Dr/Cr split needed).
  -- m1=Apr(FY)/Jan(CY) ... m12=Mar(FY)/Dec(CY), same convention as tb_ledgers.
  m1  NUMERIC(18,2) DEFAULT 0,  m2  NUMERIC(18,2) DEFAULT 0,
  m3  NUMERIC(18,2) DEFAULT 0,  m4  NUMERIC(18,2) DEFAULT 0,
  m5  NUMERIC(18,2) DEFAULT 0,  m6  NUMERIC(18,2) DEFAULT 0,
  m7  NUMERIC(18,2) DEFAULT 0,  m8  NUMERIC(18,2) DEFAULT 0,
  m9  NUMERIC(18,2) DEFAULT 0,  m10 NUMERIC(18,2) DEFAULT 0,
  m11 NUMERIC(18,2) DEFAULT 0,  m12 NUMERIC(18,2) DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tb_customer_revenue_upload  ON tb_customer_revenue(upload_id);
CREATE INDEX IF NOT EXISTS idx_tb_customer_revenue_company ON tb_customer_revenue(company_id, financial_year_id);

-- ─────────────────────────────────────────────
--  TB VENDOR EXPENSE (real per-vendor spend, source-agnostic — currently
--  populated only by Zoho sync via /bills; empty for Excel-uploaded Trial
--  Balances, which carry no vendor dimension). One row per vendor per
--  upload. Feeds the Vendor Expense Report tab — same shape/conventions as
--  tb_customer_revenue above.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tb_vendor_expense (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id         UUID REFERENCES tb_uploads(id) ON DELETE CASCADE,
  company_id        UUID REFERENCES companies(id) ON DELETE CASCADE,
  financial_year_id UUID REFERENCES financial_years(id),
  zoho_vendor_id    VARCHAR(100),
  vendor_name       VARCHAR(300) NOT NULL,
  -- Monthly spend (single signed amount per month, from real Zoho Bill
  -- totals in the org's base currency — a bill in a foreign currency is
  -- excluded rather than mis-summed; see extractVendorBills() in zoho.ts).
  -- m1=Apr(FY)/Jan(CY) ... m12=Mar(FY)/Dec(CY), same convention as tb_ledgers.
  m1  NUMERIC(18,2) DEFAULT 0,  m2  NUMERIC(18,2) DEFAULT 0,
  m3  NUMERIC(18,2) DEFAULT 0,  m4  NUMERIC(18,2) DEFAULT 0,
  m5  NUMERIC(18,2) DEFAULT 0,  m6  NUMERIC(18,2) DEFAULT 0,
  m7  NUMERIC(18,2) DEFAULT 0,  m8  NUMERIC(18,2) DEFAULT 0,
  m9  NUMERIC(18,2) DEFAULT 0,  m10 NUMERIC(18,2) DEFAULT 0,
  m11 NUMERIC(18,2) DEFAULT 0,  m12 NUMERIC(18,2) DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tb_vendor_expense_upload  ON tb_vendor_expense(upload_id);
CREATE INDEX IF NOT EXISTS idx_tb_vendor_expense_company ON tb_vendor_expense(company_id, financial_year_id);

-- ─────────────────────────────────────────────
--  TB CUSTOMER COST (real per-customer DIRECT cost — populated only from
--  Zoho expenses explicitly marked "Billable" and assigned to a customer
--  (Zoho's own billable-expense-to-customer field). Most Zoho orgs never
--  use this tagging at all — confirmed empirically on the first company
--  synced with this feature: 0 of 780 real expenses for the year were
--  tagged. An empty/all-zero table for a company therefore means "this org
--  doesn't track direct per-customer cost in Zoho", not "customers cost
--  nothing" — consumers (computeCustomerMargin in tb-engine.ts,
--  CustomerMarginTab.tsx) must disclose that plainly and must NEVER treat
--  zero direct cost as a real 100% margin.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tb_customer_cost (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id         UUID REFERENCES tb_uploads(id) ON DELETE CASCADE,
  company_id        UUID REFERENCES companies(id) ON DELETE CASCADE,
  financial_year_id UUID REFERENCES financial_years(id),
  zoho_customer_id  VARCHAR(100),
  customer_name     VARCHAR(300) NOT NULL,
  -- Monthly direct cost, same m1..m12 convention as tb_customer_revenue —
  -- deliberately the same shape so the two can be matched up per customer.
  m1  NUMERIC(18,2) DEFAULT 0,  m2  NUMERIC(18,2) DEFAULT 0,
  m3  NUMERIC(18,2) DEFAULT 0,  m4  NUMERIC(18,2) DEFAULT 0,
  m5  NUMERIC(18,2) DEFAULT 0,  m6  NUMERIC(18,2) DEFAULT 0,
  m7  NUMERIC(18,2) DEFAULT 0,  m8  NUMERIC(18,2) DEFAULT 0,
  m9  NUMERIC(18,2) DEFAULT 0,  m10 NUMERIC(18,2) DEFAULT 0,
  m11 NUMERIC(18,2) DEFAULT 0,  m12 NUMERIC(18,2) DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tb_customer_cost_upload  ON tb_customer_cost(upload_id);
CREATE INDEX IF NOT EXISTS idx_tb_customer_cost_company ON tb_customer_cost(company_id, financial_year_id);

-- ─────────────────────────────────────────────
--  LEDGER MASTER (company-specific + global pre-seeded)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledger_master (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID REFERENCES companies(id) ON DELETE CASCADE,
  ledger_code     VARCHAR(50),
  ledger_name     VARCHAR(300) NOT NULL,
  note_no         INTEGER NOT NULL,
  note_name       VARCHAR(100),
  section         VARCHAR(10) NOT NULL
                  CHECK (section IN ('anc','ac','eq','lnc','lc','inc','exp')),
  treasury_type   VARCHAR(10)
                  CHECK (treasury_type IN ('cash','bank_ca','bank_sb','fd','mf',NULL)),
  normal_bal      CHAR(2) DEFAULT 'Dr' CHECK (normal_bal IN ('Dr','Cr')),
  is_global       BOOLEAN DEFAULT FALSE,  -- TRUE = pre-seeded global mapping
  is_active       BOOLEAN DEFAULT TRUE,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
--  ZOHO BOOKS CONFIGURATION
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS zoho_config (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID REFERENCES companies(id) ON DELETE CASCADE UNIQUE,
  org_id          VARCHAR(100),
  access_token    TEXT,
  refresh_token   TEXT,
  token_expiry    TIMESTAMPTZ,
  data_center     VARCHAR(10) DEFAULT 'IN',  -- IN, US, EU, AU
  sync_frequency  VARCHAR(20) DEFAULT 'daily'
                  CHECK (sync_frequency IN ('manual','15min','hourly','daily')),
  last_synced_at  TIMESTAMPTZ,
  last_sync_status VARCHAR(20) DEFAULT 'never'
                  CHECK (last_sync_status IN ('never','success','error','running')),
  last_sync_error TEXT,
  synced_ledgers  INTEGER DEFAULT 0,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
--  SYNC LOGS (Zoho & API syncs)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID REFERENCES companies(id) ON DELETE CASCADE,
  source          VARCHAR(20) NOT NULL,   -- zoho, api, manual
  financial_year  VARCHAR(20),
  triggered_by    UUID REFERENCES users(id),
  status          VARCHAR(20) NOT NULL,   -- running, success, error
  ledgers_synced  INTEGER DEFAULT 0,
  error_message   TEXT,
  duration_ms     INTEGER,
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

-- ─────────────────────────────────────────────
--  AUDIT TRAIL
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_trail (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID REFERENCES companies(id),
  user_id       UUID REFERENCES users(id),
  user_name     VARCHAR(255),
  user_role     VARCHAR(20),
  action        VARCHAR(100) NOT NULL,
  entity_type   VARCHAR(50),
  entity_id     UUID,
  old_values    JSONB,
  new_values    JSONB,
  metadata      JSONB,
  ip_address    INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
--  INDEXES
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_email         ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_company       ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_tb_uploads_company  ON tb_uploads(company_id, financial_year_id);
CREATE INDEX IF NOT EXISTS idx_tb_uploads_current  ON tb_uploads(company_id, financial_year_id, is_current);
CREATE INDEX IF NOT EXISTS idx_tb_ledgers_upload   ON tb_ledgers(upload_id);
CREATE INDEX IF NOT EXISTS idx_tb_ledgers_company  ON tb_ledgers(company_id, financial_year_id);
CREATE INDEX IF NOT EXISTS idx_tb_ledgers_note     ON tb_ledgers(note_no);
CREATE INDEX IF NOT EXISTS idx_tb_ledgers_section  ON tb_ledgers(section);
CREATE INDEX IF NOT EXISTS idx_tb_ledgers_treasury ON tb_ledgers(treasury_type) WHERE treasury_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_master_co    ON ledger_master(company_id);
CREATE INDEX IF NOT EXISTS idx_ledger_master_code  ON ledger_master(ledger_code);
CREATE INDEX IF NOT EXISTS idx_ledger_master_name  ON ledger_master(ledger_name);
CREATE INDEX IF NOT EXISTS idx_audit_company       ON audit_trail(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user          ON audit_trail(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens      ON refresh_tokens(token) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fy_company          ON financial_years(company_id);
CREATE INDEX IF NOT EXISTS idx_rt_user             ON refresh_tokens(user_id);

-- ─────────────────────────────────────────────
--  TRIGGERS — updated_at auto-update
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_companies_updated_at
    BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END; $$;

DO $$ BEGIN
  CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END; $$;

DO $$ BEGIN
  CREATE TRIGGER trg_zoho_config_updated_at
    BEFORE UPDATE ON zoho_config FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END; $$;

DO $$ BEGIN
  CREATE TRIGGER trg_ledger_master_updated_at
    BEFORE UPDATE ON ledger_master FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END; $$;
