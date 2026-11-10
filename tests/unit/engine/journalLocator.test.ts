// A journal citation with no title ("C. Brans, R.H. Dicke, Phys. Rev. 124, 925 (1961)") is looked up in Crossref by its
// journal, volume, page and year (DESIGN 7.2). The only things that can come of it are Verified, Retracted (through the
// usual retraction lookup) or the Can't check it had before, and Details differ when words in front of the journal's
// name that the record's journal does not account for are a title the record does not carry. Never Not found or Wrong ID.
import { describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', async () => ({ browser: (await import('wxt/testing/fake-browser')).fakeBrowser }));
import { doiUrl } from '../../../src/core/identifiers';
import type { WorkRecord } from '../../../src/core/types';
import { checkReference } from '../../../src/engine/checker';
import { referencesFromPages } from '../../../src/extract/pdfReferences';
import { SourceError } from '../../../src/sources/http';
import { makeDeps, mockSources, paperRef, ref } from '../helpers/engine';
import { HEAD, column, page } from '../helpers/pdfPages';

const controller = (): AbortSignal => new AbortController().signal;
const CITED = 'C. Brans, R.H. Dicke, Phys. Rev. 124, 925 (1961)';
const UNREADABLE = "Couldn't read this reference reliably";
const NO_RECORD = 'The journal, volume and page were read, but no Crossref record was found there';

function article(over: Partial<WorkRecord> = {}): WorkRecord {
  return { source: 'crossref', title: 'Mach’s Principle and a Relativistic Theory of Gravitation', authors: ['brans', 'dicke'], year: 1961, venue: 'Physical Review', venues: ['Physical Review', 'Phys. Rev.'], volume: '124', pages: ['925'], doi: '10.1103/physrev.124.925', isRetracted: false, notes: [], ...over };
}

function setup(answer: WorkRecord[] | Error, over: Parameters<typeof makeDeps>[1] = {}) {
  const sources = mockSources();
  const searchLocator = vi.fn((): Promise<WorkRecord[]> => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)));
  Object.assign(sources.crossref, { searchLocator });
  return { sources, searchLocator, deps: makeDeps(sources, over) };
}

function titleSearchesMade(sources: ReturnType<typeof mockSources>): number {
  return [sources.crossref, sources.arxiv, sources.openreview, sources.dblp, sources.openalex].reduce((n, s) => n + s.search.mock.calls.length + s.lookupById.mock.calls.length, 0);
}

describe('a journal citation with no title', () => {
  test('is Verified when one record has the same journal, volume, page and year and an author', async () => {
    const { sources, searchLocator, deps } = setup([article()]);
    const r = await checkReference(ref(1, CITED), deps, controller());
    expect(r.status).toBe('verified');
    expect(r.match?.doi).toBe('10.1103/physrev.124.925');
    expect(r.links).toContainEqual({ label: 'DOI', url: doiUrl('10.1103/physrev.124.925') });
    expect(searchLocator).toHaveBeenCalledTimes(1);
    expect(titleSearchesMade(sources)).toBe(0);
  });

  test('has its retraction looked up (a full locator match is a strong match) and can be Retracted', async () => {
    const check = vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const, noticeDoi: '10.1103/notice' }));
    const { deps } = setup([article()], { retraction: { check } });
    const r = await checkReference(ref(1, CITED), deps, controller());
    expect(check).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('retracted');
    expect(r.links).toContainEqual({ label: 'Retraction notice', url: doiUrl('10.1103/notice') });
  });

  test('stays Verified, with a note, when the retraction lookup could not be made', async () => {
    const check = vi.fn(() => Promise.reject(new SourceError('unavailable', 'crossref', 'down')));
    const { deps } = setup([article()], { retraction: { check } });
    const r = await checkReference(ref(1, CITED), deps, controller());
    expect(r.status).toBe('verified');
    expect(r.notes.join(' ')).toMatch(/retraction status/);
    expect(deps.cache.sets).toHaveLength(0);
  });

  test('is remembered: the same article cited again is not looked up again', async () => {
    const { searchLocator, deps } = setup([article()]);
    await checkReference(ref(1, CITED), deps, controller());
    await Promise.resolve();
    const again = await checkReference(ref(2, CITED), deps, controller());
    expect(again.status).toBe('verified');
    expect(again.index).toBe(2);
    expect(searchLocator).toHaveBeenCalledTimes(1);
  });

  // With no record at that volume, page and year it says the locator was read; with another article there, it keeps the
  // message it had.
  test.each([
    ['another volume', article({ volume: '125' }), NO_RECORD],
    ['another page', article({ pages: ['926'] }), NO_RECORD],
    ['another year', article({ year: 1970 }), NO_RECORD],
    ['another journal', article({ venues: ['Physical Review Letters'], venue: 'Physical Review Letters' }), UNREADABLE],
    ['other authors', article({ authors: ['someone', 'else'] }), UNREADABLE],
    ['no authors at all', article({ authors: [] }), UNREADABLE],
    ['no volume', article({ volume: undefined as unknown as string }), NO_RECORD],
    ['nothing', undefined, NO_RECORD],
  ] as [string, WorkRecord | undefined, string][])('stays Can’t check for %s', async (_what, found, reason) => {
    const { sources, deps } = setup(found === undefined ? [] : [found]);
    const r = await checkReference(ref(1, CITED), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe(reason);
    expect(r.sourcesSearched).toEqual([]);
    expect(r.sourcesFailed).toEqual([]);
    expect(r.diffs).toEqual([]);
    expect(deps.retraction.check).not.toHaveBeenCalled();
    expect(titleSearchesMade(sources)).toBe(0);
  });

  test('stays Can’t check when two records fit', async () => {
    const { deps } = setup([article(), article({ doi: '10.1103/second' })]);
    expect((await checkReference(ref(1, CITED), deps, controller())).status).toBe('cant_check');
  });

  test.each([
    ['unavailable', new SourceError('unavailable', 'crossref', 'down')],
    ['rate limited', new SourceError('rate_limited', 'crossref', '429')],
    ['bad response', new SourceError('bad_response', 'crossref', 'junk')],
    ['not an error from the service', new TypeError('boom')],
  ])('stays Can’t check, with the message it had, when Crossref fails (%s)', async (_what, error) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { deps } = setup(error);
    const r = await checkReference(ref(1, CITED), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe(UNREADABLE);
    warn.mockRestore();
  });

  test('a malformed answer is read as Crossref failing', async () => {
    const sources = mockSources();
    Object.assign(sources.crossref, { searchLocator: () => Promise.resolve([{ junk: true }]) });
    const r = await checkReference(ref(1, CITED), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe(UNREADABLE);
  });

  test('offline is said to be offline', async () => {
    const { deps } = setup(new SourceError('offline', 'crossref', 'x'));
    const r = await checkReference(ref(1, CITED), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/offline/);
  });

  test('whatever Crossref answers, the status is Verified, Retracted or Can’t check', async () => {
    const answers: WorkRecord[][] = [[], [article()], [article({ title: '' })], [article({ isRetracted: true })], [article(), article()], [article({ authors: ['dicke'], year: 1962 })]];
    for (const answer of answers) {
      const { deps } = setup(answer);
      const r = await checkReference(ref(1, CITED), deps, controller());
      expect(['verified', 'retracted', 'cant_check']).toContain(r.status);
    }
  });
});

