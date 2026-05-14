'use strict';
const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const XLSX    = require('xlsx');
const { v4: uuid } = require('uuid');
const { query: qv, validationResult } = require('express-validator');
const db      = require('../db/connection');
const { authenticate, canWrite } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

// ── Validation helpers ──
const validateFyId = qv('financial_year_id').optional().isUUID().withMessage('financial_year_id must be a UUID');
const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
};

// ── Multer setup ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = process.env.UPLOAD_DIR || './uploads';
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) =>
    cb(null, `tb_${req.user.company_id}_${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE_MB || '50') * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.includes('spreadsheet') || file.originalname.match(/\.(xlsx|xls)$/i))
      cb(null, true);
    else cb(new Error('Only .xlsx and .xls files allowed'));
  },
});

const FY_MONTHS = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];

// ── GET /tb — list uploads ──
router.get('/', authenticate, [
  qv('limit').optional().isInt({min:1,max:100}).toInt(),
  qv('offset').optional().isInt({min:0}).toInt(),
  handleValidation,
], async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT t.*, fy.label AS fy_label, u.name AS uploaded_by_name
       FROM tb_uploads t
       JOIN financial_years fy ON fy.id = t.financial_year_id
       JOIN users u ON u.id = t.uploaded_by
       WHERE t.company_id = $1
       ORDER BY t.uploaded_at DESC LIMIT 50`,
      [req.user.company_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /tb/upload — upload TB Excel ──
router.post('/upload', authenticate, canWrite,
  upload.single('trial_balance'),
  audit('TB_UPLOAD', 'tb_upload'),
  async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { financial_year_id } = req.body;
  if (!financial_year_id) return res.status(400).json({ error: 'financial_year_id required' });

  // Verify FY belongs to company
  const { rows: fyRows } = await db.query(
    `SELECT * FROM financial_years WHERE id=$1 AND company_id=$2`,
    [financial_year_id, req.user.company_id]
  );
  if (!fyRows.length) return res.status(404).json({ error: 'Financial year not found' });
  if (fyRows[0].is_locked) return res.status(403).json({ error: 'This financial year is locked (post-audit)' });

  const uploadId = uuid();
  let wb;
  try {
    wb = XLSX.readFile(req.file.path);
  } catch (e) {
    return res.status(422).json({ error: 'Cannot read Excel file: ' + e.message });
  }

  if (!wb.SheetNames.includes('Trial_Balance'))
    return res.status(422).json({ error: 'Sheet "Trial_Balance" not found. Use the downloaded template.' });

  const tbRaw = XLSX.utils.sheet_to_json(wb.Sheets['Trial_Balance'], { header: 1 });
  const hdr   = tbRaw[0] || [];

  // Detect column indices
  const fi = (...needles) => {
    for (const n of needles) {
      const i = hdr.findIndex(h => String(h||'').toLowerCase().replace(/[_\s-]/g,'').includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  const ci = {
    code:  fi('ledgercode','ledger_code','code'),
    name:  fi('ledgername','ledger_name','name','account'),
    op_dr: fi('openingdr','opening_dr','opdr'),
    op_cr: fi('openingcr','opening_cr','opcr'),
  };
  if (ci.name < 0) return res.status(422).json({ error: 'Ledger_Name column not found. Use template.' });
  if (ci.op_dr < 0 || ci.op_cr < 0) return res.status(422).json({ error: 'Opening_Dr / Opening_Cr columns not found. Use template.' });

  const monthCols = FY_MONTHS.map(m => ({
    dr: fi(`${m.toLowerCase()}dr`, `${m}_dr`),
    cr: fi(`${m.toLowerCase()}cr`, `${m}_cr`),
  }));
  const hasMonthlyCols = monthCols.every(mc => mc.dr >= 0 && mc.cr >= 0);

  // Load Ledger Master (company-specific first, then global)
  const { rows: lmRows } = await db.query(
    `SELECT * FROM ledger_master
     WHERE (company_id=$1 OR company_id IS NULL) AND is_active=TRUE
     ORDER BY company_id NULLS LAST`,
    [req.user.company_id]
  );
  const lmByCode = new Map(lmRows.map(r => [r.ledger_code, r]));
  const lmByName = new Map(lmRows.map(r => [r.ledger_name.toLowerCase(), r]));

  // Parse rows
  const rows = []; let mapped = 0; const unmatched = [];
  tbRaw.slice(1).forEach(r => {
    if (!r[ci.name]) return;
    const name = String(r[ci.name]).trim();
    const code = ci.code >= 0 ? String(r[ci.code]||'').trim() : '';
    const lm   = lmByCode.get(code) || lmByName.get(name.toLowerCase());
    if (lm) mapped++; else if (name) unmatched.push(name);

    const row = {
      code, name,
      op_dr: parseFloat(r[ci.op_dr])||0,
      op_cr: parseFloat(r[ci.op_cr])||0,
      note_no:      lm?.note_no  || null,
      note_name:    lm?.note_name|| null,
      section:      lm?.section  || null,
      treasury_type:lm?.treasury_type || null,
      normal_bal:   lm?.normal_bal || 'Dr',
    };
    monthCols.forEach((mc, mi) => {
      const monthNum = mi + 1;
      row[`m${monthNum}_dr`] = mc.dr >= 0 ? (parseFloat(r[mc.dr])||0) : 0;
      row[`m${monthNum}_cr`] = mc.cr >= 0 ? (parseFloat(r[mc.cr])||0) : 0;
    });
    rows.push(row);
  });

  const coverage = rows.length > 0 ? Math.round(mapped / rows.length * 100) : 0;

  await db.withTransaction(async (client) => {
    // Mark previous uploads as superseded
    await client.query(
      `UPDATE tb_uploads SET is_current=FALSE, status='superseded'
       WHERE company_id=$1 AND financial_year_id=$2 AND is_current=TRUE`,
      [req.user.company_id, financial_year_id]
    );

    // Create upload record
    await client.query(
      `INSERT INTO tb_uploads
         (id, company_id, financial_year_id, uploaded_by, source, filename,
          file_size_kb, ledger_count, mapped_count, unmatched_count,
          unmatched_ledgers, coverage_pct, has_monthly_cols, status, is_current)
       VALUES ($1,$2,$3,$4,'excel',$5,$6,$7,$8,$9,$10,$11,$12,'complete',TRUE)`,
      [uploadId, req.user.company_id, financial_year_id, req.user.id,
       req.file.originalname, Math.round(req.file.size/1024),
       rows.length, mapped, unmatched.length, JSON.stringify(unmatched.slice(0,50)),
       coverage, hasMonthlyCols]
    );

    // Bulk insert ledgers
    for (const row of rows) {
      await client.query(`
        INSERT INTO tb_ledgers
          (upload_id, company_id, financial_year_id, ledger_code, ledger_name,
           note_no, note_name, section, treasury_type, normal_bal,
           op_dr, op_cr,
           m1_dr,m1_cr, m2_dr,m2_cr, m3_dr,m3_cr, m4_dr,m4_cr,
           m5_dr,m5_cr, m6_dr,m6_cr, m7_dr,m7_cr, m8_dr,m8_cr,
           m9_dr,m9_cr, m10_dr,m10_cr, m11_dr,m11_cr, m12_dr,m12_cr)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                $13,$14,$15,$16,$17,$18,$19,$20,
                $21,$22,$23,$24,$25,$26,$27,$28,
                $29,$30,$31,$32,$33,$34,$35,$36)`,
        [uploadId, req.user.company_id, financial_year_id,
         row.code||null, row.name,
         row.note_no, row.note_name, row.section, row.treasury_type, row.normal_bal,
         row.op_dr, row.op_cr,
         row.m1_dr,row.m1_cr, row.m2_dr,row.m2_cr, row.m3_dr,row.m3_cr,
         row.m4_dr,row.m4_cr, row.m5_dr,row.m5_cr, row.m6_dr,row.m6_cr,
         row.m7_dr,row.m7_cr, row.m8_dr,row.m8_cr, row.m9_dr,row.m9_cr,
         row.m10_dr,row.m10_cr, row.m11_dr,row.m11_cr, row.m12_dr,row.m12_cr]
      );
    }
  });

  // Clean up temp file
  fs.unlink(req.file.path, () => {});

  res.status(201).json({
    upload_id:        uploadId,
    ledger_count:     rows.length,
    mapped_count:     mapped,
    unmatched_count:  unmatched.length,
    coverage_pct:     coverage,
    has_monthly_cols: hasMonthlyCols,
    unmatched_sample: unmatched.slice(0, 10),
    message:          `Trial Balance uploaded. ${rows.length} ledgers processed, ${mapped} mapped (${coverage}% coverage).`,
  });
});

// ── GET /tb/:uploadId/ledgers — retrieve ledgers ──
router.get('/:uploadId/ledgers', authenticate, async (req, res, next) => {
  try {
    const { rows: upload } = await db.query(
      `SELECT * FROM tb_uploads WHERE id=$1 AND company_id=$2`,
      [req.params.uploadId, req.user.company_id]
    );
    if (!upload.length) return res.status(404).json({ error: 'Upload not found' });

    const { section, note_no, treasury_type } = req.query;
    let q = `SELECT * FROM tb_ledgers WHERE upload_id=$1`;
    const params = [req.params.uploadId];
    if (section)      { params.push(section);       q += ` AND section=$${params.length}`; }
    if (note_no)      { params.push(note_no);        q += ` AND note_no=$${params.length}`; }
    if (treasury_type){ params.push(treasury_type);  q += ` AND treasury_type=$${params.length}`; }
    q += ' ORDER BY ledger_name';

    const { rows } = await db.query(q, params);
    res.json({ upload: upload[0], ledgers: rows });
  } catch (err) { next(err); }
});

// ── GET /tb/current/:fyId — get current upload for FY ──
router.get('/current/:fyId', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT t.*, fy.label AS fy_label
       FROM tb_uploads t JOIN financial_years fy ON fy.id=t.financial_year_id
       WHERE t.company_id=$1 AND t.financial_year_id=$2 AND t.is_current=TRUE
       LIMIT 1`,
      [req.user.company_id, req.params.fyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No TB uploaded for this financial year' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /tb/:uploadId ──
router.delete('/:uploadId', authenticate, canWrite, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `DELETE FROM tb_uploads WHERE id=$1 AND company_id=$2 AND is_current=FALSE RETURNING id`,
      [req.params.uploadId, req.user.company_id]
    );
    if (!rows.length)
      return res.status(404).json({ error: 'Upload not found or is the current active upload' });
    res.json({ message: 'Upload deleted', id: req.params.uploadId });
  } catch (err) { next(err); }
});

module.exports = router;
