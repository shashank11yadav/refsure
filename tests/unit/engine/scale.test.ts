// The real cache over WXT's storage fake, pre-filled to its cap: a big run must not wait on storage writes.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', async () => ({ browser: (await import('wxt/testing/fake-browser')).fakeBrowser }));

import { fakeBrowser } from 'wxt/testing/fake-browser';
import { parseCitation } from '../../../src/core/parseCitation';
import type { CheckResult, PaperInfo } from '../../../src/core/types';
import { CACHE_KEY, CACHE_MAX_ENTRIES, cacheKey, createCache } from '../../../src/engine/cache';
import { runCheck } from '../../../src/engine/checker';
import { makeDeps, mockSources, paperRef, record } from '../helpers/engine';

const PAPER: PaperInfo = { key: 'k', title: 'P', url: 'https://arxiv.org/abs/2101.00001', origin: 'arxiv-abs', viaPdf: false };

beforeEach(() => {
  fakeBrowser.reset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function stored(status: 'verified'): Record<string, unknown> {
  return { status, reason: 'cached', diffs: [], notes: [], sourcesSearched: ['crossref'], sourcesFailed: [], links: [] };
}

describe('a 300-reference run over a full cache', () => {
  test('completes without waiting on storage, with a constant number of storage calls', async () => {
    const refs = Array.from({ length: 300 }, (_, i) => paperRef(i, { title: `Protein folding with graph networks study ${i}` }));
    const entries: { k: string; e: number; v: unknown }[] = [];
    // Fillers are the oldest entries; a third of the references are already cached.
    const cached = refs.filter((r) => r.index % 3 === 0);
    for (let i = 0; i < CACHE_MAX_ENTRIES - cached.length; i++) entries.push({ k: `t:filler ${i}||`, e: Date.now() + 1e9, v: stored('verified') });
    for (const ref of cached) entries.push({ k: cacheKey(parseCitation(ref)) ?? '', e: Date.now() + 1e9, v: stored('verified') });
    await fakeBrowser.storage.local.set({ [CACHE_KEY]: { entries } });

    const sources = mockSources({ crossref: { search: (c) => Promise.resolve([record({ title: c.title ?? '' })]) } });
    const deps = makeDeps(sources, { cache: createCache() });
    const reads = vi.spyOn(fakeBrowser.storage.local, 'get');
    const realSet = fakeBrowser.storage.local.set.bind(fakeBrowser.storage.local);
    let receivedWhenFirstWrite = -1;
    const writes = vi.spyOn(fakeBrowser.storage.local, 'set').mockImplementation((items) => {
      if (receivedWhenFirstWrite < 0) receivedWhenFirstWrite = got.length;
      return realSet(items);
    });
    const got: CheckResult[] = [];

    const summary = await runCheck({ paper: PAPER, refs, onResult: (r) => got.push(r), signal: new AbortController().signal }, deps);

    expect(got).toHaveLength(300);
    expect(summary.counts.verified).toBe(300);
    expect(sources.crossref.search).toHaveBeenCalledTimes(200);
    // Results all arrived before the first storage write started.
    expect(receivedWhenFirstWrite).toBe(300);
    expect(writes.mock.calls.length).toBeLessThanOrEqual(2);
    // The cache blob, read once, and the settings (history on/off), read once per run: neither grows with the references.
    expect(reads.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