// A complete locator that Crossref holds no record at was still read: it says so, not that the reference could not be
// read. Only when Crossref answered and no record in its answer has that volume, page and year; the status stays
// Can't check, since a missing record says nothing about the article.
describe('a complete locator that Crossref holds no record at', () => {
  test.each([
    'E. Fonseca et al., Astrophys. J. Lett. 915, L12 (2021).',
    'X.-K. Dong, F.-K. Guo, and B.-S. Zou, Progr. Phys. 41, 65 (2021).',
    'Z.-G. Wang, Front. Phys. (Beijing) 21, 016300 (2026).',
    CITED,
  ])('says the locator was read and no record found: %s', async (text) => {
    const { deps } = setup([]);
    const r = await checkReference(ref(1, text), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe(NO_RECORD);
    expect(r.diffs).toEqual([]);
  });

  test.each([
    ['another volume', article({ volume: '125' })],
    ['another page', article({ pages: ['926'] })],
    ['another year', article({ year: 1970 })],
  ] as [string, WorkRecord][])('says so when the only record has %s', async (_what, found) => {
    const { deps } = setup([found]);
    const r = await checkReference(ref(1, CITED), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe(NO_RECORD);
  });

  // A record at that volume, page and year that is not the cited one (another journal, other authors) is a record there.
  test.each([
    ['another journal', article({ venues: ['Physical Review Letters'], venue: 'Physical Review Letters' })],
    ['other authors', article({ authors: ['someone', 'else'] })],
  ] as [string, WorkRecord][])('does not say so when a record there has %s', async (_what, found) => {
    const { deps } = setup([found]);
    const r = await checkReference(ref(1, CITED), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).not.toBe(NO_RECORD);
  });

  test('does not say so when Crossref could not be asked', async () => {
    const { deps } = setup(new SourceError('unavailable', 'crossref', 'down'));
    const r = await checkReference(ref(1, CITED), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).not.toBe(NO_RECORD);
  });
});

describe('what is not looked up by journal', () => {
  test('a citation with a title', async () => {
    const { searchLocator, deps } = setup([article()]);
    await checkReference(paperRef(1), deps, controller());
    expect(searchLocator).not.toHaveBeenCalled();
  });

  test('a citation with a DOI or an arXiv id', async () => {
    const { searchLocator, deps } = setup([article()]);
    await checkReference(ref(1, `${CITED}, 10.1103/PhysRev.124.925`), deps, controller());
    await checkReference(ref(2, `${CITED} [arXiv:hep-th/0601001]`), deps, controller());
    expect(searchLocator).not.toHaveBeenCalled();
  });

  test('a book, a web page or a thesis', async () => {
    const { searchLocator, deps } = setup([article()]);
    await checkReference(ref(1, 'N.D. Birrell, P.C.W. Davies, Quantum Fields in Curved Space (Cambridge Univ. Press, Cambridge, UK, 1984)'), deps, controller());
    await checkReference(ref(2, 'OpenAI GPT-4o: multimodal large language model. Note: Accessed: 2025-02-17 External Links: Link Cited by: §4.1.'), deps, controller());
    await checkReference(ref(3, 'J. Roe, PhD thesis, Phys. Rev. 124, 925 (1961)'), deps, controller());
    expect(searchLocator).not.toHaveBeenCalled();
  });

  test('an incomplete locator', async () => {
    const { searchLocator, deps } = setup([article()]);
    await checkReference(ref(1, 'C. Brans, R.H. Dicke, Phys. Rev. (1961)'), deps, controller());
    await checkReference(ref(2, 'C. Brans, R.H. Dicke, Phys. Rev. 124, 925'), deps, controller());
    expect(searchLocator).not.toHaveBeenCalled();
  });

  test('anything, when the source cannot do it', async () => {
    const sources = mockSources();
    const r = await checkReference(ref(1, CITED), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe(UNREADABLE);
  });
});

// A match that no author backs up can be Verified, but it is not evidence enough to call a work Retracted.
describe('a journal citation that names nobody', () => {
  const NOBODY = 'Nature 571, 95 (2019).';
  const nature = article({ title: 'A paper in Nature', authors: ['roe', 'smith'], year: 2019, venue: 'Nature', venues: ['Nature'], shortVenues: ['Nature'], volume: '571', pages: ['95'], doi: '10.1038/s41586-019-1000-0' });

  test('is Verified when the record is not retracted', async () => {
    const { deps } = setup([nature]);
    expect((await checkReference(ref(1, NOBODY), deps, controller())).status).toBe('verified');
  });

  test('is Can’t check, not Retracted, when the record is retracted', async () => {
    const check = vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const, noticeDoi: '10.1038/notice' }));
    const { deps } = setup([nature], { retraction: { check } });
    const r = await checkReference(ref(1, NOBODY), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe("Couldn't confirm the identifier matches this reference");
    expect(r.match).toBeUndefined();
    expect(deps.cache.sets).toHaveLength(0);
  });

  test('a citation that names the authors is still Retracted', async () => {
    const check = vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const }));
    const { deps } = setup([nature], { retraction: { check } });
    expect((await checkReference(ref(1, 'J. Roe and K. Smith, Nature 571, 95 (2019).'), deps, controller())).status).toBe('retracted');
  });
});

