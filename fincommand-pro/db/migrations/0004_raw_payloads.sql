-- 0004 — raw Zoho responses in their own, de-duplicated table (DB Phase 1.3).
--
-- Every sync stored ALL its raw Zoho responses (~140 kB) inside its
-- tb_uploads row (raw_zoho_months), so an unchanged month was stored again
-- on every sync: tb_uploads was 4.7 MB for 37 rows. Raw responses are kept
-- (they are the proof of what Zoho returned) but each distinct response is
-- now stored once per company, and each batch links to the ones it used.
--
--   raw_payloads         one row per distinct response (company + SHA-256 of
--                        the canonical JSONB text, computed by Postgres)
--   upload_raw_payloads  which responses a batch was built from, under which
--                        label ('P&L Apr', 'BS Opening', …), period and time
--
-- Non-destructive: COPIES every existing raw_zoho_months entry, then checks
-- that each one is reachable through the links with identical JSON. The old
-- column is left as it is; clearing it is a separate, owner-approved step
-- (db/scripts/clear-raw-zoho-months.ts).

CREATE TABLE IF NOT EXISTS raw_payloads (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source         VARCHAR(20) NOT NULL,
  sha256         CHAR(64) NOT NULL,
  payload        JSONB NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, sha256)
);

CREATE TABLE IF NOT EXISTS upload_raw_payloads (
  upload_id       UUID NOT NULL REFERENCES tb_uploads(id) ON DELETE CASCADE,
  label           VARCHAR(60) NOT NULL,
  period_from     DATE,
  period_to       DATE,
  fetched_at      TIMESTAMPTZ,
  raw_payload_id  UUID NOT NULL REFERENCES raw_payloads(id),
  PRIMARY KEY (upload_id, label)
);
CREATE INDEX IF NOT EXISTS idx_upload_raw_payloads_payload ON upload_raw_payloads(raw_payload_id);

-- Every existing entry, one row each.
CREATE TEMP TABLE _raw ON COMMIT DROP AS
SELECT u.id AS upload_id, u.company_id, u.source,
       e.val->>'month' AS label,
       NULLIF(e.val->>'from_date', '')::date AS period_from,
       NULLIF(e.val->>'to_date', '')::date AS period_to,
       NULLIF(e.val->>'fetched_at', '')::timestamptz AS fetched_at,
       e.val->'raw_response' AS payload,
       encode(sha256(convert_to((e.val->'raw_response')::text, 'UTF8')), 'hex') AS sha256
FROM tb_uploads u, jsonb_array_elements(u.raw_zoho_months) AS e(val)
WHERE u.raw_zoho_months IS NOT NULL AND jsonb_typeof(u.raw_zoho_months) = 'array'
  AND e.val ? 'raw_response' AND e.val->'raw_response' IS NOT NULL AND e.val->>'month' IS NOT NULL;

DO $$
DECLARE n bigint; dup bigint;
BEGIN
  SELECT count(*) INTO n FROM _raw;
  SELECT count(*) INTO dup FROM (SELECT 1 FROM _raw GROUP BY upload_id, label HAVING count(*) > 1) x;
  IF dup > 0 THEN RAISE EXCEPTION '0004 pre-flight: % batch/label pair(s) appear twice — cannot link uniquely', dup; END IF;
  RAISE NOTICE '0004: % raw entries to copy', n;
END $$;

INSERT INTO raw_payloads (company_id, source, sha256, payload, first_seen_at, last_seen_at)
SELECT DISTINCT ON (company_id, sha256)
       company_id, source, sha256, payload,
       COALESCE(min(fetched_at) OVER w, NOW()), COALESCE(max(fetched_at) OVER w, NOW())
FROM _raw
WINDOW w AS (PARTITION BY company_id, sha256)
ORDER BY company_id, sha256, fetched_at
ON CONFLICT (company_id, sha256) DO NOTHING;

INSERT INTO upload_raw_payloads (upload_id, label, period_from, period_to, fetched_at, raw_payload_id)
SELECT r.upload_id, r.label, r.period_from, r.period_to, r.fetched_at, p.id
FROM _raw r JOIN raw_payloads p ON p.company_id = r.company_id AND p.sha256 = r.sha256
ON CONFLICT (upload_id, label) DO NOTHING;

-- Post-check: every original entry is reachable, with byte-identical JSON.
DO $$
DECLARE total bigint; reachable bigint; distinct_payloads bigint;
BEGIN
  SELECT count(*) INTO total FROM _raw;
  SELECT count(*) INTO reachable
    FROM _raw r
    JOIN upload_raw_payloads l ON l.upload_id = r.upload_id AND l.label = r.label
    JOIN raw_payloads p ON p.id = l.raw_payload_id
   WHERE p.payload = r.payload;
  IF reachable <> total THEN
    RAISE EXCEPTION '0004 post-check: only % of % raw entries are reachable with identical JSON', reachable, total;
  END IF;
  SELECT count(*) INTO distinct_payloads FROM raw_payloads;
  RAISE NOTICE '0004 done: % entries now point at % distinct stored responses', total, distinct_payloads;
END $$;
