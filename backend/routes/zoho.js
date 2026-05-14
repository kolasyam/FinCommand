'use strict';
const router = require('express').Router();
const axios  = require('axios');
const db     = require('../db/connection');
const { authenticate, isCFO } = require('../middleware/auth');
const engine = require('../services/tbEngine');

const ZOHO_ACCOUNTS = {
  IN: 'https://accounts.zoho.in',
  US: 'https://accounts.zoho.com',
  EU: 'https://accounts.zoho.eu',
  AU: 'https://accounts.zoho.com.au',
};
const ZOHO_API = {
  IN: 'https://books.zoho.in',
  US: 'https://books.zoho.com',
  EU: 'https://books.zoho.eu',
  AU: 'https://books.zoho.com.au',
};

const FY_MONTHS_DR = [
  { name:'Apr', from_suffix:'04-01', to_suffix:'04-30' },
  { name:'May', from_suffix:'05-01', to_suffix:'05-31' },
  { name:'Jun', from_suffix:'06-01', to_suffix:'06-30' },
  { name:'Jul', from_suffix:'07-01', to_suffix:'07-31' },
  { name:'Aug', from_suffix:'08-01', to_suffix:'08-31' },
  { name:'Sep', from_suffix:'09-01', to_suffix:'09-30' },
  { name:'Oct', from_suffix:'10-01', to_suffix:'10-31' },
  { name:'Nov', from_suffix:'11-01', to_suffix:'11-30' },
  { name:'Dec', from_suffix:'12-01', to_suffix:'12-31' },
  { name:'Jan', next_yr:true, from_suffix:'01-01', to_suffix:'01-31' },
  { name:'Feb', next_yr:true, from_suffix:'02-01', to_suffix:'02-28' },
  { name:'Mar', next_yr:true, from_suffix:'03-01', to_suffix:'03-31' },
];

// ── GET /zoho/auth-url — get OAuth URL ──
router.get('/auth-url', authenticate, isCFO, async (req, res, next) => {
  try {
    const dc = req.query.data_center || 'IN';
    const base = ZOHO_ACCOUNTS[dc] || ZOHO_ACCOUNTS.IN;
    const params = new URLSearchParams({
      scope:         process.env.ZOHO_SCOPES || 'ZohoBooks.fullaccess.all',
      client_id:     process.env.ZOHO_CLIENT_ID,
      response_type: 'code',
      redirect_uri:  process.env.ZOHO_REDIRECT_URI,
      access_type:   'offline',
      state:         `${req.user.company_id}|${dc}`,
    });
    res.json({ auth_url: `${base}/oauth/v2/auth?${params}` });
  } catch (err) { next(err); }
});

// ── GET /zoho/callback — OAuth callback ──
router.get('/callback', async (req, res, next) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).json({ error: 'No code received from Zoho' });
    const [companyId, dc] = (state||'').split('|');
    const base = ZOHO_ACCOUNTS[dc] || ZOHO_ACCOUNTS.IN;

    const tokenRes = await axios.post(`${base}/oauth/v2/token`, null, {
      params: {
        code, client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        redirect_uri:  process.env.ZOHO_REDIRECT_URI,
        grant_type:    'authorization_code',
      },
    });
    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const expiry = new Date(Date.now() + (expires_in - 60) * 1000);

    await db.query(`
      INSERT INTO zoho_config
        (company_id, access_token, refresh_token, token_expiry, data_center, is_active)
      VALUES ($1,$2,$3,$4,$5,TRUE)
      ON CONFLICT (company_id) DO UPDATE SET
        access_token=$2, refresh_token=$3, token_expiry=$4,
        data_center=$5, is_active=TRUE, updated_at=NOW()`,
      [companyId, access_token, refresh_token, expiry, dc]
    );

    res.json({ message: 'Zoho Books connected successfully', data_center: dc });
  } catch (err) { next(err); }
});

// ── Refresh Zoho access token ──
async function refreshZohoToken(config) {
  const base = ZOHO_ACCOUNTS[config.data_center] || ZOHO_ACCOUNTS.IN;
  const res = await axios.post(`${base}/oauth/v2/token`, null, {
    params: {
      refresh_token: config.refresh_token,
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token',
    },
  });
  const { access_token, expires_in } = res.data;
  const expiry = new Date(Date.now() + (expires_in - 60) * 1000);
  await db.query(
    `UPDATE zoho_config SET access_token=$1, token_expiry=$2 WHERE company_id=$3`,
    [access_token, expiry, config.company_id]
  );
  return access_token;
}