// "P. Astone et al., Phys. Rev. D 82, 022003 (2010)." (from 1602.03837, LIGO): with one named author, Crossref's first
// ten answers can be errata of the same volume. When they hold no match, one more request is made
// (crossref.searchLocatorAgain: the DOI APS or IOP built from the locator, or a search by the first author). Its
// answers are only candidates: every part of the locator must still match, and only one record may.
describe('an "et al." journal citation the first answers miss', () => {
  const ASTONE = 'P. Astone et al., Phys. Rev. D 82, 022003 (2010).';
  const astone = article({ title: 'An article in Physical Review D', authors: ['astone', 'babusci', 'baggio'], year: 2010, venue: 'Physical Review D', venues: ['Physical Review D'], shortVenues: ['Phys. Rev. D'], volume: '82', pages: ['022003'], doi: '10.1103/physrevd.82.022003' });
  const erratum = article({ title: 'Erratum: Something else', authors: ['someone'], year: 2010, venue: 'Physical Review D', venues: ['Physical Review D'], volume: '82', pages: ['029901'], doi: '10.1103/physrevd.82.029901' });

  function setupAgain(first: WorkRecord[], again: WorkRecord[] | Error, over: Parameters<typeof makeDeps>[1] = {}) {
    const sources = mockSources();
    const searchLocator = vi.fn((): Promise<WorkRecord[]> => Promise.resolve(first));
    const searchLocatorAgain = vi.fn((): Promise<WorkRecord[]> => (again instanceof Error ? Promise.reject(again) : Promise.resolve(again)));
    Object.assign(sources.crossref, { searchLocator, searchLocatorAgain });
    return { sources, searchLocator, searchLocatorAgain, deps: makeDeps(sources, over) };
  }

  test('is Verified when the second request brings the one record that matches', async () => {
    const { sources, searchLocator, searchLocatorAgain, deps } = setupAgain([erratum], [astone]);
    const r = await checkReference(ref(24, ASTONE), deps, controller());
    expect(r.status).toBe('verified');
    expect(r.match?.doi).toBe('10.1103/physrevd.82.022003');
    expect(r.sourcesSearched).toEqual(['crossref']);
    expect(searchLocator).toHaveBeenCalledTimes(1);
    expect(searchLocatorAgain).toHaveBeenCalledTimes(1);
    expect(titleSearchesMade(sources)).toBe(0);
  });

  test('asks no second time when the first answers hold the match', async () => {
    const { searchLocatorAgain, deps } = setupAgain([erratum, astone], [astone]);
    expect((await checkReference(ref(24, ASTONE), deps, controller())).status).toBe('verified');
    expect(searchLocatorAgain).not.toHaveBeenCalled();
  });

  test('asks no second time when two of the first answers match, and stays Can’t check', async () => {
    const { searchLocatorAgain, deps } = setupAgain([astone, { ...astone, doi: '10.1103/copy' }], [astone]);
    expect((await checkReference(ref(24, ASTONE), deps, controller())).status).toBe('cant_check');
    expect(searchLocatorAgain).not.toHaveBeenCalled();
  });

  test('can be Retracted, through the usual retraction lookup', async () => {
    const check = vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const, noticeDoi: '10.1103/notice' }));
    const { deps } = setupAgain([erratum], [astone], { retraction: { check } });
    expect((await checkReference(ref(24, ASTONE), deps, controller())).status).toBe('retracted');
  });

  test.each([
    ['another volume', article({ ...astone, volume: '83' }), NO_RECORD],
    ['another page', article({ ...astone, pages: ['022004'] }), NO_RECORD],
    ['another year', article({ ...astone, year: 2014 }), NO_RECORD],
    ['another journal', article({ ...astone, venues: ['Physical Review Letters'], venue: 'Physical Review Letters', shortVenues: ['Phys. Rev. Lett.'] }), UNREADABLE],
    ['other authors', article({ ...astone, authors: ['someone', 'else', 'entirely'] }), UNREADABLE],
    ['no authors at all', article({ ...astone, authors: [] }), UNREADABLE],
  ] as [string, WorkRecord, string][])('stays Can’t check when the second answer has %s', async (_what, found, reason) => {
    const { deps } = setupAgain([erratum], [found]);
    const r = await checkReference(ref(24, ASTONE), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe(reason);
    expect(r.diffs).toEqual([]);
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });

  test('stays Can’t check when the second answers hold two records that match', async () => {
    const { deps } = setupAgain([erratum], [astone, { ...astone, doi: '10.1103/copy' }]);
    expect((await checkReference(ref(24, ASTONE), deps, controller())).status).toBe('cant_check');
  });

  test.each([
    ['unavailable', new SourceError('unavailable', 'crossref', 'down')],
    ['rate limited', new SourceError('rate_limited', 'crossref', '429')],
    ['bad response', new SourceError('bad_response', 'crossref', 'junk')],
  ])('stays Can’t check, with the message it had, when the second request fails (%s)', async (_what, error) => {
    const { deps } = setupAgain([erratum], error);
    const r = await checkReference(ref(24, ASTONE), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe(UNREADABLE);
  });

  test('a malformed second answer is read as Crossref failing', async () => {
    const { deps } = setupAgain([erratum], [{ junk: true } as unknown as WorkRecord]);
    const r = await checkReference(ref(24, ASTONE), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe(UNREADABLE);
  });

  test('no second request when the first one failed', async () => {
    const sources = mockSources();
    const searchLocatorAgain = vi.fn((): Promise<WorkRecord[]> => Promise.resolve([astone]));
    Object.assign(sources.crossref, { searchLocator: () => Promise.reject(new SourceError('unavailable', 'crossref', 'down')), searchLocatorAgain });
    expect((await checkReference(ref(24, ASTONE), makeDeps(sources), controller())).status).toBe('cant_check');
    expect(searchLocatorAgain).not.toHaveBeenCalled();
  });

  test('whatever the second request answers, the status is Verified, Retracted or Can’t check', async () => {
    const answers: WorkRecord[][] = [[], [astone], [{ ...astone, title: '' }], [{ ...astone, isRetracted: true }], [astone, astone], [erratum], [{ ...astone, authors: ['babusci'], year: 2011 }]];
    for (const again of answers) {
      for (const text of [ASTONE, 'J. Smith et al., Phys. Rev. D 82, 022003 (2010).', 'P. Astone et al., Phys. Rev. D 82, 022003 (2016).']) {
        const { deps } = setupAgain([erratum], again);
        expect(['verified', 'retracted', 'cant_check']).toContain((await checkReference(ref(24, text), deps, controller())).status);
      }
    }
  });
});

// A Nature-style entry ("Surname, I. & Surname, I. Title. Journal vol, page (year).") is searched by
// its title. When that ends in Not found or in the unreadable Can't check, the entry is looked up by its journal locator
// as a title-less one is. Only Verified or Retracted can come of it, and only for a record that also carries the cited
// title: an invented title on a real locator keeps its Not found.
describe('a Nature-style entry the title searches miss', () => {
  const rec = (over: Partial<WorkRecord>): WorkRecord => ({ source: 'crossref', title: '', authors: [], isRetracted: false, notes: [], ...over });
  const FRUSTRATION = 'Moessner, R. & Ramirez, A. P. Geometrical frustration. Physics Today 59, 24 (2006).';
  const FRUSTRATION_REC = rec({ title: 'Geometrical frustration', authors: ['moessner', 'ramirez'], year: 2006, venue: 'Physics Today', venues: ['Physics Today'], volume: '59', pages: ['24'], doi: '10.1063/1.2186278' });
  const SPIN_ICE = 'Lee, S., Onoda, S. & Balents, L. Generic quantum spin ice. Phys. Rev. B 86, 104412 (2012).';
  const SPIN_ICE_REC = rec({ title: 'Generic quantum spin ice', authors: ['lee', 'onoda', 'balents'], year: 2012, venue: 'Physical Review B', venues: ['Physical Review B', 'Phys. Rev. B'], volume: '86', pages: ['104412'], doi: '10.1103/physrevb.86.104412' });

  test.each([
    ['a two-word title (1804.00696#1)', FRUSTRATION, FRUSTRATION_REC],
    ['a title the searches miss', SPIN_ICE, SPIN_ICE_REC],
  ])('%s is Verified by its locator', async (_what, text, record) => {
    const { searchLocator, deps } = setup([record]);
    const r = await checkReference(ref(1, text), deps, controller());
    expect(r.status).toBe('verified');
    expect(r.match?.doi).toBe(record.doi);
    expect(searchLocator).toHaveBeenCalledTimes(1);
  });

  test('a retracted record found by its locator is Retracted', async () => {
    const { deps } = setup([{ ...SPIN_ICE_REC, isRetracted: true }], { retraction: { check: vi.fn(() => Promise.resolve({ retracted: true, noticeDoi: '10.1103/physrevb.99.000001' })) } });
    expect((await checkReference(ref(1, SPIN_ICE), deps, controller())).status).toBe('retracted');
  });

  // As in step 7, a locator request that fails is counted, so the entry is Can't check and not remembered.
  test('a failed locator request makes it Can\'t check, never a remembered Not found', async () => {
    const { searchLocator, deps } = setup(new SourceError('unavailable', 'crossref', 'down'));
    const r = await checkReference(ref(1, SPIN_ICE), deps, controller());
    expect(searchLocator).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/Crossref/);
    expect(r.sourcesFailed).toContain('crossref');
    expect(deps.cache.sets).toHaveLength(0);
  });

  test('a rate-limited locator request is Can\'t check too', async () => {
    const { deps } = setup(new SourceError('rate_limited', 'crossref', 'slow down'));
    const r = await checkReference(ref(1, 'Lee, S., Onoda, S. & Balents, L. Invented classical spin liquid. Phys. Rev. B 86, 104412 (2012).'), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(deps.cache.sets).toHaveLength(0);
  });

  test('an invented title on a real locator keeps its Not found', async () => {
    const { deps } = setup([SPIN_ICE_REC]);
    const r = await checkReference(ref(1, 'Lee, S., Onoda, S. & Balents, L. Invented classical spin liquid. Phys. Rev. B 86, 104412 (2012).'), deps, controller());
    expect(r.status).toBe('not_found');
  });

  // A title that opens in lower case is a title too, and is searched and compared.
  test.each([
    ['invented classical spin liquid on the kagome lattice'],
    ['k-means clustering of frustrated magnets'],
    ['de Sitter vacua in frustrated magnets'],
  ])('an invented title opening in lower case on a real locator is Not found: %s', async (title) => {
    const { deps } = setup([SPIN_ICE_REC]);
    const r = await checkReference(ref(1, `Lee, S., Onoda, S. & Balents, L. ${title}. Phys. Rev. B 86, 104412 (2012).`), deps, controller());
    expect(r.status).toBe('not_found');
  });

  // A journal's name half spelled out, with a lower-case abbreviation, is read as a title. When the
  // one record at the locator has a journal name that accounts for that "title" (and the rest of the words in front of the
  // volume), in order and as abbreviations, the "title" is the journal: the record may Verify, with its volume, page,
  // year and an author. When no record holds that volume, page and year, it is Can't check, never Not found.
  const PRANDTL = rec({ title: 'Über die ausgebildete Turbulenz', authors: ['prandtl'], year: 1925, venue: 'ZAMM - Zeitschrift für Angewandte Mathematik und Mechanik', venues: ['Zeitschrift für angewandte Mathematik und Mechanik', 'Z. angew. Math. Mech.'], volume: '5', pages: ['136'], doi: '10.1002/zamm.19250050212' });
  const HALF_SPELLED: Array<[string, WorkRecord]> = [
    ['Prandtl, L. Zeitschrift für angew. Math. Mech. 5, 136 (1925).', PRANDTL],
    ['Smith, J. & Doe, K. Archive for rational mech. Anal. 40, 1 (1965).', rec({ title: 'On the theory of elastic rods', authors: ['smith', 'doe'], year: 1965, venue: 'Archive for Rational Mechanics and Analysis', venues: ['Archive for Rational Mechanics and Analysis', 'Arch. Rational Mech. Anal.'], volume: '40', pages: ['1'], doi: '10.1007/bf00000001' })],
    ['Smith, J. & Doe, K. Berichte der deutschen chem. Gesellschaft 40, 1 (1907).', rec({ title: 'Über Farbstoffe', authors: ['smith', 'doe'], year: 1907, venue: 'Berichte der deutschen chemischen Gesellschaft', venues: ['Berichte der deutschen chemischen Gesellschaft', 'Ber. Dtsch. Chem. Ges.'], volume: '40', pages: ['1'], doi: '10.1002/cber.19070400101' })],
    // Not on any list: the journal name's own words decide.
    ['Hückel, E. Zeitschrift für anorg. Chemie 50, 1 (1930).', rec({ title: 'Zur Theorie der Elektrolyte', authors: ['huckel'], year: 1930, venue: 'Zeitschrift für anorganische und allgemeine Chemie', volume: '50', pages: ['1'], doi: '10.1002/zaac.19300500101' })],
  ];
  test.each(HALF_SPELLED)('a half-spelled journal name is taken as the journal, and the entry is Verified by its locator: %s', async (text, record) => {
    const { searchLocator, deps } = setup([record]);
    const r = await checkReference(ref(1, text), deps, controller());
    expect(r.status).toBe('verified');
    expect(r.match?.doi).toBe(record.doi);
    expect(searchLocator).toHaveBeenCalledTimes(1);
  });
  test.each(HALF_SPELLED)('a half-spelled journal name that no record answers is Can\'t check, never Not found: %s', async (text) => {
    const r = await checkReference(ref(1, text), setup([]).deps, controller());
    expect(r.status).toBe('cant_check');
  });
  test.each([
    ['another page', 'Prandtl, L. Zeitschrift für angew. Math. Mech. 5, 137 (1925).'],
    ['another author', 'Doe, J. Zeitschrift für angew. Math. Mech. 5, 136 (1925).'],
    ['another year', 'Prandtl, L. Zeitschrift für angew. Math. Mech. 5, 136 (1930).'],
  ])('a half-spelled journal name with an altered locator (%s) is never Verified, and never Not found', async (_what, text) => {
    const r = await checkReference(ref(1, text), setup([PRANDTL]).deps, controller());
    expect(r.status).not.toBe('verified');
    expect(r.status).not.toBe('not_found');
  });
  // The same shapes on a later locator: an invented title in front of the journal's name is no part of it.
  const PRANDTL_LATER = { ...PRANDTL, year: 1975, volume: '55', doi: '10.1002/zamm.19750550212' };
  test('an invented title in front of a half-spelled journal name is Not found', async () => {
    const r = await checkReference(ref(1, 'Prandtl, L. Turbulent flow in rough pipes and channels. Zeitschrift für angew. Math. Mech. 55, 136 (1975).'), setup([PRANDTL_LATER]).deps, controller());
    expect(r.status).toBe('not_found');
  });
  // Before 1970 nothing that matches no record is Not found (older journals are often not indexed): an accepted cost.
  test('an invented title in front of a half-spelled journal name from before 1970 is Can\'t check, never Verified', async () => {
    const r = await checkReference(ref(1, 'Prandtl, L. Turbulent flow in rough pipes and channels. Zeitschrift für angew. Math. Mech. 5, 136 (1925).'), setup([PRANDTL]).deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/published before 1970/);
  });

  // The Can't check for a "title" that may be the start of a journal's name needs that shape (a few words, the last a
  // short lower-case one): an ordinary invented title on a locator no record holds keeps its Not found.
  test.each([
    ['Lee, S., Onoda, S. & Balents, L. Invented classical spin liquid. Phys. Rev. B 86, 104412 (2012).'],
    ['Blum, A. & Mansour, Y. From invented to imaginary regret bounds. Journal of Machine Learning Research 8, 1307–1324 (2007).'],
    ['Prandtl, L. Turbulent flow in rough pipes and channels. Zeitschrift für angew. Math. Mech. 55, 136 (1975).'],
    ['Lee, S. & Roe, K. Emergent photons in frustrated magnetic matter. Nature 571, 95 (2019).'],
  ])('an invented title on a locator no record holds is Not found: %s', async (text) => {
    expect((await checkReference(ref(1, text), setup([]).deps, controller())).status).toBe('not_found');
  });

  // A short title in sentence case on an invented locator is not shaped like a journal's name; only a
  // "title" that opens with a journal's head noun ("Zeitschrift", "Archive", "Berichte") or a lower-case word right after
  // a journal's initial ("J. reine angew.") is. These stay Not found whether the locator answers nothing or another article.
  const OTHER_PRB = rec({ title: 'Some other article', authors: ['someone'], year: 2019, venue: 'Physical Review B', venues: ['Physical Review B', 'Phys. Rev. B'], volume: '1', pages: ['1'], doi: '10.1103/physrevb.1.1' });
  test.each([
    ['Lee, S., Onoda, S. & Balents, L. Quantum spin ice. Phys. Rev. B 99, 299412 (2019).'],
    ['Smith, J. & Jones, K. Primordial black holes. Nature 612, 4321 (2022).'],
    ['Smith, J. & Jones, K. Majorana zero modes. Science 371, 9999 (2021).'],
    ['Smith, J. & Jones, K. Dark matter halos. Mon. Not. R. Astron. Soc. 512, 9999 (2022).'],
    ['Smith, J. & Jones, K. de Sitter vacua. Phys. Rev. D 99, 299412 (2019).'],
  ])('a short invented title on an invented locator is Not found: %s', async (text) => {
    for (const answer of [[], [OTHER_PRB]]) {
      expect((await checkReference(ref(1, text), setup(answer).deps, controller())).status).toBe('not_found');
    }
  });

  // Measured, and accepted as a narrow residual: an invented title that opens with a journal's head noun, on an invented
  // locator, is shaped like a journal's name and is Can't check rather than Not found.
  test('an invented title opening with a journal head noun, on an invented locator, is Can\'t check (residual)', async () => {
    const r = await checkReference(ref(1, 'Lee, S., Onoda, S. & Balents, L. Journal of quantum ice. Phys. Rev. B 99, 299412 (2019).'), setup([]).deps, controller());
    expect(r.status).toBe('cant_check');
  });

  // Crelle's journal keeps the outcome it had when it was read without a title.
  const WEIL = rec({ title: 'Sur les fonctions algébriques à corps de constantes fini', authors: ['weil'], year: 1938, venue: 'Journal für die reine und angewandte Mathematik', venues: ['Journal für die reine und angewandte Mathematik'], shortVenues: ['J. Reine Angew. Math.'], volume: '179', pages: ['129'], doi: '10.1515/crll.1938.179.129' });
  test.each([
    ['its record', 'Weil, A. J. reine angew. Math. 179, 129 (1938).', [WEIL], 'verified'],
    ['no answer', 'Weil, A. J. reine angew. Math. 179, 129 (1938).', [], 'cant_check'],
    ['a record of another volume', 'Weil, A. J. reine angew. Math. 179, 129 (1938).', [{ ...WEIL, volume: '180' }], 'cant_check'],
    ['other authors', 'Doe, J. & Roe, K. J. reine angew. Math. 179, 129 (1938).', [WEIL], 'cant_check'],
  ])('"J. reine angew. Math." with %s', async (_what, text, answer, status) => {
    expect((await checkReference(ref(1, text), setup(answer as WorkRecord[]).deps, controller())).status).toBe(status);
  });

  // An invented title that ends in a word some journal abbreviates ("math.", "mat.", "stud.", "rend."), on the real locator
  // by the real authors: its title is searched and compared, and the record's journal does not account for it.
  test.each([
    ['Emergent photons and the unreasonable effectiveness of math'],
    ['Quantum spin ice on a frustrated welcome mat'],
    ['Magnetic monopoles in a spin ice stud'],
    ['Quantum fluctuations that rend'],
  ])('an invented title ending in a journal-like word is Not found: %s', async (title) => {
    const r = await checkReference(ref(1, `Lee, S., Onoda, S. & Balents, L. ${title}. Phys. Rev. B 86, 104412 (2012).`), setup([SPIN_ICE_REC]).deps, controller());
    expect(r.status).toBe('not_found');
  });

  test.each([
    ['another page', 'Lee, S., Onoda, S. & Balents, L. Generic quantum spin ice. Phys. Rev. B 86, 104413 (2012).'],
    ['another volume', 'Lee, S., Onoda, S. & Balents, L. Generic quantum spin ice. Phys. Rev. B 87, 104412 (2012).'],
    ['another year', 'Lee, S., Onoda, S. & Balents, L. Generic quantum spin ice. Phys. Rev. B 86, 104412 (2009).'],
    ['another journal', 'Lee, S., Onoda, S. & Balents, L. Generic quantum spin ice. Phys. Rev. Lett. 86, 104412 (2012).'],
    ['other authors', 'Smith, J., Jones, K. & Brown, L. Generic quantum spin ice. Phys. Rev. B 86, 104412 (2012).'],
  ])('an altered locator (%s) is never Verified', async (_what, text) => {
    const { deps } = setup([SPIN_ICE_REC]);
    const r = await checkReference(ref(1, text), deps, controller());
    expect(r.status).not.toBe('verified');
  });

  test('when the locator finds nothing, the title path\'s Not found stands', async () => {
    const { deps } = setup([]);
    expect((await checkReference(ref(1, SPIN_ICE), deps, controller())).status).toBe('not_found');
  });

  test('a title search that matches needs no locator lookup', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([SPIN_ICE_REC]) } });
    const searchLocator = vi.fn(() => Promise.resolve([SPIN_ICE_REC]));
    Object.assign(sources.crossref, { searchLocator });
    expect((await checkReference(ref(1, SPIN_ICE), makeDeps(sources), controller())).status).toBe('verified');
    expect(searchLocator).not.toHaveBeenCalled();
  });

  // Such an entry gets one locator request of its own (searchLocatorAgain, absent here), tested below.
  test('an entry in another style with a title is not looked up by the Nature-style locator path', async () => {
    const { searchLocator, deps } = setup([SPIN_ICE_REC]);
    const r = await checkReference(ref(1, 'S. Lee, S. Onoda, and L. Balents, Generic quantum spin ice, Phys. Rev. B 86, 104412 (2012).'), deps, controller());
    expect(r.status).toBe('not_found');
    expect(searchLocator).not.toHaveBeenCalled();
  });
});

