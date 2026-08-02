'use strict';
require('dotenv').config();

const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const morgan      = require('morgan');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const cron        = require('node-cron');
const path        = require('path');
const fs          = require('fs');

const app = express();
const PORT = process.env.PORT || 4000;
const API  = process.env.API_PREFIX || '/api/v1';

// ── Ensure upload dir ──
// Vercel's serverless functions have a read-only filesystem except /tmp.
// Previously this ran unguarded on every cold start and, on Vercel, would
// throw EROFS before a single route was registered — taking down the whole
// API (including all Zoho endpoints), not just file upload/logging.
const IS_SERVERLESS = !!process.env.VERCEL;
if (IS_SERVERLESS) {
  process.env.UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/uploads';
  process.env.LOG_DIR    = process.env.LOG_DIR    || '/tmp/logs';
}
try {
  fs.mkdirSync(process.env.UPLOAD_DIR || './uploads', { recursive: true });
  fs.mkdirSync(process.env.LOG_DIR    || './logs',    { recursive: true });
} catch (e) {
  console.warn(`[startup] Could not create upload/log dirs (${e.message}) — continuing without them.`);
}

// ── Security & utility middleware ──
app.use(helmet());
// app.use(cors({
//   origin:      [process.env.FRONTEND_URL || 'http://localhost:3000', 'http://localhost:5500', 'null'],
//   credentials: true,
//   methods:     ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
//   allowedHeaders: ['Content-Type','Authorization','X-Company-ID'],
// }));
app.use(cors({
  origin: true,
  credentials: true,
  methods:     ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Company-ID'],
}));
app.use(compression());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Rate limiting ──
app.use(rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max:      parseInt(process.env.RATE_LIMIT_MAX || '200'),
  message:  { error: 'Too many requests. Please try again later.' },
  skip: (req) => req.path === `${API}/health`,
}));

// Tighter limit on auth routes
app.use(`${API}/auth/login`, rateLimit({ windowMs: 900000, max: 20, message: { error: 'Too many login attempts' } }));

// ── Routes ──
const authRouter   = require('./routes/auth');
const tbRouter     = require('./routes/trialBalance');
const reportRouter = require('./routes/reports');
const zohoModule   = require('./routes/zoho');
const { companies, financialYears, ledgerMaster, auditRoutes } = require('./routes/misc');

app.use(`${API}/auth`,          authRouter);
app.use(`${API}/tb`,            tbRouter);
app.use(`${API}/reports`,       reportRouter);
app.use(`${API}/zoho`,          zohoModule.router);
app.use(`${API}/companies`,     companies);
app.use(`${API}/fy`,            financialYears);
app.use(`${API}/ledger-master`, ledgerMaster);
app.use(`${API}/audit`,         auditRoutes);

// ── Health check ──
app.get(`${API}/health`, (req, res) => {
  res.json({
    status:  'ok',
    service: 'FinCommand Pro API',
    version: '1.0.0',
    uptime:  Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ── Root route ──
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to FinCommand',
    status:  'ok',
    service: 'FinCommand Pro API',
    version: '1.0.0',
  });
});

// ── Zoho auto-sync ──
// The actual sync logic, shared by both the in-process node-cron scheduler
// (local/traditional hosting) and the Vercel Cron endpoint below.
async function runZohoAutoSync() {
  if (process.env.NODE_ENV === 'test') return;
  const db = require('./db/connection');
  const results = [];
  try {
    const { rows } = await db.query(
      `SELECT zc.company_id, fy.id AS fy_id
       FROM zoho_config zc
       JOIN financial_years fy ON fy.company_id=zc.company_id
       WHERE zc.is_active=TRUE AND zc.org_id IS NOT NULL
         AND zc.sync_frequency != 'manual'
         AND fy.is_locked=FALSE
         AND fy.end_date >= NOW()-INTERVAL '1 year'
       ORDER BY fy.start_date DESC`
    );
    for (const row of rows) {
      try {
        await zohoModule.syncFromZoho(row.company_id, row.fy_id, null);
        console.log(`[CRON] Zoho sync complete for company ${row.company_id}`);
        results.push({ company_id: row.company_id, status: 'ok' });
      } catch (e) {
        console.error(`[CRON] Zoho sync failed for company ${row.company_id}:`, e.message);
        results.push({ company_id: row.company_id, status: 'error', error: e.message });
      }
    }
  } catch (e) {
    console.error('[CRON] Scheduler error:', e.message);
    throw e;
  }
  return results;
}

if (IS_SERVERLESS) {
  // node-cron relies on a long-lived process staying alive between ticks —
  // on Vercel each invocation is a fresh, short-lived instance, so
  // cron.schedule() here previously registered a timer that would (almost)
  // never actually fire. Use Vercel Cron Jobs instead: add a `crons` entry
  // in vercel.json pointing at this route (protected by CRON_SECRET), e.g.
  //   { "path": "/api/v1/internal/zoho-cron", "schedule": "0 */6 * * *" }
  app.get(`${API}/internal/zoho-cron`, async (req, res, next) => {
    const secret = req.headers['authorization'];
    if (process.env.CRON_SECRET && secret !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const results = await runZohoAutoSync();
      res.json({ ran_at: new Date().toISOString(), results });
    } catch (e) { next(e); }
  });
}

// ── Catch-all 404 ──
app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));

// ── Global error handler ──
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  if (process.env.NODE_ENV === 'development') console.error(err.stack);

  if (err.type === 'entity.parse.failed')
    return res.status(400).json({ error: 'Invalid JSON body' });
  if (err.code === '23505')
    return res.status(409).json({ error: 'Duplicate entry: ' + err.detail });
  if (err.code === '23503')
    return res.status(400).json({ error: 'Foreign key violation: ' + err.detail });

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status === 500 && process.env.NODE_ENV === 'production'
      ? 'Internal server error' : err.message,
    ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {}),
  });
});

// ── In-process cron (non-serverless hosting only) ──
if (!IS_SERVERLESS) {
  const CRON = process.env.ZOHO_SYNC_CRON || '0 0 */6 * * *'; // every 6h default
  cron.schedule(CRON, runZohoAutoSync);
}

// ── Start server ──
app.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║   FinCommand Pro — API Server         ║`);
  console.log(`║   Port  : ${PORT}                          ║`);
  console.log(`║   Env   : ${(process.env.NODE_ENV||'development').padEnd(12)}              ║`);
  console.log(`║   Prefix: ${API.padEnd(16)}         ║`);
  console.log(`╚═══════════════════════════════════════╝\n`);
});

module.exports = app;