// ── GET valid access token ──
async function getToken(companyId) {
  const { rows } = await db.query(
    `SELECT * FROM zoho_config WHERE company_id=$1 AND is_active=TRUE`, [companyId]
  );
  if (!rows.length) throw new Error('Zoho Books not connected. Please authenticate first.');
  const cfg = rows[0];
  if (new Date(cfg.token_expiry) <= new Date()) {
    return await refreshZohoToken(cfg);
  }
  return cfg.access_token;
}

// ── Core sync function ──
async function syncFromZoho(companyId, fyId, triggeredBy = null) {
  const logId = require('uuid').v4();
  const start = Date.now();

  // Get FY details
  const { rows: fyRows } = await db.query(
    `SELECT * FROM financial_years WHERE id=$1 AND company_id=$2`, [fyId, companyId]
  );
  if (!fyRows.length) throw new Error('Financial year not found');
  const fy = fyRows[0];
  const startYear = new Date(fy.start_date).getFullYear();

  // Get Zoho config
  const { rows: cfgRows } = await db.query(
    `SELECT * FROM zoho_config WHERE company_id=$1`, [companyId]
  );
  if (!cfgRows.length) throw new Error('Zoho Books not connected');
  const cfg = cfgRows[0];
  const orgId = cfg.org_id;
  if (!orgId) throw new Error('Zoho Organisation ID not set');

  // Update sync status
  await db.query(
    `UPDATE zoho_config SET last_sync_status='running', updated_at=NOW() WHERE company_id=$1`, [companyId]
  );
  await db.query(
    `INSERT INTO sync_logs (id,company_id,source,financial_year,triggered_by,status,started_at)
     VALUES ($1,$2,'zoho',$3,$4,'running',NOW())`,
    [logId, companyId, fy.label, triggeredBy]
  );

  let token;
  try {
    token = await getToken(companyId);
  } catch (e) {
    await db.query(`UPDATE sync_logs SET status='error',error_message=$1,completed_at=NOW() WHERE id=$2`,
      [e.message, logId]);
    throw e;
  }

  const apiBase = `${ZOHO_API[cfg.data_center] || ZOHO_API.IN}/api/v3`;
  const headers = { Authorization: `Zoho-oauthtoken ${token}` };

  // Fetch Chart of Accounts for Ledger Master mapping
  let coaMap = {};
  try {
    const coaRes = await axios.get(`${apiBase}/chartofaccounts`, {
      headers, params: { organization_id: orgId },
    });
    (coaRes.data.chartofaccounts || []).forEach(acct => {
      coaMap[acct.account_id] = acct.account_name;
    });
  } catch (e) {
    console.warn('COA fetch failed:', e.message);
  }

  // Fetch TB for each month
  const ledgerMap = {}; // key = account_name

  for (let mi = 0; mi < 12; mi++) {
    const m = FY_MONTHS_DR[mi];
    const yr = m.next_yr ? startYear + 1 : startYear;
    const from_date = `${yr}-${m.from_suffix}`;
    const to_date   = `${yr}-${m.to_suffix}`;

    try {
      const tbRes = await axios.get(`${apiBase}/trialbalance`, {
        headers,
        params: { organization_id: orgId, from_date, to_date },
      });

      const accounts = tbRes.data?.accounts || tbRes.data?.trial_balance || [];
      accounts.forEach(acct => {
        const name = acct.account_name || acct.name;
        if (!name) return;
        if (!ledgerMap[name]) {
          ledgerMap[name] = {
            code: acct.account_id || '',
            name,
            op_dr: parseFloat(acct.opening_balance_dr || 0),
            op_cr: parseFloat(acct.opening_balance_cr || 0),
            m: Array(12).fill(null).map(() => ({ dr: 0, cr: 0 })),
          };
        }
        ledgerMap[name].m[mi] = {
          dr: parseFloat(acct.debit_amount || acct.dr_amount || 0),
          cr: parseFloat(acct.credit_amount || acct.cr_amount || 0),
        };
      });
    } catch (e) {
      console.warn(`Month ${m.name} fetch failed:`, e.message);
    }
  }

  // Build TB rows with Ledger Master mapping
  const { rows: lmRows } = await db.query(
    `SELECT * FROM ledger_master WHERE (company_id=$1 OR company_id IS NULL) AND is_active=TRUE`,
    [companyId]
  );
  const lmByName = new Map(lmRows.map(r => [r.ledger_name.toLowerCase(), r]));

  const tbRows = Object.values(ledgerMap);
  let mapped = 0;
  const uploadId = require('uuid').v4();

  await db.withTransaction(async (client) => {
    // Supersede existing
    await client.query(
      `UPDATE tb_uploads SET is_current=FALSE, status='superseded'
       WHERE company_id=$1 AND financial_year_id=$2 AND is_current=TRUE`,
      [companyId, fyId]
    );

    await client.query(`
      INSERT INTO tb_uploads
        (id,company_id,financial_year_id,uploaded_by,source,ledger_count,
         mapped_count,has_monthly_cols,status,is_current)
      VALUES ($1,$2,$3,$4,'zoho',$5,$6,TRUE,'complete',TRUE)`,
      [uploadId, companyId, fyId, triggeredBy,
       tbRows.length, tbRows.filter(r => lmByName.has(r.name.toLowerCase())).length]
    );

    for (const row of tbRows) {
      const lm = lmByName.get(row.name.toLowerCase());
      if (lm) mapped++;
      await client.query(`
        INSERT INTO tb_ledgers
          (upload_id,company_id,financial_year_id,ledger_code,ledger_name,
           note_no,note_name,section,treasury_type,normal_bal,
           op_dr,op_cr,
           m1_dr,m1_cr,m2_dr,m2_cr,m3_dr,m3_cr,m4_dr,m4_cr,
           m5_dr,m5_cr,m6_dr,m6_cr,m7_dr,m7_cr,m8_dr,m8_cr,
           m9_dr,m9_cr,m10_dr,m10_cr,m11_dr,m11_cr,m12_dr,m12_cr)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                $13,$14,$15,$16,$17,$18,$19,$20,
                $21,$22,$23,$24,$25,$26,$27,$28,
                $29,$30,$31,$32,$33,$34,$35,$36)`,
        [uploadId, companyId, fyId, row.code, row.name,
         lm?.note_no||null, lm?.note_name||null, lm?.section||null,
         lm?.treasury_type||null, lm?.normal_bal||'Dr',
         row.op_dr, row.op_cr,
         row.m[0].dr,row.m[0].cr, row.m[1].dr,row.m[1].cr,
         row.m[2].dr,row.m[2].cr, row.m[3].dr,row.m[3].cr,
         row.m[4].dr,row.m[4].cr, row.m[5].dr,row.m[5].cr,
         row.m[6].dr,row.m[6].cr, row.m[7].dr,row.m[7].cr,
         row.m[8].dr,row.m[8].cr, row.m[9].dr,row.m[9].cr,
         row.m[10].dr,row.m[10].cr, row.m[11].dr,row.m[11].cr]
      );
    }
  });

  const duration = Date.now() - start;
  await db.query(
    `UPDATE zoho_config SET last_synced_at=NOW(),last_sync_status='success',
      synced_ledgers=$1, updated_at=NOW() WHERE company_id=$2`,
    [tbRows.length, companyId]
  );
  await db.query(
    `UPDATE sync_logs SET status='success',ledgers_synced=$1,duration_ms=$2,completed_at=NOW() WHERE id=$3`,
    [tbRows.length, duration, logId]
  );

  return { ledgers_synced: tbRows.length, mapped, upload_id: uploadId, duration_ms: duration };
}