// A PDF entry cut from a line that held two (pdfReferences.ts) may hold the other's words. It can be
// Verified, but never Not found.
describe('a PDF entry cut in the middle of a line', () => {
  const PART = 'E. Author, An invented title on nothing at all, Phys. Rev. Lett. 99, 123456 (2020).';
  test('is Can\'t check where it would be Not found', async () => {
    const r = await checkReference({ ...ref(5, PART), partial: true }, makeDeps(mockSources()), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/line of the PDF/);
  });
  test('the same entry not cut is Not found', async () => {
    expect((await checkReference(ref(5, PART), makeDeps(mockSources()), controller())).status).toBe('not_found');
  });
  test('can still be Verified', async () => {
    const found: WorkRecord = { source: 'crossref', title: 'An invented title on nothing at all', authors: ['author'], year: 2020, isRetracted: false, notes: [] };
    const r = await checkReference({ ...ref(5, PART), partial: true }, makeDeps(mockSources({ crossref: { search: () => Promise.resolve([found]) } })), controller());
    expect(r.status).toBe('verified');
  });

  // A mid-line cut sends the continuation lines of both entries to the later one, so it can hold the earlier entry's DOI
  // or locator: its Wrong ID and Details differ are as unreliable as its Not found.
  const OTHER: WorkRecord = { source: 'crossref', title: 'Spectral methods for the heat equation on spheres', authors: ['iris'], year: 2020, doi: '10.1016/j.jcp.2020.000002', isRetracted: false, notes: [] };
  const WITH_DOI = `${PART.slice(0, -1)}, doi:10.1016/j.jcp.2020.000002.`;
  test('is Can\'t check where it would be Wrong ID', async () => {
    const deps = () => makeDeps(mockSources({ crossref: { lookupById: () => Promise.resolve(OTHER) } }));
    expect((await checkReference(ref(5, WITH_DOI), deps(), controller())).status).toBe('wrong_id');
    const r = await checkReference({ ...ref(5, WITH_DOI), partial: true }, deps(), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/mixed with the one next to it/);
    expect(r.links).toEqual([]);
  });
  test('is Can\'t check where it would be Details differ', async () => {
    const found: WorkRecord = { source: 'crossref', title: 'An invented title on nothing at all', authors: ['author'], year: 2014, isRetracted: false, notes: [] };
    const deps = () => makeDeps(mockSources({ crossref: { search: () => Promise.resolve([found]) } }));
    expect((await checkReference(ref(5, PART), deps(), controller())).status).toBe('details_differ');
    const r = await checkReference({ ...ref(5, PART), partial: true }, deps(), controller());
    expect(r.status).toBe('cant_check');
    expect(r.diffs).toEqual([]);
  });
  test('can still be Retracted', async () => {
    const found: WorkRecord = { source: 'crossref', title: 'An invented title on nothing at all', authors: ['author'], year: 2020, doi: '10.1103/physrevlett.99.123456', isRetracted: true, notes: [] };
    const check = vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const, noticeDoi: '10.1103/notice' }));
    const r = await checkReference({ ...ref(5, PART), partial: true }, makeDeps(mockSources({ crossref: { search: () => Promise.resolve([found]) } }), { retraction: { check } }), controller());
    expect(r.status).toBe('retracted');
  });
});

