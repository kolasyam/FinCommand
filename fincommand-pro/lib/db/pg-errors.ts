/**
 * True only when Postgres says a TABLE is missing (SQLSTATE 42P01 undefined_table) — what the
 * "table not created yet" fallbacks are meant for. Matching on the message text ("does not exist")
 * also swallowed a missing column, a missing function or a misspelt name, hiding real bugs as empty lists.
 */
export function isUndefinedTable(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '42P01';
}
