import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', async () => ({ browser: (await import('wxt/testing/fake-browser')).fakeBrowser }));
import { RATE } from '../../../src/config';
import { arxivUrl, doiUrl } from '../../../src/core/identifiers';
import type { CheckResult, PaperInfo, SourceName, WorkRecord } from '../../../src/core/types';
import { checkReference, defaultDeps, HALT_AFTER, runCheck } from '../../../src/engine/checker';
import { updateSettings } from '../../../src/engine/settings';
import { RefusedRedirectError, SourceError, UrlNotAllowedError } from '../../../src/sources/http';
import { makeDeps, mockSources, paperRef, record, ref, TITLE } from '../helpers/engine';

const controller = (): AbortSignal => new AbortController().signal;
const unavailable = (source: SourceName): SourceError => new SourceError('unavailable', source, 'down');
const fail = (source: SourceName, kind: SourceError['kind'] = 'unavailable') => () => Promise.reject(new SourceError(kind, source, 'x'));

describe('checkReference: lookup by identifier', () => {
  test('a DOI that resolves to the cited paper is verified via the id', async () => {
    const sources = mockSources({ crossref: { lookupById: () => Promise.resolve(record({ doi: '10.1000/xyz123' })) } });
    const deps = makeDeps(sources);
    const r = await checkReference(paperRef(1, { doi: '10.1000/xyz123' }), deps, controller());
    expect(r.status).toBe('verified');
    expect(r.index).toBe(1);
    expect(r.label).toBe('[1]');
    expect(r.links).toContainEqual({ label: 'DOI', url: doiUrl('10.1000/xyz123') });
    expect(sources.crossref.search).not.toHaveBeenCalled();
    expect(sources.openalex.search).not.toHaveBeenCalled();
    expect(deps.retraction.check).toHaveBeenCalledTimes(1);
  });

  test('falls back to OpenAlex by id when Crossref has no such DOI', async () => {
    const sources = mockSources({ openalex: { lookupById: () => Promise.resolve(record({ source: 'openalex' })) } });
    const r = await checkReference(paperRef(1, { doi: '10.48550/arxiv.2101.00001' }), makeDeps(sources), controller());
    expect(r.status).toBe('verified');
    expect(sources.crossref.lookupById).toHaveBeenCalledTimes(1);
    expect(sources.openalex.lookupById).toHaveBeenCalledTimes(1);
    expect(sources.openalex.search).not.toHaveBeenCalled();
  });

  test('an arXiv ID that resolves is verified and linked', async () => {
    const sources = mockSources({ arxiv: { lookupById: () => Promise.resolve(record({ source: 'arxiv', arxivId: '2101.00001' })) } });
    const r = await checkReference(paperRef(2, { arxivId: '2101.00001' }), makeDeps(sources), controller());
    expect(r.status).toBe('verified');
    expect(r.links).toContainEqual({ label: 'arXiv', url: arxivUrl('2101.00001') });
    expect(sources.crossref.lookupById).not.toHaveBeenCalled();
  });

  test('an ID with a different title is Wrong ID: no search, no retraction lookup', async () => {
    // A different paper has different authors; the same authors and year would only be a reworded title (see the Wrong ID tests below).
    const sources = mockSources({ crossref: { lookupById: () => Promise.resolve(record({ title: 'Quantum chromodynamics on the lattice', authors: ['feynman', 'gell'], year: 1987, doi: '10.1000/xyz123' })) } });
    const deps = makeDeps(sources);
    const r = await checkReference(paperRef(1, { doi: '10.1000/xyz123' }), deps, controller());
    expect(r.status).toBe('wrong_id');
    expect(r.diffs.some((d) => d.field === 'identifier')).toBe(true);
    expect(sources.crossref.search).not.toHaveBeenCalled();
    expect(deps.retraction.check).not.toHaveBeenCalled();
    expect(r.match?.title).toBe('Quantum chromodynamics on the lattice');
  });

  test('when both ids are cited, a wrong one is not hidden by the right one', async () => {
    const sources = mockSources({
      crossref: { lookupById: () => Promise.resolve(record()) },
      arxiv: { lookupById: () => Promise.resolve(record({ source: 'arxiv', title: 'Something else entirely about whales', authors: ['melville'], year: 1851 })) },
    });
    const text = `Jane Roe, John Smith, Wei Chen. ${TITLE}. 2019. doi:10.1000/xyz123 arXiv:2101.00001`;
    const r = await checkReference(ref(1, text), makeDeps(sources), controller());
    expect(r.status).toBe('wrong_id');
  });

  test('an ID that resolves nowhere falls through to a title search', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record()]) } });
    const r = await checkReference(paperRef(1, { doi: '10.1000/xyz123' }), makeDeps(sources), controller());
    expect(r.status).toBe('verified');
    expect(sources.crossref.search).toHaveBeenCalledTimes(1);
  });
});

describe('checkReference: search', () => {
  test('searches crossref, arxiv, openreview, dblp, openalex in order and stops at the first hit', async () => {
    const order: string[] = [];
    const empty = (name: string) => () => {
      order.push(name);
      return Promise.resolve([]);
    };
    const sources = mockSources({
      crossref: { search: empty('crossref') },
      arxiv: { search: empty('arxiv') },
      openreview: {
        search: () => {
          order.push('openreview');
          return Promise.resolve([record({ source: 'openreview', openreviewId: 'abc123XYZ' })]);
        },
      },
      dblp: { search: empty('dblp') },
      openalex: { search: empty('openalex') },
    });
    const r = await checkReference(paperRef(1), makeDeps(sources), controller());
    expect(order).toEqual(['crossref', 'arxiv', 'openreview']);
    expect(r.status).toBe('verified');
    expect(r.links).toContainEqual({ label: 'OpenReview', url: 'https://openreview.net/forum?id=abc123XYZ' });
  });

  test('skips candidates whose title is not close enough', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record({ title: 'Unrelated work on plasma physics' })]) } });
    const r = await checkReference(paperRef(1), makeDeps(sources), controller());
    expect(r.status).toBe('not_found');
    expect(r.reason).toMatch(/Crossref, arXiv, OpenReview or OpenAlex/);
    expect(r.sourcesSearched).toEqual(expect.arrayContaining(['crossref', 'arxiv', 'openreview', 'openalex']));
    expect(r.sourcesFailed).toEqual([]);
  });

  test('a match with a different year is Details differ', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record({ year: 2012 })]) } });
    const r = await checkReference(paperRef(1), makeDeps(sources), controller());
    expect(r.status).toBe('details_differ');
    expect(r.diffs.map((d) => d.field)).toContain('year');
  });

  test('an unknown kind with a title is searched normally', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record({ authors: ['vaswani'], year: 2017, title: 'Attention is all you need' })]) } });
    const r = await checkReference(ref(1, 'Ashish Vaswani, Noam Shazeer, Niki Parmar. Attention is all you need. NeurIPS, 2017.'), makeDeps(sources), controller());
    expect(sources.crossref.search).toHaveBeenCalledTimes(1);
    expect(r.status).not.toBe('cant_check');
  });
});

describe('checkReference: retraction', () => {
  test('a retracted match is Retracted and links the notice', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record({ doi: '10.1000/xyz123' })]) } });
    const deps = makeDeps(sources, { retraction: { check: vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const, noticeDoi: '10.1000/notice1' })) } });
    const r = await checkReference(paperRef(1), deps, controller());
    expect(r.status).toBe('retracted');
    expect(r.links).toContainEqual({ label: 'Retraction notice', url: doiUrl('10.1000/notice1') });
  });

  test('a failed retraction lookup keeps the match status and adds a note, never Retracted', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record()]) } });
    const deps = makeDeps(sources, { retraction: { check: vi.fn(() => Promise.reject(unavailable('crossref'))) } });
    const r = await checkReference(paperRef(1), deps, controller());
    expect(r.status).toBe('verified');
    expect(r.notes.join(' ')).toMatch(/retraction/i);
    // An incomplete answer must not be remembered as a complete one.
    expect(deps.cache.sets).toEqual([]);
  });

  // The verdict reads a reference again with the record (names left in front of the title), so the
  // retraction lookup is decided on the same reading; otherwise a match made strong by the re-read would be Verified
  // unchecked.
  const ganor = record({ source: 'arxiv', title: 'Small E(8) Instantons and Tensionless Non-critical Strings', authors: ['ganor', 'hanany'], year: 1996, arxivId: 'hep-th/9602120' });
  const inspire = 'O.J. Ganor and A. Hanany, Small E(8) instantons and tensionless noncritical strings, Nucl. Phys. B 474 (1996) 122 [hep-th/9602120].';

  test('a reference read again with the record is looked up for a retraction, and is Retracted when it is', async () => {
    const sources = mockSources({ arxiv: { lookupById: () => Promise.resolve(ganor) } });
    const deps = makeDeps(sources, { retraction: { check: vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const })) } });
    const r = await checkReference(ref(1, inspire), deps, controller());
    expect(deps.retraction.check).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('retracted');
  });

  test('a reference read again with the record is Verified after a clean retraction lookup', async () => {
    const sources = mockSources({ arxiv: { lookupById: () => Promise.resolve(ganor) } });
    const deps = makeDeps(sources);
    const r = await checkReference(ref(1, inspire), deps, controller());
    expect(deps.retraction.check).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('verified');
  });

  test('other names in front of the title are not read as the record’s authors: no retraction lookup, no Retracted', async () => {
    const sources = mockSources({ arxiv: { lookupById: () => Promise.resolve(ganor) } });
    const deps = makeDeps(sources, { retraction: { check: vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const })) } });
    const r = await checkReference(ref(1, inspire.replace('O.J. Ganor and A. Hanany', 'J.R. Roe and K.L. Moe')), deps, controller());
    expect(deps.retraction.check).not.toHaveBeenCalled();
    expect(r.status).not.toBe('retracted');
    expect(r.status).not.toBe('verified');
  });
});

