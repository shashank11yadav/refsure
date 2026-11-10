// A W-second blip on the real adapters, http.ts (with its retries, backoff and limiters) and fake timers. fetch is
// stubbed; nothing leaves the machine. Fresh modules per test.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', async () => ({ browser: (await import('wxt/testing/fake-browser')).fakeBrowser }));

import type { CheckResult, PaperInfo } from '../../../src/core/types';
import { memoryCache, paperRef } from '../helpers/engine';

const PAPER: PaperInfo = { key: 'arxiv:2101.00001', title: 'A paper', url: 'https://arxiv.org/abs/2101.00001', origin: 'arxiv-abs', viaPdf: false };
const titleOf = (i: number): string => `Distinct paper number ${String(i)} on graph networks`;
const EMPTY_FEED = '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><title>q</title><id>x</id><updated>2026-10-28T00:00:00Z</updated><opensearch:totalResults>0</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex><opensearch:itemsPerPage>10</opensearch:itemsPerPage></feed>';

let requests: { at: number; host: string }[];
let t0: number;
let fault: (host: string, sinceStart: number) => 'network' | '503' | 'block' | 'bot' | 'budget' | undefined;
const LATENCY: Record<string, number> = { 'api.crossref.org': 300, 'export.arxiv.org': 600, 'api2.openreview.net': 300, 'dblp.org': 400, 'api.openalex.org': 300 };

function respond(url: URL): Response {
  const host = url.host;
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (host === 'api.crossref.org') {
    const q = url.searchParams.get('query.bibliographic') ?? '';
    const n = /number (\d+) on/.exec(q)?.[1] ?? '0';
    return json({ status: 'ok', message: { items: [{ DOI: `10.5555/x${n}`, type: 'journal-article', title: [titleOf(Number(n))], author: [{ family: 'Roe', given: 'Jane' }, { family: 'Smith', given: 'John' }, { family: 'Chen', given: 'Wei' }], issued: { 'date-parts': [[2019]] }, 'container-title': ['Nature Methods'] }] } });
  }
  if (host === 'export.arxiv.org') return new Response(EMPTY_FEED, { status: 200, headers: { 'content-type': 'application/atom+xml' } });
  if (host === 'api2.openreview.net') return json({ notes: [] });
  if (host === 'dblp.org') return json({ result: { hits: { '@total': '0', '@sent': '0', hit: [] } } });
  return json({ meta: { count: 0 }, results: [] });
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 28, 18, 0)) });
  t0 = Date.now();
  requests = [];
  fault = () => undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: { signal?: AbortSignal }) => {
      const url = new URL(String(input));
      requests.push({ at: Date.now() - t0, host: url.host });
      const kind = fault(url.host, Date.now() - t0);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (kind === 'network') return reject(new TypeError('Failed to fetch'));
          const r =
            kind === '503'
              ? new Response(null, { status: 503, headers: { 'content-type': 'application/json' } })
              : kind === 'block'
                ? new Response(null, { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '3600' } })
                : kind === 'bot'
                  ? new Response(null, { status: 403, headers: { 'content-type': 'text/html' } })
                  : kind === 'budget'
                    ? new Response(null, { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '40000' } })
                    : respond(url);
          Object.defineProperty(r, 'url', { value: url.href });
          resolve(r);
        }, LATENCY[url.host] ?? 300);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'));
        });
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function runReal(n: number): Promise<{ got: CheckResult[]; halted: string | undefined; ms: number }> {
  const checker = await import('../../../src/engine/checker');
  const { arxiv } = await import('../../../src/sources/arxiv');
  const { crossref } = await import('../../../src/sources/crossref');
  const { dblp } = await import('../../../src/sources/dblp');
  const { openalex } = await import('../../../src/sources/openalex');
  const { openreview } = await import('../../../src/sources/openreview');
  const deps = { sources: { crossref, arxiv, openreview, dblp, openalex }, retraction: { check: () => Promise.resolve({ retracted: false }) }, cache: memoryCache(), now: Date.now };
  const got: CheckResult[] = [];
  const refs = Array.from({ length: n }, (_, i) => paperRef(i + 1, { title: titleOf(i + 1) }));
  const p = checker.runCheck({ paper: PAPER, refs, onResult: (r: CheckResult) => got.push(r), signal: new AbortController().signal } as never, deps as never) as Promise<{ halted?: string }>;
  let done = false;
  void p.finally(() => (done = true)).catch(() => undefined);
  for (let i = 0; i < 20_000 && !done; i++) await vi.advanceTimersByTimeAsync(100);
  const s = await p;
  return { got, halted: s.halted, ms: Date.now() - t0 };
}

describe('real http.ts: a blip at every service', () => {
  test('sanity: no blip, every reference Verified', async () => {
    const r = await runReal(40);
    expect(r.got.filter((x) => x.status === 'verified')).toHaveLength(40);
  });
  for (const kind of ['network', '503'] as const) {
    test.each([3, 6, 10, 12, 15, 20, 30])(`${kind} blip of %i s starting at 1 s`, async (w) => {
      fault = (_host, since) => (since >= 1000 && since < 1000 + w * 1000 ? kind : undefined);
      const r = await runReal(40);
      expect(r.got.every((x) => ['verified', 'cant_check'].includes(x.status))).toBe(true);
      // A blip at every service, up to 30 s, never stops the run.
      expect(r.halted).toBeUndefined();
      expect(r.got).toHaveLength(40);
    });
  }
});

describe('real http.ts: steady-state outages elsewhere, a blip at Crossref only', () => {
  // arXiv asks for an hour (503 + Retry-After 3600), OpenReview shows its bot check (403), OpenAlex's search budget is
  // spent (429 + a long Retry-After). Crossref, the one source answering, has a W-second blip.
  for (const kind of ['network', '503'] as const) {
    test.each([15, 18, 20, 22, 25, 30, 45])(`${kind} Crossref blip of %i s`, async (w) => {
      fault = (host, since) => {
        if (host === 'export.arxiv.org') return 'block';
        if (host === 'api2.openreview.net') return 'bot';
        if (host === 'api.openalex.org') return 'budget';
        return host === 'api.crossref.org' && since >= 1000 && since < 1000 + w * 1000 ? kind : undefined;
      };
      const r = await runReal(40);
      expect(r.got.every((x) => ['verified', 'cant_check'].includes(x.status))).toBe(true);
      // Up to 25 s: no stop, and 37 or more Verified. From 30 s the run may stop: every required source is failing
      // then, and the run offers Try again.
      if (w <= 25) {
        expect(r.halted).toBeUndefined();
        expect(r.got.filter((x) => x.status === 'verified').length).toBeGreaterThanOrEqual(37);
      }
    });
  }
});
