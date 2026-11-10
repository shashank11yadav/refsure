import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', async () => ({ browser: (await import('wxt/testing/fake-browser')).fakeBrowser }));

import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { CheckResult, CheckSummary } from '../../../src/core/types';
import { CACHE_KEY, createCache } from '../../../src/engine/cache';
import { clearHistory, getHistoryEpoch, getLast, HISTORY_KEY, HISTORY_MAX_BYTES, HISTORY_MAX_PAPERS, saveSummary } from '../../../src/engine/history';
import { updateSettings } from '../../../src/engine/settings';

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

function summary(key: string, finishedAt = 5): CheckSummary {
  return {
    paper: { key, title: `Paper ${key}`, url: `https://arxiv.org/abs/${key}`, origin: 'arxiv-abs', viaPdf: false },
    counts: { verified: 1, details_differ: 0, wrong_id: 0, retracted: 0, not_found: 0, cant_check: 0 },
    total: 1,
    startedAt: 1,
    finishedAt,
    beta: false,
  };
}

const RESULT: CheckResult = { index: 1, label: '[1]', citedText: 'x', status: 'verified', reason: 'ok', diffs: [], notes: [], sourcesSearched: [], sourcesFailed: [], links: [] };
const results: CheckResult[] = [RESULT];

describe('history', () => {
  test('saves and returns the last check of a paper', async () => {
    await saveSummary(summary('a'), results);
    expect(await getLast('a')).toEqual({ summary: summary('a'), results });
    expect(await getLast('b')).toBeUndefined();
  });

  test('a newer check replaces the older one for the same paper', async () => {
    await saveSummary(summary('a', 5), results);
    await saveSummary(summary('a', 9), []);
    expect(await getLast('a')).toEqual({ summary: summary('a', 9), results: [] });
  });

  test('is a no-op when history is turned off', async () => {
    await updateSettings({ historyEnabled: false });
    await saveSummary(summary('a'), results);
    expect(await fakeBrowser.storage.local.get(HISTORY_KEY)).toEqual({});
    expect(await getLast('a')).toBeUndefined();
  });

  test('keeps at most the cap, dropping the oldest papers', async () => {
    for (let i = 0; i < HISTORY_MAX_PAPERS + 2; i++) await saveSummary(summary(`p${i}`, i), results);
    expect(await getLast('p0')).toBeUndefined();
    expect(await getLast('p1')).toBeUndefined();
    expect(await getLast('p2')).toBeDefined();
    expect(await getLast(`p${HISTORY_MAX_PAPERS + 1}`)).toBeDefined();
  });

  test('corrupt stored history reads as empty', async () => {
    await fakeBrowser.storage.local.set({ [HISTORY_KEY]: 'garbage' });
    expect(await getLast('a')).toBeUndefined();
    await saveSummary(summary('a'), results);
    expect(await getLast('a')).toBeDefined();
  });

  test('clearing history also clears the cache', async () => {
    await saveSummary(summary('a'), results);
    const cache = createCache(() => 0);
    await cache.set('k', { ...RESULT, status: 'verified' });
    await clearHistory();
    expect(await getLast('a')).toBeUndefined();
    expect(await cache.get('k')).toBeUndefined();
    expect(await fakeBrowser.storage.local.get([HISTORY_KEY, CACHE_KEY])).toEqual({});
  });

  test('is capped by serialised size, dropping the oldest papers and keeping the newest', async () => {
    expect(HISTORY_MAX_BYTES).toBe(3 * 1024 * 1024);
    const big: CheckResult[] = [{ ...RESULT, reason: 'r'.repeat(400_000) }];
    for (let i = 0; i < 12; i++) await saveSummary(summary(`p${i}`, i), big);
    expect(await getLast('p0')).toBeUndefined();
    expect(await getLast('p11')).toBeDefined();
    const raw = JSON.stringify((await fakeBrowser.storage.local.get(HISTORY_KEY))[HISTORY_KEY]);
    expect(raw.length).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
  });

  test('a single check too big to keep is skipped without failing', async () => {
    await saveSummary(summary('small'), results);
    await expect(saveSummary(summary('huge', 9), [{ ...RESULT, reason: 'r'.repeat(HISTORY_MAX_BYTES) }])).resolves.toBeUndefined();
    expect(await getLast('huge')).toBeUndefined();
    expect(await getLast('small')).toBeDefined();
  });

  test('on a quota error it evicts about a quarter of the oldest papers and retries once', async () => {
    for (let i = 0; i < 8; i++) await saveSummary(summary(`p${i}`, i), results);
    vi.spyOn(fakeBrowser.storage.local, 'set').mockImplementationOnce(() => Promise.reject(new Error('QUOTA_BYTES quota exceeded')));
    await saveSummary(summary('p8', 8), results);
    expect(await getLast('p0')).toBeUndefined();
    expect(await getLast('p1')).toBeUndefined();
    expect(await getLast('p2')).toBeUndefined();
    expect(await getLast('p3')).toBeDefined();
    expect(await getLast('p8')).toBeDefined();
  });

  test('gives up silently and logs nothing sensitive when the retry fails too', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(fakeBrowser.storage.local, 'set').mockImplementation(() => Promise.reject(new Error('QUOTA_BYTES quota exceeded')));
    await expect(saveSummary(summary('a'), results)).resolves.toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain('Paper a');
  });

  test('clearing removes history and cache even when one of them fails, then reports the failure', async () => {
    await saveSummary(summary('a'), results);
    const cache = createCache(() => 0);
    await cache.set('k', RESULT);
    await cache.flush();
    const real = fakeBrowser.storage.local.remove.bind(fakeBrowser.storage.local);
    vi.spyOn(fakeBrowser.storage.local, 'remove').mockImplementation((keys) => (JSON.stringify(keys).includes(CACHE_KEY) ? Promise.reject(new Error('boom')) : real(keys)));
    await expect(clearHistory()).rejects.toThrow('boom');
    expect(await fakeBrowser.storage.local.get(HISTORY_KEY)).toEqual({});
    expect(await cache.get('k')).toBeUndefined();
  });

  test('a save from a check that started before the clear does not bring history back', async () => {
    const epoch = getHistoryEpoch();
    await clearHistory();
    await saveSummary(summary('late'), results, epoch);
    expect(await getLast('late')).toBeUndefined();
    await saveSummary(summary('fresh'), results, getHistoryEpoch());
    expect(await getLast('fresh')).toBeDefined();
  });

  test('uses storage.local only', async () => {
    await saveSummary(summary('a'), results);
    expect(await fakeBrowser.storage.sync.get(null)).toEqual({});
  });
});
