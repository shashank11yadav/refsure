// When every required source but Crossref is switched off for the run (arXiv asked for an hour's wait, OpenReview answers
// with a bot check, OpenAlex's daily search budget is spent), Crossref is the only way to an answer. A passing Crossref
// outage must not stop the run, a lasting one still must, and the waits services ask for still hold. The real adapters,
// http.ts and its limiters run on fake timers; fetch is stubbed, so nothing leaves the machine.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', async () => ({ browser: (await import('wxt/testing/fake-browser')).fakeBrowser }));

import { REQUIRED_SOURCES, type CheckResult, type PaperInfo, type SourceName } from '../../../src/core/types';
import { HALT_AFTER, OutageWatch } from '../../../src/engine/checker';
import { SourceError } from '../../../src/sources/http';
import { memoryCache, paperRef } from '../helpers/engine';

const PAPER: PaperInfo = { key: 'arxiv:2101.00001', title: 'A paper', url: 'https://arxiv.org/abs/2101.00001', origin: 'arxiv-abs', viaPdf: false };
const titleOf = (i: number): string => `Distinct paper number ${String(i)} on graph networks`;

interface Sent {
  at: number;
  url: URL;
  status: number;
}
let sent: Sent[];
/** Crossref's answer to a request sent `ms` after the run started. */
let crossrefAt: (ms: number) => { status: number; retryAfter?: string };
let t0: number;

function reply(url: string, status: number, headers: Record<string, string> = {}, body: string | null = null): Response {
  const r = new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
  Object.defineProperty(r, 'url', { value: url });
  return r;
}

/** A Crossref search answer holding the work the query names, so the reference is Verified. */
function crossrefMatch(url: URL): string {
  const n = /number (\d+) on/.exec(url.searchParams.get('query.bibliographic') ?? '')?.[1] ?? '0';
  const item = {
    DOI: `10.5555/graph.${n}`,
    title: [titleOf(Number(n))],
    author: [
      { given: 'Jane', family: 'Roe' },
      { given: 'John', family: 'Smith' },
      { given: 'Wei', family: 'Chen' },
    ],
    issued: { 'date-parts': [[2019]] },
    'container-title': ['Nature Methods'],
    type: 'journal-article',
  };
  return JSON.stringify({ status: 'ok', 'message-type': 'work-list', message: { items: [item] } });
}

function answer(url: URL): Response {
  switch (url.hostname) {
    case 'api.crossref.org': {
      const { status, retryAfter } = crossrefAt(Date.now() - t0);
      return status === 200 ? reply(url.href, 200, {}, crossrefMatch(url)) : reply(url.href, status, retryAfter === undefined ? {} : { 'retry-after': retryAfter });
    }
    case 'export.arxiv.org':
    case 'arxiv.org':
      return reply(url.href, 503, { 'retry-after': '3600' });
    case 'api2.openreview.net':
      return reply(url.href, 403, {}, '{"name":"ForbiddenError"}');
    case 'api.openalex.org':
      return reply(url.href, 429, { 'retry-after': '14538' });
    default:
      return reply(url.href, 503);
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 28, 18, 0)) });
  t0 = Date.now();
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = new URL(String(input));
      const r = answer(url);
      sent.push({ at: Date.now() - t0, url, status: r.status });
      return Promise.resolve(r);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function check(n: number, now: () => number = Date.now): Promise<{ got: CheckResult[]; halted: boolean; elapsed: number }> {
  const checker = await import('../../../src/engine/checker');
  const { arxiv } = await import('../../../src/sources/arxiv');
  const { crossref } = await import('../../../src/sources/crossref');
  const { dblp } = await import('../../../src/sources/dblp');
  const { openalex } = await import('../../../src/sources/openalex');
  const { openreview } = await import('../../../src/sources/openreview');
  const deps = { sources: { crossref, arxiv, openreview, dblp, openalex }, retraction: { check: () => Promise.resolve({ retracted: false }) }, cache: memoryCache(), now };
  const refs = Array.from({ length: n }, (_, i) => paperRef(i + 1, { title: titleOf(i + 1) }));
  const got: CheckResult[] = [];
  const p = checker.runCheck({ paper: PAPER, refs, onResult: (r) => got.push(r), signal: new AbortController().signal }, deps);
  let done = false;
  void p.finally(() => (done = true)).catch(() => undefined);
  for (let i = 0; i < 20_000 && !done; i++) await vi.advanceTimersByTimeAsync(100);
  const summary = await p;
  return { got, halted: summary.halted === 'services-down', elapsed: Date.now() - t0 };
}

