const mockQuery = jest.fn();
jest.mock('@/lib/db/neon', () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

import axios from 'axios';
import { callZoho, isTransientRefreshRefusal, refreshZohoTokenSingleFlight, type ZohoConfigRow } from '@/lib/services/zoho/client';
import { unflushedCalls } from '@/lib/services/zoho/usage';

const cfgFor = (id: string): ZohoConfigRow => ({
  company_id: id, org_id: 'org1', access_token: 'tok', refresh_token: 'ref', data_center: 'IN',
  token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
});
const axiosErr = (status: number, code?: number) =>
  Object.assign(new Error('request failed'), { response: { status, data: { code, message: 'Zoho said no' } } });

beforeEach(() => { mockQuery.mockReset(); jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

describe('a refused token refresh does not disconnect a healthy connection', () => {
  const deactivations = () => mockQuery.mock.calls.filter((c) => /is_active=FALSE/.test(String(c[0])));

  test('what counts as a rate-limit refusal', () => {
    expect(isTransientRefreshRefusal({ error: 'Access Denied', error_description: 'You have made too many requests continuously. Please try again after some time.' })).toBe(true);
    expect(isTransientRefreshRefusal({ error: 'invalid_code' })).toBe(false);
    expect(isTransientRefreshRefusal({ error: 'invalid_client' })).toBe(false);
    expect(isTransientRefreshRefusal(undefined)).toBe(false);
  });

  test('refused twice for volume: the error is raised, the connection is kept', async () => {
    jest.useFakeTimers();
    jest.spyOn(axios, 'post').mockResolvedValue({ data: { error: 'Access Denied', error_description: 'You have made too many requests continuously. Please try again after some time.' } });
    const p = refreshZohoTokenSingleFlight(cfgFor('refresh-a')).catch((e) => e);
    await jest.advanceTimersByTimeAsync(3_000);
    const e = await p;
    expect(String(e.message)).toMatch(/refused the token refresh for now/);
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(deactivations()).toHaveLength(0);
  });

  test('refused twice because the token itself is rejected: the connection is deactivated, as before', async () => {
    jest.useFakeTimers();
    mockQuery.mockResolvedValue({ rows: [] });
    jest.spyOn(axios, 'post').mockResolvedValue({ data: { error: 'invalid_code' } });
    const p = refreshZohoTokenSingleFlight(cfgFor('refresh-b')).catch((e) => e);
    await jest.advanceTimersByTimeAsync(3_000);
    const e = await p;
    expect(String(e.message)).toMatch(/no longer valid/);
    expect(deactivations()).toHaveLength(1);
    expect(deactivations()[0]![1][1]).toBe('refresh-b');
  });

  test('a first refusal followed by success just works', async () => {
    jest.useFakeTimers();
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    mockQuery.mockResolvedValue({ rows: [] });
    jest.spyOn(axios, 'post')
      .mockResolvedValueOnce({ data: { error: 'Access Denied' } })
      .mockResolvedValueOnce({ data: { access_token: 'fresh', expires_in: 3600 } });
    const cfg = cfgFor('refresh-c');
    const p = refreshZohoTokenSingleFlight(cfg);
    await jest.advanceTimersByTimeAsync(3_000);
    await expect(p).resolves.toBe('fresh');
    expect(deactivations()).toHaveLength(0);
    expect(cfg.access_token).toBe('fresh');
  });
});

describe('callZoho counts every request against the day\'s Zoho quota', () => {
  test('one count per request', async () => {
    const id = 'count-a';
    const before = unflushedCalls(id);
    await callZoho(id, async () => 'ok', 2, cfgFor(id));
    await callZoho(id, async () => 'ok', 2, cfgFor(id));
    expect(unflushedCalls(id) - before).toBe(2);
  });

  test('a failed request counts too: Zoho counted it', async () => {
    const id = 'count-b';
    await expect(callZoho(id, async () => { throw axiosErr(500); }, 2, cfgFor(id))).rejects.toThrow();
    expect(unflushedCalls(id)).toBe(1);
  });
});

describe('Zoho\'s daily limit (code 45) is final', () => {
  test('it is thrown at once, without the retries a per-minute limit gets', async () => {
    const id = 'daily-a';
    const fn = jest.fn(async () => { throw axiosErr(429, 45); });
    await expect(callZoho(id, fn, 2, cfgFor(id))).rejects.toMatchObject({ status: 429, zohoCode: 45 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(unflushedCalls(id)).toBe(1);
  });

  test('a plain per-minute 429 (code 44) is retried after a pause, then given up on', async () => {
    jest.useFakeTimers();
    const id = 'minute-a';
    const fn = jest.fn(async () => { throw axiosErr(429, 44); });
    const p = callZoho(id, fn, 1, cfgFor(id)).catch((e) => e);
    await jest.advanceTimersByTimeAsync(5_000);
    const e = await p;
    expect(fn).toHaveBeenCalledTimes(2);
    expect(e).toMatchObject({ status: 429, zohoCode: 44 });
    expect(unflushedCalls(id)).toBe(2);
  });

  test('code 43 is retried too, and a retry that works returns its result', async () => {
    jest.useFakeTimers();
    const id = 'minute-b';
    let n = 0;
    const fn = jest.fn(async () => { if (++n === 1) throw axiosErr(400, 43); return 'fine'; });
    const p = callZoho(id, fn, 2, cfgFor(id));
    await jest.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBe('fine');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('any other error is thrown at once and carries the Zoho code', async () => {
    const id = 'other-a';
    const fn = jest.fn(async () => { throw axiosErr(404, 5); });
    await expect(callZoho(id, fn, 2, cfgFor(id))).rejects.toMatchObject({ status: 404, zohoCode: 5 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
