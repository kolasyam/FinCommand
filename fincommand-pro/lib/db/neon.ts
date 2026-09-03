import { Pool, type PoolClient, type QueryResultRow } from 'pg';

/**
 * Neon/PostgreSQL connection pool.
 *
 * Preserves the original backend/db/connection.js contract: builds from the
 * individual DB_* env vars (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD,
 * DB_POOL_MIN, DB_POOL_MAX, DATABASE_SSL). `DATABASE_URL` is accepted as an
 * optional override (handy for Neon's connection-string workflow) but is
 * never required — the DB_* vars remain the source of truth so the existing
 * .env keeps working unmodified.
 */

declare global {
  // eslint-disable-next-line no-var
  var __fcPgPool: Pool | undefined;
}

function buildPool(): Pool {
  const ssl = process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false;

  if (process.env.DATABASE_URL) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      min: parseInt(process.env.DB_POOL_MIN || '2'),
      max: parseInt(process.env.DB_POOL_MAX || '10'),
      idleTimeoutMillis: 30000,
      // Neon's serverless compute auto-suspends when idle and can take up
      // to ~20-30s to resume on the next connection ("cold start") — 5s
      // (the original backend/db/connection.js value) was timing out the
      // very first request after any idle period. 30s covers a cold start;
      // subsequent requests reuse the warm pooled connection and are fast.
      connectionTimeoutMillis: 30000,
      ssl,
    });
  }

  return new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'fincommand',
    user: process.env.DB_USER || 'fincommand_user',
    password: process.env.DB_PASSWORD,
    min: parseInt(process.env.DB_POOL_MIN || '2'),
    max: parseInt(process.env.DB_POOL_MAX || '10'),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    ssl,
  });
}

// In development, clear cached pool on module reload so old connection sockets are refreshed
if (process.env.NODE_ENV === 'development' && global.__fcPgPool) {
  global.__fcPgPool.end().catch(() => {});
  global.__fcPgPool = undefined;
}

// Reuse a single pool across server invocations.
const pool: Pool = global.__fcPgPool || buildPool();
global.__fcPgPool = pool;

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

// Keep-alive ping to prevent Neon serverless compute cold-start latency (runs every 3 minutes)
declare global {
  // eslint-disable-next-line no-var
  var __fcKeepAlivePing: NodeJS.Timeout | undefined;
}
if (!global.__fcKeepAlivePing) {
  global.__fcKeepAlivePing = setInterval(() => {
    pool.query('SELECT 1').catch(() => {});
  }, 3 * 60 * 1000);
}

export function query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
  return pool.query<T>(text, params);
}

export function getClient(): Promise<PoolClient> {
  return pool.connect();
}

/** Transaction helper — mirrors db.withTransaction() from the original connection.js. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let released = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const msg = (err as Error).message || '';
    if (msg.includes('does not exist') || msg.includes('column') || msg.includes('relation')) {
      // Destroy socket so stale pool connection isn't reused across DDL schema updates
      client.release(true);
      released = true;
    }
    throw err;
  } finally {
    if (!released) client.release();
  }
}

export { pool };
export default { query, getClient, withTransaction, pool };