describe('checkReference: unexpected retraction failures', () => {
  test('a non-SourceError from the retraction lookup is logged by name only and read as unknown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record()]) } });
    const deps = makeDeps(sources, { retraction: { check: vi.fn(() => Promise.reject(new TypeError('secret detail'))) } });
    const r = await checkReference(paperRef(1), deps, controller());
    expect(r.status).toBe('verified');
    expect(r.notes.join(' ')).toMatch(/retraction/i);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret detail');
  });

  test('a UrlNotAllowedError from the retraction lookup propagates', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record()]) } });
    const deps = makeDeps(sources, { retraction: { check: vi.fn(() => Promise.reject(new UrlNotAllowedError('nope'))) } });
    await expect(checkReference(paperRef(1), deps, controller())).rejects.toBeInstanceOf(UrlNotAllowedError);
  });
});

describe('checkReference: cant_check rules', () => {
  test('websites are not looked up at all', async () => {
    const sources = mockSources();
    const r = await checkReference(ref(1, 'OpenAI. Our approach to alignment research. https://openai.com/blog/our-approach, 2022.'), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
    for (const s of Object.values(sources)) {
      expect(s.lookupById).not.toHaveBeenCalled();
      expect(s.search).not.toHaveBeenCalled();
    }
  });

  test('an unreadable reference is cant_check and is not cached', async () => {
    const deps = makeDeps(mockSources());
    const r = await checkReference(ref(1, 'x'), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(deps.cache.sets).toEqual([]);
  });
});

describe('checkReference: failures never become Not found', () => {
  test('Crossref unavailable and nothing else matches: cant_check naming Crossref', async () => {
    const sources = mockSources({ crossref: { search: fail('crossref') } });
    const deps = makeDeps(sources);
    const r = await checkReference(paperRef(1), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/Crossref/);
    expect(r.sourcesFailed).toEqual(['crossref']);
    expect(deps.cache.sets).toEqual([]);
  });

  test('a match from another source still wins over a failed one', async () => {
    const sources = mockSources({ crossref: { search: fail('crossref') }, arxiv: { search: () => Promise.resolve([record({ source: 'arxiv' })]) } });
    expect((await checkReference(paperRef(1), makeDeps(sources), controller())).status).toBe('verified');
  });

  test('DBLP failing alone does not block Not found', async () => {
    const sources = mockSources({ dblp: { search: fail('dblp') } });
    const r = await checkReference(paperRef(1), makeDeps(sources), controller());
    expect(r.status).toBe('not_found');
    expect(r.sourcesFailed).not.toContain('dblp');
  });

  test('OpenReview unavailable (403 challenge) blocks Not found', async () => {
    const sources = mockSources({ openreview: { search: fail('openreview') } });
    expect((await checkReference(paperRef(1), makeDeps(sources), controller())).status).toBe('cant_check');
  });

  test.each(['budget_exhausted', 'rate_limited'] as const)('OpenAlex %s is cant_check and says the free daily limit is used up', async (kind) => {
    const sources = mockSources({ openalex: { search: fail('openalex', kind) } });
    const r = await checkReference(paperRef(1), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe("OpenAlex's free daily search limit is used up. Try again tomorrow.");
    expect(r.sourcesFailed).toEqual(['openalex']);
  });

  test('another source that is limited gets a generic reason, never the OpenAlex key hint', async () => {
    const sources = mockSources({ crossref: { search: fail('crossref', 'rate_limited') } });
    const r = await checkReference(paperRef(1), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe("Crossref's lookup limit is reached for now. Try again later.");
  });

  test('several limited sources are named as a list: "A, B and C"', async () => {
    const sources = mockSources({ crossref: { search: fail('crossref', 'rate_limited') }, arxiv: { search: fail('arxiv', 'rate_limited') }, openreview: { search: fail('openreview', 'rate_limited') } });
    const r = await checkReference(paperRef(1), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/^The lookup limits of \S+, \S+ and \S+ are reached for now\. Try again later\.$/);
    for (const name of ['Crossref', 'arXiv', 'OpenReview']) expect(r.reason).toContain(name);
  });

  test('a required source failing for another reason is still cant_check, never Not found, with the plain reason', async () => {
    const sources = mockSources({ openalex: { search: fail('openalex', 'unavailable') } });
    const r = await checkReference(paperRef(1), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).not.toMatch(/limit/i);
  });

  test('an arXiv ID lookup that fails is cant_check, not Not found', async () => {
    const sources = mockSources({ arxiv: { lookupById: fail('arxiv') } });
    const r = await checkReference(paperRef(1, { arxivId: '2101.00001' }), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
  });
});

describe('checkReference: offline', () => {
  test('every source offline: cant_check mentioning offline, nothing cached', async () => {
    const off = (s: SourceName) => ({ lookupById: fail(s, 'offline'), search: fail(s, 'offline') });
    const sources = mockSources({ crossref: off('crossref'), arxiv: off('arxiv'), openreview: off('openreview'), dblp: off('dblp'), openalex: off('openalex') });
    const deps = makeDeps(sources);
    for (const r of [paperRef(1), paperRef(2, { doi: '10.1000/xyz123' })]) {
      const result = await checkReference(r, deps, controller());
      expect(result.status).toBe('cant_check');
      expect(result.reason).toMatch(/offline/i);
    }
    expect(deps.cache.sets).toEqual([]);
  });

  test('a single offline source is enough, and the remaining sources are not tried', async () => {
    const sources = mockSources({ crossref: { search: fail('crossref', 'offline') } });
    const r = await checkReference(paperRef(1), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/offline/i);
    expect(sources.openalex.search).not.toHaveBeenCalled();
  });
});

describe('checkReference: misbehaving sources', () => {
  test('a source that throws a non-SourceError is a failed source, not a crash', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.reject(new TypeError('boom')) } });
    const r = await checkReference(paperRef(1), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
    expect(r.sourcesFailed).toEqual(['crossref']);
  });

  test('a source that returns something that is not a list is a failed source', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve('nonsense' as unknown as WorkRecord[]) } });
    expect((await checkReference(paperRef(1), makeDeps(sources), controller())).status).toBe('cant_check');
  });

  test('a record without a title is ignored, not trusted', async () => {
    const bad = { source: 'crossref', authors: [], isRetracted: false, notes: [] } as unknown as WorkRecord;
    const sources = mockSources({ crossref: { search: () => Promise.resolve([bad]) } });
    expect((await checkReference(paperRef(1), makeDeps(sources), controller())).status).toBe('cant_check');
  });

  test('a UrlNotAllowedError is a programming error and propagates', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.reject(new UrlNotAllowedError('nope')) } });
    await expect(checkReference(paperRef(1), makeDeps(sources), controller())).rejects.toBeInstanceOf(UrlNotAllowedError);
  });

  test('a source that answers after the run was aborted does not produce a result', async () => {
    const ac = new AbortController();
    const sources = mockSources({
      crossref: {
        search: () => {
          ac.abort();
          return Promise.resolve([record()]);
        },
      },
    });
    await expect(checkReference(paperRef(1), makeDeps(sources), ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a storage failure in the cache does not fail the check', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record()]) } });
    const deps = makeDeps(sources);
    deps.cache.get = () => Promise.reject(new Error('storage broken'));
    deps.cache.set = () => Promise.reject(new Error('quota'));
    expect((await checkReference(paperRef(1), deps, controller())).status).toBe('verified');
  });
});

describe('checkReference: cache', () => {
  test('a second check of the same citation is served from the cache with its own index and label', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record()]) } });
    const deps = makeDeps(sources);
    const first = await checkReference(paperRef(1), deps, controller());
    const second = await checkReference(paperRef(9), deps, controller());
    expect(second).toMatchObject({ status: first.status, index: 9, label: '[9]' });
    expect(second.citedText).toBe(paperRef(9).text);
    expect(sources.crossref.search).toHaveBeenCalledTimes(1);
  });

  test('the same DOI cited with a different title is not answered from the first citation', async () => {
    const sources = mockSources({ crossref: { lookupById: () => Promise.resolve(record({ doi: '10.1000/xyz123' })) } });
    const deps = makeDeps(sources);
    expect((await checkReference(paperRef(1, { doi: '10.1000/xyz123' }), deps, controller())).status).toBe('verified');
    const other = await checkReference(paperRef(2, { doi: '10.1000/xyz123', title: 'Completely unrelated study of medieval pottery' }), deps, controller());
    // Same authors and year as the record, so only the title differs: Details differ, not the first citation's Verified.
    expect(other.status).toBe('details_differ');
    expect(other.diffs.map((d) => d.field)).toContain('title');
  });

  test('the cache key holds identifiers and titles only', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record()]) } });
    const deps = makeDeps(sources);
    await checkReference(paperRef(1), deps, controller());
    expect(deps.cache.sets).toHaveLength(1);
    expect(deps.cache.sets[0]).toMatch(/^t:/);
    expect(deps.cache.sets[0]).not.toContain('Jane');
  });
});

