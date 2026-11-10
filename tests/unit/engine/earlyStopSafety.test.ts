// What the early stop must never do: give up a run that a short blip or a steady-state outage elsewhere leaves able to
// finish, or accuse; and a warm cache must not hide an outage. Mock sources
// honour the signal, the way the real adapters do through http.ts.
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', async () => ({ browser: (await import('wxt/testing/fake-browser')).fakeBrowser }));

import { REQUIRED_SOURCES } from '../../../src/core/types';
import type { CheckResult, PaperInfo, ParsedCitation, SourceName, WorkRecord } from '../../../src/core/types';
import { runCheck } from '../../../src/engine/checker';
import { SourceError } from '../../../src/sources/http';
import { cacheKey } from '../../../src/engine/cache';
import { parseCitation } from '../../../src/core/parseCitation';
import { makeDeps, mockSources, paperRef, record } from '../helpers/engine';

const PAPER: PaperInfo = { key: 'arxiv:2101.00001', title: 'A paper', url: 'https://arxiv.org/abs/2101.00001', origin: 'arxiv-abs', viaPdf: false };
const titleOf = (i: number): string => `Distinct paper number ${String(i)} on graph networks`;
const titled = (i: number) => paperRef(i, { title: titleOf(i) });
const numberOf = (c: ParsedCitation): number => Number(/number (\d+) on/.exec(c.title ?? '')?.[1]);

