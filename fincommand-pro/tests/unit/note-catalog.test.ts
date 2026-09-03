import { NOTE_CATALOG, findNoteCatalogEntry, isBSSection } from '@/lib/financial/note-catalog';

describe('NOTE_CATALOG', () => {
  test('has no duplicate (note_no, section) combinations', () => {
    // A duplicate would make findNoteCatalogEntry() non-deterministic and
    // silently pick whichever entry happens to come first — this is the
    // server-side source of truth for what a drag-and-drop reclassification
    // is allowed to write into real financial data, so it must be exact.
    const seen = new Set<string>();
    const dupes: string[] = [];
    NOTE_CATALOG.forEach(n => {
      const key = `${n.note_no}_${n.section}`;
      if (seen.has(key)) dupes.push(key);
      seen.add(key);
    });
    expect(dupes).toEqual([]);
  });

  test('deliberately covers the one real note_no collision — Note 20 means Revenue (P&L) vs Bank Balances/FDs (Balance Sheet)', () => {
    const bsNote20 = findNoteCatalogEntry(20, 'ac');
    const plNote20 = findNoteCatalogEntry(20, 'inc');
    expect(bsNote20?.note_name).toBe('Bank Balances (FDs)');
    expect(bsNote20?.treasuryType).toBe('fd');
    expect(plNote20?.note_name).toBe('Revenue from Operations');
    expect(plNote20?.treasuryType).toBeNull();
  });

  test('findNoteCatalogEntry returns undefined for a genuinely invalid note — the reclassify API route must reject these, not fabricate one', () => {
    expect(findNoteCatalogEntry(999, 'ac')).toBeUndefined();
    expect(findNoteCatalogEntry(1, 'exp')).toBeUndefined(); // Note 1 (Share Capital) is only ever an equity note
  });

  test('every section value is one computeBS()/computePL() actually groups by', () => {
    const validSections = new Set(['anc', 'ac', 'eq', 'lnc', 'lc', 'inc', 'exp']);
    NOTE_CATALOG.forEach(n => expect(validSections.has(n.section)).toBe(true));
  });

  test('isBSSection matches the same BS-vs-P&L split Notes to Accounts and the reclassify route both rely on', () => {
    expect(isBSSection('eq')).toBe(true);
    expect(isBSSection('anc')).toBe(true);
    expect(isBSSection('ac')).toBe(true);
    expect(isBSSection('lnc')).toBe(true);
    expect(isBSSection('lc')).toBe(true);
    expect(isBSSection('inc')).toBe(false);
    expect(isBSSection('exp')).toBe(false);
  });
});