describe('checkReference: confident matches only', () => {
  const CITED = 'Application of machine learning in financial risk prediction';
  const NEAR = 'Application of machine learning in financial risk assessment';
  const probeRef = ref(1, `Jane Roe, John Smith. ${CITED}. Nature Methods, 2019.`);
  const retractedCheck = () => vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const, noticeDoi: '10.1000/notice1' }));

  test('a retracted near-miss with different authors is Details differ, never Retracted, and is not looked up', async () => {
    const nearMiss = record({ title: NEAR, authors: ['wang', 'li'], doi: '10.1000/nearmiss' });
    const sources = mockSources({ crossref: { search: () => Promise.resolve([nearMiss]) } });
    const deps = makeDeps(sources, { retraction: { check: retractedCheck() } });
    const r = await checkReference(probeRef, deps, controller());
    expect(r.status).toBe('details_differ');
    expect(r.status).not.toBe('retracted');
    expect(deps.retraction.check).not.toHaveBeenCalled();
    expect(r.links.some((l) => l.label === 'Retraction notice')).toBe(false);
    expect(deps.cache.sets).toHaveLength(1);
    expect([...deps.cache.store.values()].map((v) => v.status)).toEqual(['details_differ']);
  });

  test('a confident search match whose record is retracted is still Retracted', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record({ title: CITED, authors: ['roe', 'smith'], doi: '10.1000/real' })]) } });
    const deps = makeDeps(sources, { retraction: { check: retractedCheck() } });
    const r = await checkReference(probeRef, deps, controller());
    expect(r.status).toBe('retracted');
    expect(deps.retraction.check).toHaveBeenCalledTimes(1);
  });

  test('a title that matches exactly but with different authors is not confident: Details differ, no retraction lookup', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record({ title: CITED, authors: ['wang', 'li'], doi: '10.1000/other' })]) } });
    const deps = makeDeps(sources, { retraction: { check: retractedCheck() } });
    const r = await checkReference(probeRef, deps, controller());
    expect(r.status).toBe('details_differ');
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });

  test('a weak candidate does not stop the search: a later confident one wins', async () => {
    const weak = record({ title: NEAR, authors: ['wang', 'li'], doi: '10.1000/weak' });
    const good = record({ source: 'arxiv', title: CITED, authors: ['roe', 'smith'], arxivId: '2101.00001' });
    const sources = mockSources({ crossref: { search: () => Promise.resolve([weak]) }, arxiv: { search: () => Promise.resolve([good]) } });
    const deps = makeDeps(sources);
    const r = await checkReference(probeRef, deps, controller());
    expect(r.status).toBe('verified');
    expect(r.match?.source).toBe('arxiv');
    expect(sources.crossref.search).toHaveBeenCalledTimes(1);
    expect(sources.arxiv.search).toHaveBeenCalledTimes(1);
    expect(sources.openreview.search).not.toHaveBeenCalled();
  });

  test('with only weak candidates every source is searched and the best one is shown as Details differ', async () => {
    const weak = record({ title: NEAR, authors: ['wang', 'li'], doi: '10.1000/weak' });
    const weaker = record({ source: 'arxiv', title: 'Application of machine learning in financial markets', authors: ['wang'], arxivId: '2101.00002' });
    const sources = mockSources({ crossref: { search: () => Promise.resolve([weaker]) }, arxiv: { search: () => Promise.resolve([weak]) } });
    const deps = makeDeps(sources, { retraction: { check: retractedCheck() } });
    const r = await checkReference(probeRef, deps, controller());
    expect(r.status).toBe('details_differ');
    expect(r.match?.doi).toBe('10.1000/weak');
    for (const name of ['crossref', 'arxiv', 'openreview', 'openalex'] as const) expect(sources[name].search).toHaveBeenCalledTimes(1);
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });

  test('within one source a confident record beats a closer-titled one with the wrong authors', async () => {
    const wrongAuthors = record({ title: CITED, authors: ['wang', 'li'], doi: '10.1000/wrong' });
    const rightAuthors = record({ title: `${CITED}s`, authors: ['roe', 'smith'], doi: '10.1000/right' });
    const sources = mockSources({ crossref: { search: () => Promise.resolve([wrongAuthors, rightAuthors]) } });
    const deps = makeDeps(sources);
    const r = await checkReference(probeRef, deps, controller());
    expect(r.match?.doi).toBe('10.1000/right');
  });

  test('an id match that is not a wrong id is confident: its retraction counts', async () => {
    const sources = mockSources({ crossref: { lookupById: () => Promise.resolve(record({ doi: '10.1000/xyz123' })) } });
    const deps = makeDeps(sources, { retraction: { check: retractedCheck() } });
    expect((await checkReference(paperRef(1, { doi: '10.1000/xyz123' }), deps, controller())).status).toBe('retracted');
  });
});

describe('checkReference: a record is not a Wrong ID on thin evidence', () => {
  test.each(['', '   ', '...'])('a record with title %j for a DOI is never Wrong ID and is not cached: falls to search, else Can\'t check', async (title) => {
    const sources = mockSources({ crossref: { lookupById: () => Promise.resolve(record({ title, authors: [], year: undefined, doi: '10.1000/xyz123' })) } });
    const deps = makeDeps(sources);
    const r = await checkReference(paperRef(1, { doi: '10.1000/xyz123' }), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.status).not.toBe('wrong_id');
    expect(sources.crossref.search).toHaveBeenCalledTimes(1);
    expect(deps.cache.sets).toEqual([]);
  });

  test('a blank-title DOI record with a different year and authors is still not a Wrong ID', async () => {
    const sources = mockSources({ crossref: { lookupById: () => Promise.resolve(record({ title: '', authors: ['zhang'], year: 1999, doi: '10.1000/xyz123' })) } });
    const r = await checkReference(paperRef(1, { doi: '10.1000/xyz123' }), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
  });

  test('a blank-title DOI record is skipped and the title search can still verify the citation', async () => {
    const sources = mockSources({
      crossref: { lookupById: () => Promise.resolve(record({ title: '', doi: '10.1000/xyz123' })), search: () => Promise.resolve([record({ doi: '10.1000/xyz123' })]) },
    });
    const r = await checkReference(paperRef(1, { doi: '10.1000/xyz123' }), makeDeps(sources), controller());
    expect(r.status).toBe('verified');
  });

  test('a blank-title arXiv record is also no evidence', async () => {
    const sources = mockSources({ arxiv: { lookupById: () => Promise.resolve(record({ source: 'arxiv', title: '', authors: ['zhang'], year: 1999, arxivId: '2101.00001' })) } });
    const r = await checkReference(paperRef(1, { arxivId: '2101.00001' }), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
  });

  test('a record in another language with matching authors and year is Details differ with a title difference', async () => {
    const french = record({ title: 'Réseaux de neurones sur graphes pour le repliement des protéines', doi: '10.1000/xyz123' });
    const sources = mockSources({ crossref: { lookupById: () => Promise.resolve(french) } });
    const deps = makeDeps(sources);
    const r = await checkReference(paperRef(1, { doi: '10.1000/xyz123' }), deps, controller());
    expect(r.status).toBe('details_differ');
    expect(r.diffs.map((d) => d.field)).toContain('title');
  });

  test('a different title with the same authors is Details differ whatever the year (the year does not make it a Wrong ID)', async () => {
    const sources = mockSources({ crossref: { lookupById: () => Promise.resolve(record({ title: 'Quantum chromodynamics on the lattice', year: 1987, doi: '10.1000/xyz123' })) } });
    expect((await checkReference(paperRef(1, { doi: '10.1000/xyz123' }), makeDeps(sources), controller())).status).toBe('details_differ');
  });
});

describe('runCheck: history off stores nothing', () => {
  test('with historyEnabled false no cache write is made, with true one is', async () => {
    const run = async (historyEnabled: boolean): Promise<string[]> => {
      await updateSettings({ historyEnabled });
      const sources = mockSources({ crossref: { search: () => Promise.resolve([record()]) } });
      const deps = makeDeps(sources);
      await runCheck({ paper: PAPER, refs: [paperRef(1)], onResult: () => undefined, signal: controller() }, deps);
      return deps.cache.sets;
    };
    expect(await run(false)).toEqual([]);
    expect(await run(true)).toHaveLength(1);
  });
});

describe('checkReference: only a strong match can be Retracted', () => {
  const DOI = '10.1000/xyz123';
  const retractedCheck = () => vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const }));
  const idOnly = (lookup: WorkRecord) => mockSources({ crossref: { lookupById: () => Promise.resolve(lookup) } });
  const zinc = 'Effects of dietary zinc on broiler chicken growth';

  test('a citation with no author names whose DOI resolves to an unrelated retracted paper is Details differ, never Retracted', async () => {
    // Wrong ID needs a reference that names someone; a quoted title alone is no such evidence.
    const deps = makeDeps(idOnly(record({ title: zinc, authors: ['kumar', 'singh'], year: 2019, doi: DOI })), { retraction: { check: retractedCheck() } });
    const r = await checkReference(ref(1, `"${TITLE}." Nature Methods, 2019. doi:${DOI}`), deps, controller());
    expect(r.status).toBe('details_differ');
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });

  test('an unrelated retracted record with no authors and no year is Wrong ID', async () => {
    const deps = makeDeps(idOnly(record({ title: zinc, authors: [], year: undefined, doi: DOI })), { retraction: { check: retractedCheck() } });
    const r = await checkReference(paperRef(1, { doi: DOI }), deps, controller());
    expect(r.status).toBe('wrong_id');
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });

  test('the same authors and year on a completely different title is Details differ, never Retracted, no lookup', async () => {
    // Authors that genuinely agree make a different title look like a reworded or translated one, so this
    // is not called Wrong ID; it must still never be called Retracted.
    const deps = makeDeps(idOnly(record({ title: 'Contrastive pretraining of single-cell transcriptomes', doi: DOI })), { retraction: { check: retractedCheck() } });
    const r = await checkReference(paperRef(1, { doi: DOI }), deps, controller());
    expect(r.status).toBe('details_differ');
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });

  test.each([
    [`${TITLE}: methods and benchmarks`, TITLE],
    [TITLE, 'Graph neural networks'],
  ])('an id record whose title is only a prefix (%j vs %j), by other authors, retracted: never Retracted, no lookup', async (cited, prefix) => {
    const deps = makeDeps(idOnly(record({ title: prefix, authors: ['vaswani'], year: 2019, doi: DOI })), { retraction: { check: retractedCheck() } });
    const r = await checkReference(paperRef(1, { doi: DOI, title: cited }), deps, controller());
    expect(r.status).not.toBe('retracted');
    expect(['details_differ', 'wrong_id']).toContain(r.status);
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });

  test('an id record with the right title and authors but a year 3 off is not strong: Details differ, no lookup', async () => {
    const deps = makeDeps(idOnly(record({ year: 2022, doi: DOI })), { retraction: { check: retractedCheck() } });
    const r = await checkReference(paperRef(1, { doi: DOI }), deps, controller());
    expect(r.status).toBe('details_differ');
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });

  test('a retracted sibling paper by the same authors in Crossref does not beat the exact match in arXiv', async () => {
    const cited = 'Deep learning for lung nodule detection in CT images';
    const sibling = record({ title: 'Deep learning for lung nodule detection in MRI images', authors: ['roe', 'smith'], year: 2021, doi: '10.1000/sibling' });
    const real = record({ source: 'arxiv', title: cited, authors: ['roe', 'smith'], year: 2021, arxivId: '2101.00009' });
    const sources = mockSources({ crossref: { search: () => Promise.resolve([sibling]) }, arxiv: { search: () => Promise.resolve([real]) } });
    const deps = makeDeps(sources, { retraction: { check: vi.fn((m: WorkRecord) => Promise.resolve(m.doi === '10.1000/sibling' ? { retracted: true, version: 'cited' as const } : { retracted: false })) } });
    const r = await checkReference(ref(1, `Jane Roe and John Smith. ${cited}. In Proceedings of MICCAI, 2021.`), deps, controller());
    expect(r.status).toBe('verified');
    expect(r.match?.arxivId).toBe('2101.00009');
    expect(sources.crossref.search).toHaveBeenCalledTimes(1);
    expect(deps.retraction.check).toHaveBeenCalledTimes(1);
    expect(deps.retraction.check).toHaveBeenCalledWith(real, expect.anything());
  });

  test('a sibling that is the only candidate (confident, not strong) is Verified or Details differ but never Retracted, no lookup', async () => {
    const sibling = record({ title: 'Graph neural networks for protein folding at scales', authors: ['roe', 'smith', 'chen'], year: 2019, doi: '10.1000/sibling' });
    const sources = mockSources({ crossref: { search: () => Promise.resolve([sibling]) } });
    const deps = makeDeps(sources, { retraction: { check: retractedCheck() } });
    const r = await checkReference(paperRef(1), deps, controller());
    expect(r.status).not.toBe('retracted');
    expect(deps.retraction.check).not.toHaveBeenCalled();
    // The search went on to the other sources.
    expect(sources.openalex.search).toHaveBeenCalledTimes(1);
  });

  test('a strong match that is retracted is Retracted', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record({ doi: '10.1000/real' })]) } });
    const deps = makeDeps(sources, { retraction: { check: retractedCheck() } });
    expect((await checkReference(paperRef(1), deps, controller())).status).toBe('retracted');
    expect(sources.arxiv.search).not.toHaveBeenCalled();
  });

  test('a translated title with genuinely agreeing authors and the year off by 2 is Details differ, not Wrong ID, no lookup', async () => {
    const french = record({ title: 'Réseaux de neurones sur graphes pour le repliement des protéines', year: 2021, doi: DOI });
    const deps = makeDeps(idOnly(french), { retraction: { check: retractedCheck() } });
    const r = await checkReference(paperRef(1, { doi: DOI }), deps, controller());
    expect(r.status).toBe('details_differ');
    expect(r.diffs.map((d) => d.field)).toContain('title');
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });

  describe('an author-less citation against an author-less retracted record', () => {
    const authorless = (title: string) => ref(1, `"${title}." Nature Methods, 2019.`);
    const run = async (recordTitle: string) => {
      const sources = mockSources({ crossref: { search: () => Promise.resolve([record({ title: recordTitle, authors: [], year: 2019, doi: '10.1000/nobody' })]) } });
      const deps = makeDeps(sources, { retraction: { check: retractedCheck() } });
      return { r: await checkReference(authorless(TITLE), deps, controller()), deps };
    };

    test('at 0.96 it is not Retracted and not looked up', async () => {
      const { r, deps } = await run(`${TITLE.replace('at scale', 'at a scale')}`);
      expect(r.status).not.toBe('retracted');
      expect(deps.retraction.check).not.toHaveBeenCalled();
    });

    test('at an identical title it is Retracted', async () => {
      const { r } = await run(TITLE);
      expect(r.status).toBe('retracted');
    });
  });
});