/** Settles after `ms`, or rejects with the signal's reason the moment it aborts (what http.ts does). */
function after<T>(ms: number, signal: AbortSignal | undefined, value: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      value().then(resolve, reject);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const net = (s: SourceName) => Promise.reject(new SourceError('network', s, 'Server error (HTTP 503)'));
const strong = (c: ParsedCitation): WorkRecord[] => [record({ title: c.title ?? '' })];

async function run(sources: ReturnType<typeof mockSources>, n: number): Promise<{ got: CheckResult[]; halted: boolean }> {
  const got: CheckResult[] = [];
  const summary = await runCheck({ paper: PAPER, refs: Array.from({ length: n }, (_, i) => titled(i + 1)), onResult: (r) => got.push(r), signal: new AbortController().signal }, makeDeps(sources));
  return { got, halted: summary.halted === 'services-down' };
}

describe('the early stop does not give up a run that can finish', () => {
  // A brief network blip catches two references: every lookup for references 3 and 4 fails (after http.ts's retries);
  // everything else answers with a strong match. The run reports 28 Verified and does not stop.
  test('two references caught by a short blip at every source', async () => {
    const blip = (c: ParsedCitation) => numberOf(c) === 3 || numberOf(c) === 4;
    const mk = (s: SourceName) => ({ search: vi.fn((c: ParsedCitation, signal?: AbortSignal) => after(10, signal, () => (blip(c) ? net(s) : Promise.resolve(strong(c))))) });
    const sources = mockSources({ crossref: mk('crossref'), arxiv: mk('arxiv'), openreview: mk('openreview'), dblp: mk('dblp'), openalex: mk('openalex') });
    const { got, halted } = await run(sources, 30);
    const verified = got.filter((r) => r.status === 'verified').length;
    expect(halted).toBe(false);
    expect(verified).toBe(28);
  });

  // The common steady state: OpenAlex's free daily search budget is spent and OpenReview answers with a bot check. Crossref
  // and arXiv answer, except that references 3 and 4 time out at both. 28 Verified, no stop.
  test('OpenAlex budget spent + OpenReview bot check + two Crossref/arXiv timeouts', async () => {
    const blip = (c: ParsedCitation) => numberOf(c) === 3 || numberOf(c) === 4;
    const free = (s: SourceName) => ({
      search: vi.fn((c: ParsedCitation, signal?: AbortSignal) =>
        after(10 * (numberOf(c) % 3 + 1), signal, () => (blip(c) ? Promise.reject(new SourceError('timeout', s, 'Request timed out after 15000 ms')) : Promise.resolve(strong(c)))),
      ),
    });
    const sources = mockSources({
      crossref: free('crossref'),
      arxiv: free('arxiv'),
      openreview: { search: () => Promise.reject(new SourceError('unavailable', 'openreview', 'OpenReview refused the request (HTTP 401/403), often a bot check')) },
      openalex: { search: () => Promise.reject(new SourceError('budget_exhausted', 'openalex', 'The OpenAlex search budget for today is used up')) },
    });
    const { got, halted } = await run(sources, 30);
    const verified = got.filter((r) => r.status === 'verified').length;
    expect(halted).toBe(false);
    expect(verified).toBe(28);
  });

  // Crossref is slow and fails now and then (two in a row once); arXiv and the others answer. Must never stop.
  test('one flaky source while the others answer never stops the run', async () => {
    const mk = (s: SourceName, flaky: boolean) => ({
      search: vi.fn((c: ParsedCitation, signal?: AbortSignal) => after(flaky ? 40 : 5, signal, () => (flaky && numberOf(c) % 5 < 2 ? net(s) : Promise.resolve([])))),
    });
    const sources = mockSources({ crossref: mk('crossref', true), arxiv: mk('arxiv', false), openreview: mk('openreview', false), openalex: mk('openalex', false) });
    const { got, halted } = await run(sources, 40);
    expect(halted).toBe(false);
    expect(got).toHaveLength(40);
  });
});

describe('the early stop never makes an accusation (property, seeded)', () => {
  // Each lookup answers "nothing" (null / []) or fails, at random, with random delays. After the watch trips and the run
  // halts, every delivered result must still obey: Not found only when every required source answered and none failed;
  // no Wrong ID or Retracted (no source ever returns a record).
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  test.each(Array.from({ length: 40 }, (_, i) => i + 1))('seed %i', async (seed) => {
    const rand = rng(seed);
    const pFail = 0.3 + rand() * 0.7;
    const mk = (s: SourceName) => ({
      search: vi.fn((_c: ParsedCitation, signal?: AbortSignal) => after(Math.floor(rand() * 8), signal, () => (rand() < pFail ? net(s) : Promise.resolve([])))),
      lookupById: vi.fn((_c: ParsedCitation, signal?: AbortSignal) => after(Math.floor(rand() * 8), signal, () => (rand() < pFail ? net(s) : Promise.resolve(null)))),
    });
    const sources = mockSources({ crossref: mk('crossref'), arxiv: mk('arxiv'), openreview: mk('openreview'), dblp: mk('dblp'), openalex: mk('openalex') });
    const refs = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? paperRef(i + 1, { title: titleOf(i + 1), doi: `10.1234/x${String(i)}` }) : titled(i + 1)));
    const got: CheckResult[] = [];
    await runCheck({ paper: PAPER, refs, onResult: (r) => got.push(r), signal: new AbortController().signal }, makeDeps(sources));
    for (const r of got) {
      expect(['wrong_id', 'retracted']).not.toContain(r.status);
      if (r.status === 'not_found') {
        expect(r.sourcesFailed).toEqual([]);
        for (const s of REQUIRED_SOURCES) expect(r.sourcesSearched).toContain(s);
      }
    }
  });
});

afterEach(() => vi.useRealTimers());

async function drive(p: Promise<unknown>): Promise<void> {
  let done = false;
  void p.finally(() => (done = true)).catch(() => undefined);
  for (let i = 0; i < 20_000 && !done; i++) await vi.advanceTimersByTimeAsync(100);
}

