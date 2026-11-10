// How soon a run gives up when every service answers 503 with no Retry-After. The real adapters,
// http.ts and its limiters run on fake timers; fetch is stubbed, so nothing leaves the machine.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', async () => ({ browser: (await import('wxt/testing/fake-browser')).fakeBrowser }));

import { REQUIRED_SOURCES, type CheckResult, type PaperInfo, type RawReference, type SourceName } from '../../../src/core/types';
import { HALT_AFTER, OutageWatch, runCheck, SOURCE_DOWN_AFTER, type EngineDeps } from '../../../src/engine/checker';
import { arxiv } from '../../../src/sources/arxiv';
import { crossref } from '../../../src/sources/crossref';
import { dblp } from '../../../src/sources/dblp';
import { resetNetworkStateForTests, retriesAllowed, SourceError } from '../../../src/sources/http';
import { openalex } from '../../../src/sources/openalex';
import { openreview } from '../../../src/sources/openreview';
import { makeDeps, memoryCache, mockSources, paperRef } from '../helpers/engine';

const PAPER: PaperInfo = { key: 'arxiv:2101.00001', title: 'A paper', url: 'https://arxiv.org/abs/2101.00001', origin: 'arxiv-abs', viaPdf: false };

let requests: string[];

function realDeps(): EngineDeps {
  return { sources: { crossref, arxiv, openreview, dblp, openalex }, retraction: { check: () => Promise.resolve({ retracted: false }) }, cache: memoryCache(), now: Date.now };
}

async function timedRun(refs: RawReference[]): Promise<{ got: CheckResult[]; elapsed: number; halted: boolean }> {
  const got: CheckResult[] = [];
  const t0 = Date.now();
  const p = runCheck({ paper: PAPER, refs, onResult: (r) => got.push(r), signal: new AbortController().signal }, realDeps());
  let done = false;
  void p.finally(() => (done = true)).catch(() => undefined);
  for (let i = 0; i < 4000 && !done; i++) await vi.advanceTimersByTimeAsync(250);
  const summary = await p;
  return { got, elapsed: Date.now() - t0, halted: summary.halted === 'services-down' };
}

beforeEach(() => {
  resetNetworkStateForTests();
  vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 28)) });
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      requests.push(String(input));
      const r = new Response(null, { status: 503, headers: { 'content-type': 'application/json' } });
      Object.defineProperty(r, 'url', { value: String(input) });
      return Promise.resolve(r);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('every service answers 503 with no Retry-After', () => {
  // Lookups are sent once each while every required source is failing: 49.5 s with 98 requests, and 70.5 s with 106.
  test.each([
    ['titled references', (i: number) => paperRef(i, { title: `Graph neural networks for protein folding at scale, part ${String(i)}` }), 55_000, 147],
    ['references with arXiv ids', (i: number) => paperRef(i, { title: `Graph neural networks for protein folding at scale, part ${String(i)}`, arxivId: `2101.${String(i).padStart(5, '0')}` }), 75_000, 155],
  ])('%s: the run stops sooner, with fewer requests, and still shows five rows and the banner', async (_name, make, withinMs, before) => {
    const { got, elapsed, halted } = await timedRun(Array.from({ length: 30 }, (_, i) => make(i + 1)));
    expect(halted).toBe(true);
    expect(got).toHaveLength(HALT_AFTER);
    expect(got.every((r) => r.status === 'cant_check')).toBe(true);
    expect(elapsed).toBeLessThan(withinMs);
    expect(requests.length).toBeLessThan(before);
    // Nothing is asked once the run has stopped.
    const sent = requests.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(requests).toHaveLength(sent);
  });
});

