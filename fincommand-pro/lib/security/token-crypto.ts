import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Encryption at rest for third-party OAuth tokens (Zoho Books access and
 * refresh tokens in zoho_config). AES-256-GCM, so a tampered value fails to
 * decrypt instead of silently yielding garbage.
 *
 * Stored format: `enc:v1:<iv>:<auth tag>:<ciphertext>` (base64url parts).
 * The key is TOKEN_ENCRYPTION_KEY — 32 random bytes, base64-encoded:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * decryptToken() passes a value without the prefix through unchanged, so
 * tokens written before this existed keep working until
 * db/scripts/encrypt-existing-zoho-tokens.ts (or the next token refresh)
 * rewrites them. encryptToken() refuses to run without a key — tokens are
 * never stored in plain text by accident.
 */

const PREFIX = 'enc:v1:';

function loadKey(keyB64: string | undefined): Buffer {
  if (!keyB64) throw new Error('TOKEN_ENCRYPTION_KEY is not set — Zoho tokens cannot be stored or read.');
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
  return key;
}

export function isEncryptedToken(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptToken(plain: string, keyB64: string | undefined = process.env.TOKEN_ENCRYPTION_KEY): string {
  const key = loadKey(keyB64);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptToken(stored: string, keyB64?: string): string;
export function decryptToken(stored: string | null, keyB64?: string): string | null;
export function decryptToken(stored: string | null, keyB64: string | undefined = process.env.TOKEN_ENCRYPTION_KEY): string | null {
  if (stored == null) return null;
  if (!isEncryptedToken(stored)) return stored; // written before encryption existed
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Stored token is malformed.');
  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', loadKey(keyB64), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Stored token could not be decrypted (wrong TOKEN_ENCRYPTION_KEY, or the value was altered).');
  }
}
