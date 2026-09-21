-- 0007 — Phase B of the Zoho record mirror: master data, banking and report snapshots.
--
--   zoho_records.title       a name for master records that have no document number
--                            (an account, item, tax, location, bank account ...)
--   zoho_records.parent_id   the record this one belongs to (a bank transaction's bank account)
--   zoho_report_snapshots    Zoho's own report totals for a period (tax summary, ageing, cash flow,
--                            sales by item), kept as dated snapshots so the records can be
--                            reconciled against what Zoho itself reports.
--
-- Additive only: nothing that exists is read, changed or deleted.

ALTER TABLE zoho_records ADD COLUMN IF NOT EXISTS title VARCHAR(400);
ALTER TABLE zoho_records ADD COLUMN IF NOT EXISTS parent_id VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_zoho_records_parent ON zoho_records (company_id, module, parent_id, doc_date DESC) WHERE parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS zoho_report_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  report          VARCHAR(40) NOT NULL,
  period_from     DATE,
  period_to       DATE NOT NULL,
  payload         JSONB NOT NULL,
  payload_sha256  CHAR(64) NOT NULL,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- The same content for the same period is one row (its last_seen_at moves); changed content is a new row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_zoho_snapshots_content
  ON zoho_report_snapshots (company_id, report, COALESCE(period_from, DATE '0001-01-01'), period_to, payload_sha256);
CREATE INDEX IF NOT EXISTS idx_zoho_snapshots_latest ON zoho_report_snapshots (company_id, report, period_to DESC, last_seen_at DESC);

DO $$
BEGIN
  IF to_regclass('public.zoho_report_snapshots') IS NULL THEN RAISE EXCEPTION '0007 post-check: zoho_report_snapshots missing'; END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_name = 'zoho_records' AND column_name IN ('title', 'parent_id')) <> 2 THEN
    RAISE EXCEPTION '0007 post-check: zoho_records columns missing';
  END IF;
END $$;