const to = (host: string): Sent[] => sent.filter((s) => s.url.hostname === host);

describe('Crossref is the only source left', () => {
  test('a 30-second Crossref outage does not stop the run; the references it caught are Can\'t check, the rest Verified', async () => {
    crossrefAt = (ms) => ({ status: ms >= 5_000 && ms < 35_000 ? 503 : 200 });
    const { got, halted } = await check(60);
    expect(halted).toBe(false);
    expect(got).toHaveLength(60);
    expect(got.every((r) => r.status === 'verified' || r.status === 'cant_check')).toBe(true);
    expect(got.filter((r) => r.status === 'verified').length).toBeGreaterThan(30);
    // arXiv asked for an hour: after its first answer nothing more is sent to it.
    expect(to('export.arxiv.org').length + to('arxiv.org').length).toBeLessThanOrEqual(1);
    // OpenAlex's search budget is spent: after its first answer no other search is sent.
    expect(to('api.openalex.org').filter((s) => s.url.pathname === '/works' && s.url.searchParams.has('search')).length).toBeLessThanOrEqual(1);
  });

  test('a Crossref outage that does not end still stops the run, and nothing is sent after the stop', async () => {
    crossrefAt = (ms) => ({ status: ms >= 5_000 ? 503 : 200 });
    const { got, halted, elapsed } = await check(200);
    expect(halted).toBe(true);
    expect(got.length).toBeLessThan(200);
    expect(elapsed).toBeLessThan(5 * 60_000);
    const count = sent.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent).toHaveLength(count);
  });

  // The wait is measured on the wall clock, which can stand still or jump back (a suspended laptop, a clock set by
  // hand). Counting the references that failed in a row ends the wait however the clock behaves.
  test('a Crossref outage that does not end stops the run even when the clock stands still', async () => {
    crossrefAt = () => ({ status: 503 });
    const frozen = Date.now();
    const { got, halted } = await check(300, () => frozen);
    expect(halted).toBe(true);
    expect(got.length).toBeLessThan(300);
    expect(got.length).toBeLessThanOrEqual(4 * HALT_AFTER + 10);
    const count = sent.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent).toHaveLength(count);
  });

  test('a Retry-After from Crossref during its outage is honoured: no Crossref request is sent before the stated time', async () => {
    crossrefAt = (ms) => (ms >= 5_000 && ms < 35_000 ? { status: 503, retryAfter: '8' } : { status: 200 });
    await check(60);
    const crossref = to('api.crossref.org');
    for (const [i, s] of crossref.entries()) {
      if (s.status !== 503) continue;
      const next = crossref[i + 1];
      // Requests already in flight together may answer together; the next one sent after an answer waits the 8 s.
      const later = crossref.slice(i + 1).find((r) => r.at > s.at);
      if (next !== undefined && later !== undefined) expect(later.at - s.at).toBeGreaterThanOrEqual(8_000);
    }
  });
});

