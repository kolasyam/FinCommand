'use strict';
const router  = require('express').Router();
const { query: qv, validationResult } = require('express-validator');
const db      = require('../db/connection');
const { authenticate } = require('../middleware/auth');
const engine  = require('../services/tbEngine');

// ── Shared validators ──
const commonValidators = [
  qv('fy_id').isUUID().withMessage('fy_id must be a valid UUID'),
  qv('period_type').optional().isIn(['annual','quarterly','halfyear']).withMessage('period_type must be annual, quarterly, or halfyear'),
  qv('period').optional().isIn(['Q1','Q2','Q3','Q4','H1','H2']).withMessage('period must be Q1-Q4 or H1/H2'),
  qv('year_type').optional().isIn(['FY','CY']).withMessage('year_type must be FY or CY'),
];
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
};

// ── Helper: load ledgers for a company+FY ──
async function loadLedgers(companyId, fyId) {
  const { rows } = await db.query(
    `SELECT l.* FROM tb_ledgers l
     JOIN tb_uploads u ON u.id = l.upload_id
     WHERE l.company_id = $1 AND l.financial_year_id = $2 AND u.is_current = TRUE
     ORDER BY l.ledger_name`,
    [companyId, fyId]
  );
  return rows;
}

// ── Helper: parse common period params from query ──
function parsePeriodParams(query) {
  return {
    periodType: query.period_type || 'annual',  // annual|quarterly|halfyear
    period:     query.period      || null,       // Q1..Q4|H1|H2|null
    yearType:   query.year_type   || 'FY',       // FY|CY
  };
}