describe('checkReference: identifier-only citations can surface retractions', () => {
  const DOI = '10.1000/xyz123';
  // Parses as two authors and a year, with no title.
  const idOnly = ref(1, `Jane Roe, John Smith. 2019. doi:${DOI}`);
  const lookup = (title: string) => mockSources({ crossref: { lookupById: () => Promise.resolve(record({ title, doi: DOI })) } });

  test('a retracted record is Retracted', async () => {
    const deps = makeDeps(lookup(TITLE), { retraction: { check: vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const })) } });
    expect((await checkReference(idOnly, deps, controller())).status).toBe('retracted');
    expect(deps.retraction.check).toHaveBeenCalledTimes(1);
  });

  test('the same record, not retracted, is Verified', async () => {
    const deps = makeDeps(lookup(TITLE));
    expect((await checkReference(idOnly, deps, controller())).status).toBe('verified');
    expect(deps.retraction.check).toHaveBeenCalledTimes(1);
  });

  test.each(['', '   ', '...'])('a record with title %j is Can\'t check, not looked up for retraction and not cached', async (title) => {
    const sources = lookup(title);
    const deps = makeDeps(sources, { retraction: { check: vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const })) } });
    const r = await checkReference(idOnly, deps, controller());
    expect(r.status).toBe('cant_check');
    expect(deps.retraction.check).not.toHaveBeenCalled();
    expect(deps.cache.sets).toEqual([]);
    expect(sources.crossref.search).not.toHaveBeenCalled();
  });
});

describe('checkReference: bare identifiers reach the lookup', () => {
  test.each([['doi:10.1000/x'], ['https://doi.org/10.1000/xyz123'], ['[1] 10.1000/xyz123']])('%s is looked up by DOI', async (text) => {
    const sources = mockSources({ crossref: { lookupById: () => Promise.resolve(record({ doi: '10.1000/xyz123' })) } });
    const r = await checkReference(ref(1, text), makeDeps(sources), controller());
    expect(sources.crossref.lookupById).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('verified');
  });

  test('arXiv:1706.03762 is looked up by arXiv id', async () => {
    const sources = mockSources({ arxiv: { lookupById: () => Promise.resolve(record({ source: 'arxiv', arxivId: '1706.03762' })) } });
    const r = await checkReference(ref(1, 'arXiv:1706.03762'), makeDeps(sources), controller());
    expect(sources.arxiv.lookupById).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('verified');
  });

  test('a bare DOI whose record is retracted is Retracted', async () => {
    const sources = mockSources({ crossref: { lookupById: () => Promise.resolve(record({ doi: '10.1000/xyz123' })) } });
    const deps = makeDeps(sources, { retraction: { check: vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const, noticeDoi: '10.1000/notice1' })) } });
    const r = await checkReference(ref(1, 'doi:10.1000/xyz123'), deps, controller());
    expect(r.status).toBe('retracted');
    expect(r.links).toContainEqual({ label: 'Retraction notice', url: doiUrl('10.1000/notice1') });
  });

  test('a bare identifier that resolves nowhere is Can\'t check, never Not found (nothing to search by)', async () => {
    const r = await checkReference(ref(1, 'doi:10.1000/xyz123'), makeDeps(mockSources()), controller());
    expect(r.status).toBe('cant_check');
  });

  test('garbage with no identifier is still Can\'t check and sends nothing', async () => {
    const sources = mockSources();
    const deps = makeDeps(sources);
    for (const text of ['x', '???', '10.5 and 1234.5']) {
      expect((await checkReference(ref(1, text), deps, controller())).status, text).toBe('cant_check');
    }
    for (const s of Object.values(sources)) {
      expect(s.lookupById).not.toHaveBeenCalled();
      expect(s.search).not.toHaveBeenCalled();
    }
    expect(deps.cache.sets).toEqual([]);
  });
});

