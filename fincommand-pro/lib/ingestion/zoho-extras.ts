import { query, withTransaction } from '@/lib/db/neon';
import type { CommentRow, ExtrasKind, ExtrasStore } from '@/lib/services/zoho/extras';
import { saveSnapshot } from './zoho-records';

/**
 * Database side of the Zoho "extras" read (comments, attached files, bank statements; migration 0016).
 * Every save is idempotent: comments and files are keyed so a re-read adds only what is new.
 */

const MAX_FAILED_ATTEMPTS = 3;

export const pgExtrasStore: ExtrasStore = {
  async needing(companyId, kind, module, limit) {
    const { rows } = await query<{ zoho_id: string }>(
      `SELECT r.zoho_id
         FROM zoho_records r
         LEFT JOIN zoho_extras_state s
                ON s.company_id = r.company_id AND s.kind = $2 AND s.module = r.module AND s.zoho_id = r.zoho_id
        WHERE r.company_id = $1 AND r.module = $3 AND r.deleted_at IS NULL
          AND ($2 <> 'attachment' OR (r.payload->>'has_attachment') = 'true')
          AND (
               s.zoho_id IS NULL
            OR (s.status = 'done' AND r.zoho_modified_at IS NOT NULL AND r.zoho_modified_at > s.updated_at)
            OR (s.status = 'failed' AND s.attempts < $5 AND s.updated_at < NOW() - INTERVAL '1 hour')
          )
        ORDER BY r.doc_date DESC NULLS LAST, r.zoho_id
        LIMIT $4`,
      [companyId, kind, module, limit, MAX_FAILED_ATTEMPTS]
    );
    return rows.map((r) => r.zoho_id);
  },

  async saveComments(companyId, module, zohoId, rows: CommentRow[]) {
    return withTransaction(async (c) => {
      let added = 0;
      for (const r of rows) {
        const res = await c.query(
          `INSERT INTO zoho_record_comments (company_id, module, zoho_id, comment_id, commented_by, commented_at, comment_type, description, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
           ON CONFLICT (company_id, module, zoho_id, comment_id) DO NOTHING`,
          [companyId, module, zohoId, r.commentId, r.commentedBy, r.commentedAt, r.commentType, r.description, JSON.stringify(r.payload)]
        );
        added += res.rowCount ?? 0;
      }
      await markDoneOn(c, companyId, 'comments', module, zohoId);
      return added;
    });
  },

  async saveAttachment(companyId, module, zohoId, file) {
    return withTransaction(async (c) => {
      const res = await c.query(
        `INSERT INTO zoho_attachments (company_id, module, zoho_id, sha256, file_name, content_type, size_bytes, content)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (company_id, module, zoho_id, sha256) DO NOTHING`,
        [companyId, module, zohoId, file.sha256, file.fileName?.slice(0, 400) ?? null, file.contentType?.slice(0, 160) ?? null, file.bytes.length, file.bytes]
      );
      await markDoneOn(c, companyId, 'attachment', module, zohoId);
      return (res.rowCount ?? 0) > 0 ? 'stored' : 'duplicate';
    });
  },

  async markDone(companyId, kind, module, zohoId) {
    await withTransaction((c) => markDoneOn(c, companyId, kind, module, zohoId));
  },

  async markFailure(companyId, kind, module, zohoId, message) {
    await query(
      `INSERT INTO zoho_extras_state (company_id, kind, module, zoho_id, status, attempts, last_error, updated_at)
       VALUES ($1,$2,$3,$4,'failed',1,$5,NOW())
       ON CONFLICT (company_id, kind, module, zoho_id) DO UPDATE SET
         status = 'failed', attempts = zoho_extras_state.attempts + 1, last_error = EXCLUDED.last_error, updated_at = NOW()`,
      [companyId, kind, module, zohoId, message.slice(0, 500)]
    );
  },

  async accountsNeedingStatement(companyId, olderThanMs) {
    const { rows } = await query<{ zoho_id: string }>(
      `SELECT r.zoho_id FROM zoho_records r
        WHERE r.company_id = $1 AND r.module = 'bankaccounts' AND r.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM zoho_report_snapshots s
                           WHERE s.company_id = r.company_id AND s.report = 'bankstatement:' || r.zoho_id
                             AND s.last_seen_at > NOW() - ($2 || ' milliseconds')::interval)
        ORDER BY r.zoho_id`,
      [companyId, String(Math.floor(olderThanMs))]
    );
    return rows.map((r) => r.zoho_id);
  },

  async saveStatement(companyId, accountId, payload) {
    // Same snapshot store as the Zoho reports. The period is a fixed placeholder, so an unchanged statement only
    // moves its "seen" time instead of adding a row every day; a changed one is a new row.
    await saveSnapshot({ companyId, report: `bankstatement:${accountId}`, periodFrom: null, periodTo: '1970-01-01', payload });
  },
};

async function markDoneOn(c: { query: (sql: string, params: unknown[]) => Promise<unknown> }, companyId: string, kind: ExtrasKind, module: string, zohoId: string) {
  await c.query(
    `INSERT INTO zoho_extras_state (company_id, kind, module, zoho_id, status, attempts, updated_at)
     VALUES ($1,$2,$3,$4,'done',0,NOW())
     ON CONFLICT (company_id, kind, module, zoho_id) DO UPDATE SET status = 'done', updated_at = NOW()`,
    [companyId, kind, module, zohoId]
  );
}
