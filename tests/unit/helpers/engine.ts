import { vi } from 'vitest';
import type { Cache } from '../../../src/engine/cache';
import type { EngineDeps } from '../../../src/engine/checker';
import type { CheckResult, RawReference, SourceName, WorkRecord } from '../../../src/core/types';
import type { Source } from '../../../src/sources/source';

export const TITLE = 'Graph neural networks for protein folding at scale';

export function ref(index: number, text: string): RawReference {
  return { index, label: `[${index}]`, text };
}

/** A reference the parser reads as title + three authors + year (+ the given identifier). */
export function paperRef(index: number, opts: { title?: string; doi?: string; arxivId?: string } = {}): RawReference {
  const id = opts.doi !== undefined ? ` doi:${opts.doi}` : opts.arxivId !== undefined ? ` arXiv:${opts.arxivId}` : '';
  const venue = id === '' ? ' Nature Methods, 2019.' : ', 2019.';
  return ref(index, `Jane Roe, John Smith, Wei Chen. ${opts.title ?? TITLE}.${venue}${id}`);
}

export function record(over: Partial<WorkRecord> = {}): WorkRecord {
  return { source: 'crossref', title: TITLE, authors: ['roe', 'smith', 'chen'], year: 2019, isRetracted: false, notes: [], ...over };
}

export type MockSource = { [K in keyof Source]: Source[K] } & {
  lookupById: ReturnType<typeof vi.fn<Source['lookupById']>>;
  search: ReturnType<typeof vi.fn<Source['search']>>;
};

export function mockSource(name: SourceName, over: Partial<Pick<Source, 'lookupById' | 'search'>> = {}): MockSource {
  return {
    name,
    lookupById: vi.fn<Source['lookupById']>(over.lookupById ?? (() => Promise.resolve(null))),
    search: vi.fn<Source['search']>(over.search ?? (() => Promise.resolve([]))),
  };
}

export type Sources = Record<SourceName, MockSource> & { arxiv: MockSource & { lookupMany: ReturnType<typeof vi.fn<(ids: string[], signal?: AbortSignal) => Promise<Map<string, WorkRecord>>>> } };

export function mockSources(over: Partial<Record<SourceName, Partial<Pick<Source, 'lookupById' | 'search'>>>> = {}, lookupMany?: (ids: string[]) => Promise<Map<string, WorkRecord>>): Sources {
  const arxiv = Object.assign(mockSource('arxiv', over.arxiv), {
    lookupMany: vi.fn<(ids: string[], signal?: AbortSignal) => Promise<Map<string, WorkRecord>>>(lookupMany ?? (() => Promise.resolve(new Map()))),
  });
  return {
    crossref: mockSource('crossref', over.crossref),
    arxiv,
    openreview: mockSource('openreview', over.openreview),
    dblp: mockSource('dblp', over.dblp),
    openalex: mockSource('openalex', over.openalex),
  };
}

/** In-memory Cache that records what was stored. */
export function memoryCache(): Cache & { store: Map<string, CheckResult>; sets: string[] } {
  const store = new Map<string, CheckResult>();
  const sets: string[] = [];
  return {
    store,
    sets,
    get: (key) => Promise.resolve(store.get(key)),
    set: (key, value) => {
      sets.push(key);
      store.set(key, value);
      return Promise.resolve();
    },
    clear: () => {
      store.clear();
      return Promise.resolve();
    },
  };
}

export function makeDeps(sources: Sources, over: Partial<EngineDeps> = {}): EngineDeps & { cache: ReturnType<typeof memoryCache> } {
  const cache = memoryCache();
  return {
    sources,
    retraction: { check: vi.fn(() => Promise.resolve({ retracted: false })) },
    cache,
    now: () => 1_000,
    ...over,
  } as EngineDeps & { cache: ReturnType<typeof memoryCache> };
}