// The later part of a real mid-line cut, a correct citation, carries the earlier entry's DOI.
describe('the later part of a mid-line cut', () => {
  const lines = [
    ...Array.from({ length: 8 }, (_, i) => `[${i + 1}] Author${i + 1}, A. A title for the work numbered ${i + 1}. Venue, 2020.`),
    '[9] I. Iris, Spectral methods for the heat equation [10] J. Jones, Quasinormal ringing of rotating black holes',
    'on spheres, J. Comput. Phys. 1, 2 (2020), doi:10.1016/j.jcp.2020.000002. in modified gravity, Phys. Rev. B 3, 4 (2020).',
  ];
  const NINE: WorkRecord = { source: 'crossref', title: 'Spectral methods for the heat equation on spheres', authors: ['iris'], year: 2020, doi: '10.1016/j.jcp.2020.000002', isRetracted: false, notes: [] };
  test('is never Wrong ID on the earlier entry\'s DOI', async () => {
    const ten = referencesFromPages([page([HEAD(), ...column(72, 130, lines)])]).refs.find((r) => r.label === '[10]');
    if (ten === undefined) throw new Error('no [10]');
    expect(ten.partial).toBe(true);
    expect(ten.text).toContain('doi:10.1016/j.jcp.2020.000002');
    const r = await checkReference(ten, makeDeps(mockSources({ crossref: { lookupById: () => Promise.resolve(NINE) } })), controller());
    expect(r.status).toBe('cant_check');
  });
});