describe('checkReference: references whose authors the parser missed', () => {
  const PRL = '10.1103/physrevlett.98.123401';
  const quantum = record({ title: 'Quantum transport in twisted bilayer graphene', authors: ['roe', 'smith', 'chen'], year: 2020, doi: PRL });
  const D = 'doi:10.1103/PhysRevLett.98.123401';
  const U = 'https://doi.org/10.1103/PhysRevLett.98.123401';
  const withRecord = (rec: WorkRecord, retracted = false) =>
    makeDeps(mockSources({ crossref: { lookupById: () => Promise.resolve(rec) } }), { retraction: { check: vi.fn(() => Promise.resolve(retracted ? { retracted: true, version: 'cited' as const } : { retracted: false })) } });

  test.each([
    `J. Roe and J. Smith, Science 367, 123 (2020), ${D}.`,
    `J. Roe, J. Smith, Science 367, 123 (2020), ${D}.`,
    `J. Roe, J. Smith, W. Chen, Science 367, 123 (2020). ${U}`,
    `J. Roe and J. Smith, Nature 571, 95 (2020), ${D}.`,
    `J. Roe and J. Smith, Nat. Phys. 16, 1 (2020), ${D}.`,
    `J. Roe, J. Smith, and W. Chen, Science 367, 123 (2020), ${D}.`,
    `J. Roe and J. Smith, PNAS 117, 1 (2020). ${U}`,
    `Jane Roe and John Smith (2020). ${D}`,
    `Roe, J. & Smith, J. 2020, ApJ, 900, 1. ${D}`,
    `Retrieved from ${U}`,
    `Supplementary material, ${D}`,
  ])('correct DOI, %s: never Wrong ID', async (text) => {
    const r = await checkReference(ref(1, text), withRecord(quantum), controller());
    expect(['verified', 'details_differ']).toContain(r.status);
  });

  test('a retracted record cited in Science style with the right DOI is Retracted (raw-text agreement is genuine agreement)', async () => {
    const deps = withRecord(quantum, true);
    const r = await checkReference(ref(1, `J. Roe and J. Smith, Science 367, 123 (2020), ${D}.`), deps, controller());
    expect(r.status).toBe('retracted');
    expect(deps.retraction.check).toHaveBeenCalledTimes(1);
  });

  test('a bare DOI of a retracted record is still Retracted', async () => {
    expect((await checkReference(ref(1, `doi:${PRL}`), withRecord(quantum, true), controller())).status).toBe('retracted');
  });

  const OTHER = record({ title: 'Effects of dietary zinc on broiler chicken growth', authors: ['kumar', 'singh'], year: 2009, doi: '10.1000/xyz124' });

  test.each([
    ['Vancouver style', 'Roe J, Smith J. Nature 2020;571:95. doi:10.1000/xyz124'],
    ['one author, another year', 'Roe, J. Nature 2019; 571: 95. doi:10.1000/xyz124'],
  ])('%s: a DOI typo that lands on another retracted record is Can\'t check, not Retracted, no lookup', async (_name, text) => {
    const deps = withRecord(OTHER, true);
    const r = await checkReference(ref(1, text), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe("The identifier points to a record that doesn't match the other details");
    expect(deps.retraction.check).not.toHaveBeenCalled();
    expect(deps.cache.sets).toEqual([]);
  });

});

describe('checkReference: overlong text with an identifier', () => {
  const filler = Array.from({ length: 45 }, (_, i) => `[${i + 2}] A. Author${i} and B. Writer${i}. Some paper number ${i} on topic ${i}. In Proc. Conf ${i}, 2019, pp. 1-10.`).join(' ');
  const blob = `Jane Roe, John Smith and Wei Chen. ${TITLE}. Nature Methods, 2019. ${filler} [50] K. Kumar and S. Singh. Effects of dietary zinc on broiler chicken growth. Poultry Sci. 2009. doi:10.1000/xyz124`;
  const other = record({ title: 'Effects of dietary zinc on broiler chicken growth', authors: ['kumar', 'singh'], year: 2009, doi: '10.1000/xyz124' });

  test.each([false, true])('O1/O2: a merged blob over 4000 characters (record retracted: %s) is Can\'t check and nothing is sent', async (retracted) => {
    const sources = mockSources({ crossref: { lookupById: () => Promise.resolve(other) } });
    const deps = makeDeps(sources, { retraction: { check: vi.fn(() => Promise.resolve({ retracted, version: 'cited' as const })) } });
    expect(blob.length).toBeGreaterThan(4000);
    const r = await checkReference(ref(1, blob), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(sources.crossref.lookupById).not.toHaveBeenCalled();
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });

  test('a low-confidence reference with an identifier is checked by the identifier alone: Verified, never Details differ', async () => {
    // Parses as three authors, no title, no year (confidence 0.35); the record shares only one surname.
    const text = 'Jane Roe, John Smith, Wei Chen. doi:10.1000/xyz123';
    const sources = mockSources({ crossref: { lookupById: () => Promise.resolve(record({ title: 'Anything at all here', authors: ['roe', 'kumar', 'singh'], year: 1990, doi: '10.1000/xyz123' })) } });
    const r = await checkReference(ref(1, text), makeDeps(sources), controller());
    expect(r.status).toBe('verified');
  });
});

describe('checkReference: generic short titles', () => {
  const retractedCheck = () => vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const }));
  const crossrefHas = (r: WorkRecord) => mockSources({ crossref: { search: () => Promise.resolve([r]) } });

  test('"Editorial, 2015." against a retracted author-less "Editorial" is never Retracted', async () => {
    const deps = makeDeps(crossrefHas(record({ title: 'Editorial', authors: [], year: 2015, doi: '10.1000/ed' })), { retraction: { check: retractedCheck() } });
    const r = await checkReference(ref(1, 'Editorial, 2015.'), deps, controller());
    expect(r.status).not.toBe('retracted');
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });

  test('"See above" is Can\'t check, not Not found, and sends nothing', async () => {
    const sources = mockSources();
    const r = await checkReference(ref(1, 'see above'), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
    for (const s of Object.values(sources)) expect(s.search).not.toHaveBeenCalled();
  });

  test('"Introduction to the special issue" (five words) is still Retracted at an identical title and a compatible year', async () => {
    const t = 'Introduction to the special issue';
    const text = `"${t}." Journal of X, 2015.`;
    const hit = record({ title: t, authors: [], year: 2015, doi: '10.1000/in' });
    const deps = makeDeps(crossrefHas(hit), { retraction: { check: retractedCheck() } });
    expect((await checkReference(ref(1, text), deps, controller())).status).toBe('retracted');
    const off = makeDeps(crossrefHas({ ...hit, year: 2005 }), { retraction: { check: retractedCheck() } });
    expect((await checkReference(ref(1, text), off, controller())).status).not.toBe('retracted');
    expect(off.retraction.check).not.toHaveBeenCalled();
  });
});

