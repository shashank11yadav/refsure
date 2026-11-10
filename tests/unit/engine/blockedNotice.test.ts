// A source blocked by a long Retry-After is reported to the caller with the time the block ends,
// once per source and block, so the panel can name both.
import { describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', async () => ({ browser: (await import('wxt/testing/fake-browser')).fakeBrowser }));

import type { PaperInfo, SourceName } from '../../../src/core/types';
import { runCheck } from '../../../src/engine/checker';
import { SourceError } from '../../../src/sources/http';
import { makeDeps, mockSources, paperRef } from '../helpers/engine';

const PAPER: PaperInfo = { key: 'arxiv:2101.00001', title: 'A paper', url: 'https://arxiv.org/abs/2101.00001', origin: 'arxiv-abs', viaPdf: false };
const UNTIL = Date.UTC(2026, 9, 28, 19, 42);
const titled = (i: number) => paperRef(i, { title: `Distinct paper number ${String(i)} on graph networks` });
const blocked = (source: SourceName, until = UNTIL) => () => Promise.reject(new SourceError('network', source, 'x', until - 1000, until));

async function told(sources: ReturnType<typeof mockSources>, n = 6): Promise<[SourceName, number][]> {
  const seen: [SourceName, number][] = [];
  await runCheck({ paper: PAPER, refs: Array.from({ length: n }, (_, i) => titled(i + 1)), onResult: () => undefined, onBlocked: (s, until) => seen.push([s, until]), signal: new AbortController().signal }, makeDeps(sources));
  return seen;
}

describe('onBlocked', () => {
  test('is told once per blocked required source, with the end time, however many references hit it', async () => {
    expect(await told(mockSources({ crossref: { search: blocked('crossref') } }))).toEqual([['crossref', UNTIL]]);
  });

  test('is told again when the same source is blocked anew until a later time', async () => {
    let calls = 0;
    const later = UNTIL + 30 * 60_000;
    const crossref = { search: () => Promise.reject(new SourceError('network', 'crossref', 'x', 1, ++calls > 2 ? later : UNTIL)) };
    expect(await told(mockSources({ crossref }))).toEqual([
      ['crossref', UNTIL],
      ['crossref', later],
    ]);
  });

  test('an earlier end time for a source already told is not told: the later time stands', async () => {
    let calls = 0;
    const earlier = UNTIL - 30 * 60_000;
    const crossref = { search: () => Promise.reject(new SourceError('network', 'crossref', 'x', 1, ++calls > 2 ? earlier : UNTIL)) };
    expect(await told(mockSources({ crossref }))).toEqual([['crossref', UNTIL]]);
  });

  test('is not told for DBLP (optional, it never makes a reference Can\'t check), nor for a failure without a block', async () => {
    const sources = mockSources({ dblp: { search: blocked('dblp') }, arxiv: { search: () => Promise.reject(new SourceError('network', 'arxiv', 'x')) } });
    expect(await told(sources)).toEqual([]);
  });

  test('a blocked rate limit is still told as a limit too, so a run without the panel keeps its old notice', async () => {
    const limited: SourceName[] = [];
    const seen: SourceName[] = [];
    const sources = mockSources({ crossref: { search: () => Promise.reject(new SourceError('rate_limited', 'crossref', 'x', 1, UNTIL)) } });
    await runCheck({ paper: PAPER, refs: [titled(1)], onResult: () => undefined, onLimited: (s) => limited.push(s), onBlocked: (s) => seen.push(s), signal: new AbortController().signal }, makeDeps(sources));
    expect(limited).toEqual(['crossref']);
    expect(seen).toEqual(['crossref']);
  });
});