describe('the watch: which sources are left', () => {
  const until = Date.UTC(2026, 9, 28, 19, 0);
  const switchOffAllButCrossref = (watch: OutageWatch): void => {
    watch.failed('arxiv', watch.started(), new SourceError('network', 'arxiv', 'x', 3_600_000, until));
    watch.failed('openreview', watch.started(), new SourceError('unavailable', 'openreview', 'x'));
    watch.failed('openreview', watch.started(), new SourceError('unavailable', 'openreview', 'x'));
    watch.failed('openalex', watch.started(), new SourceError('budget_exhausted', 'openalex', 'x'));
  };
  const crossrefDown = (watch: OutageWatch): void => {
    for (let i = 0; i < 2; i++) watch.failed('crossref', watch.started(), new SourceError('timeout', 'crossref', 'x'));
  };

  test('three sources switched off by lasting faults leave Crossref, whose retries are kept while it fails', () => {
    const watch = new OutageWatch();
    switchOffAllButCrossref(watch);
    crossrefDown(watch);
    expect(watch.allFailing).toBe(true);
    expect(watch.oneSourceLeft).toBe(true);
    expect(watch.retriesAllowed).toBe(true);
  });

  // An answer from DBLP (optional) shows the network is up, but does not lift a wait, a budget or a bot check.
  test('an answer from another source does not bring a switched-off source back; its own answer does', () => {
    const watch = new OutageWatch();
    switchOffAllButCrossref(watch);
    crossrefDown(watch);
    watch.answered('dblp');
    expect(watch.oneSourceLeft).toBe(true);
    watch.answered('openalex');
    crossrefDown(watch);
    expect(watch.oneSourceLeft).toBe(false);
  });

  // A bot check that DBLP's answers keep interrupting is still a bot check.
  test('two bot checks from OpenReview with DBLP answers in between switch it off', () => {
    const watch = new OutageWatch();
    watch.failed('arxiv', watch.started(), new SourceError('network', 'arxiv', 'x', 3_600_000, until));
    watch.failed('openalex', watch.started(), new SourceError('budget_exhausted', 'openalex', 'x'));
    watch.failed('openreview', watch.started(), new SourceError('unavailable', 'openreview', 'x'));
    watch.answered('dblp');
    watch.failed('openreview', watch.started(), new SourceError('unavailable', 'openreview', 'x'));
    watch.answered('dblp');
    crossrefDown(watch);
    expect(watch.oneSourceLeft).toBe(true);
  });

  test('the last source counts as left only while it fails for a passing fault', () => {
    const watch = new OutageWatch();
    switchOffAllButCrossref(watch);
    expect(watch.oneSourceLeft).toBe(false);
    watch.failed('crossref', watch.started(), new SourceError('bad_response', 'crossref', 'x'));
    expect(watch.oneSourceLeft).toBe(false);
    watch.failed('crossref', watch.started(), new SourceError('unavailable', 'crossref', 'x'));
    expect(watch.oneSourceLeft).toBe(false);
    watch.failed('crossref', watch.started(), new SourceError('timeout', 'crossref', 'x'));
    expect(watch.oneSourceLeft).toBe(true);
    watch.answered('crossref');
    expect(watch.oneSourceLeft).toBe(false);
  });

  test('every required source failing for a passing fault is a real outage: one try each, no waiting out', () => {
    const watch = new OutageWatch();
    for (const source of REQUIRED_SOURCES) for (let i = 0; i < 2; i++) watch.failed(source, watch.started(), new SourceError('network', source, 'x'));
    expect(watch.allFailing).toBe(true);
    expect(watch.oneSourceLeft).toBe(false);
    expect(watch.retriesAllowed).toBe(false);
  });

  test('every required source switched off leaves none: one try each, no waiting out', () => {
    const watch = new OutageWatch();
    switchOffAllButCrossref(watch);
    watch.failed('crossref', watch.started(), new SourceError('rate_limited', 'crossref', 'x', 3_600_000, until));
    expect(watch.allFailing).toBe(true);
    expect(watch.oneSourceLeft).toBe(false);
    expect(watch.retriesAllowed).toBe(false);
  });

  test('two sources switched off leave two: nothing changes', () => {
    const watch = new OutageWatch();
    const sources: SourceName[] = ['arxiv', 'openalex'];
    for (const source of sources) watch.failed(source, watch.started(), new SourceError('budget_exhausted', source, 'x'));
    expect(watch.oneSourceLeft).toBe(false);
  });
});