describe('checkReference: an identifier that resolves nowhere, with no title', () => {
  test('says what happened instead of naming sources that were never involved', async () => {
    const r = await checkReference(ref(1, 'doi:10.1000/xyz123'), makeDeps(mockSources()), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe("Couldn't find this identifier and there's no title to search by");
  });
});

describe('checkReference: author zone, name variants and boilerplate', () => {
  const ID = '10.1000/abc';
  const withRecord = (rec: WorkRecord, retracted = false) =>
    makeDeps(mockSources({ crossref: { lookupById: () => Promise.resolve(rec) } }), { retraction: { check: vi.fn(() => Promise.resolve(retracted ? { retracted: true, version: 'cited' as const } : { retracted: false })) } });
  const zinc = (authors: string[], year = 2020) => record({ title: 'Effects of dietary zinc on broiler chicken growth', authors, year, doi: ID });
  const quantum = (over: Partial<WorkRecord> = {}) => record({ title: 'Quantum transport in twisted bilayer graphene', authors: ['roe', 'smith'], year: 2020, doi: ID, ...over });

  // The year of a low-confidence reference is kept, so the year guard fires on a DOI typo.
  test.each([
    ['Y. Wang, Science 367, 123 (2020). doi:10.1000/abc', ['wang', 'kumar']],
    ['Roe 2020, doi:10.1000/abc', ['kumar', 'singh']],
  ])('A: %s against a retracted 2009 record is Can\'t check, never Retracted', async (text, authors) => {
    const deps = withRecord(zinc(authors, 2009), true);
    const r = await checkReference(ref(1, text), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });

  // Ordinary words in the title or venue are not the record's authors.
  test.each([
    ['A. Roe and B. Doe. Long short-term memory networks for traffic forecasting. In ICML, 2020. doi:10.1000/abc', ['long', 'short', 'kim']],
    ['A. Roe and B. Doe. Green computing for large language models. In NeurIPS, 2020. doi:10.1000/abc', ['green', 'kumar', 'singh']],
    ['A. Roe and B. Doe. Robust lidar odometry in forests. Journal of Field Robotics, 2020. doi:10.1000/abc', ['field', 'kumar']],
    ['A. Roe and B. Doe. Social media use among young adults. In CHI, 2020. doi:10.1000/abc', ['young']],
    ['A. Roe and B. Doe. State of health estimation for Li-ion batteries. Energy, 2020. doi:10.1000/abc', ['li', 'wang', 'zhang']],
    ['A. Roe and B. Doe. An analysis of transformer attention heads. In ACL, 2020. doi:10.1000/abc', ['an', 'kumar']],
    ['A. Roe and B. Doe. Accelerating Smith-Waterman alignment on GPUs. Bioinformatics, 2020. doi:10.1000/abc', ['smith', 'kumar']],
    ['A. Roe and B. Doe. Fisher information in deep networks. In ICLR, 2020. doi:10.1000/abc', ['fisher', 'kumar']],
    ['A. Roe and B. Doe. Hidden Markov models for speech. In ICASSP, 2020. doi:10.1000/abc', ['markov']],
    ['Y. Wang and K. Lee. Sparse attention for video transformers. In CVPR, 2020. doi:10.1000/abc', ['wang', 'chen', 'liu']],
  ])('B: hallucinated DOI, %s: Wrong ID', async (text, authors) => {
    const r = await checkReference(ref(1, text), withRecord(zinc(authors)), controller());
    expect(r.status).toBe('wrong_id');
  });

  // A journal citation with no title is no evidence of a Wrong ID (DESIGN 7.2: the cited title needs three real
  // words). Its author names are not its title, so the identifier is left unconfirmed (Can't check), never accused.
  test('names cited, record by others, no title: Can\'t check, never Wrong ID', async () => {
    const r = await checkReference(ref(1, 'J. Roe and J. Smith, Nature 571, 95 (2020). doi:10.1000/abc'), withRecord(zinc(['kumar', 'singh'], 2009), true), controller());
    expect(r.status).toBe('cant_check');
  });

  test.each([
    'J. Roe, J. Smith and W. Chen. Long short-term memory. Nature, 2020. doi:10.1000/abc',
    'Roe J, Smith J. Long short-term memory. Nature 2020;571:95. doi:10.1000/abc',
    'Roe, J., Smith, J. (2020). Long short-term memory. Nature 571, 95. doi:10.1000/abc',
    'J. Roe and J. Smith, "Long short-term memory," Nature, 2020. doi:10.1000/abc',
  ])('B: correct DOI with the authors written before the title, %s: never Wrong ID', async (text) => {
    const r = await checkReference(ref(1, text), withRecord(quantum({ authors: ['roe', 'smith', 'chen'] })), controller());
    expect(['verified', 'details_differ']).toContain(r.status);
  });

  // The same person written another way.
  test.each([
    ['D1 Mueller / muller', 'M. Mueller, Nature 571, 95 (2020). doi:10.1000/abc', quantum({ authors: ['muller'] })],
    ['Muller / mueller', 'M. Muller and J. Weiss, Nature 571, 95 (2020). doi:10.1000/abc', quantum({ authors: ['mueller', 'weiss'] })],
    ['D9 Garcia / garcia perez', 'J. García, Nature 571, 95 (2020). doi:10.1000/abc', quantum({ authors: ['garcia perez'] })],
    ['D10 swapped given and family names', 'X. Wang and Y. Li, Nature 571, 95 (2020). doi:10.1000/abc', quantum({ authors: ['xiaoming', 'yan'], givenNames: ['wang', 'li'] })],
    ['J. Silva / da silva', 'J. Silva, Nature 571, 95 (2020). doi:10.1000/abc', quantum({ authors: ['da silva'] })],
    ['Berg, J. van der / van der berg', 'Berg, J. van der, Nature 571, 95 (2020). doi:10.1000/abc', quantum({ authors: ['van der berg'] })],
  ])('C: %s with the correct DOI is never Wrong ID', async (_name, text, rec) => {
    const r = await checkReference(ref(1, text), withRecord(rec), controller());
    expect(r.status).not.toBe('wrong_id');
  });

  test('C: a given name only counts next to the family name\'s initial, so a common given name does not hide a Wrong ID', async () => {
    const rec = { ...zinc(['kumar']), givenNames: ['john'] };
    const r = await checkReference(ref(1, 'John Roe and Jane Smith. Graph neural networks for protein folding at scale. Nature, 2020. doi:10.1000/abc'), withRecord(rec), controller());
    expect(r.status).toBe('wrong_id');
  });

  // Boilerplate and venue-plus-volume "titles" are no evidence of a different paper.
  test.each([
    'Proceedings of the National Academy of Sciences 117(5), 2345 (2020). doi:10.1000/abc',
    'Accessed on 12 May 2021. https://doi.org/10.1000/abc',
    'Data available at https://doi.org/10.1000/abc',
    'Supplementary material for this article, doi:10.1000/abc',
    'Software, version 2.1. Zenodo, 2020. https://doi.org/10.1000/abc',
  ])('D: correct DOI, %s: never Wrong ID', async (text) => {
    const r = await checkReference(ref(1, text), withRecord(quantum()), controller());
    expect(r.status).not.toBe('wrong_id');
  });

  test('a typo citation of the same DOI and year with other authors does not inherit a cached Retracted', async () => {
    // Both parse with no title (title-less journal style), the same DOI and the same year.
    const deps = withRecord(quantum(), true);
    const first = await checkReference(ref(1, 'J. Roe and J. Smith, Science 367, 123 (2020), doi:10.1000/abc.'), deps, controller());
    expect(first.status).toBe('retracted');
    expect(deps.cache.sets).toHaveLength(1);
    const second = await checkReference(ref(2, 'K. Lee and S. Park, Science 367, 123 (2020), doi:10.1000/abc.'), deps, controller());
    expect(second.status).toBe('cant_check');
    expect(second.reason).toBe("The identifier points to a record that doesn't match the other details");
    // The first citation again is still answered from the cache.
    const again = await checkReference(ref(3, 'J. Roe and J. Smith, Science 367, 123 (2020), doi:10.1000/abc.'), deps, controller());
    expect(again.status).toBe('retracted');
    expect(deps.retraction.check).toHaveBeenCalledTimes(1);
  });

  // "arXiv preprint arXiv:<id>" is not a title.
  test('E: an arXiv preprint line whose id resolves nowhere is not searched as a title', async () => {
    const sources = mockSources();
    const r = await checkReference(ref(1, 'arXiv preprint arXiv:2001.01234, 2020.'), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe("Couldn't find this identifier and there's no title to search by");
    for (const s of Object.values(sources)) expect(s.search).not.toHaveBeenCalled();
  });
});

describe('defaultDeps', () => {
  test('every run shares the same sources, so the per-source gates are shared too', () => {
    expect(defaultDeps().sources).toBe(defaultDeps().sources);
    expect(defaultDeps().cache).toBe(defaultDeps().cache);
  });
});

const PAPER: PaperInfo = { key: 'arxiv:2101.00001', title: 'A paper', url: 'https://arxiv.org/abs/2101.00001', origin: 'arxiv-abs', viaPdf: false };

describe('runCheck', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('batches arXiv IDs into one lookupMany and reports each result and a summary', async () => {
    const sources = mockSources(
      { crossref: { search: () => Promise.resolve([record()]) } },
      (ids) => Promise.resolve(new Map(ids.map((id) => [id, record({ source: 'arxiv', arxivId: id })]))),
    );
    const refs = [paperRef(1, { arxivId: '2101.00001' }), paperRef(2, { arxivId: '2101.00002' }), paperRef(3), ref(4, 'x')];
    const got: CheckResult[] = [];
    const deps = makeDeps(sources);
    const summary = await runCheck({ paper: PAPER, refs, onResult: (r) => got.push(r), signal: controller() }, deps);
    expect(sources.arxiv.lookupMany).toHaveBeenCalledTimes(1);
    expect(sources.arxiv.lookupMany.mock.calls[0]?.[0]).toEqual(['2101.00001', '2101.00002']);
    expect(sources.arxiv.lookupById).not.toHaveBeenCalled();
    expect(got).toHaveLength(4);
    expect(summary.total).toBe(4);
    expect(summary.counts).toMatchObject({ verified: 3, cant_check: 1 });
    expect(summary.beta).toBe(false);
    expect(summary.paper).toBe(PAPER);
    expect(summary.finishedAt).toBeDefined();
  });

  test('an arXiv id that was skipped as cached but is gone at check time is requested, not read as not found', async () => {
    const found = (id: string) => record({ source: 'arxiv', arxivId: id });
    const sources = mockSources({ arxiv: { lookupById: () => Promise.resolve(found('2101.00001')) } }, (ids) => Promise.resolve(new Map(ids.map((id) => [id, found(id)]))));
    const deps = makeDeps(sources);
    // The first look (to decide what to prefetch) sees a cached answer; by check time it has expired.
    const realGet = deps.cache.get;
    let first = true;
    const stale: CheckResult = { index: 0, label: '', citedText: '', status: 'verified', reason: 'cached', diffs: [], notes: [], sourcesSearched: [], sourcesFailed: [], links: [] };
    deps.cache.get = (key) => {
      if (key.startsWith('arxiv:2101.00001') && first) {
        first = false;
        return Promise.resolve(stale);
      }
      return key.startsWith('arxiv:2101.00001') ? Promise.resolve(undefined) : realGet(key);
    };
    const got: CheckResult[] = [];
    await runCheck({ paper: PAPER, refs: [paperRef(1, { arxivId: '2101.00001' }), paperRef(2, { arxivId: '2101.00002' })], onResult: (r) => got.push(r), signal: controller() }, deps);
    expect(sources.arxiv.lookupMany.mock.calls[0]?.[0]).toEqual(['2101.00002']);
    expect(sources.arxiv.lookupById).toHaveBeenCalledTimes(1);
    expect(got.map((r) => r.status)).toEqual(['verified', 'verified']);
  });

  test('an id the batch really asked for and did not get is still not found at arXiv', async () => {
    const sources = mockSources({}, () => Promise.resolve(new Map()));
    const got: CheckResult[] = [];
    await runCheck({ paper: PAPER, refs: [paperRef(1, { arxivId: '2101.00001' })], onResult: (r) => got.push(r), signal: controller() }, makeDeps(sources));
    expect(sources.arxiv.lookupById).not.toHaveBeenCalled();
  });

  test('removes its abort listener when it finishes', async () => {
    const ac = new AbortController();
    const remove = vi.spyOn(ac.signal, 'removeEventListener');
    await runCheck({ paper: PAPER, refs: [paperRef(1)], onResult: () => undefined, signal: ac.signal }, makeDeps(mockSources()));
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  test('asks the cache to flush when the run finishes', async () => {
    const deps = makeDeps(mockSources());
    const flush = vi.fn(() => Promise.resolve());
    deps.cache.flush = flush;
    await runCheck({ paper: PAPER, refs: [paperRef(1)], onResult: () => undefined, signal: controller() }, deps);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  test('a PDF-derived paper is marked beta', async () => {
    const summary = await runCheck({ paper: { ...PAPER, viaPdf: true }, refs: [], onResult: () => undefined, signal: controller() }, makeDeps(mockSources()));
    expect(summary.beta).toBe(true);
    expect(summary.total).toBe(0);
  });

  test('a failed arXiv batch makes those references cant_check, not Not found', async () => {
    const sources = mockSources({}, () => Promise.reject(unavailable('arxiv')));
    const got: CheckResult[] = [];
    await runCheck({ paper: PAPER, refs: [paperRef(1, { arxivId: '2101.00001' })], onResult: (r) => got.push(r), signal: controller() }, makeDeps(sources));
    expect(got[0]?.status).toBe('cant_check');
  });

  // When a paper's one batch of 30 ids times out, the references that have only their id to go on must not end in
  // "try again later" without arXiv being asked again.
  describe('a failed arXiv batch is asked again in smaller batches', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `2101.${String(10_000 + i)}`);
    const refs = ids.map((id, i) => paperRef(i + 1, { arxivId: id }));
    const found = (batch: string[]) => new Map(batch.map((id) => [id, record({ source: 'arxiv', arxivId: id })]));
    const timeout = () => new SourceError('timeout', 'arxiv', 'Request timed out after 15000 ms');

    test('in batches of ten, one request at a time, and every reference is checked by its id', async () => {
      let inFlight = 0;
      let most = 0;
      const sources = mockSources({}, async (batch) => {
        most = Math.max(most, ++inFlight);
        await Promise.resolve();
        inFlight--;
        if (batch.length > 10) throw timeout();
        return found(batch);
      });
      const got: CheckResult[] = [];
      await runCheck({ paper: PAPER, refs, onResult: (r) => got.push(r), signal: controller() }, makeDeps(sources));
      const calls = sources.arxiv.lookupMany.mock.calls.map((c) => c[0]);
      expect(calls.map((c) => c.length)).toEqual([30, 10, 10, 10]);
      expect(calls.slice(1).flat()).toEqual(ids);
      expect(most).toBe(1);
      expect(got.map((r) => r.status)).toEqual(ids.map(() => 'verified'));
      expect(got.every((r) => r.sourcesFailed.length === 0)).toBe(true);
    });

    test('ids that still fail fall through to the title search, and are never Not found or Wrong ID', async () => {
      const sources = mockSources(
        { crossref: { search: (c) => Promise.resolve(c.title === TITLE ? [record()] : []) } },
        (batch) => (batch.includes('2101.10001') ? Promise.reject(timeout()) : Promise.resolve(found(batch))),
      );
      const parts = [
        paperRef(1, { arxivId: '2101.10000' }),
        paperRef(2, { arxivId: '2101.10001' }),
        paperRef(3, { arxivId: '2101.10001', title: 'Sparse mixture routing for long-context retrieval in multilingual corpora' }),
        ref(4, 'DeepSeek-AI, Aixin Liu, Bei Feng, Bing Xue. Deepseek-v3 technical report, 2024. URL https://arxiv.org/abs/2101.10001.'),
      ];
      const got: CheckResult[] = [];
      await runCheck({ paper: PAPER, refs: parts, onResult: (r) => got.push(r), signal: controller() }, makeDeps(sources));
      const byIndex = new Map(got.map((r) => [r.index, r]));
      expect(sources.arxiv.lookupMany.mock.calls.map((c) => c[0])).toEqual([['2101.10000', '2101.10001'], ['2101.10000', '2101.10001']]);
      // Both batches failed: the cited title is searched instead, and verifies the reference only as it would alone.
      expect(byIndex.get(1)?.status).toBe('verified');
      expect(byIndex.get(2)?.status).toBe('verified');
      expect(byIndex.get(2)?.sourcesFailed).toContain('arxiv');
      // An invented title with an id nobody could read: arXiv did not answer, so nothing is Not found.
      expect(byIndex.get(3)?.status).toBe('cant_check');
      expect(byIndex.get(4)?.status).toBe('cant_check');
      expect(byIndex.get(4)?.reason).toMatch(/Try again later/);
      for (const r of got) expect(['not_found', 'wrong_id']).not.toContain(r.status);
      expect(sources.crossref.search).toHaveBeenCalled();
    });

    test('a retry keeps the ids that came back; the others are searched by title', async () => {
      const sources = mockSources(
        { crossref: { search: (c) => Promise.resolve(c.title === TITLE ? [record()] : []) } },
        (batch) => (batch.length > 10 || batch.includes('2101.10015') ? Promise.reject(timeout()) : Promise.resolve(found(batch))),
      );
      const got: CheckResult[] = [];
      await runCheck({ paper: PAPER, refs, onResult: (r) => got.push(r), signal: controller() }, makeDeps(sources));
      const failedArxiv = got.filter((r) => r.sourcesFailed.includes('arxiv')).map((r) => r.index);
      // The second small batch fails: the retry stops there, so the third is not asked either.
      expect(sources.arxiv.lookupMany.mock.calls.map((c) => c[0].length)).toEqual([30, 10, 10]);
      expect(failedArxiv).toEqual(ids.slice(10).map((_, i) => i + 11));
      // The title search verifies them (it alone would), but arXiv's silence is never read as absence.
      expect(got.every((r) => r.status === 'verified')).toBe(true);
    });

    test('a batch whose error carries a Retry-After, or that was redirected out of the allowlist, is not asked again', async () => {
      for (const error of [new SourceError('network', 'arxiv', 'Server error (HTTP 503)', 3_600_000), new RefusedRedirectError('arxiv', 'Redirected to an origin that is not allowed')]) {
        const sources = mockSources({}, () => Promise.reject(error));
        await runCheck({ paper: PAPER, refs: refs.slice(0, 12), onResult: () => undefined, signal: controller() }, makeDeps(sources));
        expect(sources.arxiv.lookupMany).toHaveBeenCalledTimes(1);
      }
    });

    test.each(['rate_limited', 'budget_exhausted', 'forbidden', 'unavailable'] as const)('a batch refused as %s is not asked again', async (kind) => {
      const sources = mockSources({}, () => Promise.reject(new SourceError(kind, 'arxiv', 'x')));
      const got: CheckResult[] = [];
      await runCheck({ paper: PAPER, refs: refs.slice(0, 12), onResult: (r) => got.push(r), signal: controller() }, makeDeps(sources));
      expect(sources.arxiv.lookupMany).toHaveBeenCalledTimes(1);
      expect(got.every((r) => r.status === 'cant_check')).toBe(true);
    });

    test('an abort during the retry ends the run as an abort, not as failed lookups', async () => {
      const ac = new AbortController();
      const sources = mockSources({}, (batch) => {
        if (batch.length > 10) return Promise.reject(timeout());
        ac.abort();
        return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
      await expect(runCheck({ paper: PAPER, refs, onResult: () => undefined, signal: ac.signal }, makeDeps(sources))).rejects.toMatchObject({ name: 'AbortError' });
      expect(sources.arxiv.lookupMany).toHaveBeenCalledTimes(2);
    });

    test('a retry stops at the first refusal, so a rate limit is not walked into again', async () => {
      const sources = mockSources({}, (batch) => Promise.reject(batch.length > 10 ? timeout() : new SourceError('rate_limited', 'arxiv', 'x')));
      await runCheck({ paper: PAPER, refs, onResult: () => undefined, signal: controller() }, makeDeps(sources));
      expect(sources.arxiv.lookupMany).toHaveBeenCalledTimes(2);
    });
  });

  test('cached arXiv ids are not fetched again', async () => {
    const sources = mockSources({}, (ids) => Promise.resolve(new Map(ids.map((id) => [id, record({ source: 'arxiv', arxivId: id })]))));
    const deps = makeDeps(sources);
    const input = { paper: PAPER, refs: [paperRef(1, { arxivId: '2101.00001' })], onResult: () => undefined, signal: controller() };
    await runCheck(input, deps);
    await runCheck(input, deps);
    expect(sources.arxiv.lookupMany).toHaveBeenCalledTimes(1);
  });

  test('offline: every result is cant_check mentioning offline and the cache stays empty', async () => {
    const off = (s: SourceName) => ({ lookupById: fail(s, 'offline'), search: fail(s, 'offline') });
    const sources = mockSources({ crossref: off('crossref'), arxiv: off('arxiv'), openreview: off('openreview'), dblp: off('dblp'), openalex: off('openalex') }, fail('arxiv', 'offline'));
    const refs = [paperRef(1), paperRef(2, { arxivId: '2101.00001' }), paperRef(3, { doi: '10.1000/xyz123' })];
    const got: CheckResult[] = [];
    const deps = makeDeps(sources);
    const summary = await runCheck({ paper: PAPER, refs, onResult: (r) => got.push(r), signal: controller() }, deps);
    expect(got).toHaveLength(3);
    for (const r of got) {
      expect(r.status).toBe('cant_check');
      expect(r.reason).toMatch(/offline/i);
    }
    expect(summary.counts.cant_check).toBe(3);
    expect(deps.cache.store.size).toBe(0);
  });

  describe('limits and the circuit breaker', () => {
    const down = (s: SourceName) => ({ lookupById: fail(s), search: fail(s) });
    const allDown = (): Parameters<typeof mockSources>[0] => ({ crossref: down('crossref'), arxiv: down('arxiv'), openreview: down('openreview'), openalex: down('openalex') });
    const titled = (index: number, title: string) => paperRef(index, { title });

    test('onLimited is told once per source that runs out, however many references hit it', async () => {
      const sources = mockSources({ openalex: { search: fail('openalex', 'budget_exhausted') } });
      const told: SourceName[] = [];
      await runCheck({ paper: PAPER, refs: [1, 2, 3].map((i) => titled(i, `Distinct paper number ${i} on graph networks`)), onResult: () => undefined, onLimited: (s) => told.push(s), signal: controller() }, makeDeps(sources));
      expect(told).toEqual(['openalex']);
    });

    test('DBLP is optional: running out of its budget is not announced as a limit that causes Can\'t check', async () => {
      const sources = mockSources({ dblp: { search: fail('dblp', 'rate_limited') } });
      const told: SourceName[] = [];
      const got: CheckResult[] = [];
      await runCheck({ paper: PAPER, refs: [1, 2, 3].map((i) => titled(i, `Distinct paper number ${i} on graph networks`)), onResult: (r) => got.push(r), onLimited: (s) => told.push(s), signal: controller() }, makeDeps(sources));
      expect(told).toEqual([]);
      expect(got.every((r) => r.status === 'not_found')).toBe(true);
    });

    test('a failed arXiv batch is neutral for the early stop: title-less arXiv-id references do not stop a run that is otherwise fine', async () => {
      const sources = mockSources({}, () => Promise.reject(unavailable('arxiv')));
      const idOnly = Array.from({ length: HALT_AFTER + 3 }, (_, i) => ref(i + 1, `arXiv:2101.${String(i + 1).padStart(5, '0')}`));
      const got: CheckResult[] = [];
      const summary = await runCheck({ paper: PAPER, refs: [...idOnly, titled(20, 'Distinct paper twenty on graph networks')], onResult: (r) => got.push(r), signal: controller() }, makeDeps(sources));
      expect(summary.halted).toBeUndefined();
      expect(got).toHaveLength(idOnly.length + 1);
      expect(got.slice(0, idOnly.length).every((r) => r.status === 'cant_check')).toBe(true);
    });

    test('five references in a row with every lookup failed stop the run; what was reported stands and the rest is never reported', async () => {
      const sources = mockSources(allDown());
      const refs = Array.from({ length: 30 }, (_, i) => titled(i + 1, `Failing paper ${i + 1} on graph networks`));
      const got: CheckResult[] = [];
      const deps = makeDeps(sources);
      const summary = await runCheck({ paper: PAPER, refs, onResult: (r) => got.push(r), signal: controller() }, deps);
      expect(got).toHaveLength(HALT_AFTER);
      expect(got.every((r) => r.status === 'cant_check')).toBe(true);
      expect(summary.halted).toBe('services-down');
      expect(summary.total).toBe(30);
      expect(summary.counts.cant_check).toBe(HALT_AFTER);
      expect(deps.cache.store.size).toBe(0);
    });

    test('a run that is stopped this way does not wait for lookups still in flight', async () => {
      const sources = mockSources({
        ...allDown(),
        crossref: { lookupById: fail('crossref'), search: (c) => (c.title?.includes('Slow') ? new Promise(() => undefined) : Promise.reject(new SourceError('unavailable', 'crossref', 'x'))) },
      });
      const refs = [...Array.from({ length: 5 }, (_, i) => titled(i + 1, `Failing paper ${i + 1}`)), titled(6, 'Slow paper that never answers')];
      const summary = await runCheck({ paper: PAPER, refs, onResult: () => undefined, signal: controller() }, makeDeps(sources));
      expect(summary.halted).toBe('services-down');
    });

    test('one reference that gets an answer in between starts the count again', async () => {
      // Results are counted in the order they finish, so the test holds each group back until the one before it was reported.
      const gates = { first: Promise.withResolvers<undefined>(), fine: Promise.withResolvers<undefined>() };
      const failing = (title: string, after: Promise<undefined>): Promise<WorkRecord[]> => after.then(() => Promise.reject(new SourceError('unavailable', 'crossref', title)));
      const sources = mockSources({
        ...allDown(),
        crossref: {
          lookupById: fail('crossref'),
          search: (c) => {
            const title = c.title ?? '';
            if (title.includes('Fine')) return gates.first.promise.then(() => [record({ title })]);
            return failing(title, title.includes('Late') ? gates.fine.promise : Promise.resolve(undefined));
          },
        },
      });
      const refs = [1, 2, 3, 4].map((i) => titled(i, `Failing paper ${i}`)).concat([titled(5, 'Fine paper five')], [6, 7, 8, 9].map((i) => titled(i, `Late failing paper ${i}`)));
      const got: CheckResult[] = [];
      const summary = await runCheck(
        {
          paper: PAPER,
          refs,
          onResult: (r) => {
            got.push(r);
            if (got.length === 4) gates.first.resolve(undefined);
            if (got.length === 5) gates.fine.resolve(undefined);
          },
          signal: controller(),
        },
        makeDeps(sources),
      );
      expect(got.map((r) => r.status).slice(0, 5)).toEqual(['cant_check', 'cant_check', 'cant_check', 'cant_check', 'verified']);
      expect(got).toHaveLength(9);
      expect(summary.halted).toBeUndefined();
    });

    test('a clean miss (every source answered, none knows it) is not a failure', async () => {
      const refs = Array.from({ length: 8 }, (_, i) => titled(i + 1, `Unknown paper ${i + 1} on graph networks`));
      const got: CheckResult[] = [];
      const summary = await runCheck({ paper: PAPER, refs, onResult: (r) => got.push(r), signal: controller() }, makeDeps(mockSources()));
      expect(got.every((r) => r.status === 'not_found')).toBe(true);
      expect(summary.halted).toBeUndefined();
    });

    test('references with nothing to look up neither count nor reset the streak', async () => {
      const sources = mockSources(allDown());
      const refs = [titled(1, 'Failing paper 1'), titled(2, 'Failing paper 2'), ref(3, 'x'), titled(4, 'Failing paper 4'), ref(5, 'y'), titled(6, 'Failing paper 6'), titled(7, 'Failing paper 7'), titled(8, 'Failing paper 8')];
      const summary = await runCheck({ paper: PAPER, refs, onResult: () => undefined, signal: controller() }, makeDeps(sources));
      expect(summary.halted).toBe('services-down');
    });

    test('offline keeps its own behaviour: every reference is reported and the run is not stopped', async () => {
      const off = (s: SourceName) => ({ lookupById: fail(s, 'offline'), search: fail(s, 'offline') });
      const sources = mockSources({ crossref: off('crossref'), arxiv: off('arxiv'), openreview: off('openreview'), dblp: off('dblp'), openalex: off('openalex') });
      const refs = Array.from({ length: 9 }, (_, i) => titled(i + 1, `Offline paper ${i + 1}`));
      const got: CheckResult[] = [];
      const summary = await runCheck({ paper: PAPER, refs, onResult: (r) => got.push(r), signal: controller() }, makeDeps(sources));
      expect(got).toHaveLength(9);
      expect(summary.halted).toBeUndefined();
    });

    test('a user abort after a halt does not matter, and an abort during a run still rejects', async () => {
      const ac = new AbortController();
      const sources = mockSources({ crossref: { search: () => new Promise(() => undefined) } });
      const pending = runCheck({ paper: PAPER, refs: [titled(1, 'Waiting paper')], onResult: () => undefined, signal: ac.signal }, makeDeps(sources));
      ac.abort();
      await expect(pending).rejects.toBeDefined();
    });
  });

  describe('300 references', () => {
    function busySources() {
      const live: Record<string, number> = {};
      const peak: Record<string, number> = {};
      const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 3));
      const track = async <T>(name: string, value: T): Promise<T> => {
        live[name] = (live[name] ?? 0) + 1;
        peak[name] = Math.max(peak[name] ?? 0, live[name]);
        await sleep();
        live[name] = (live[name] ?? 1) - 1;
        return value;
      };
      const titleOf = (c: { title?: string }) => c.title ?? '';
      const search = (name: SourceName, hit: (n: number) => boolean) => (c: { title?: string }) => {
        const n = Number(/(\d+)$/.exec(titleOf(c))?.[1]);
        return track(name, hit(n) ? [record({ source: name, title: titleOf(c) })] : []);
      };
      const sources = mockSources({
        crossref: { search: search('crossref', (n) => n % 3 === 0), lookupById: (c) => track('crossref', c.doi === undefined ? null : record({ title: c.title ?? '' })) },
        arxiv: { search: search('arxiv', (n) => n % 3 === 1) },
        openreview: { search: search('openreview', () => false) },
        dblp: { search: search('dblp', () => false) },
        openalex: { search: search('openalex', () => false) },
      });
      return { sources, peak };
    }

    const refs300 = Array.from({ length: 300 }, (_, i) => paperRef(i, { title: `Protein folding with graph networks study ${i}` }));

    test('all 300 complete, each is reported once, and no source exceeds its concurrency limit', async () => {
      const { sources, peak } = busySources();
      const got: CheckResult[] = [];
      const done = runCheck({ paper: PAPER, refs: refs300, onResult: (r) => got.push(r), signal: controller() }, makeDeps(sources));
      await vi.runAllTimersAsync();
      const summary = await done;
      expect(got).toHaveLength(300);
      expect(new Set(got.map((r) => r.index)).size).toBe(300);
      expect(summary.total).toBe(300);
      expect(summary.counts.verified).toBe(200);
      expect(summary.counts.not_found).toBe(100);
      for (const name of Object.keys(peak)) {
        expect(peak[name], name).toBeLessThanOrEqual(RATE[name as SourceName].maxConcurrent);
      }
      expect(peak['crossref']).toBeGreaterThan(1);
    });

    test('aborting at result 50 stops all further results', async () => {
      const { sources } = busySources();
      const ac = new AbortController();
      let count = 0;
      const done = runCheck(
        {
          paper: PAPER,
          refs: refs300,
          onResult: () => {
            count++;
            if (count === 50) ac.abort();
          },
          signal: ac.signal,
        },
        makeDeps(sources),
      );
      const outcome = done.then(
        () => 'resolved',
        (e: unknown) => (e instanceof Error ? e.name : 'other'),
      );
      await vi.advanceTimersByTimeAsync(200);
      expect(count).toBe(50);
      expect(await outcome).toBe('AbortError');
      await vi.advanceTimersByTimeAsync(5000);
      expect(count).toBe(50);
    });

    test('an already-aborted signal does no work', async () => {
      const { sources } = busySources();
      const ac = new AbortController();
      ac.abort();
      const onResult = vi.fn();
      await expect(runCheck({ paper: PAPER, refs: refs300, onResult, signal: ac.signal }, makeDeps(sources))).rejects.toMatchObject({ name: 'AbortError' });
      expect(onResult).not.toHaveBeenCalled();
      expect(sources.crossref.search).not.toHaveBeenCalled();
    });
  });

  test('a UrlNotAllowedError fails the whole run loudly', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.reject(new UrlNotAllowedError('nope')) } });
    await expect(runCheck({ paper: PAPER, refs: [paperRef(1), paperRef(2)], onResult: () => undefined, signal: controller() }, makeDeps(sources))).rejects.toBeInstanceOf(UrlNotAllowedError);
  });
});

