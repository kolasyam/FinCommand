-- 0000 — baseline marker.
--
-- The schema up to this point is db/schema.sql, which db:init applies
-- before running migrations. Existing databases already match it, so this
-- file changes nothing; it only records where versioned migrations begin.
-- From here on every schema change is a new numbered file in this folder.
SELECT 1;
