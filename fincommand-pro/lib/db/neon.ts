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

// Guards every connection the pool ever hands out, regardless of which
// query function is used to run it — a single slow/runaway query (a
// missing index, an accidental cross-join, a report run against a
// pathologically large ledger set) can otherwise hold a connection forever
// and starve the pool for every other request. statement_timeout bounds a
// single query; idle_in_transaction_session_timeout bounds a client that
// opened a transaction (withTransaction()/BEGIN) and then never committed
// or rolled back — e.g. a crash mid-transaction, or a bug that throws
// between BEGIN and the COMMIT/ROLLBACK it's paired with — which would
// otherwise hold both the connection AND whatever row locks it took
// indefinitely. Both configurable via env so a genuinely long-running
// admin/reporting query can be given more room without a code change.
const STATEMENT_TIMEOUT_MS = parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '30000');
const IDLE_IN_TRANSACTION_TIMEOUT_MS = parseInt(process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS || '15000');

// How long an unused pooled connection is kept open (beyond DB_POOL_MIN). It
// was 30 s. Opening a connection is the most expensive thing a request can
// do — TCP + TLS + login is about 5 round trips, so ~1.3-2 s from India to a
// us-east-1 Neon — and a page load asks for ~10 at once. Measured with the
// old value: the first page load after a 35 s pause took 3.4 s, against 0.34 s
// with connections kept (docs/LATENCY.md). 5 minutes matches Neon's own
// scale-to-zero window, and TCP keep-alive lets a connection the network
// dropped meanwhile be detected instead of reused.
const IDLE_TIMEOUT_MS = parseInt(process.env.DB_IDLE_TIMEOUT_MS || '300000');
const KEEP_ALIVE = { keepAlive: true, keepAliveInitialDelayMillis: 10000 };

function buildPool(): Pool {
  const ssl = process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false;

  if (process.env.DATABASE_URL) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      min: parseInt(process.env.DB_POOL_MIN || '2'),
      max: parseInt(process.env.DB_POOL_MAX || '10'),
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      ...KEEP_ALIVE,
      // Neon's serverless compute auto-suspends when idle and can take up
      // to ~20-30s to resume on the next connection ("cold start") — 5s
      // (the original backend/db/connection.js value) was timing out the
      // very first request after any idle period. 30s covers a cold start;
      // subsequent requests reuse the warm pooled connection and are fast.
      connectionTimeoutMillis: 30000,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      query_timeout: STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
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
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    ...KEEP_ALIVE,
    // Same cold-start allowance as the DATABASE_URL branch above — Neon is
    // allowed to scale to zero now that there's no keep-alive ping.
    connectionTimeoutMillis: 30000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
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

// Schema changes are never made from here. There used to be a startup
// ALTER TABLE for dashboard_widgets' widget_type CHECK (it drifted out of
// sync with schema.sql once and broke layout saves): gone — schema lives in
// db/migrations (`npm run db:migrate`).
//
// The 3-minute `SELECT 1` keep-alive was removed in DB Phase 0 so Neon could
// scale to zero (cost). On 2026-09-20 the owner chose the other side of that
// trade: keep the compute awake, and pay its hours, so the first request after
// a quiet spell doesn't wait seconds for the database to wake (docs/LATENCY.md
// §5). A long-lived server pings from here; on Vercel, where nothing lives
// between requests, a cron does it (/api/v1/internal/keepalive, vercel.json).
// The 30 s connectionTimeoutMillis above still absorbs a genuine cold start.

declare global {
  // eslint-disable-next-line no-var
  var __fcPgKeepAlive: ReturnType<typeof setInterval> | undefined;
}

/** How often this process pings the database, in ms; 0 = not at all (tests, Vercel, or DB_KEEPALIVE_MS=0). */
export function keepAliveIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  if (env.NODE_ENV === 'test') return 0;
  if (env.DB_KEEPALIVE_MS !== undefined) {
    const ms = parseInt(env.DB_KEEPALIVE_MS, 10);
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  }
  return env.VERCEL ? 0 : 240000; // under Neon's 5-minute suspend window
}

/**
 * Pings `p` with a trivial query every `everyMs`. The timer is unref'd, so it
 * never keeps a script or a shutting-down server alive, and a previous timer
 * (a dev hot reload builds a new pool) is replaced, never stacked.
 */
export function startKeepAlive(p: Pick<Pool, 'query'>, everyMs: number): ReturnType<typeof setInterval> {
  if (global.__fcPgKeepAlive) clearInterval(global.__fcPgKeepAlive);
  const timer = setInterval(() => { Promise.resolve(p.query('SELECT 1')).catch(() => {}); }, everyMs);
  timer.unref?.();
  global.__fcPgKeepAlive = timer;
  return timer;
}

const keepAliveMs = keepAliveIntervalMs();
if (keepAliveMs > 0) startKeepAlive(pool, keepAliveMs);

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
