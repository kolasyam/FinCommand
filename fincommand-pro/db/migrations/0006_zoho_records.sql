-- 0006 — a read-only mirror of the individual records Zoho Books holds
-- (invoices, bills, journals, payments, bank transactions, GST fields, ...).
--
-- The statement sync reads Zoho's REPORTS. This adds the documents behind
-- them, stored per company, so drill-downs, ageing, GST and reconciliation
-- can be built on real records. Nothing that exists today is read, changed or
-- deleted: five new tables and three additive columns on zoho_config.
--
--   zoho_records         one row per Zoho record: the list row and the detail
--                        record as JSON (everything Zoho returns), plus typed
--                        columns to filter on. base_amount is filled only when
--                        Zoho itself gives a base-currency figure or the
--                        document is in the base currency - never a guessed rate.
--   zoho_record_lines    line items / journal legs / applied documents, with
--                        the GST fields (tax, HSN/SAC, ITC) as columns.
--   zoho_record_history  append-only: the previous version of any record that
--                        changed in Zoho. Nothing is silently overwritten.
--   zoho_module_state    where each module's read has got to (resumable).
--   zoho_api_usage       Zoho API calls per company per day (quota guard).
--
-- Records that disappear from Zoho are only FLAGGED (deleted_at), never removed.

CREATE TABLE IF NOT EXISTS zoho_records (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  module              VARCHAR(40) NOT NULL,
  zoho_id             VARCHAR(64) NOT NULL,
  doc_number          VARCHAR(160),
  doc_date            DATE,
  due_date            DATE,
  status              VARCHAR(80),
  contact_id          VARCHAR(64),
  contact_name        VARCHAR(400),
  currency_code       VARCHAR(10),
  exchange_rate       NUMERIC(24,8),
  amount              NUMERIC(22,2),
  base_amount         NUMERIC(22,2),
  balance             NUMERIC(22,2),
  sub_amount          NUMERIC(22,2),
  tax_amount          NUMERIC(22,2),
  gst_treatment       VARCHAR(60),
  gst_no              VARCHAR(40),
  place_of_supply     VARCHAR(60),
  zoho_modified_at    TIMESTAMPTZ,
  payload             JSONB NOT NULL,
  payload_sha256      CHAR(64) NOT NULL,
  detail              JSONB,
  detail_sha256       CHAR(64),
  detail_stale        BOOLEAN NOT NULL DEFAULT TRUE,
  detail_attempts     SMALLINT NOT NULL DEFAULT 0,
  detail_error        TEXT,
  revision            INTEGER NOT NULL DEFAULT 1,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ,
  UNIQUE (company_id, module, zoho_id)
);
CREATE INDEX IF NOT EXISTS idx_zoho_records_date    ON zoho_records (company_id, module, doc_date DESC);
CREATE INDEX IF NOT EXISTS idx_zoho_records_contact ON zoho_records (company_id, module, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_zoho_records_todo    ON zoho_records (company_id, module, doc_date DESC) WHERE detail_stale AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS zoho_record_lines (
  company_id          UUID NOT NULL,
  module              VARCHAR(40) NOT NULL,
  zoho_id             VARCHAR(64) NOT NULL,
  line_no             INTEGER NOT NULL,
  kind                VARCHAR(12) NOT NULL,
  account_id          VARCHAR(64),
  account_name        VARCHAR(400),
  account_code        VARCHAR(60),
  item_id             VARCHAR(64),
  item_name           VARCHAR(400),
  description         TEXT,
  quantity            NUMERIC(24,6),
  rate                NUMERIC(24,6),
  amount              NUMERIC(22,2),
  base_amount         NUMERIC(22,2),
  debit_or_credit     VARCHAR(8),
  tax_id              VARCHAR(64),
  tax_name            VARCHAR(200),
  tax_percentage      NUMERIC(10,4),
  tax_amount          NUMERIC(22,2),
  hsn_or_sac          VARCHAR(40),
  gst_treatment_code  VARCHAR(60),
  itc_eligibility     VARCHAR(60),
  ref_id              VARCHAR(64),
  ref_number          VARCHAR(160),
  taxes               JSONB,
  PRIMARY KEY (company_id, module, zoho_id, line_no),
  FOREIGN KEY (company_id, module, zoho_id) REFERENCES zoho_records (company_id, module, zoho_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_zoho_lines_account ON zoho_record_lines (company_id, module, account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_zoho_lines_hsn     ON zoho_record_lines (company_id, hsn_or_sac) WHERE hsn_or_sac IS NOT NULL;

CREATE TABLE IF NOT EXISTS zoho_record_history (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  module         VARCHAR(40) NOT NULL,
  zoho_id        VARCHAR(64) NOT NULL,
  revision       INTEGER NOT NULL,
  payload        JSONB NOT NULL,
  detail         JSONB,
  superseded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_zoho_history_record ON zoho_record_history (company_id, module, zoho_id, revision);

CREATE TABLE IF NOT EXISTS zoho_module_state (
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  module                VARCHAR(40) NOT NULL,
  pass_kind             VARCHAR(12),
  pass_started_at       TIMESTAMPTZ,
  page_cursor           INTEGER,
  sub_cursor            TEXT,
  incremental_cursor    TIMESTAMPTZ,
  last_full_at          TIMESTAMPTZ,
  last_incremental_at   TIMESTAMPTZ,
  detail_enabled        BOOLEAN,
  claimed_at            TIMESTAMPTZ,
  last_error            TEXT,
  last_error_at         TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, module)
);

CREATE TABLE IF NOT EXISTS zoho_api_usage (
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  day            DATE NOT NULL,
  calls          INTEGER NOT NULL DEFAULT 0,
  blocked_until  TIMESTAMPTZ,
  PRIMARY KEY (company_id, day)
);

ALTER TABLE zoho_config ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE zoho_config ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE zoho_config ADD COLUMN IF NOT EXISTS api_daily_limit INTEGER NOT NULL DEFAULT 1000;

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
    FROM unnest(ARRAY['zoho_records','zoho_record_lines','zoho_record_history','zoho_module_state','zoho_api_usage']) t
   WHERE to_regclass('public.' || t) IS NULL;
  IF missing IS NOT NULL THEN RAISE EXCEPTION '0006 post-check: missing table(s) %', missing; END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_name = 'zoho_config' AND column_name IN ('consecutive_failures','next_attempt_at','api_daily_limit')) <> 3 THEN
    RAISE EXCEPTION '0006 post-check: zoho_config columns missing';
  END IF;
END $$;
