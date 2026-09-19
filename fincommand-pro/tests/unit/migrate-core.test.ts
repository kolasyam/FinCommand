import {
  parseMigrationFilename, migrationChecksum, loadMigrationFiles, planMigrations, parseTarget, connectionConfigFor,
} from '@/db/migrate-core';

describe('migration runner — pure helpers', () => {
  test('filenames must be NNNN_snake_case.sql', () => {
    expect(parseMigrationFilename('0001_integrity.sql')).toEqual({ version: '0001', name: 'integrity' });
    expect(parseMigrationFilename('1_integrity.sql')).toBeNull();
    expect(parseMigrationFilename('0001-integrity.sql')).toBeNull();
    expect(parseMigrationFilename('0001_Integrity.sql')).toBeNull();
    expect(() => loadMigrationFiles([{ filename: '01_x.sql', sql: '' }])).toThrow(/Bad migration filename/);
  });

  test('files are ordered by version and non-.sql files are ignored', () => {
    const files = loadMigrationFiles([
      { filename: '0002_b.sql', sql: 'b' },
      { filename: 'README.md', sql: '' },
      { filename: '0000_a.sql', sql: 'a' },
      { filename: '0001_c.sql', sql: 'c' },
    ]);
    expect(files.map(f => f.version)).toEqual(['0000', '0001', '0002']);
  });

  test('a duplicate version is refused', () => {
    expect(() => loadMigrationFiles([
      { filename: '0001_a.sql', sql: 'a' },
      { filename: '0001_b.sql', sql: 'b' },
    ])).toThrow(/Duplicate migration version 0001/);
  });

  test('checksum ignores CRLF vs LF (git autocrlf) but not real edits', () => {
    expect(migrationChecksum('SELECT 1;\r\nSELECT 2;\r\n')).toBe(migrationChecksum('SELECT 1;\nSELECT 2;\n'));
    expect(migrationChecksum('SELECT 1;')).not.toBe(migrationChecksum('SELECT 2;'));
  });

  test('plan: pending = not yet applied; an edited applied file is reported, not re-run', () => {
    const files = loadMigrationFiles([
      { filename: '0000_base.sql', sql: 'SELECT 1;' },
      { filename: '0001_x.sql', sql: 'SELECT 2; -- edited' },
      { filename: '0002_y.sql', sql: 'SELECT 3;' },
    ]);
    const plan = planMigrations(files, [
      { version: '0000', name: 'base', checksum: migrationChecksum('SELECT 1;') },
      { version: '0001', name: 'x', checksum: migrationChecksum('SELECT 2;') },
      { version: '0009', name: 'gone', checksum: 'abc' },
    ]);
    expect(plan.pending.map(p => p.version)).toEqual(['0002']);
    expect(plan.changed).toEqual([{ version: '0001', filename: '0001_x.sql' }]);
    expect(plan.missing.map(m => m.version)).toEqual(['0009']);
  });

  test('re-running with everything applied is a no-op', () => {
    const files = loadMigrationFiles([{ filename: '0000_base.sql', sql: 'SELECT 1;' }]);
    const plan = planMigrations(files, [{ version: '0000', name: 'base', checksum: files[0].checksum }]);
    expect(plan).toEqual({ pending: [], changed: [], missing: [] });
  });

  test('--target has NO default — a dropped argument must never fall back to production', () => {
    expect(() => parseTarget([])).toThrow(/no default/i);
    expect(() => parseTarget(['--dry-run'])).toThrow(/no default/i);
    expect(parseTarget(['--target=branch'])).toBe('branch');
    expect(parseTarget(['--target=main'])).toBe('main');
    expect(() => parseTarget(['--target=prod'])).toThrow();
  });

  test('branch target requires BRANCH_DATABASE_URL; main falls back to DB_* vars', () => {
    expect(() => connectionConfigFor('branch', {} as NodeJS.ProcessEnv)).toThrow(/BRANCH_DATABASE_URL/);
    expect(connectionConfigFor('branch', { BRANCH_DATABASE_URL: 'postgres://b' } as NodeJS.ProcessEnv).connectionString).toBe('postgres://b');
    expect(connectionConfigFor('main', { DATABASE_URL: 'postgres://m' } as NodeJS.ProcessEnv).connectionString).toBe('postgres://m');
    const cfg = connectionConfigFor('main', { DB_HOST: 'h', DB_NAME: 'd' } as NodeJS.ProcessEnv);
    expect(cfg.connectionString).toBeUndefined();
    expect(cfg.host).toBe('h');
    expect(cfg.database).toBe('d');
  });
});
