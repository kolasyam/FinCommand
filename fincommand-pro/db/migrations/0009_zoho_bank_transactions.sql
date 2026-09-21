-- 0009 — bank transactions get their own table, built for volume.
--
-- They were rows of the generic zoho_records table (3,341 of one company's 6,721),
-- with amount and date in JSON or squeezed into generic columns. A large company can
-- have millions. This table has typed columns for what queries ask (account, date,
-- amount, debit/credit, payee, running balance), keeps everything Zoho returns as JSON,
-- and is HASH-PARTITIONED by company_id (16 partitions): every query filters on
-- company_id, so it touches one partition; no per-company set-up is ever needed.
--
-- The primary key is (company_id, account_id, txn_id): a Zoho transaction id is unique
-- only WITHIN a bank account (a transfer shows on both accounts with the same id).
--
-- Creates the EMPTY table only. Moving the existing rows is a separate, gated,
-- fingerprint-checked step (db/scripts/move-bank-transactions.ts); removing the old
-- copies from zoho_records is a further step that needs the owner's approval.
-- Row-level security, policy and grants are here (see 0008: a new table is closed to the
-- restricted role until a migration opens it).

CREATE TABLE IF NOT EXISTS zoho_bank_transactions (
  company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_id           VARCHAR(64) NOT NULL,
  txn_id               VARCHAR(64) NOT NULL,
  account_name         VARCHAR(400),
  txn_date             DATE,
  amount               NUMERIC(22,2),
  debit_or_credit      VARCHAR(8),
  transaction_type     VARCHAR(80),
  status               VARCHAR(80),
  payee                VARCHAR(400),
  customer_id          VARCHAR(64),
  reference_number     VARCHAR(160),
  description          TEXT,
  offset_account_name  VARCHAR(400),
  currency_code        VARCHAR(10),
  running_balance      NUMERIC(22,2),
  payload              JSONB NOT NULL,
  payload_sha256       CHAR(64) NOT NULL,
  revision             INTEGER NOT NULL DEFAULT 1,
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at           TIMESTAMPTZ,
  PRIMARY KEY (company_id, account_id, txn_id)
) PARTITION BY HASH (company_id);

DO $$
DECLARE i int;
BEGIN
  FOR i IN 0..15 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF zoho_bank_transactions FOR VALUES WITH (MODULUS 16, REMAINDER %s)',
      'zoho_bank_transactions_p' || i, i);
    -- A partition is only ever reached through the parent; RLS on it too, so a stray direct grant stays closed.
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', 'zoho_bank_transactions_p' || i);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_zoho_bank_txn_account_date ON zoho_bank_transactions (company_id, account_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_zoho_bank_txn_date        ON zoho_bank_transactions (company_id, txn_date DESC);

-- Row-level security: a company sees and writes only its own transactions.
ALTER TABLE zoho_bank_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON zoho_bank_transactions;
CREATE POLICY tenant_isolation ON zoho_bank_transactions FOR ALL TO fincommand_app
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON zoho_bank_transactions TO fincommand_app;

DO $$
DECLARE parts int; rls_off text;
BEGIN
  SELECT count(*) INTO parts FROM pg_inherits WHERE inhparent = 'zoho_bank_transactions'::regclass;
  IF parts <> 16 THEN RAISE EXCEPTION '0009 post-check: expected 16 partitions, found %', parts; END IF;
  SELECT string_agg(c.relname, ', ') INTO rls_off
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity;
  IF rls_off IS NOT NULL THEN RAISE EXCEPTION '0009 post-check: row-level security is off on: %', rls_off; END IF;
END $$;
