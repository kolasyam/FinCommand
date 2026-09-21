import { assertCompanyId, isCompanyId, currentCompanyId, runAsCompany, runAsSystem } from '@/lib/db/tenant-context';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tick = () => new Promise((r) => setTimeout(r, 1));

describe('company ids that become SQL text', () => {
  test('a UUID is accepted and lower-cased', () => {
    expect(assertCompanyId(A.toUpperCase())).toBe(A);
    expect(isCompanyId(A)).toBe(true);
  });

  test.each([
    '', 'c1', 'not-a-uuid', `${A}'; DROP TABLE users; --`, `${A} `, ` ${A}`, `${A}\n`, '00000000-0000-0000-0000-00000000000g',
  ])('%j is refused', (bad) => {
    expect(() => assertCompanyId(bad)).toThrow(/Invalid company id/);
    expect(isCompanyId(bad)).toBe(false);
  });

  test('non-strings are refused', () => {
    expect(isCompanyId(undefined)).toBe(false);
    expect(isCompanyId(null)).toBe(false);
    expect(isCompanyId(42)).toBe(false);
  });
});

describe('the company follows the work', () => {
  test('outside any context there is no company (system work)', () => {
    expect(currentCompanyId()).toBeNull();
  });

  test('it survives awaits, timers and Promise.all inside the scope, and is gone after it', async () => {
    const seen: Array<string | null> = [];
    await runAsCompany(A, async () => {
      seen.push(currentCompanyId());
      await tick();
      seen.push(currentCompanyId());
      await Promise.all([tick().then(() => seen.push(currentCompanyId())), Promise.resolve().then(() => seen.push(currentCompanyId()))]);
    });
    expect(seen).toEqual([A, A, A, A]);
    expect(currentCompanyId()).toBeNull();
  });

  test('two requests in flight at once never see each other\'s company', async () => {
    const trace: string[] = [];
    const work = (id: string, label: string) => runAsCompany(id, async () => {
      for (let i = 0; i < 5; i++) { await tick(); trace.push(`${label}:${currentCompanyId()}`); }
    });
    await Promise.all([work(A, 'a'), work(B, 'b'), work(A, 'a2')]);
    expect(trace.filter((t) => t.startsWith('a:')).every((t) => t.endsWith(A))).toBe(true);
    expect(trace.filter((t) => t.startsWith('b:')).every((t) => t.endsWith(B))).toBe(true);
    expect(trace.filter((t) => t.startsWith('a2:')).every((t) => t.endsWith(A))).toBe(true);
  });

  test('runAsSystem steps out of a company scope, and back', async () => {
    await runAsCompany(A, async () => {
      await runAsSystem(async () => { await tick(); expect(currentCompanyId()).toBeNull(); });
      expect(currentCompanyId()).toBe(A);
    });
  });

  test('a nested company replaces the outer one only inside its own scope', async () => {
    await runAsCompany(A, async () => {
      await runAsCompany(B, async () => { await tick(); expect(currentCompanyId()).toBe(B); });
      expect(currentCompanyId()).toBe(A);
    });
  });

  test('runAsCompany refuses an invalid id before running anything', () => {
    const fn = jest.fn(async () => 1);
    expect(() => runAsCompany('c1', fn)).toThrow(/Invalid company id/);
    expect(fn).not.toHaveBeenCalled();
  });

  test('errors thrown inside propagate and do not leave the scope behind', async () => {
    await expect(runAsCompany(A, async () => { await tick(); throw new Error('boom'); })).rejects.toThrow('boom');
    expect(currentCompanyId()).toBeNull();
  });
});
