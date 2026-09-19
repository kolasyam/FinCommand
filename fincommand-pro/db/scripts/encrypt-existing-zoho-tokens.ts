/* eslint-disable no-console */
/**
 * One-off: encrypts Zoho tokens that were stored in plain text before
 * lib/security/token-crypto.ts existed.
 *
 *   npx tsx db/scripts/encrypt-existing-zoho-tokens.ts --target=branch --dry-run
 *   npx tsx db/scripts/encrypt-existing-zoho-tokens.ts --target=branch
 *   npx tsx db/scripts/encrypt-existing-zoho-tokens.ts               (main)
 *
 * Needs TOKEN_ENCRYPTION_KEY — the SAME value the app uses, or the app won't
 * be able to read the tokens back. Idempotent: already-encrypted values are
 * left alone. Each row is updated only if its tokens are still the ones read
 * (a token refresh racing this script wins, and the row is retried next run).
 * Prints counts only — never a token.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { connectionConfigFor, parseTarget } from '../migrate-core';
import { encryptToken, decryptToken, isEncryptedToken } from '../../lib/security/token-crypto';

async function main() {
  const target = parseTarget(process.argv);
  const dryRun = process.argv.includes('--dry-run');
  // Fail before touching anything if the key is missing or malformed.
  decryptToken(encryptToken('self-test'));

  const pool = new Pool({ ...connectionConfigFor(target, process.env), max: 1 });
  try {
    const { rows } = await pool.query<{ company_id: string; access_token: string | null; refresh_token: string | null }>(
      `SELECT company_id, access_token, refresh_token FROM zoho_config`
    );
    const pending = rows.filter(r =>
      (r.access_token && !isEncryptedToken(r.access_token)) || (r.refresh_token && !isEncryptedToken(r.refresh_token)));
    console.log(`Target: ${target}. ${rows.length} zoho_config row(s), ${pending.length} with plain-text tokens.`);
    if (dryRun || !pending.length) return;

    let updated = 0;
    for (const r of pending) {
      const enc = (v: string | null) => (v && !isEncryptedToken(v) ? encryptToken(v) : v);
      const next = { access: enc(r.access_token), refresh: enc(r.refresh_token) };
      // Round-trip check before writing: what we store must decrypt to what was there.
      if (decryptToken(next.access) !== r.access_token || decryptToken(next.refresh) !== r.refresh_token) {
        throw new Error(`Round-trip check failed for one company — nothing written for it.`);
      }
      const { rowCount } = await pool.query(
        `UPDATE zoho_config SET access_token=$1, refresh_token=$2
         WHERE company_id=$3 AND access_token IS NOT DISTINCT FROM $4 AND refresh_token IS NOT DISTINCT FROM $5`,
        [next.access, next.refresh, r.company_id, r.access_token, r.refresh_token]
      );
      updated += rowCount ?? 0;
    }
    console.log(`✅ Encrypted tokens in ${updated} of ${pending.length} row(s).`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`❌ ${(err as Error).message}`);
  process.exit(1);
});