// A titled journal reference that no title search finds ("cecoin5" against Crossref's
// "CeCoIn<sub>5</sub>"). When the title path ends in Not found and the reference gives a full journal locator, Crossref is
// asked once more by that locator (searchLocatorAgain). A record found there counts only if it carries the whole locator
// (matchesLocator) and the cited title (the usual title rule); a record at the locator with another title is ignored.
describe('a titled journal reference the title searches miss', () => {
  const PETROVIC = 'C. Petrovic, P. Pagliuso, M. F. Hundley, R. Movshovich, J. L. Sarrao, J. D. Thompson, Z. Fisk, and P. Monthoux, Heavy-fermion superconductivity in cecoin5 at 2.3 k, Journal of Physics: Condensed Matter 13, L337 (2001).';
  const PETROVIC_REC: WorkRecord = {
    source: 'crossref',
    title: 'Heavy-fermion superconductivity in CeCoIn5 at 2.3 K',
    authors: ['petrovic', 'pagliuso', 'hundley', 'movshovich', 'sarrao', 'thompson', 'fisk', 'monthoux'],
    year: 2001,
    venue: 'Journal of Physics: Condensed Matter',
    venues: ['Journal of Physics: Condensed Matter', 'J. Phys.: Condens. Matter'],
    shortVenues: ['J. Phys.: Condens. Matter'],
    volume: '13',
    pages: ['l337'],
    doi: '10.1088/0953-8984/13/17/103',
    isRetracted: false,
    notes: [],
  };
  const OTHER_AT_LOCATOR: WorkRecord = { ...PETROVIC_REC, title: 'Magnetic order in an unrelated compound', doi: '10.1088/0953-8984/13/17/999' };

  function setupTitled(again: WorkRecord[] | Error, over: Parameters<typeof makeDeps>[1] = {}, search: WorkRecord[] = []) {
    const sources = mockSources({ crossref: { search: () => Promise.resolve(search) } });
    const searchLocator = vi.fn((): Promise<WorkRecord[]> => Promise.resolve([PETROVIC_REC]));
    const searchLocatorAgain = vi.fn((): Promise<WorkRecord[]> => (again instanceof Error ? Promise.reject(again) : Promise.resolve(again)));
    Object.assign(sources.crossref, { searchLocator, searchLocatorAgain });
    return { sources, searchLocator, searchLocatorAgain, deps: makeDeps(sources, over) };
  }

  test('is Verified when the one locator request brings a record with the locator and the cited title', async () => {
    const { searchLocator, searchLocatorAgain, deps } = setupTitled([PETROVIC_REC]);
    const r = await checkReference(ref(26, PETROVIC), deps, controller());
    expect(r.status).toBe('verified');
    expect(r.match?.doi).toBe('10.1088/0953-8984/13/17/103');
    expect(r.links).toContainEqual({ label: 'DOI', url: doiUrl('10.1088/0953-8984/13/17/103') });
    expect(searchLocatorAgain).toHaveBeenCalledTimes(1);
    expect(searchLocator).not.toHaveBeenCalled();
  });

  test('the locator is read without the title, and the cited year stays', async () => {
    const { searchLocatorAgain, deps } = setupTitled([PETROVIC_REC]);
    await checkReference(ref(26, PETROVIC), deps, controller());
    const asked = searchLocatorAgain.mock.calls[0] as unknown as [{ title?: string; year?: number; raw: string }];
    expect(asked[0].title).toBeUndefined();
    expect(asked[0].year).toBe(2001);
    expect(asked[0].raw).toBe(PETROVIC);
  });

  test('is Retracted through the usual retraction lookup when the record is retracted', async () => {
    const check = vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const, noticeDoi: '10.1088/notice' }));
    const { deps } = setupTitled([{ ...PETROVIC_REC, isRetracted: true }], { retraction: { check } });
    const r = await checkReference(ref(26, PETROVIC), deps, controller());
    expect(check).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('retracted');
  });

  test('a record at the locator with another title is ignored: the reference stays Not found', async () => {
    const { deps } = setupTitled([OTHER_AT_LOCATOR]);
    const r = await checkReference(ref(26, PETROVIC), deps, controller());
    expect(r.status).toBe('not_found');
    expect(r.match).toBeUndefined();
    expect(r.diffs).toEqual([]);
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });

  test('an answer with nothing in it leaves Not found', async () => {
    const { deps } = setupTitled([]);
    expect((await checkReference(ref(26, PETROVIC), deps, controller())).status).toBe('not_found');
  });

  test('a failed locator request makes it Can\'t check, never Not found', async () => {
    const { deps } = setupTitled(new SourceError('unavailable', 'crossref', 'down'));
    const r = await checkReference(ref(26, PETROVIC), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/Crossref/);
    expect(r.sourcesFailed).toContain('crossref');
    expect(deps.cache.sets).toHaveLength(0);
  });

  test('a malformed answer is read as Crossref failing', async () => {
    const { deps } = setupTitled([{ junk: true } as unknown as WorkRecord]);
    expect((await checkReference(ref(26, PETROVIC), deps, controller())).status).toBe('cant_check');
  });

  test('a title search that matches asks nothing by locator', async () => {
    const { searchLocatorAgain, deps } = setupTitled([PETROVIC_REC], {}, [PETROVIC_REC]);
    expect((await checkReference(ref(26, PETROVIC), deps, controller())).status).toBe('verified');
    expect(searchLocatorAgain).not.toHaveBeenCalled();
  });

  test.each([
    ['no locator', 'C. Petrovic, P. Pagliuso, and P. Monthoux, Heavy-fermion superconductivity in cecoin5 at 2.3 k, Journal of Physics: Condensed Matter (2001).'],
    ['a DOI', `${PETROVIC} doi:10.1088/0953-8984/13/17/103`],
  ])('a reference with %s asks nothing by locator', async (_what, text) => {
    const { searchLocatorAgain, deps } = setupTitled([PETROVIC_REC]);
    await checkReference(ref(26, text), deps, controller());
    expect(searchLocatorAgain).not.toHaveBeenCalled();
  });

  // Adversarial: what the locator brings is the article at that locator; an invented or altered reference dressed with it
  // must not newly reach Verified.
  test.each([
    ['an invented title on the real locator', PETROVIC.replace('Heavy-fermion superconductivity in cecoin5 at 2.3 k', 'Quantum criticality of an invented heavy-fermion compound')],
    ['another page', PETROVIC.replace('L337', 'L338')],
    ['another volume', PETROVIC.replace('Matter 13,', 'Matter 14,')],
    ['another year', PETROVIC.replace('(2001)', '(2009)')],
    ['another journal', PETROVIC.replace('Journal of Physics: Condensed Matter', 'Physical Review Letters')],
    ['other authors', 'J. Smith, K. Jones, and L. Brown, Heavy-fermion superconductivity in cecoin5 at 2.3 k, Journal of Physics: Condensed Matter 13, L337 (2001).'],
  ])('%s stays Not found, whatever the record at the locator', async (_what, text) => {
    for (const answer of [[PETROVIC_REC], [OTHER_AT_LOCATOR], [PETROVIC_REC, OTHER_AT_LOCATOR]]) {
      const { deps } = setupTitled(answer);
      const r = await checkReference(ref(26, text), deps, controller());
      expect(r.status).toBe('not_found');
      expect(deps.retraction.check).not.toHaveBeenCalled();
    }
  });

  // With no author before a comma and no built DOI, the further request has nothing to go on: the plain locator request
  // is made instead, still only one.
  const HINTON = 'G. E. Hinton and R. R. Salakhutdinov. Reducing the dimensionality of data with neural networks. Science 313, 504–507 (2006).';
  const HINTON_REC: WorkRecord = { source: 'crossref', title: 'Reducing the Dimensionality of Data with Neural Networks', authors: ['hinton', 'salakhutdinov'], year: 2006, venue: 'Science', venues: ['Science'], volume: '313', pages: ['504'], doi: '10.1126/science.1127647', isRetracted: false, notes: [] };
  function setupPlain(first: WorkRecord[]) {
    const sources = mockSources();
    const searchLocator = vi.fn((): Promise<WorkRecord[]> => Promise.resolve(first));
    const searchLocatorAgain = vi.fn((): Promise<WorkRecord[]> => Promise.resolve([]));
    Object.assign(sources.crossref, { searchLocator, searchLocatorAgain });
    return { searchLocator, searchLocatorAgain, deps: makeDeps(sources) };
  }

  test('a reference with no comma before its journal gets the plain locator request instead, once', async () => {
    const { searchLocator, searchLocatorAgain, deps } = setupPlain([HINTON_REC]);
    const r = await checkReference(ref(1, HINTON), deps, controller());
    expect(r.status).toBe('verified');
    expect(searchLocator).toHaveBeenCalledTimes(1);
    expect(searchLocatorAgain).not.toHaveBeenCalled();
  });

  test('an invented title in that style stays Not found (corrupted#37)', async () => {
    const { deps } = setupPlain([HINTON_REC]);
    const r = await checkReference(ref(1, 'G. E. Hinton and R. R. Salakhutdinov. Bidirectional Encoders with Dynamic Span Masking for Low-Resource Transfer. Science 313, 504–507 (2006).'), deps, controller());
    expect(r.status).toBe('not_found');
  });

  test('an invented title on the real locator never brings out the record\'s retraction', async () => {
    const check = vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const, noticeDoi: '10.1088/notice' }));
    const { deps } = setupTitled([{ ...PETROVIC_REC, isRetracted: true }], { retraction: { check } });
    const r = await checkReference(ref(26, PETROVIC.replace('Heavy-fermion superconductivity in cecoin5 at 2.3 k', 'Quantum criticality of an invented heavy-fermion compound')), deps, controller());
    expect(r.status).toBe('not_found');
    expect(check).not.toHaveBeenCalled();
  });
});

