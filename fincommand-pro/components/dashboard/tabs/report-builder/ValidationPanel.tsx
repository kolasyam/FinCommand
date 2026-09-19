'use client';

import type { ValidationResult } from '@/lib/financial/report-builder-engine';

export function ValidationPanel({
  result, onIssueClick,
}: {
  result: ValidationResult;
  /** Jumps the Structure Editor to the offending line(s) — omitted (or an issue with no lineIds, e.g. no_subtotal/no_percent_base) leaves the row non-interactive. */
  onIssueClick?: (lineIds: string[]) => void;
}) {
  if (result.issues.length === 0) {
    return (
      <div className="success-bar" style={{ marginBottom: 12 }}>
        ✓ All checks passed — mappings, signs and subtotals look consistent.
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-hdr">
        <span className="ct">Validation</span>
        {result.errors.length > 0 && <span className="pill pr">{result.errors.length} blocking</span>}
        {result.warnings.length > 0 && (
          <span className="pill pa">{result.warnings.length} warning{result.warnings.length > 1 ? 's' : ''}</span>
        )}
      </div>
      <div>
        {result.issues.map((issue, i) => {
          const clickable = !!onIssueClick && issue.lineIds.length > 0;
          return (
            <div
              key={`${issue.code}-${i}`}
              onClick={clickable ? () => onIssueClick!(issue.lineIds) : undefined}
              title={clickable ? 'Jump to the affected line' : undefined}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 14px',
                borderBottom: '1px solid var(--border)', fontSize: 12,
                cursor: clickable ? 'pointer' : 'default',
              }}
            >
              <span style={{ marginTop: 1 }}>{issue.severity === 'error' ? '🛑' : '⚠️'}</span>
              <div>
                <div style={{ fontWeight: 600 }}>{issue.title}{clickable && <span style={{ marginLeft: 6, fontWeight: 400, color: 'var(--blue)' }}>→ jump to line</span>}</div>
                <div style={{ color: 'var(--text2)', fontSize: 11 }}>{issue.detail}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