describe('year agreement across versions', () => {
  // The gate for a retraction lookup follows the same any-version year rule as Verified.
  test('a citation with the preprint year is Verified against the journal record, and its retraction is looked up', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record({ year: 2022, otherYears: [2019] })]) } });
    const deps = makeDeps(sources);
    const r = await checkReference(paperRef(1), deps, controller());
    expect(r.status).toBe('verified');
    // paperRef cites 2019; the record's main year is 2022 but it was also known in 2019: a strong match
    expect(deps.retraction.check).toHaveBeenCalledTimes(1);
  });

  test('a retracted work cited with its preprint year is Retracted', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record({ year: 2022, otherYears: [2019], doi: '10.1000/xyz123' })]) } });
    const check = vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const, noticeDoi: '10.1000/notice1' }));
    const r = await checkReference(paperRef(1), makeDeps(sources, { retraction: { check } }), controller());
    expect(r.status).toBe('retracted');
  });

  test('a year that no version of the work has still keeps the retraction lookup away', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record({ year: 2022, otherYears: [2016] })]) } });
    const deps = makeDeps(sources);
    const r = await checkReference(paperRef(1), deps, controller());
    expect(r.status).toBe('details_differ');
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });

  test('Retracted still needs the rest of a strong match: the same year agreement with other authors is not enough', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record({ year: 2022, otherYears: [2019], authors: ['someone', 'else', 'again'] })]) } });
    const deps = makeDeps(sources, { retraction: { check: vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const })) } });
    const r = await checkReference(paperRef(1), deps, controller());
    expect(r.status).not.toBe('retracted');
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });
});

