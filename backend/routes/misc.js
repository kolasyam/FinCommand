'use strict';
const router = require('express').Router();
const db     = require('../db/connection');
const { authenticate, isAdmin, canWrite } = require('../middleware/auth');

// ══════════════════════════════════════════════
//  COMPANIES
// ══════════════════════════════════════════════
const companies = require('express').Router();

// GET /companies/me
companies.get('/me', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM companies WHERE id=$1', [req.user.company_id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /companies/me
companies.put('/me', authenticate, isAdmin, async (req, res, next) => {
  try {
    const { name, cin, pan, gstin, registered_address } = req.body;
    const { rows } = await db.query(
      `UPDATE companies SET name=COALESCE($1,name), cin=COALESCE($2,cin),
         pan=COALESCE($3,pan), gstin=COALESCE($4,gstin),
         registered_address=COALESCE($5,registered_address), updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [name, cin, pan, gstin, registered_address, req.user.company_id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// GET /companies/users
companies.get('/users', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, email, role, is_active, last_login, created_at
       FROM users WHERE company_id=$1 ORDER BY name`,
      [req.user.company_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /companies/users
companies.post('/users', authenticate, isAdmin, async (req, res, next) => {
  try {
    const bcrypt = require('bcryptjs');
    const { name, email, role, password } = req.body;
    if (!name || !email || !role || !password)
      return res.status(400).json({ error: 'name, email, role, password required' });
    const hash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS || '12'));
    const { rows } = await db.query(
      `INSERT INTO users (company_id,name,email,password_hash,role,email_verified)
       VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id,name,email,role,created_at`,
      [req.user.company_id, name, email, hash, role]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    next(err);
  }
});

// ══════════════════════════════════════════════
//  FINANCIAL YEARS
// ══════════════════════════════════════════════
const financialYears = require('express').Router();

// GET /fy
financialYears.get('/', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT fy.*, 
              (SELECT COUNT(*) FROM tb_uploads t WHERE t.financial_year_id=fy.id AND t.is_current=TRUE) AS has_tb
       FROM financial_years fy
       WHERE fy.company_id=$1 ORDER BY fy.start_date DESC`,
      [req.user.company_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /fy
financialYears.post('/', authenticate, canWrite, async (req, res, next) => {
  try {
    const { label, short_label, start_date, end_date, year_type = 'FY' } = req.body;
    if (!label || !start_date || !end_date)
      return res.status(400).json({ error: 'label, start_date, end_date required' });
    const { rows } = await db.query(
      `INSERT INTO financial_years (company_id,label,short_label,start_date,end_date,year_type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.company_id, label, short_label||label, start_date, end_date, year_type]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Financial year already exists' });
    next(err);
  }
});

// PUT /fy/:id/lock
financialYears.put('/:id/lock', authenticate, isAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE financial_years SET is_locked=TRUE, locked_by=$1, locked_at=NOW()
       WHERE id=$2 AND company_id=$3 RETURNING *`,
      [req.user.id, req.params.id, req.user.company_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'FY not found' });
    res.json({ message: 'Financial year locked', fy: rows[0] });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════
//  LEDGER MASTER
// ══════════════════════════════════════════════
const ledgerMaster = require('express').Router();

// GET /ledger-master
ledgerMaster.get('/', authenticate, async (req, res, next) => {
  try {
    const { section, note_no, search } = req.query;
    let q = `SELECT * FROM ledger_master WHERE (company_id=$1 OR company_id IS NULL) AND is_active=TRUE`;
    const params = [req.user.company_id];
    if (section)  { params.push(section);  q += ` AND section=$${params.length}`; }
    if (note_no)  { params.push(note_no);  q += ` AND note_no=$${params.length}`; }
    if (search)   { params.push(`%${search}%`); q += ` AND ledger_name ILIKE $${params.length}`; }
    q += ' ORDER BY note_no, ledger_name';
    const { rows } = await db.query(q, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /ledger-master — add custom mapping
ledgerMaster.post('/', authenticate, canWrite, async (req, res, next) => {
  try {
    const { ledger_code, ledger_name, note_no, note_name, section, treasury_type, normal_bal } = req.body;
    if (!ledger_name || !note_no || !section)
      return res.status(400).json({ error: 'ledger_name, note_no, section required' });
    const { rows } = await db.query(
      `INSERT INTO ledger_master
         (company_id,ledger_code,ledger_name,note_no,note_name,section,treasury_type,normal_bal,is_global,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,$9)
       ON CONFLICT DO NOTHING RETURNING *`,
      [req.user.company_id, ledger_code||null, ledger_name, note_no, note_name||null,
       section, treasury_type||null, normal_bal||'Dr', req.user.id]
    );
    res.status(201).json(rows[0] || { message: 'Already exists' });
  } catch (err) { next(err); }
});

// PUT /ledger-master/:id
ledgerMaster.put('/:id', authenticate, canWrite, async (req, res, next) => {
  try {
    const { note_no, note_name, section, treasury_type, normal_bal } = req.body;
    const { rows } = await db.query(
      `UPDATE ledger_master SET
         note_no=COALESCE($1,note_no), note_name=COALESCE($2,note_name),
         section=COALESCE($3,section), treasury_type=$4,
         normal_bal=COALESCE($5,normal_bal), updated_at=NOW()
       WHERE id=$6 AND company_id=$7 RETURNING *`,
      [note_no, note_name, section, treasury_type||null, normal_bal, req.params.id, req.user.company_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Mapping not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /ledger-master/:id
ledgerMaster.delete('/:id', authenticate, canWrite, async (req, res, next) => {
  try {
    await db.query(
      `UPDATE ledger_master SET is_active=FALSE WHERE id=$1 AND company_id=$2`,
      [req.params.id, req.user.company_id]
    );
    res.json({ message: 'Mapping deactivated' });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════
//  AUDIT TRAIL
// ══════════════════════════════════════════════
const auditRoutes = require('express').Router();

auditRoutes.get('/', authenticate, async (req, res, next) => {
  try {
    if (!['admin','cfo','auditor'].includes(req.user.role))
      return res.status(403).json({ error: 'Audit trail access requires admin, cfo, or auditor role' });

    const { action, user_id, from, to, limit = 100, offset = 0 } = req.query;
    let q = `SELECT a.*, u.name AS user_name_full
             FROM audit_trail a LEFT JOIN users u ON u.id=a.user_id
             WHERE a.company_id=$1`;
    const params = [req.user.company_id];
    if (action)  { params.push(action);  q += ` AND a.action=$${params.length}`; }
    if (user_id) { params.push(user_id); q += ` AND a.user_id=$${params.length}`; }
    if (from)    { params.push(from);    q += ` AND a.created_at >= $${params.length}`; }
    if (to)      { params.push(to);      q += ` AND a.created_at <= $${params.length}`; }
    q += ` ORDER BY a.created_at DESC LIMIT $${params.push(Math.min(+limit,500))} OFFSET $${params.push(+offset)}`;

    const { rows } = await db.query(q, params);
    const { rows: cnt } = await db.query(
      `SELECT COUNT(*) FROM audit_trail WHERE company_id=$1`, [req.user.company_id]
    );
    res.json({ total: parseInt(cnt[0].count), rows });
  } catch (err) { next(err); }
});

module.exports = { companies, financialYears, ledgerMaster, auditRoutes };
