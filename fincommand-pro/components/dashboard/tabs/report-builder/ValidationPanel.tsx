'use client';

import type { ValidationResult } from '@/lib/financial/report-builder-engine';

export function ValidationPanel({ result }: { result: ValidationResult }) {
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
        {result.issues.map((issue, i) => (
          <div
            key={`${issue.code}-${i}`}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 14px',
              borderBottom: '1px solid var(--border)', fontSize: 12,
            }}
          >
            <span style={{ marginTop: 1 }}>{issue.severity === 'error' ? '🛑' : '⚠️'}</span>
            <div>
              <div style={{ fontWeight: 600 }}>{issue.title}</div>
              <div style={{ color: 'var(--text2)', fontSize: 11 }}>{issue.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