describe('duplicate publications with one retracted', () => {
  const retractedCopy = record({ doi: '10.1000/retracted', isRetracted: true, venue: 'Journal of Alpha', year: 2019 });
  const keptCopy = record({ doi: '10.1000/kept', isRetracted: false, venue: 'Nature Methods', year: 2019 });
  const checkOf = () => vi.fn((r: WorkRecord) => Promise.resolve(r.isRetracted ? { retracted: true, version: 'cited' as const } : { retracted: false }));

  test('the venue the reference names decides which copy is meant', async () => {
    const check = checkOf();
    const sources = mockSources({ crossref: { search: () => Promise.resolve([retractedCopy, keptCopy]) } });
    const r = await checkReference(paperRef(1), makeDeps(sources, { retraction: { check } }), controller());
    expect(r.status).toBe('verified');
    expect(r.match?.doi).toBe('10.1000/kept');
  });

  test('the year the reference cites decides when the venue does not', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([{ ...keptCopy, venue: 'Journal of Beta', year: 2015 }, { ...retractedCopy, year: 2019 }]) } });
    const r = await checkReference(paperRef(1), makeDeps(sources, { retraction: { check: checkOf() } }), controller());
    expect(r.status).toBe('retracted');
    expect(r.match?.doi).toBe('10.1000/retracted');
  });

  test('two copies the reference cannot tell apart give no verdict, and no other source is asked', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([{ ...retractedCopy, venue: 'Journal of Alpha' }, { ...keptCopy, venue: 'Journal of Beta' }]) } });
    const deps = makeDeps(sources, { retraction: { check: checkOf() } });
    const r = await checkReference(paperRef(1), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/two records/i);
    expect(r.match).toBeUndefined();
    expect(sources.arxiv.search).not.toHaveBeenCalled();
    expect(deps.retraction.check).not.toHaveBeenCalled();
    expect(deps.cache.sets).toHaveLength(0);
  });
});