// Physics PDFs print a DOI where the page goes ("Nucl. Phys. B537, <DOI> (1999)") or an erratum after the locator. The
// first is looked up by its DOI with no title to compare; the second by its locator, as any title-less citation.
describe('a title-less citation with a DOI for its page, or an erratum after its locator', () => {
  const ALFORD = 'M. G. Alford, K. Rajagopal, and F. Wilczek, Nucl. Phys. B537, 10.1016/S0550-3213(98)00668-3 (1999).';
  const ALFORD_REC: WorkRecord = { source: 'crossref', title: 'Color-flavor locking and chiral symmetry breaking in high density QCD', authors: ['alford', 'rajagopal', 'wilczek'], year: 1999, venue: 'Nuclear Physics B', venues: ['Nuclear Physics B'], volume: '537', pages: ['443'], doi: '10.1016/s0550-3213(98)00668-3', isRetracted: false, notes: [] };
  const byDoi = (r: WorkRecord) => mockSources({ crossref: { lookupById: () => Promise.resolve(r) } });

  test('the DOI entry is Verified against its record, not "Title differs" (2610.31730#26)', async () => {
    const r = await checkReference(ref(26, ALFORD), makeDeps(byDoi(ALFORD_REC)), controller());
    expect(r.status).toBe('verified');
    expect(r.diffs).toEqual([]);
  });

  test.each([
    ['other authors', { ...ALFORD_REC, authors: ['someone', 'else'] }],
    ['another year', { ...ALFORD_REC, year: 1985 }],
  ])('the DOI entry is not Verified against a record with %s', async (_what, rec) => {
    const r = await checkReference(ref(26, ALFORD), makeDeps(byDoi(rec)), controller());
    expect(r.status).not.toBe('verified');
  });

  const GUO = 'F.-K. Guo, C. Hanhart, U.-G. Meißner, Q. Wang, Q. Zhao, and B.-S. Zou, Rev. Mod. Phys. 90, 015004 (2018), [Erratum: Rev.Mod.Phys. 94, 029901 (2022)].';
  const GUO_REC: WorkRecord = { source: 'crossref', title: 'Hadronic molecules', authors: ['guo', 'hanhart', 'meissner', 'wang', 'zhao', 'zou'], year: 2018, venue: 'Reviews of Modern Physics', venues: ['Reviews of Modern Physics'], shortVenues: ['Rev. Mod. Phys.'], volume: '90', pages: ['015004'], doi: '10.1103/revmodphys.90.015004', isRetracted: false, notes: [] };

  test('the erratum entry is looked up by its locator and Verified (2610.27843#11)', async () => {
    const { searchLocator, deps } = setup([GUO_REC]);
    const r = await checkReference(ref(11, GUO), deps, controller());
    expect(searchLocator).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('verified');
  });

  test.each([
    ['nothing matches', [] as WorkRecord[]],
    ['only the erratum\'s own record', [{ ...GUO_REC, title: 'Erratum: Hadronic molecules', volume: '94', pages: ['029901'], year: 2022 }]],
    ['another page', [{ ...GUO_REC, pages: ['015005'] }]],
  ])('the erratum entry is only ever Verified or Can\'t check: %s', async (_what, records) => {
    const { deps } = setup(records);
    const r = await checkReference(ref(11, GUO), deps, controller());
    expect(r.status).toBe('cant_check');
  });
});

// The title-less reading takes every word in front of the volume for the journal's name, so a title written before the
// journal with a full stop, a colon or nothing between ends up there ("..., Dark matter from locked quarks. Nucl. Phys.
// B537, ..."). The words the record's journal name does not account for are a title, compared as one: an invented title
// before a real article's journal and locator, or its DOI, is never Verified.
describe('words in front of the journal\'s name that the record\'s journal does not account for', () => {
  const NAMES = 'M. G. Alford, K. Rajagopal, and F. Wilczek,';
  const REC: WorkRecord = { source: 'crossref', title: 'Color-flavor locked three-flavor QCD', authors: ['alford', 'rajagopal', 'wilczek'], year: 1999, venue: 'Nuclear Physics B', venues: ['Nuclear Physics B', 'Nucl. Phys. B'], volume: '537', pages: ['443'], doi: '10.1016/s0550-3213(98)00668-3', isRetracted: false, notes: [] };
  const byDoi = (r: WorkRecord) => mockSources({ crossref: { lookupById: () => Promise.resolve(r) } });

  test.each([
    ['a full stop', `${NAMES} Dark matter from locked quarks. Nucl. Phys. B537, 10.1016/S0550-3213(98)00668-3 (1999).`],
    ['no separator', `${NAMES} Dark matter from locked quarks Nucl. Phys. B537, 10.1016/S0550-3213(98)00668-3 (1999).`],
    ['a colon', `${NAMES} Dark matter from locked quarks: Nucl. Phys. B537, 10.1016/S0550-3213(98)00668-3 (1999).`],
  ])('an invented title before a DOI in the page\'s place, after %s, is Details differ', async (_what, text) => {
    const r = await checkReference(ref(26, text), makeDeps(byDoi(REC)), controller());
    expect(r.status).toBe('details_differ');
    expect(r.diffs.map((d) => d.field)).toContain('title');
  });

  // Once the record's journal name is found in the text, what stands in front of it is the title however it is written:
  // in capitals, as one short word, or in words that journals' names use too.
  test.each([
    ['capitals and a comma, a DOI as page', `${NAMES} DARK MATTER FROM LOCKED QUARKS, Nucl. Phys. B537, 10.1016/S0550-3213(98)00668-3 (1999).`],
    ['one short word, a DOI as page', `${NAMES} Inflation. Nucl. Phys. B537, 10.1016/S0550-3213(98)00668-3 (1999).`],
    ['words journals use, a DOI as page', `${NAMES} Nuclear Physics Letters Review. Nucl. Phys. B537, 10.1016/S0550-3213(98)00668-3 (1999).`],
  ])('an invented title in %s is not Verified', async (_what, text) => {
    const r = await checkReference(ref(26, text), makeDeps(byDoi(REC)), controller());
    expect(r.status).not.toBe('verified');
  });

  test.each([
    ['capitals and a colon', `${NAMES} DARK MATTER FROM LOCKED QUARKS: Nucl. Phys. B537, 443 (1999).`],
    ['capitals and no separator', `${NAMES} DARK MATTER FROM LOCKED QUARKS Nucl. Phys. B537, 443 (1999).`],
    ['Title Case and a comma', `${NAMES} Dark Matter from Locked Quarks, Nucl. Phys. B537, 443 (1999).`],
    ['capitals and a comma', `${NAMES} DARK MATTER FROM LOCKED QUARKS, Nucl. Phys. B537, 443 (1999).`],
  ])('an invented title in %s before a real locator is not Verified', async (_what, text) => {
    const { deps } = setup([REC]);
    const r = await checkReference(ref(26, text), deps, controller());
    expect(r.status).not.toBe('verified');
  });

  test('an invented title and invented names before a real DOI are a Wrong ID', async () => {
    const text = 'J. Whitfield and R. Okonkwo, Dark matter from locked quarks. Nucl. Phys. B537, 10.1016/S0550-3213(98)00668-3 (1999).';
    const r = await checkReference(ref(26, text), makeDeps(byDoi(REC)), controller());
    expect(r.status).toBe('wrong_id');
  });

  // Read without a title, names the record does not list contradict the identifier; the record's own title in front of
  // the journal does not make them right.
  test('the record\'s own title with invented names before its DOI is not Verified', async () => {
    const text = 'J. Whitfield and R. Okonkwo, Color-flavor locked three-flavor QCD. Nucl. Phys. B537, 10.1016/S0550-3213(98)00668-3 (1999).';
    const r = await checkReference(ref(26, text), makeDeps(byDoi(REC)), controller());
    expect(r.status).toBe('cant_check');
  });

  test('the record\'s own title before its DOI with another year is Details differ', async () => {
    const text = `${NAMES} Color-flavor locked three-flavor QCD. Nucl. Phys. B537, 10.1016/S0550-3213(98)00668-3 (2004).`;
    const r = await checkReference(ref(26, text), makeDeps(byDoi(REC)), controller());
    expect(r.status).toBe('details_differ');
  });

  // "Y. LeCun, Y. Bengio and G. Hinton. Deep learning. Nature 521, 436–444 (2015). https://doi.org/..." is read with only
  // "Y. LeCun," as the authors: the record's other names in front of the title are not part of it.
  test('the record\'s other names in front of its title are no part of the title', async () => {
    const lecun: WorkRecord = { source: 'crossref', title: 'Deep learning', authors: ['lecun', 'bengio', 'hinton'], year: 2015, venue: 'Nature', venues: ['Nature'], volume: '521', pages: ['436'], doi: '10.1038/nature14539', isRetracted: false, notes: [] };
    const r = await checkReference(ref(1, 'Y. LeCun, Y. Bengio and G. Hinton. Deep learning. Nature 521, 436–444 (2015). https://doi.org/10.1038/nature14539'), makeDeps(byDoi(lecun)), controller());
    expect(r.status).toBe('verified');
  });

  test('the record\'s own title before the DOI is Verified', async () => {
    const text = `${NAMES} Color-flavor locked three-flavor QCD. Nucl. Phys. B537, 10.1016/S0550-3213(98)00668-3 (1999).`;
    const r = await checkReference(ref(26, text), makeDeps(byDoi(REC)), controller());
    expect(r.status).toBe('verified');
  });

  // With no journal name on the record there is nothing to tell the journal's words from a title's.
  test('words that could be a title, against a record with no journal name, are Can\'t check', async () => {
    const text = `${NAMES} Dark matter from locked quarks. Nucl. Phys. B537, 10.1016/S0550-3213(98)00668-3 (1999).`;
    const r = await checkReference(ref(26, text), makeDeps(byDoi({ ...REC, venue: undefined, venues: undefined })), controller());
    expect(r.status).toBe('cant_check');
  });

  test('the journal\'s name alone, against a record with no journal name, stays Verified', async () => {
    const text = `${NAMES} Nucl. Phys. B537, 10.1016/S0550-3213(98)00668-3 (1999).`;
    const r = await checkReference(ref(26, text), makeDeps(byDoi({ ...REC, venue: undefined, venues: undefined })), controller());
    expect(r.status).toBe('verified');
  });

  test.each([
    ['a page', `${NAMES} Dark matter from locked quarks. Nucl. Phys. B537, 443 (1999).`],
    ['a page and an erratum', `${NAMES} Dark matter from locked quarks. Nucl. Phys. B537, 443 (1999) [Erratum: Nucl. Phys. B540, 12 (2000)].`],
  ])('an invented title before a real locator with %s is Details differ, and never Retracted', async (_what, text) => {
    const check = vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const, noticeDoi: '10.1016/notice' }));
    const { deps } = setup([{ ...REC, isRetracted: true }], { retraction: { check } });
    const r = await checkReference(ref(26, text), deps, controller());
    expect(r.status).toBe('details_differ');
    expect(r.notes.join(' ')).toMatch(/closest record found has been retracted/);
  });

  test('the record\'s own title before a real locator is Verified', async () => {
    const { deps } = setup([REC]);
    const r = await checkReference(ref(26, `${NAMES} Color-flavor locked three-flavor QCD. Nucl. Phys. B537, 443 (1999).`), deps, controller());
    expect(r.status).toBe('verified');
  });

  // Real title-less citations: only names, initials or a journal's own words stand in front of its name.
  test.each([
    ['P. Astone et al., Phys. Rev. D 82, 022003 (2010).', { title: 'All-sky search of NAUTILUS data', authors: ['astone'], year: 2010, venue: 'Physical Review D', venues: ['Physical Review D'], volume: '82', pages: ['022003'] }],
    ['U. K. Laemmli, Nature (London) 227, 680 (1970).', { title: 'Cleavage of structural proteins during the assembly of the head of bacteriophage T4', authors: ['laemmli'], year: 1970, venue: 'Nature', venues: ['Nature'], volume: '227', pages: ['680'] }],
    ['R. Abbott et al., Astrophys. J. Lett. 915, L5 (2021).', { title: 'Observation of gravitational waves from two neutron star–black hole coalescences', authors: ['abbott'], year: 2021, venue: 'The Astrophysical Journal Letters', venues: ['The Astrophysical Journal Letters'], volume: '915', pages: ['l5'] }],
    ['K. Bakke and C. Furtado, The European Physical Journal B 87, 222 (2014).', { title: 'On the interaction of the Dirac oscillator with the Aharonov–Casher system in topological defect backgrounds', authors: ['bakke', 'furtado'], year: 2014, venue: 'The European Physical Journal B', venues: ['The European Physical Journal B'], volume: '87', pages: ['222'] }],
    ['Chrimes. A. F., Berean, K. J., Mitchell, A., Rosengarten, G. & Kalantar-zadeh, K. Controlled electrochemical deformation of liquid-phase gallium. ACS. Appl. Mater. Inter. 8, 3833-3839 (2016).', { title: 'Controlled Electrochemical Deformation of Liquid-Phase Gallium', authors: ['chrimes', 'berean', 'mitchell', 'rosengarten', 'kalantar zadeh'], year: 2016, venue: 'ACS Applied Materials &amp; Interfaces', venues: ['ACS Applied Materials &amp; Interfaces', 'ACS Appl. Mater. Interfaces'], volume: '8', pages: ['3833'] }],
    ['Andrey E. Miroshnichenko, Yuri S. Kivshar, Nucl. Phys. B 537, 443 (1999).', { title: 'Fano resonances', authors: ['miroshnichenko', 'kivshar'], year: 1999, venue: 'Nuclear Physics B', venues: ['Nuclear Physics B'], volume: '537', pages: ['443'] }],
    ['B. P. Abbott et al. (LIGO Scientific Collaboration and Virgo Collaboration), Phys. Rev. Lett. 116, 061102 (2016).', { title: 'Observation of Gravitational Waves from a Binary Black Hole Merger', authors: ['abbott'], year: 2016, venue: 'Physical Review Letters', venues: ['Physical Review Letters'], volume: '116', pages: ['061102'] }],
    ['LIGO Scientific Collaboration, Virgo Collaboration, Phys. Rev. Lett. 116, 061102 (2016).', { title: 'Observation of Gravitational Waves from a Binary Black Hole Merger', authors: ['abbott'], year: 2016, venue: 'Physical Review Letters', venues: ['Physical Review Letters'], volume: '116', pages: ['061102'] }],
    ['Abbott, B. P. et al. Phys. Rev. Lett. 116, 061102 (2016).', { title: 'Observation of Gravitational Waves from a Binary Black Hole Merger', authors: ['abbott'], year: 2016, venue: 'Physical Review Letters', venues: ['Physical Review Letters'], volume: '116', pages: ['061102'] }],
  ] as const)('a real title-less citation, or one whose title the record carries, stays Verified: %s', async (text, over) => {
    const { deps } = setup([article({ ...over, doi: '10.1000/x', authors: [...over.authors], venues: [...over.venues], pages: [...over.pages] })]);
    const r = await checkReference(ref(1, text), deps, controller());
    expect(r.status).toBe('verified');
  });
});