describe('steady-state outages plus one Crossref hiccup', () => {
  // OpenAlex's free daily search budget is spent; OpenReview answers with a bot check; arXiv's batch prefetch timed out
  // (the large batch and the first batch of ten). Crossref answers every title with a strong match, except one 15 s
  // hiccup in which the three requests in flight time out together. Expected: 37 of 40 Verified, no stop (Crossref is
  // answering).
  test('Crossref answers all but three references in a row', async () => {
    vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 28)) });
    const hiccup = (c: ParsedCitation) => numberOf(c) >= 4 && numberOf(c) <= 6;
    const sources = mockSources(
      {
        crossref: { search: (c, signal) => after(hiccup(c) ? 15_000 : 300, signal, () => (hiccup(c) ? Promise.reject(new SourceError('timeout', 'crossref', 'Request timed out after 15000 ms')) : Promise.resolve(strong(c)))) },
        arxiv: { search: (c, signal) => after(3_000, signal, () => Promise.resolve(strong(c))) },
        openreview: { search: () => Promise.reject(new SourceError('unavailable', 'openreview', 'OpenReview refused the request (HTTP 401/403), often a bot check')) },
        openalex: { search: () => Promise.reject(new SourceError('budget_exhausted', 'openalex', 'The OpenAlex search budget for today is used up')) },
      },
      () => Promise.reject(new SourceError('timeout', 'arxiv', 'Request timed out after 15000 ms')),
    );
    const refs = Array.from({ length: 40 }, (_, i) => paperRef(i + 1, { title: titleOf(i + 1), ...(i >= 25 && { arxivId: `2101.${String(i).padStart(5, '0')}` }) }));
    const got: CheckResult[] = [];
    const p = runCheck({ paper: PAPER, refs, onResult: (r) => got.push(r), signal: new AbortController().signal }, makeDeps(sources));
    await drive(p);
    const summary = await p;
    const verified = got.filter((r) => r.status === 'verified').length;
    expect(summary.halted).toBeUndefined();
    expect(verified).toBeGreaterThanOrEqual(37);
  });

  // The same, but arXiv is in an outage too (503 on every request): only Crossref answers, and it answers every
  // reference but the three caught by one hiccup. Expected: 37 Verified, no stop.
  test('three required sources down, Crossref answering all but one hiccup of three requests', async () => {
    vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 28)) });
    const hiccup = (c: ParsedCitation) => numberOf(c) >= 4 && numberOf(c) <= 6;
    const sources = mockSources({
      crossref: { search: (c, signal) => after(hiccup(c) ? 15_000 : 300, signal, () => (hiccup(c) ? Promise.reject(new SourceError('timeout', 'crossref', 'Request timed out after 15000 ms')) : Promise.resolve(strong(c)))) },
      arxiv: { search: (_c, signal) => after(3_000, signal, () => Promise.reject(new SourceError('network', 'arxiv', 'Server error (HTTP 503)'))) },
      openreview: { search: () => Promise.reject(new SourceError('unavailable', 'openreview', 'OpenReview refused the request (HTTP 401/403), often a bot check')) },
      openalex: { search: () => Promise.reject(new SourceError('budget_exhausted', 'openalex', 'The OpenAlex search budget for today is used up')) },
    });
    const refs = Array.from({ length: 40 }, (_, i) => paperRef(i + 1, { title: titleOf(i + 1) }));
    const got: CheckResult[] = [];
    const p = runCheck({ paper: PAPER, refs, onResult: (r) => got.push(r), signal: new AbortController().signal }, makeDeps(sources));
    await drive(p);
    const summary = await p;
    const verified = got.filter((r) => r.status === 'verified').length;
    expect(summary.halted).toBeUndefined();
    expect(verified).toBe(37);
  });

  // arXiv asked RefSure to wait (a long Retry-After: every arXiv lookup fails at once, unsent), OpenReview answers with a
  // bot check and OpenAlex's free budget is spent. Crossref answers every reference except one 15 s hiccup in which the
  // three requests in flight time out together. Expected: 37 of 40 Verified, no stop.
  test('arXiv blocked + OpenReview bot check + OpenAlex budget spent + one Crossref hiccup', async () => {
    vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 28)) });
    const until = Date.now() + 30 * 60_000;
    const hiccup = (c: ParsedCitation) => numberOf(c) >= 4 && numberOf(c) <= 6;
    const sources = mockSources({
      crossref: { search: (c, signal) => after(hiccup(c) ? 15_000 : 300, signal, () => (hiccup(c) ? Promise.reject(new SourceError('timeout', 'crossref', 'Request timed out after 15000 ms')) : Promise.resolve(strong(c)))) },
      arxiv: { search: () => Promise.reject(new SourceError('network', 'arxiv', 'The service asked not to be contacted for a while; not sent', until - Date.now(), until)) },
      openreview: { search: () => Promise.reject(new SourceError('unavailable', 'openreview', 'OpenReview refused the request (HTTP 401/403), often a bot check')) },
      openalex: { search: () => Promise.reject(new SourceError('budget_exhausted', 'openalex', 'The OpenAlex search budget for today is used up')) },
    });
    const refs = Array.from({ length: 40 }, (_, i) => paperRef(i + 1, { title: titleOf(i + 1) }));
    const got: CheckResult[] = [];
    const p = runCheck({ paper: PAPER, refs, onResult: (r) => got.push(r), signal: new AbortController().signal }, makeDeps(sources));
    await drive(p);
    const summary = await p;
    const verified = got.filter((r) => r.status === 'verified').length;
    expect(summary.halted).toBeUndefined();
    expect(verified).toBe(37);
  });
});

