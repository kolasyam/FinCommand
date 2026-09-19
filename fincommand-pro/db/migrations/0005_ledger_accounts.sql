-- 0005 — stable account identity (DB Phase 1.4).
--
-- tb_ledgers rows are re-created by every upload/sync, so nothing could point
-- at "this account" except by its name — and a renamed Zoho account silently
-- broke Report Builder links. Now every ledger row belongs to a
-- ledger_accounts row whose identity never changes:
--
--   Zoho   the Zoho account id (stable across renames), else the code
--   Excel  the ledger code, else "name:" + lowercased trimmed name
--
-- The identity is defined ONCE, in SQL (ledger_account_key), and assigned by
-- a trigger on every tb_ledgers insert — so it holds for every writer (the
-- ingestion pipeline, seed.ts, and the code still deployed while this
-- migration is rolled out), and account_id can be NOT NULL from day one.
--
-- Non-destructive: new table, new columns, backfill of existing rows.

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source             VARCHAR(20) NOT NULL,
  source_key         VARCHAR(320) NOT NULL,
  code               VARCHAR(50),
  name               VARCHAR(300) NOT NULL,
  zoho_account_type  VARCHAR(50),
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (company_id, source, source_key)
);
CREATE INDEX IF NOT EXISTS idx_ledger_accounts_company_name ON ledger_accounts (company_id, lower(name));

CREATE OR REPLACE FUNCTION ledger_account_key(p_source TEXT, p_zoho_account_id TEXT, p_code TEXT, p_name TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_source = 'zoho'
    THEN COALESCE(NULLIF(btrim(p_zoho_account_id), ''), NULLIF(btrim(p_code), ''), 'name:' || lower(btrim(p_name)))
    ELSE COALESCE(NULLIF(btrim(p_code), ''), 'name:' || lower(btrim(p_name)))
  END
$$;

-- ── Backfill accounts from every existing ledger row (latest name wins) ──
INSERT INTO ledger_accounts (company_id, source, source_key, code, name, zoho_account_type, first_seen_at, last_seen_at)
SELECT DISTINCT ON (l.company_id, u.source, k.key)
       l.company_id, u.source, k.key, l.ledger_code, l.ledger_name, l.zoho_account_type,
       min(u.uploaded_at) OVER w, max(u.uploaded_at) OVER w
FROM tb_ledgers l
JOIN tb_uploads u ON u.id = l.upload_id
CROSS JOIN LATERAL (SELECT ledger_account_key(u.source, l.zoho_account_id, l.ledger_code, l.ledger_name) AS key) k
WINDOW w AS (PARTITION BY l.company_id, u.source, k.key)
ORDER BY l.company_id, u.source, k.key, u.uploaded_at DESC
ON CONFLICT (company_id, source, source_key) DO NOTHING;

ALTER TABLE tb_ledgers ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES ledger_accounts(id);

UPDATE tb_ledgers l
   SET account_id = a.id
  FROM tb_uploads u, ledger_accounts a
 WHERE u.id = l.upload_id
   AND a.company_id = l.company_id AND a.source = u.source
   AND a.source_key = ledger_account_key(u.source, l.zoho_account_id, l.ledger_code, l.ledger_name)
   AND l.account_id IS NULL;

DO $$
DECLARE missing bigint;
BEGIN
  SELECT count(*) INTO missing FROM tb_ledgers WHERE account_id IS NULL;
  IF missing > 0 THEN RAISE EXCEPTION '0005 post-check: % ledger row(s) got no account', missing; END IF;
END $$;

ALTER TABLE tb_ledgers ALTER COLUMN account_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tb_ledgers_account ON tb_ledgers(account_id);

-- ── Every future ledger row gets its account here, whoever writes it ──
CREATE OR REPLACE FUNCTION tb_ledgers_assign_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_source TEXT;
BEGIN
  IF NEW.account_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT source INTO v_source FROM tb_uploads WHERE id = NEW.upload_id;
  INSERT INTO ledger_accounts (company_id, source, source_key, code, name, zoho_account_type)
  VALUES (NEW.company_id, v_source, ledger_account_key(v_source, NEW.zoho_account_id, NEW.ledger_code, NEW.ledger_name),
          NEW.ledger_code, NEW.ledger_name, NEW.zoho_account_type)
  ON CONFLICT (company_id, source, source_key) DO UPDATE
     SET code = EXCLUDED.code,
         name = EXCLUDED.name,                  -- a rename in Zoho just updates the name
         zoho_account_type = COALESCE(EXCLUDED.zoho_account_type, ledger_accounts.zoho_account_type),
         last_seen_at = NOW(),
         is_active = TRUE
  RETURNING id INTO NEW.account_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_tb_ledgers_assign_account ON tb_ledgers;
CREATE TRIGGER trg_tb_ledgers_assign_account
  BEFORE INSERT ON tb_ledgers FOR EACH ROW EXECUTE FUNCTION tb_ledgers_assign_account();

-- ── Report Builder links follow the account, not just its name ──
-- A link is resolved to an account when exactly one of the company's
-- accounts has that name; ambiguous names (e.g. "Amortisation — Intangibles",
-- two real accounts) stay name-only, exactly as before.
ALTER TABLE report_line_ledgers ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES ledger_accounts(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION report_line_ledger_account(p_line_id UUID, p_name TEXT) RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(a.id))[1] END
  FROM report_lines rl
  JOIN report_templates rt ON rt.id = rl.template_id
  JOIN ledger_accounts a ON a.company_id = rt.company_id AND lower(a.name) = lower(btrim(p_name))
  WHERE rl.id = p_line_id
$$;

UPDATE report_line_ledgers SET account_id = report_line_ledger_account(line_id, ledger_name) WHERE account_id IS NULL;

CREATE OR REPLACE FUNCTION report_line_ledgers_assign_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id IS NULL THEN NEW.account_id := report_line_ledger_account(NEW.line_id, NEW.ledger_name); END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_report_line_ledgers_assign_account ON report_line_ledgers;
CREATE TRIGGER trg_report_line_ledgers_assign_account
  BEFORE INSERT ON report_line_ledgers FOR EACH ROW EXECUTE FUNCTION report_line_ledgers_assign_account();

DO $$
DECLARE accounts bigint; links bigint; linked bigint;
BEGIN
  SELECT count(*) INTO accounts FROM ledger_accounts;
  SELECT count(*), count(account_id) INTO links, linked FROM report_line_ledgers;
  RAISE NOTICE '0005 done: % accounts; every ledger row has one; % of % Report Builder links resolved to an account', accounts, linked, links;
END $$;
