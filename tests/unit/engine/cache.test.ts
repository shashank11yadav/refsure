import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', async () => ({ browser: (await import('wxt/testing/fake-browser')).fakeBrowser }));

import { fakeBrowser } from 'wxt/testing/fake-browser';
import { TTL } from '../../../src/config';
import type { CheckResult, ParsedCitation, Status } from '../../../src/core/types';
import { CACHE_FLUSH_MS, CACHE_KEY, CACHE_MAX_BYTES, CACHE_MAX_ENTRIES, cacheKey, clearAllCaches, createCache } from '../../../src/engine/cache';
import { updateSettings, getSettings } from '../../../src/engine/settings';
import { citation } from '../helpers/fixtures';

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

afterEach(() => vi.useRealTimers());

const QUOTA = (): Promise<never> => Promise.reject(new Error('QUOTA_BYTES quota exceeded'));

function result(status: Status, over: Partial<CheckResult> = {}): CheckResult {
  return { index: 7, label: '[7]', citedText: 'the full cited text', status, reason: 'because', diffs: [], notes: [], sourcesSearched: ['crossref'], sourcesFailed: [], links: [], ...over };
}

describe('cacheKey', () => {
  test('a DOI wins, lower-cased, and the cited title is part of the key', () => {
    const k = cacheKey(citation({ doi: '10.1000/ABC', arxivId: '1706.03762', title: 'Attention Is All You Need' }));
    expect(k).toMatch(/^doi:10\.1000\/abc\|/);
    expect(k).toContain('attention is all you need');
  });

  test('every identifier present is in the key, the arXiv ID without its version', () => {
    const k = cacheKey(citation({ doi: '10.1000/ABC', arxivId: '1706.03762v5', title: 'Attention Is All You Need', authors: ['vaswani'], year: 2017, raw: 'A. Vaswani. Attention Is All You Need. 2017.' }));
    expect(k).toBe('doi:10.1000/abc|arxiv:1706.03762|attention is all you need|vaswani|2017|zone:a vaswani');
  });

  test('the same DOI cited with different arXiv IDs gets different keys', () => {
    const a = cacheKey(citation({ doi: '10.1/x', arxivId: '1706.03762', title: 'T title' }));
    const b = cacheKey(citation({ doi: '10.1/x', arxivId: '1706.99999', title: 'T title' }));
    const none = cacheKey(citation({ doi: '10.1/x', title: 'T title' }));
    expect(new Set([a, b, none]).size).toBe(3);
  });

  test('an arXiv ID is used without its version when there is no DOI', () => {
    expect(cacheKey(citation({ arxivId: '1706.03762v5', title: 'T title' }))).toMatch(/^arxiv:1706\.03762\|/);
  });

  test('without identifiers the key is the title, first surname, year and author zone', () => {
    const raw = 'A. Vaswani and N. Shazeer. Attention: Is All You Need! 2017.';
    expect(cacheKey(citation({ title: 'Attention: Is All You Need!', authors: ['vaswani', 'shazeer'], year: 2017, raw }))).toBe('t:attention is all you need|vaswani|2017|zone:a and n shazeer vaswani');
  });

  test('the same identifier cited with a different title gets a different key', () => {
    const a = cacheKey(citation({ doi: '10.1/x', title: 'First title here' }));
    const b = cacheKey(citation({ doi: '10.1/x', title: 'A completely different title' }));
    expect(a).not.toBe(b);
  });

  test('the same citation gives the same key', () => {
    expect(cacheKey(citation({ doi: '10.1/x', title: 'T' }))).toBe(cacheKey(citation({ doi: '10.1/x', title: 'T' })));
  });

  test('nothing to key on gives undefined', () => {
    expect(cacheKey(citation({ title: '!!!' }))).toBeUndefined();
    expect(cacheKey(citation({}))).toBeUndefined();
  });

  test('a title-less identifier key carries the words of the author zone, initials included', () => {
    const roe = cacheKey(citation({ doi: '10.1/x', year: 2020, raw: 'J. Roe and J. Smith, Science 367, 123 (2020). doi:10.1/x' }));
    const lee = cacheKey(citation({ doi: '10.1/x', year: 2020, raw: 'K. Lee and S. Park, Science 367, 123 (2020). doi:10.1/x' }));
    expect(roe).not.toBe(lee);
    expect(roe).toBe('doi:10.1/x|||2020|zone:and j roe smith');
    // Another initial is another person.
    expect(cacheKey(citation({ doi: '10.1/x', year: 2020, raw: 'K. Roe and J. Smith, Science 367, 123 (2020). doi:10.1/x' }))).not.toBe(roe);
    // The same names in another order, or another venue after them, are the same citation.
    expect(cacheKey(citation({ doi: '10.1/x', year: 2020, raw: 'J. Smith and J. Roe, Nature 571, 95 (2020). doi:10.1/x' }))).toBe(roe);
    expect(cacheKey(citation({ doi: '10.1/x', year: 2020, raw: 'J. Roe and J. Smith, Science 367, 123 (2020). doi:10.1/x' }))).toBe(roe);
  });

  // A title written before the journal's name and read into it is compared with the record, so it is part of the key: two
  // entries that differ only after a digit in that title ("... 2 photons" and "... 2 bosons") do not share a verdict.
  test('a title-less reading keys the words of its journal name that are not a journal\'s', () => {
    const at = (title: string): ParsedCitation => ({ raw: `J. Roe, ${title}. Nucl. Phys. B537, 10.1/x (1999).`, authors: [], kind: 'unknown', confidence: 0.2, doi: '10.1/x', year: 1999, venue: `${title}. Nucl. Phys. B537, 10.1/x` });
    expect(cacheKey(at('Search for 2 photons'))).not.toBe(cacheKey(at('Search for 2 bosons')));
    expect(cacheKey(at('Search for 2 photons'))).toMatch(/\|j:search 2 photons$/);
    const plain = (venue: string): ParsedCitation => ({ raw: `J. Roe, ${venue} (1999).`, authors: [], kind: 'unknown', confidence: 0.2, doi: '10.1/x', year: 1999, venue });
    expect(cacheKey(plain('Nucl. Phys. B537, 10.1/x'))).toBe('doi:10.1/x|||1999|zone:j nucl roe');
  });

  test('a long author zone is keyed by a stable 64-bit hash of its words; a bare id has no zone part', () => {
    const names = Array.from({ length: 40 }, (_, i) => `A. Author${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`).join(', ');
    const a = cacheKey(citation({ doi: '10.1/x', raw: `${names}. doi:10.1/x` }));
    expect(a).toMatch(/\|zone#[0-9a-f]{16}$/);
    expect(cacheKey(citation({ doi: '10.1/x', raw: `${names}. doi:10.1/x` }))).toBe(a);
    expect(cacheKey(citation({ doi: '10.1/x', raw: `${names.replace('A. Authoraa', 'B. Authoraa')}. doi:10.1/x` }))).not.toBe(a);
    expect(cacheKey(citation({ doi: '10.1/x', raw: 'et al. doi:10.1/x' }))).toBe('doi:10.1/x||||zone:al et');
    expect(cacheKey(citation({ doi: '10.1/x', raw: '???? doi:10.1/x' }))).toBe('doi:10.1/x|||');
    expect(cacheKey(citation({ doi: '10.1/x', raw: 'doi:10.1/x' }))).toBe('doi:10.1/x|||');
  });

  test('a titled key carries the author zone too', () => {
    expect(cacheKey(citation({ doi: '10.1/x', title: 'Some title words', raw: 'J. Roe. Some title words. doi:10.1/x' }))).toBe('doi:10.1/x|some title words|||zone:j roe');
    expect(cacheKey(citation({ doi: '10.1/x', title: 'Some title words', raw: 'Some title words. doi:10.1/x' }))).toBe('doi:10.1/x|some title words||');
    expect(cacheKey(citation({ title: 'Some title words', raw: 'Li Roe. Some title words.' }))).toBe('t:some title words|||zone:li roe');
  });

  test('never contains the raw reference text', () => {
    const c: ParsedCitation = citation({ raw: 'SECRET RAW TEXT', title: 'Some title words' });
    expect(cacheKey(c)).not.toContain('SECRET');
  });
});

describe('createCache', () => {
  test('returns what was stored, without the per-paper fields', async () => {
    const cache = createCache(() => 0);
    await cache.set('k', result('verified'));
    await cache.flush();
    const hit = await cache.get('k');
    expect(hit).toMatchObject({ status: 'verified', reason: 'because', sourcesSearched: ['crossref'] });
    // The cited text belongs to one paper's bibliography; it is not kept in the shared cache.
    expect(JSON.stringify(await fakeBrowser.storage.local.get(CACHE_KEY))).not.toContain('the full cited text');
  });

  test('a miss is undefined', async () => {
    expect(await createCache(() => 0).get('nope')).toBeUndefined();
  });

  test('cant_check results are never stored', async () => {
    const cache = createCache(() => 0);
    await cache.set('k', result('cant_check'));
    await cache.flush();
    expect(await cache.get('k')).toBeUndefined();
    expect(await fakeBrowser.storage.local.get(CACHE_KEY)).toEqual({});
  });

  test.each([
    ['verified', TTL.retractionMs],
    ['details_differ', TTL.retractionMs],
    ['retracted', TTL.retractionMs],
    ['wrong_id', TTL.recordMs],
    ['not_found', TTL.negativeMs],
  ] as const)('%s expires after its TTL', async (status, ttl) => {
    let now = 1_000_000;
    const cache = createCache(() => now);
    await cache.set('k', result(status));
    now += ttl - 1;
    expect(await cache.get('k')).toBeDefined();
    now += 1;
    expect(await cache.get('k')).toBeUndefined();
  });

  test('negative results are forgotten before positive ones', () => {
    expect(TTL.negativeMs).toBeLessThan(TTL.retractionMs);
  });

  test('keeps at most the cap, evicting the oldest', async () => {
    expect(CACHE_MAX_ENTRIES).toBe(5000);
    let now = 0;
    const cache = createCache(() => ++now, 5);
    for (let i = 0; i < 8; i++) await cache.set(`k${i}`, result('verified'));
    expect(await cache.get('k0')).toBeUndefined();
    expect(await cache.get('k2')).toBeUndefined();
    expect(await cache.get('k3')).toBeDefined();
    expect(await cache.get('k7')).toBeDefined();
  });

  test('storing a key again refreshes it rather than duplicating it', async () => {
    const cache = createCache(() => 0, 2);
    await cache.set('a', result('verified'));
    await cache.set('b', result('verified'));
    await cache.set('a', result('not_found'));
    await cache.set('c', result('verified'));
    expect(await cache.get('b')).toBeUndefined();
    expect((await cache.get('a'))?.status).toBe('not_found');
  });

  test('concurrent sets do not lose entries', async () => {
    const cache = createCache(() => 0);
    await Promise.all(Array.from({ length: 20 }, (_, i) => cache.set(`k${i}`, result('verified'))));
    for (let i = 0; i < 20; i++) expect(await cache.get(`k${i}`)).toBeDefined();
  });

  test('a corrupt stored cache reads as empty', async () => {
    await fakeBrowser.storage.local.set({ [CACHE_KEY]: { entries: 'nope' } });
    const cache = createCache(() => 0);
    expect(await cache.get('k')).toBeUndefined();
    await cache.set('k', result('verified'));
    expect(await cache.get('k')).toBeDefined();
  });

  test('clear empties it', async () => {
    const cache = createCache(() => 0);
    await cache.set('k', result('verified'));
    await cache.clear();
    expect(await cache.get('k')).toBeUndefined();
  });

  test('stores in storage.local only', async () => {
    const cache = createCache(() => 0);
    await cache.set('k', result('verified'));
    await cache.flush();
    expect(await fakeBrowser.storage.sync.get(null)).toEqual({});
  });
});

describe('createCache: memory, batching and storage limits', () => {
  test('loads the stored blob once and serves every get from memory', async () => {
    await fakeBrowser.storage.local.set({ [CACHE_KEY]: { entries: [{ k: 'a', e: 1e12, v: result('verified') }] } });
    const read = vi.spyOn(fakeBrowser.storage.local, 'get');
    const cache = createCache(() => 0);
    for (let i = 0; i < 50; i++) await cache.get('a');
    expect(read).toHaveBeenCalledTimes(1);
  });

  test('sets are written in one debounced flush', async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(fakeBrowser.storage.local, 'set');
    const cache = createCache(() => 0);
    for (let i = 0; i < 10; i++) await cache.set(`k${i}`, result('verified'));
    expect(write).not.toHaveBeenCalled();
    expect(await cache.get('k3')).toBeDefined();
    await vi.advanceTimersByTimeAsync(CACHE_FLUSH_MS);
    expect(write).toHaveBeenCalledTimes(1);
    const stored = (await fakeBrowser.storage.local.get(CACHE_KEY))[CACHE_KEY] as { entries: unknown[] };
    expect(stored.entries).toHaveLength(10);
  });

  test('flush writes at once and does nothing when nothing changed', async () => {
    const write = vi.spyOn(fakeBrowser.storage.local, 'set');
    const cache = createCache(() => 0);
    await cache.flush();
    expect(write).not.toHaveBeenCalled();
    await cache.set('k', result('verified'));
    await cache.flush();
    expect(write).toHaveBeenCalledTimes(1);
    await cache.flush();
    expect(write).toHaveBeenCalledTimes(1);
  });

  test('is capped by serialised size as well as by count, evicting the oldest', async () => {
    expect(CACHE_MAX_BYTES).toBe(4 * 1024 * 1024);
    let now = 0;
    const cache = createCache(() => ++now, 5000, 6000);
    for (let i = 0; i < 40; i++) await cache.set(`k${i}`, result('verified', { reason: 'r'.repeat(500) }));
    await cache.flush();
    expect(await cache.get('k0')).toBeUndefined();
    expect(await cache.get('k39')).toBeDefined();
    const raw = JSON.stringify((await fakeBrowser.storage.local.get(CACHE_KEY))[CACHE_KEY]);
    expect(raw.length).toBeLessThanOrEqual(6000 + 200);
  });

  test('on a quota error it evicts about a quarter of the oldest entries and retries once', async () => {
    let now = 0;
    const cache = createCache(() => ++now);
    for (let i = 0; i < 20; i++) await cache.set(`k${i}`, result('verified'));
    vi.spyOn(fakeBrowser.storage.local, 'set').mockImplementationOnce(QUOTA);
    await cache.flush();
    const stored = (await fakeBrowser.storage.local.get(CACHE_KEY))[CACHE_KEY] as { entries: { k: string }[] };
    expect(stored.entries.map((e) => e.k)).toEqual(Array.from({ length: 15 }, (_, i) => `k${i + 5}`));
    expect(await cache.get('k0')).toBeUndefined();
  });

  test('gives up silently when the retry fails too, and still serves from memory', async () => {
    const cache = createCache(() => 0);
    for (let i = 0; i < 4; i++) await cache.set(`k${i}`, result('verified'));
    vi.spyOn(fakeBrowser.storage.local, 'set').mockImplementation(QUOTA);
    await expect(cache.flush()).resolves.toBeUndefined();
    expect(await cache.get('k3')).toBeDefined();
  });

  test('a failing cache flush never affects settings', async () => {
    const cache = createCache(() => 0);
    await cache.set('k', result('verified'));
    const real = fakeBrowser.storage.local.set.bind(fakeBrowser.storage.local);
    vi.spyOn(fakeBrowser.storage.local, 'set').mockImplementation((items) => (CACHE_KEY in (items as object) ? QUOTA() : real(items)));
    await cache.flush();
    expect((await updateSettings({ autoCheckArxiv: true })).autoCheckArxiv).toBe(true);
    expect((await getSettings()).autoCheckArxiv).toBe(true);
  });

  test('clear empties memory and storage, and a flush scheduled before it writes nothing', async () => {
    vi.useFakeTimers();
    const cache = createCache(() => 0);
    await cache.set('k', result('verified'));
    await cache.clear();
    await vi.advanceTimersByTimeAsync(CACHE_FLUSH_MS * 2);
    expect(await cache.get('k')).toBeUndefined();
    expect(await fakeBrowser.storage.local.get(CACHE_KEY)).toEqual({});
  });

  test('a write from before a clear is ignored afterwards', async () => {
    const cache = createCache(() => 0);
    const epoch = cache.epoch();
    await cache.clear();
    await cache.set('late', result('verified'), epoch);
    await cache.flush();
    expect(await cache.get('late')).toBeUndefined();
    expect(await fakeBrowser.storage.local.get(CACHE_KEY)).toEqual({});
    await cache.set('fresh', result('verified'), cache.epoch());
    expect(await cache.get('fresh')).toBeDefined();
  });

  test('clearAllCaches empties every cache in memory', async () => {
    const a = createCache(() => 0);
    await a.set('k', result('verified'));
    await clearAllCaches();
    expect(await a.get('k')).toBeUndefined();
  });

  test('storage cleared from another extension page empties memory too', async () => {
    const cache = createCache(() => 0);
    await cache.set('k', result('verified'));
    await cache.flush();
    await fakeBrowser.storage.local.remove(CACHE_KEY);
    expect(await cache.get('k')).toBeUndefined();
    await cache.flush();
    expect(await fakeBrowser.storage.local.get(CACHE_KEY)).toEqual({});
  });
});
