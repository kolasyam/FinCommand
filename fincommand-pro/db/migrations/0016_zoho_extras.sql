-- 0016 — what Zoho keeps ABOUT its records: comments / activity history, attached files, and read progress.
--
--   zoho_record_comments  one row per Zoho comment or activity entry on a record (who did what, when), as Zoho sent it.
--   zoho_attachments      the files attached to records (invoice PDFs, bill scans, expense receipts), stored as bytes
--                         so the books stay complete even if the file is removed in Zoho. Identical files are kept once.
--   zoho_extras_state     which records have had their comments / attachment read, so a read resumes and re-reads
--                         only what changed in Zoho since (or what failed, a limited number of times).
--
-- Additive only: three new tables, nothing existing is changed. Row-level security follows migration 0008/0011.

CREATE TABLE IF NOT EXISTS zoho_record_comments (
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  module        VARCHAR(40) NOT NULL,
  zoho_id       VARCHAR(64) NOT NULL,
  comment_id    VARCHAR(64) NOT NULL,
  commented_by  VARCHAR(200),
  commented_at  TIMESTAMPTZ,
  comment_type  VARCHAR(40),
  description   TEXT,
  payload       JSONB NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, module, zoho_id, comment_id)
);
CREATE INDEX IF NOT EXISTS idx_zoho_comments_time ON zoho_record_comments (company_id, commented_at DESC);

CREATE TABLE IF NOT EXISTS zoho_attachments (
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  module        VARCHAR(40) NOT NULL,
  zoho_id       VARCHAR(64) NOT NULL,
  sha256        CHAR(64) NOT NULL,
  file_name     VARCHAR(400),
  content_type  VARCHAR(160),
  size_bytes    INTEGER NOT NULL,
  content       BYTEA NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, module, zoho_id, sha256)
);

CREATE TABLE IF NOT EXISTS zoho_extras_state (
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind          VARCHAR(20) NOT NULL,        -- 'comments' | 'attachment'
  module        VARCHAR(40) NOT NULL,
  zoho_id       VARCHAR(64) NOT NULL,
  status        VARCHAR(10) NOT NULL CHECK (status IN ('done', 'failed')),
  attempts      SMALLINT NOT NULL DEFAULT 0,
  last_error    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, kind, module, zoho_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zoho_record_comments', 'zoho_attachments', 'zoho_extras_state'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO fincommand_app USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO fincommand_app', t);
  END LOOP;
END $$;
