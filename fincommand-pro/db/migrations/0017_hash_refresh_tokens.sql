-- 0017 — refresh tokens are stored only as their SHA-256 (audit item 6).
--
-- The app now saves and looks up hashRefreshToken(token) = hex(sha256(token)) (lib/auth/jwt.ts). Rows written
-- before that still hold the token itself. This hashes them in place with the same function, so those sessions
-- keep working after the deploy and no usable token is left in the database.
-- A token is a ~190-character JWT; a hash is exactly 64 hex characters, so already-hashed rows are left alone
-- and the file is safe to re-run. Run it together with the deploy of the hashing code: the OLD code looks
-- tokens up as-is, so between the two its users would simply be asked to sign in again.

UPDATE refresh_tokens
   SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex')
 WHERE token !~ '^[0-9a-f]{64}$';

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM refresh_tokens WHERE token !~ '^[0-9a-f]{64}$';
  IF n > 0 THEN RAISE EXCEPTION '0017 post-check: % refresh token(s) still stored in plain text', n; END IF;
  RAISE NOTICE '0017 done: every refresh token is stored as a hash';
END $$;