describe('the run is not stopped while a required source still answers', () => {
  const titled = (i: number) => paperRef(i, { title: `Distinct paper number ${String(i)} on graph networks` });
  const down = (source: SourceName) => () => Promise.reject(new SourceError('network', source, 'x'));
  const signal = () => new AbortController().signal;

  test('one source failing every time (arXiv) is still asked for every reference, and every reference is reported', async () => {
    const sources = mockSources({ arxiv: { lookupById: down('arxiv'), search: down('arxiv') } });
    const got: CheckResult[] = [];
    const summary = await runCheck({ paper: PAPER, refs: Array.from({ length: 30 }, (_, i) => titled(i + 1)), onResult: (r) => got.push(r), signal: signal() }, makeDeps(sources));
    expect(summary.halted).toBeUndefined();
    expect(got).toHaveLength(30);
    expect(sources.arxiv.search).toHaveBeenCalledTimes(30);
  });

  test('three required sources down and the fourth answering: no stop, every reference reported', async () => {
    const sources = mockSources({
      crossref: { lookupById: down('crossref'), search: down('crossref') },
      arxiv: { lookupById: down('arxiv'), search: down('arxiv') },
      openreview: { lookupById: down('openreview'), search: down('openreview') },
    });
    const got: CheckResult[] = [];
    const summary = await runCheck({ paper: PAPER, refs: Array.from({ length: 30 }, (_, i) => titled(i + 1)), onResult: (r) => got.push(r), signal: signal() }, makeDeps(sources));
    expect(summary.halted).toBeUndefined();
    expect(got).toHaveLength(30);
    expect(sources.openalex.search).toHaveBeenCalledTimes(30);
  });

  test('a source that answers again after two failures is no longer counted as down', async () => {
    // Crossref fails for the first two references only; the other required sources fail throughout.
    const sources = mockSources({
      crossref: { search: (c) => (/number [12] on/.test(c.title ?? '') ? Promise.reject(new SourceError('network', 'crossref', 'x')) : Promise.resolve([])) },
      arxiv: { search: down('arxiv') },
      openreview: { search: down('openreview') },
      openalex: { search: down('openalex') },
    });
    const got: CheckResult[] = [];
    const summary = await runCheck({ paper: PAPER, refs: Array.from({ length: 30 }, (_, i) => titled(i + 1)), onResult: (r) => got.push(r), signal: signal() }, makeDeps(sources));
    expect(summary.halted).toBeUndefined();
    expect(got).toHaveLength(30);
    expect(got.every((r) => r.status === 'cant_check')).toBe(true);
  });

  test('while every required source is failing, lookups go out once each (no retries)', async () => {
    const allowed: boolean[] = [];
    const failing = (source: SourceName) => (_c: unknown, signal?: AbortSignal) => {
      allowed.push(retriesAllowed(signal));
      return Promise.reject(new SourceError('network', source, 'x'));
    };
    // DBLP fails too: an answer from any source, the optional one included, shows the network is up.
    const sources = mockSources({ crossref: { search: failing('crossref') }, arxiv: { search: failing('arxiv') }, openreview: { search: failing('openreview') }, dblp: { search: failing('dblp') }, openalex: { search: failing('openalex') } });
    const got: CheckResult[] = [];
    const summary = await runCheck({ paper: PAPER, refs: Array.from({ length: 30 }, (_, i) => titled(i + 1)), onResult: (r) => got.push(r), signal: signal() }, makeDeps(sources));
    expect(summary.halted).toBe('services-down');
    expect(got).toHaveLength(HALT_AFTER);
    // The first lookups may retry; once each required source has failed SOURCE_DOWN_AFTER times, none may.
    expect(allowed[0]).toBe(true);
    expect(allowed.at(-1)).toBe(false);
    expect(allowed.indexOf(false)).toBeGreaterThanOrEqual(REQUIRED_SOURCES.length * SOURCE_DOWN_AFTER - 1);
    expect(allowed.slice(allowed.indexOf(false)).every((a) => !a)).toBe(true);
  });

  test('the watch: an answer from any source clears every count; failures in flight together count once', () => {
    const watch = new OutageWatch();
    const fail = (source: SourceName, at = watch.started()) => watch.failed(source, at, new SourceError('network', source, 'x'));
    for (const source of REQUIRED_SOURCES) for (let i = 0; i < SOURCE_DOWN_AFTER; i++) fail(source);
    expect(watch.allFailing).toBe(true);
    watch.answered();
    expect(watch.allFailing).toBe(false);
    // Three Crossref lookups sent together and failing together are one failure.
    const together = watch.started();
    for (const source of REQUIRED_SOURCES.filter((s) => s !== 'crossref')) for (let i = 0; i < SOURCE_DOWN_AFTER; i++) fail(source);
    for (let i = 0; i < 3; i++) fail('crossref', together);
    expect(watch.allFailing).toBe(SOURCE_DOWN_AFTER <= 1);
    fail('crossref');
    expect(watch.allFailing).toBe(true);
  });

  test('the watch: a lasting failure counts as failing, but not alone while another required source has not failed', () => {
    const watch = new OutageWatch();
    const until = Date.now() + 60_000;
    watch.failed('arxiv', watch.started(), new SourceError('network', 'arxiv', 'x', 1, until));
    // A bot check: an `unavailable` answer that repeats.
    watch.failed('openreview', watch.started(), new SourceError('unavailable', 'openreview', 'x'));
    watch.failed('openreview', watch.started(), new SourceError('unavailable', 'openreview', 'x'));
    watch.failed('openalex', watch.started(), new SourceError('budget_exhausted', 'openalex', 'x'));
    expect(watch.allFailing).toBe(false);
    watch.failed('crossref', watch.started(), new SourceError('timeout', 'crossref', 'x'));
    expect(watch.allFailing).toBe(SOURCE_DOWN_AFTER <= 1);
    watch.failed('crossref', watch.started(), new SourceError('timeout', 'crossref', 'x'));
    expect(watch.allFailing).toBe(true);
  });

  // `unavailable` is also a one-off error page served as a 200, so it lasts only when it repeats.
  test('the watch: one unavailable answer is an ordinary failure; a second one makes it a lasting fault', () => {
    const watch = new OutageWatch();
    for (const source of ['crossref', 'arxiv', 'openalex'] as const) for (let i = 0; i < SOURCE_DOWN_AFTER; i++) watch.failed(source, watch.started(), new SourceError('network', source, 'x'));
    const together = watch.started();
    watch.failed('openreview', together, new SourceError('unavailable', 'openreview', 'x'));
    expect(watch.allFailing).toBe(SOURCE_DOWN_AFTER <= 1);
    // Two timeouts sent together count once; two unavailable answers sent together are a repeat: a lasting fault.
    const other = new OutageWatch();
    for (const source of ['crossref', 'arxiv', 'openalex'] as const) for (let i = 0; i < SOURCE_DOWN_AFTER; i++) other.failed(source, other.started(), new SourceError('network', source, 'x'));
    const at = other.started();
    other.failed('openreview', at, new SourceError('timeout', 'openreview', 'x'));
    other.failed('openreview', at, new SourceError('timeout', 'openreview', 'x'));
    expect(other.allFailing).toBe(SOURCE_DOWN_AFTER <= 1);
    watch.failed('openreview', together, new SourceError('unavailable', 'openreview', 'x'));
    expect(watch.allFailing).toBe(true);
  });

  test('sources that fail for the whole run (a wait, a spent budget, a bot check) never make it look all down while one answers, and one hiccup of concurrent lookups counts once', async () => {
    const allowed: boolean[] = [];
    const until = Date.now() + 30 * 60_000;
    const sources = mockSources({
      // Crossref answers, except one moment in which its three concurrent lookups (references 4 to 6) fail together.
      crossref: {
        search: (c, signal) => {
          allowed.push(retriesAllowed(signal));
          return /number [456] on/.test(c.title ?? '') ? Promise.reject(new SourceError('timeout', 'crossref', 'x')) : Promise.resolve([]);
        },
      },
      arxiv: { search: () => Promise.reject(new SourceError('network', 'arxiv', 'x', until - Date.now(), until)) },
      openreview: { search: () => Promise.reject(new SourceError('unavailable', 'openreview', 'x')) },
      openalex: { search: () => Promise.reject(new SourceError('budget_exhausted', 'openalex', 'x')) },
    });
    await runCheck({ paper: PAPER, refs: Array.from({ length: 12 }, (_, i) => titled(i + 1)), onResult: () => undefined, signal: signal() }, makeDeps(sources));
    expect(allowed.every((a) => a)).toBe(true);
  });
});