// ── Helper: verify FY access ──
async function getFY(companyId, fyId) {
  const { rows } = await db.query(
    `SELECT * FROM financial_years WHERE id=$1 AND company_id=$2`,
    [fyId, companyId]
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────
//  MIS REPORT — Period-aware P&L summary
//  GET /reports/mis?fy_id=&period_type=annual&year_type=FY
// ─────────────────────────────────────────────
router.get('/mis', authenticate, commonValidators, validate, async (req, res, next) => {
  try {
    const { fy_id } = req.query;
    if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

    const fy = await getFY(req.user.company_id, fy_id);
    if (!fy) return res.status(404).json({ error: 'Financial year not found' });

    const ledgers = await loadLedgers(req.user.company_id, fy_id);
    if (!ledgers.length) return res.status(404).json({ error: 'No Trial Balance data found for this FY. Upload TB first.' });

    const params  = parsePeriodParams(req.query);
    const result  = engine.computeMIS(ledgers, params);

    res.json({
      financial_year: fy,
      period_params:  params,
      period_label:   engine.resolvePeriod(params).label,
      ...result,
      generated_at:   new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────
//  BALANCE SHEET — Schedule III IND AS
//  GET /reports/bs?fy_id=&period_type=quarterly&period=Q2
// ─────────────────────────────────────────────
router.get('/bs',       authenticate, commonValidators, validate, async (req, res, next) => {
  try {
    const { fy_id } = req.query;
    if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

    const fy = await getFY(req.user.company_id, fy_id);
    if (!fy) return res.status(404).json({ error: 'Financial year not found' });

    const ledgers = await loadLedgers(req.user.company_id, fy_id);
    if (!ledgers.length) return res.status(404).json({ error: 'No Trial Balance data found. Upload TB first.' });

    const params  = parsePeriodParams(req.query);
    const result  = engine.computeBS(ledgers, params);
    const resolved= engine.resolvePeriod(params);

    res.json({
      financial_year:  fy,
      period_params:   params,
      period_end:      resolved.periodEnd || fy.end_date,
      period_label:    resolved.label,
      ...result,
      generated_at:    new Date().toISOString(),
      ind_as_note:     'Balance Sheet prepared as per Schedule III of Companies Act 2013 — IND AS. Closing balance = Opening + Σ monthly movements to period end.',
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────
//  P&L ACCOUNT — Schedule III IND AS
//  GET /reports/pl?fy_id=&period_type=halfyear&period=H1
// ─────────────────────────────────────────────
router.get('/pl', authenticate, commonValidators, validate, async (req, res, next) => {
  try {
    const { fy_id } = req.query;
    if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

    const fy = await getFY(req.user.company_id, fy_id);
    if (!fy) return res.status(404).json({ error: 'Financial year not found' });

    const ledgers = await loadLedgers(req.user.company_id, fy_id);
    if (!ledgers.length) return res.status(404).json({ error: 'No Trial Balance data found. Upload TB first.' });

    const params  = parsePeriodParams(req.query);
    const result  = engine.computePL(ledgers, params);
    const resolved= engine.resolvePeriod(params);

    res.json({
      financial_year: fy,
      period_params:  params,
      period_label:   resolved.label,
      ...result,
      generated_at:   new Date().toISOString(),
      ind_as_note:    'P&L for the period = sum of income/expense ledger monthly movements for selected months only.',
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────
//  NOTES TO ACCOUNTS (Notes 1–26)
//  GET /reports/notes?fy_id=&note_no=23   (optional filter)
// ─────────────────────────────────────────────
router.get('/notes',    authenticate, commonValidators, validate, async (req, res, next) => {
  try {
    const { fy_id, note_no } = req.query;
    if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

    const fy = await getFY(req.user.company_id, fy_id);
    if (!fy) return res.status(404).json({ error: 'Financial year not found' });

    const ledgers = await loadLedgers(req.user.company_id, fy_id);
    if (!ledgers.length) return res.status(404).json({ error: 'No Trial Balance data found.' });

    const params = parsePeriodParams(req.query);
    const notes  = engine.computeNotes(ledgers, params);

    // Filter by note_no if requested
    const filtered = note_no
      ? Object.fromEntries(Object.entries(notes).filter(([k]) => k === String(note_no)))
      : notes;

    // Sort by note_no
    const sorted = Object.values(filtered).sort((a,b) => a.note_no - b.note_no);

    res.json({
      financial_year: fy,
      period_params:  params,
      total_notes:    sorted.length,
      notes:          sorted,
      generated_at:   new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────
//  TREASURY — Cash, FDs, MFs
//  GET /reports/treasury?fy_id=&period_type=quarterly&period=Q2
// ─────────────────────────────────────────────
router.get('/treasury', authenticate, commonValidators, validate, async (req, res, next) => {
  try {
    const { fy_id } = req.query;
    if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

    const fy = await getFY(req.user.company_id, fy_id);
    if (!fy) return res.status(404).json({ error: 'Financial year not found' });

    const ledgers = await loadLedgers(req.user.company_id, fy_id);
    if (!ledgers.length) return res.status(404).json({ error: 'No Trial Balance data found.' });

    const params  = parsePeriodParams(req.query);
    const result  = engine.computeTreasury(ledgers, params);
    const resolved= engine.resolvePeriod(params);

    res.json({
      financial_year: fy,
      period_end:     resolved.periodEnd || fy.end_date,
      period_label:   resolved.label,
      ...result,
      source_note:    'Treasury auto-extracted from TB ledgers tagged with treasury_type in Ledger Master. Note 19 = Cash & CE, Note 20 = FDs, Note 13 = MFs.',
      generated_at:   new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────
//  CASH FLOW STATEMENT (IND AS 7 — Indirect)
//  GET /reports/cashflow?fy_id=
// ─────────────────────────────────────────────
router.get('/cashflow', authenticate, [qv('fy_id').isUUID(), validate], async (req, res, next) => {
  try {
    const { fy_id } = req.query;
    if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

    const fy = await getFY(req.user.company_id, fy_id);
    if (!fy) return res.status(404).json({ error: 'Financial year not found' });

    const ledgers = await loadLedgers(req.user.company_id, fy_id);
    if (!ledgers.length) return res.status(404).json({ error: 'No Trial Balance data found.' });

    const params = parsePeriodParams(req.query);
    const result = engine.computeCashFlow(ledgers, params);

    res.json({
      financial_year: fy,
      period_label:   engine.resolvePeriod(params).label,
      method:         'Indirect',
      ind_as:         'IND AS 7',
      ...result,
      generated_at:   new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────
//  KEY FINANCIAL RATIOS
//  GET /reports/ratios?fy_id=
// ─────────────────────────────────────────────
router.get('/ratios',   authenticate, [qv('fy_id').isUUID(), validate], async (req, res, next) => {
  try {
    const { fy_id } = req.query;
    if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

    const fy = await getFY(req.user.company_id, fy_id);
    if (!fy) return res.status(404).json({ error: 'Financial year not found' });

    const ledgers = await loadLedgers(req.user.company_id, fy_id);
    if (!ledgers.length) return res.status(404).json({ error: 'No Trial Balance data found.' });

    const params = parsePeriodParams(req.query);
    const result = engine.computeRatios(ledgers, params);

    res.json({
      financial_year: fy,
      period_label:   engine.resolvePeriod(params).label,
      ...result,
      benchmarks: {
        current_ratio:  '> 1.5x',
        quick_ratio:    '> 1.0x',
        gross_margin:   '> 45%',
        ebitda_margin:  '> 10%',
        net_margin:     '> 8%',
        roe:            '> 15%',
        roce:           '> 15%',
        debt_equity:    '< 1.0x',
        interest_cover: '> 3.0x',
        dso:            '< 60 days',
        dpo:            '30–45 days',
      },
      generated_at: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────
//  CONSOLIDATED — all reports in one call
//  GET /reports/all?fy_id=
// ─────────────────────────────────────────────
router.get('/all', authenticate, async (req, res, next) => {
  try {
    const { fy_id } = req.query;
    if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

    const fy = await getFY(req.user.company_id, fy_id);
    if (!fy) return res.status(404).json({ error: 'Financial year not found' });

    const ledgers = await loadLedgers(req.user.company_id, fy_id);
    if (!ledgers.length) return res.status(404).json({ error: 'No Trial Balance data found.' });

    const params = parsePeriodParams(req.query);

    const [mis, bs, pl, notes, treasury, cashflow, ratios] = await Promise.all([
      engine.computeMIS(ledgers, params),
      engine.computeBS(ledgers, params),
      engine.computePL(ledgers, params),
      engine.computeNotes(ledgers, params),
      engine.computeTreasury(ledgers, params),
      engine.computeCashFlow(ledgers, params),
      engine.computeRatios(ledgers, params),
    ]);

    res.json({
      financial_year: fy,
      period_params:  params,
      period_label:   engine.resolvePeriod(params).label,
      mis, bs, pl,
      notes:          Object.values(notes).sort((a,b)=>a.note_no-b.note_no),
      treasury, cashflow, ratios,
      generated_at:   new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────
//  3-YEAR COMPARATIVE
//  GET /reports/threeyear?fy_ids=id1,id2,id3&year_type=FY
// ─────────────────────────────────────────────
router.get('/threeyear', authenticate, [
  qv('fy_ids').notEmpty().withMessage('fy_ids (comma-separated UUIDs) required'),
  qv('year_type').optional().isIn(['FY','CY']),
  validate,
], async (req, res, next) => {
  try {
    const fyIds = (req.query.fy_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (fyIds.length < 2 || fyIds.length > 3)
      return res.status(400).json({ error: 'Provide 2 or 3 fy_ids for comparison' });

    // Verify all FYs belong to this company
    const { rows: fys } = await db.query(
      `SELECT * FROM financial_years WHERE id = ANY($1) AND company_id = $2 ORDER BY start_date`,
      [fyIds, req.user.company_id]
    );
    if (fys.length !== fyIds.length)
      return res.status(404).json({ error: 'One or more financial years not found' });

    const yearType = req.query.year_type || 'FY';
    const results = [];

    for (const fy of fys) {
      const ledgers = await loadLedgers(req.user.company_id, fy.id);
      if (!ledgers.length) {
        results.push({ financial_year: fy, no_data: true });
        continue;
      }
      const params = { periodType: 'annual', period: null, yearType };
      const [mis, pl, treasury, ratios] = await Promise.all([
        engine.computeMIS(ledgers, params),
        engine.computePL(ledgers, params),
        engine.computeTreasury(ledgers, params),
        engine.computeRatios(ledgers, params),
      ]);
      results.push({ financial_year: fy, mis: mis.totals, pl, treasury: { total: treasury.total, cash: treasury.total_cash_and_bank, fd: treasury.total_fd, mf: treasury.total_mf }, ratios });
    }

    // Compute YoY growth rates
    const withGrowth = results.map((r, i) => {
      if (i === 0 || !results[i-1].mis || !r.mis) return r;
      const prev = results[i-1].mis;
      return {
        ...r,
        yoy: {
          revenue_growth: prev.rev > 0 ? +((r.mis.rev - prev.rev) / prev.rev * 100).toFixed(1) : null,
          ebitda_growth:  prev.pbt > 0 ? +((r.mis.pbt - prev.pbt) / prev.pbt * 100).toFixed(1) : null,
          pat_growth:     prev.pat > 0 ? +((r.mis.pat - prev.pat) / prev.pat * 100).toFixed(1) : null,
        },
      };
    });

    // CAGR (if 3 years)
    let cagr = null;
    if (results.length === 3 && results[0].mis && results[2].mis) {
      const r0 = results[0].mis.rev, r2 = results[2].mis.rev;
      const p0 = results[0].mis.pat, p2 = results[2].mis.pat;
      cagr = {
        revenue: r0 > 0 ? +((Math.pow(r2/r0, 0.5) - 1) * 100).toFixed(1) : null,
        pat:     p0 > 0 ? +((Math.pow(p2/p0, 0.5) - 1) * 100).toFixed(1) : null,
      };
    }

    res.json({ years: withGrowth, cagr, generated_at: new Date().toISOString() });
  } catch (err) { next(err); }
});

module.exports = router;