describe('a network blip of W seconds at every source (realistic per-source pacing)', () => {
  // Every lookup that starts inside [1 s, 1 s + W) fails when its time is up; the others answer with a strong match.
  // Per-call times roughly follow each source's gate and pace: Crossref 0.4 s, arXiv 3 s, OpenReview 0.6 s, DBLP 1 s,
  // OpenAlex 0.6 s.
  const PACE: Record<SourceName, number> = { crossref: 400, arxiv: 3000, openreview: 600, dblp: 1000, openalex: 600 };
  test.each([2, 4, 6, 8, 10, 12, 15, 20, 30, 60])('W = %i s', async (w) => {
    vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 28)) });
    const t0 = Date.now();
    const mk = (s: SourceName) => ({
      search: (c: ParsedCitation, signal?: AbortSignal) => {
        const startedAt = Date.now() - t0;
        const inBlip = startedAt >= 1000 && startedAt < 1000 + w * 1000;
        return after(PACE[s], signal, () => (inBlip ? Promise.reject(new SourceError('network', s, 'Network error')) : Promise.resolve(strong(c))));
      },
    });
    const sources = mockSources({ crossref: mk('crossref'), arxiv: mk('arxiv'), openreview: mk('openreview'), dblp: mk('dblp'), openalex: mk('openalex') });
    const refs = Array.from({ length: 60 }, (_, i) => paperRef(i + 1, { title: titleOf(i + 1) }));
    const got: CheckResult[] = [];
    const p = runCheck({ paper: PAPER, refs, onResult: (r) => got.push(r), signal: new AbortController().signal }, makeDeps(sources));
    await drive(p);
    const summary = await p;
    const verified = got.filter((r) => r.status === 'verified').length;
    // Every run with W <= 15 s finishes, with these Verified counts.
    if (w <= 15) expect(summary.halted).toBeUndefined();
    const expectedVerified: Partial<Record<number, number>> = { 10: 58, 12: 57, 15: 56 };
    if (expectedVerified[w] !== undefined) expect(verified).toBe(expectedVerified[w]);
  });
});

describe('the early stop with a warm cache', () => {
  test('every other reference is cached; every service is down', async () => {
    const down = (s: 'crossref' | 'arxiv' | 'openreview' | 'openalex') => ({ search: () => Promise.reject(new SourceError('network', s, 'x')) });
    const sources = mockSources({ crossref: down('crossref'), arxiv: down('arxiv'), openreview: down('openreview'), openalex: down('openalex') });
    const deps = makeDeps(sources);
    const refs = Array.from({ length: 40 }, (_, i) => paperRef(i + 1, { title: `Distinct paper number ${String(i + 1)} on graph networks` }));
    for (const r of refs.filter((_, i) => i % 2 === 1)) {
      const key = cacheKey(parseCitation(r));
      if (key !== undefined) deps.cache.store.set(key, { index: r.index, label: r.label, citedText: r.text, status: 'verified', reason: 'ok', diffs: [], notes: [], sourcesSearched: ['crossref'], sourcesFailed: [], links: [] });
    }
    const got: CheckResult[] = [];
    const summary = await runCheck({ paper: PAPER, refs, onResult: (r) => got.push(r), signal: new AbortController().signal }, deps);
    // Cached results say nothing about the services either way, so the run still stops.
    expect(summary.halted).toBe('services-down');
    expect(got.filter((r) => r.status === 'cant_check').length).toBeGreaterThanOrEqual(5);
  });
});