// ── POST /zoho/sync — manual sync ──
router.post('/sync', authenticate, isCFO, async (req, res, next) => {
  try {
    const { fy_id } = req.body;
    if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

    const result = await syncFromZoho(req.user.company_id, fy_id, req.user.id);
    res.json({ message: 'Zoho Books sync complete', ...result });
  } catch (err) {
    await db.query(
      `UPDATE zoho_config SET last_sync_status='error',last_sync_error=$1 WHERE company_id=$2`,
      [err.message, req.user.company_id]
    ).catch(()=>{});
    next(err);
  }
});

// ── GET /zoho/status ──
router.get('/status', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, org_id, data_center, sync_frequency, last_synced_at,
              last_sync_status, last_sync_error, synced_ledgers,
              is_active, token_expiry > NOW() AS token_valid
       FROM zoho_config WHERE company_id=$1`,
      [req.user.company_id]
    );
    if (!rows.length) return res.json({ connected: false });
    res.json({ connected: true, ...rows[0] });
  } catch (err) { next(err); }
});

// ── PUT /zoho/config — update org_id & sync freq ──
router.put('/config', authenticate, isCFO, async (req, res, next) => {
  try {
    const { org_id, sync_frequency } = req.body;
    const { rows } = await db.query(
      `UPDATE zoho_config SET
         org_id=COALESCE($1,org_id),
         sync_frequency=COALESCE($2,sync_frequency),
         updated_at=NOW()
       WHERE company_id=$3 RETURNING *`,
      [org_id, sync_frequency, req.user.company_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Zoho not connected yet' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /zoho/logs ──
router.get('/logs', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM sync_logs WHERE company_id=$1 ORDER BY started_at DESC LIMIT 20`,
      [req.user.company_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = { router, syncFromZoho };