// A titled paper from before 1970 that no title search finds is Can't check (older journals are often not indexed), but
// its journal locator is asked for all the same, as for a Not found: a record there that carries the cited title
// verifies it.
describe('a titled journal reference from before 1970 the title searches miss', () => {
  const LK = 'I. M. Lifshitz and A. M. Kosevich, Theory of magnetic susceptibility in metals at low temperatures, Soviet Physics JETP 2, 636 (1956).';
  const LK_REC: WorkRecord = {
    source: 'crossref',
    title: 'Theory of magnetic susceptibility in metals at low temperatures',
    authors: ['lifshitz', 'kosevich'],
    year: 1956,
    venue: 'Soviet Physics JETP',
    venues: ['Soviet Physics JETP'],
    volume: '2',
    pages: ['636'],
    doi: '10.1234/jetp.2.636',
    isRetracted: false,
    notes: [],
  };
  const OLD = /published before 1970/;

  function setupOld(again: WorkRecord[] | Error) {
    const sources = mockSources();
    const searchLocator = vi.fn((): Promise<WorkRecord[]> => Promise.resolve([]));
    const searchLocatorAgain = vi.fn((): Promise<WorkRecord[]> => (again instanceof Error ? Promise.reject(again) : Promise.resolve(again)));
    Object.assign(sources.crossref, { searchLocator, searchLocatorAgain });
    return { searchLocator, searchLocatorAgain, deps: makeDeps(sources) };
  }

  test('nothing at the locator: Can\'t check, after the one locator request', async () => {
    const { searchLocator, searchLocatorAgain, deps } = setupOld([]);
    const r = await checkReference(ref(21, LK), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(OLD);
    expect(searchLocatorAgain.mock.calls.length + searchLocator.mock.calls.length).toBe(1);
  });

  test('a record at the locator with the cited title is Verified', async () => {
    const { deps } = setupOld([LK_REC]);
    const r = await checkReference(ref(21, LK), deps, controller());
    expect(r.status).toBe('verified');
  });

  test('a failed locator request says the source failed', async () => {
    const { deps } = setupOld(new SourceError('unavailable', 'crossref', 'down'));
    const r = await checkReference(ref(21, LK), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/Crossref/);
  });

  // Adversarial: an invented title on a real old locator is not Verified by the record there, and brings out no
  // retraction. It is Can't check as any old paper nothing matched (accepted).
  test('an invented title on the real locator is not Verified', async () => {
    const check = vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const, noticeDoi: '10.1234/notice' }));
    const sources = mockSources();
    Object.assign(sources.crossref, { searchLocator: () => Promise.resolve([{ ...LK_REC, isRetracted: true }]), searchLocatorAgain: () => Promise.resolve([{ ...LK_REC, isRetracted: true }]) });
    const deps = makeDeps(sources, { retraction: { check } });
    const r = await checkReference(ref(21, LK.replace('Theory of magnetic susceptibility in metals at low temperatures', 'Quantum oscillations of an invented metal in weak fields')), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(check).not.toHaveBeenCalled();
  });
});
