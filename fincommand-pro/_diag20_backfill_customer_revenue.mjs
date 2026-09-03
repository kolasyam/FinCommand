// One-off backfill: parse the Sales-by-Customer raw responses already stored
// in tb_uploads.raw_zoho_months (from the sync that already ran, before the
// extractSalesByCustomer() field-name fix in lib/services/zoho.ts) and
// populate tb_customer_revenue — without hitting Zoho's API again.
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const FY_MONTH_ORDER = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];

// Mirrors the fixed extractSalesByCustomer() in lib/services/zoho.ts
function extractSalesByCustomer(rawResponse) {
  const data = rawResponse;
  if (!data) return [];
  const candidates = [
    data.sales, data.sales_by_customers, data.salesbycustomer, data.sales_by_customer, data.customers, data.customer_summary,
  ];
  const arr = candidates.find((c) => Array.isArray(c));
  if (!arr) return [];
  return arr
    .map((item) => {
      const name = String(item.customer_name ?? item.contact_name ?? item.name ?? '').trim();
      const idRaw = item.customer_id ?? item.contact_id ?? item.entity_id;
      const totalRaw = item.sales ?? item.total ?? item.invoiced_amount ?? item.sales_with_tax ?? item.amount ?? 0;
      const currency = item.currency_code ?? item.currency ?? undefined;
      return {
        customer_id: idRaw != null ? String(idRaw) : undefined,
        customer_name: name,
        total: parseFloat(String(totalRaw)) || 0,
        currency_code: currency != null ? String(currency).toUpperCase() : undefined,
      };
    })
    .filter((c) => c.customer_name);
}

async function main() {
  const client = await pool.connect();
  try {
    const { rows: uploads } = await client.query(`
      SELECT u.id AS upload_id, u.company_id, u.financial_year_id, u.raw_zoho_months, co.currency AS base_currency
      FROM tb_uploads u
      JOIN companies co ON co.id = u.company_id
      WHERE u.source = 'zoho' AND u.is_current = TRUE AND u.raw_zoho_months IS NOT NULL
    `);

    if (!uploads.length) {
      console.log('No current Zoho uploads with raw_zoho_months found — nothing to backfill.');
      return;
    }

    for (const upload of uploads) {
      const months = upload.raw_zoho_months || [];
      const custMonths = months.filter((m) => typeof m.month === 'string' && m.month.startsWith('Sales by Customer'));
      const baseCurrency = (upload.base_currency || 'INR').toUpperCase();

      console.log(`\nUpload ${upload.upload_id} (base currency ${baseCurrency}): ${custMonths.length} Sales-by-Customer month(s) in raw_zoho_months`);
      if (!custMonths.length) {
        console.log('  Nothing to backfill for this upload (re-sync from Zoho to fetch it).');
        continue;
      }

      const customerMap = new Map(); // key -> { customer_id, name, m: number[12] }
      let totalLeavesFound = 0;
      let skippedForeignCurrency = 0;
      const foreignSeen = new Set();

      for (const entry of custMonths) {
        const label = entry.month.replace('Sales by Customer', '').trim(); // e.g. "Apr"
        const mi = FY_MONTH_ORDER.indexOf(label);
        if (mi === -1) {
          console.log(`  ! Could not map month label "${label}" to an index — skipping.`);
          continue;
        }
        const leaves = extractSalesByCustomer(entry.raw_response);
        totalLeavesFound += leaves.length;
        for (const leaf of leaves) {
          if (leaf.currency_code && leaf.currency_code !== baseCurrency) {
            skippedForeignCurrency++;
            foreignSeen.add(`${leaf.customer_name} (${leaf.currency_code})`);
            continue;
          }
          if (!customerMap.has(leaf.customer_name)) {
            customerMap.set(leaf.customer_name, { customer_id: leaf.customer_id, name: leaf.customer_name, m: Array(12).fill(0) });
          }
          const rec = customerMap.get(leaf.customer_name);
          rec.m[mi] += leaf.total;
          if (leaf.customer_id && !rec.customer_id) rec.customer_id = leaf.customer_id;
        }
      }

      console.log(`  Parsed ${totalLeavesFound} customer-month leaf row(s) across ${custMonths.length} months -> ${customerMap.size} distinct ${baseCurrency} customer(s)`);
      if (skippedForeignCurrency > 0) {
        console.log(`  Skipped ${skippedForeignCurrency} row(s) in a non-${baseCurrency} currency (no conversion rate available): ${[...foreignSeen].join(', ')}`);
      }

      if (customerMap.size === 0) {
        console.log('  Still zero customers after re-parsing — the response shape may differ from zoho_debug_salesbycustomer.json. Not touching tb_customer_revenue.');
        continue;
      }

      await client.query('BEGIN');
      try {
        // Idempotent: clear any partial prior backfill for this upload before inserting fresh.
        await client.query('DELETE FROM tb_customer_revenue WHERE upload_id = $1', [upload.upload_id]);

        const rowsToInsert = Array.from(customerMap.values());
        const chunkSize = 50;
        for (let i = 0; i < rowsToInsert.length; i += chunkSize) {
          const chunk = rowsToInsert.slice(i, i + chunkSize);
          const values = [];
          const params = [];
          let p = 1;
          for (const c of chunk) {
            const rowVals = [upload.upload_id, upload.company_id, upload.financial_year_id, c.customer_id || null, c.name, ...c.m];
            values.push(`(${rowVals.map(() => `$${p++}`).join(',')})`);
            params.push(...rowVals);
          }
          await client.query(
            `INSERT INTO tb_customer_revenue
              (upload_id,company_id,financial_year_id,zoho_customer_id,customer_name,
               m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12)
             VALUES ${values.join(', ')}`,
            params
          );
        }
        await client.query('COMMIT');
        console.log(`  ✅ Inserted ${rowsToInsert.length} customer row(s) into tb_customer_revenue for upload ${upload.upload_id}`);

        // Show a quick top-5-by-annual-total preview
        const preview = rowsToInsert
          .map((c) => ({ customer: c.name, annual_total: c.m.reduce((s, v) => s + v, 0) }))
          .sort((a, b) => b.annual_total - a.annual_total)
          .slice(0, 5);
        console.log('  Top 5 preview (annual):', preview);
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('  ❌ Backfill insert failed, rolled back:', e.message);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main();
