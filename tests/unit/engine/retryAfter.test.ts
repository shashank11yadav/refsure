// Retry-After is honoured end to end, with the real adapters and http.ts on a stubbed fetch and fake timers. Each test
// loads a fresh copy of the modules (vi.resetModules).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', async () => ({ browser: (await import('wxt/testing/fake-browser')).fakeBrowser }));

import type { CheckResult, PaperInfo, SourceName } from '../../../src/core/types';
import { memoryCache, paperRef } from '../helpers/engine';

const PAPER: PaperInfo = { key: 'arxiv:2101.00001', title: 'A paper', url: 'https://arxiv.org/abs/2101.00001', origin: 'arxiv-abs', viaPdf: false };
let requests: string[];
let answer: (url: URL) => Response;
/** Milliseconds before the n-th response (0-based) arrives. */
let latency: (n: number) => number = () => 0;

function reply(url: string, status: number, headers: Record<string, string> = {}, body: string | null = null): Response {
  const r = new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
  Object.defineProperty(r, 'url', { value: url });
  return r;
}

beforeEach(() => {
  vi.resetModules();
  latency = () => 0;
  vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 28, 18, 0)) });
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const n = requests.push(String(input)) - 1;
      const ms = latency(n);
      const r = answer(new URL(String(input)));
      return ms === 0 ? Promise.resolve(r) : new Promise((resolve) => setTimeout(() => resolve(r), ms));
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function engine() {
  const checker = await import('../../../src/engine/checker');
  const { arxiv } = await import('../../../src/sources/arxiv');
  const { crossref } = await import('../../../src/sources/crossref');
  const { dblp } = await import('../../../src/sources/dblp');
  const { openalex } = await import('../../../src/sources/openalex');
  const { openreview } = await import('../../../src/sources/openreview');
  const deps = { sources: { crossref, arxiv, openreview, dblp, openalex }, retraction: { check: () => Promise.resolve({ retracted: false }) }, cache: memoryCache(), now: Date.now };
  return { checker, deps };
}

async function drive<T>(p: Promise<T>): Promise<T> {
  let done = false;
  void p.finally(() => (done = true)).catch(() => undefined);
  for (let i = 0; i < 4000 && !done; i++) await vi.advanceTimersByTimeAsync(250);
  return p;
}

describe('Try again during a block sends nothing', () => {
  test('every service answers 503 with Retry-After: 3600; the second run sends no request at all', async () => {
    answer = (url) => reply(url.href, 503, { 'retry-after': '3600' });
    const { checker, deps } = await engine();
    const refs = Array.from({ length: 20 }, (_, i) => paperRef(i + 1, { title: `Distinct paper number ${String(i + 1)} on graph networks`, ...(i % 4 === 0 && { arxivId: `2101.${String(i).padStart(5, '0')}` }) }));
    const blocked1: [SourceName, number][] = [];
    const s1 = await drive(checker.runCheck({ paper: PAPER, refs, onResult: () => undefined, onBlocked: (s: SourceName, u: number) => blocked1.push([s, u]), signal: new AbortController().signal } as never, deps as never));
    const first = requests.length;
    expect((s1 as { halted?: string }).halted).toBe('services-down');

    await vi.advanceTimersByTimeAsync(10 * 60_000); // ten minutes later, well inside the block
    const got: CheckResult[] = [];
    const blocked2: [SourceName, number][] = [];
    const t0 = Date.now();
    const s2 = await drive(checker.runCheck({ paper: PAPER, refs, onResult: (r: CheckResult) => got.push(r), onBlocked: (s: SourceName, u: number) => blocked2.push([s, u]), signal: new AbortController().signal } as never, deps as never));
    expect(requests.length).toBe(first);
    expect(got.every((r) => r.status === 'cant_check')).toBe(true);
    // The run stops at once and names every required source with its wait.
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((s2 as { halted?: string }).halted).toBe('services-down');
    expect(new Set(blocked2.map(([s]) => s))).toEqual(new Set(['crossref', 'arxiv', 'openreview', 'openalex']));
  });
});

describe('a block is never shortened or sidestepped', () => {
  // Three Crossref requests are in flight together (Crossref's gate allows three). The first answer asks for an hour, a
  // later one, already sent, asks for two minutes. The hour must stand.
  test('a shorter Retry-After that arrives later does not shorten a longer block', async () => {
    const http = await import('../../../src/sources/http');
    let n = 0;
    answer = (url) => {
      n++;
      return n === 1 ? reply(url.href, 503, { 'retry-after': '3600' }) : reply(url.href, 503, { 'retry-after': '120' });
    };
    // The first answer takes a second; the second request is sent (Crossref allows three a second) before it arrives.
    latency = (i) => (i === 0 ? 1000 : 1200);
    const base = 'https://api.crossref.org/works?query.bibliographic=';
    const a = http.fetchJson(`${base}a`, { source: 'crossref' }).catch((e: unknown) => e);
    const b = http.fetchJson(`${base}b`, { source: 'crossref' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3000);
    const ea = (await a) as { blockedUntil?: number };
    const eb = (await b) as { blockedUntil?: number };
    // The later, shorter answer keeps the hour that the first one asked for.
    expect(ea.blockedUntil).toBe(Date.UTC(2026, 9, 28, 19, 0, 1));
    expect(eb.blockedUntil).toBe(ea.blockedUntil);
    const sentBefore = requests.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000); // five minutes: past the two, well inside the hour
    answer = (url) => reply(url.href, 200, {}, '{"message":{"items":[]}}');
    await http.fetchJson(`${base}c`, { source: 'crossref' }).catch((e: unknown) => e);
    expect(requests.length - sentBefore).toBe(0);
  });

  // OpenAlex answers an id lookup with 503 and Retry-After: 3600 (maintenance). Its searches are a separate lane in
  // http.ts; they should not be sent during the hour either.
  test('an OpenAlex outage reported on the id lane also holds back the search lane', async () => {
    const http = await import('../../../src/sources/http');
    answer = (url) => reply(url.href, 503, { 'retry-after': '3600' });
    await drive(http.fetchJson('https://api.openalex.org/works/doi:10.1/x', { source: 'openalex' }).catch((e: unknown) => e));
    const sent = requests.length;
    await drive(http.fetchJson('https://api.openalex.org/works?search=graph', { source: 'openalex', lane: 'search' }).catch((e: unknown) => e));
    expect(requests.length - sent).toBe(0);
  });
});

