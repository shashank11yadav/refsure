// Books, theses, ISBN-bearing proceedings and IACR ePrints get one Crossref title search. It can only
// make them Verified; every other outcome leaves the Can't check they had.
import { describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', async () => ({ browser: (await import('wxt/testing/fake-browser')).fakeBrowser }));
import { checkReference } from '../../../src/engine/checker';
import { SourceError } from '../../../src/sources/http';
import { makeDeps, mockSources, record, ref } from '../helpers/engine';

const controller = (): AbortSignal => new AbortController().signal;
const BOOK = "Looks like a book or thesis, which these databases don't list reliably";

const BIRRELL = 'N.D. Birrell, P.C.W. Davies, Quantum Fields in Curved Space (Cambridge Univ. Press, Cambridge, UK, 1984)';
const birrell = record({ title: 'Quantum Fields in Curved Space', authors: ['birrell', 'davies'], year: 1984, doi: '10.1017/cbo9780511622632' });
const PROCEEDINGS = 'C. Braz and J. Robert (2006) Security and usability: the case of the user authentication methods. In Proceedings of the 18th Conference on l’Interaction Homme-Machine, pp. 199–203. External Links: ISBN 1595933506';
const braz = record({ title: 'Security and usability: the case of the user authentication methods', authors: ['braz', 'robert'], year: 2006, doi: '10.1145/1132736.1132768' });

describe('a book that Crossref holds', () => {
  test('is Verified by one Crossref search, with nothing sent anywhere else and no retraction lookup', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([birrell]) } });
    const deps = makeDeps(sources);
    const r = await checkReference(ref(1, BIRRELL), deps, controller());
    expect(r.status).toBe('verified');
    expect(r.match?.doi).toBe('10.1017/cbo9780511622632');
    expect(sources.crossref.search).toHaveBeenCalledTimes(1);
    for (const s of ['arxiv', 'openreview', 'dblp', 'openalex'] as const) expect(sources[s].search).not.toHaveBeenCalled();
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });

  test('a proceedings paper that carries an ISBN is Verified the same way', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([braz]) } });
    const r = await checkReference(ref(1, PROCEEDINGS), makeDeps(sources), controller());
    expect(r.status).toBe('verified');
  });
});

describe('every other outcome leaves the book Can\'t check', () => {
  test.each([
    ['nothing found', () => Promise.resolve([])],
    ['another edition (another year)', () => Promise.resolve([{ ...birrell, year: 2009 }])],
    ['other authors', () => Promise.resolve([{ ...birrell, authors: ['parker', 'toms'] }])],
    ['a retracted record', () => Promise.resolve([{ ...birrell, isRetracted: true }])],
    ['a similar title only', () => Promise.resolve([{ ...birrell, title: 'Quantum Fields in Curved Space and Black Holes' }])],
    ['Crossref failing', () => Promise.reject(new SourceError('unavailable', 'crossref', 'down'))],
  ])('%s', async (_what, search) => {
    const sources = mockSources({ crossref: { search } });
    const deps = makeDeps(sources, { retraction: { check: vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const })) } });
    const r = await checkReference(ref(1, BIRRELL), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe(BOOK);
    expect(sources.openalex.search).not.toHaveBeenCalled();
    expect(deps.retraction.check).not.toHaveBeenCalled();
    expect(deps.cache.sets).toEqual([]);
  });

  test('a one-word book title with no parsed authors is not searched at all', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record({ title: 'Hydrodynamics', authors: ['lamb'], year: 1932 })]) } });
    const r = await checkReference(ref(1, 'Lamb. Hydrodynamics. Cambridge University Press, 1932.'), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
  });

  test('a website is never searched', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([record()]) } });
    const r = await checkReference(ref(1, 'OpenAI GPT-4o: multimodal large language model. Note: Accessed: 2025-02-17 External Links: Link'), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
    expect(sources.crossref.search).not.toHaveBeenCalled();
  });
});

describe('an IACR ePrint', () => {
  const TEXT = 'E. Heilman, L. Mugnier, A. Filippidis (2023) OpenPubkey: Augmenting OpenID connect with user held signing keys. Note: https://eprint.iacr.org/2023/296';
  test('is Verified when Crossref holds it, and stays Can\'t check otherwise', async () => {
    const found = record({ title: 'OpenPubkey: Augmenting OpenID Connect with User held Signing Keys', authors: ['heilman', 'mugnier', 'filippidis'], year: 2023 });
    expect((await checkReference(ref(1, TEXT), makeDeps(mockSources({ crossref: { search: () => Promise.resolve([found]) } })), controller())).status).toBe('verified');
    const none = mockSources();
    const r = await checkReference(ref(1, TEXT), makeDeps(none), controller());
    expect(r.status).toBe('cant_check');
    expect(none.openalex.search).not.toHaveBeenCalled();
  });
});

describe('no OpenAlex search for a "title" that can never be Not found', () => {
  // "Nature (London) 227, 936 (1970)" is read as a title-less journal citation (looked up by its locator), so the
  // names-and-venue "title" of this test is written with square brackets, which are no place name.
  test.each([['C. V. Vishveshwara, Nature [London] 227, 936 (1970).'], ['Kaiming He, X. Zhang, Shaoqing Ren, and Jian Sun. Deep residual learning for image recognition. In CVPR, 2016.']])('%s: the free sources are asked, OpenAlex is not', async (text) => {
    const sources = mockSources();
    const r = await checkReference(ref(1, text), makeDeps(sources), controller());
    expect(sources.crossref.search).toHaveBeenCalled();
    expect(sources.openalex.search).not.toHaveBeenCalled();
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe("Couldn't read this reference reliably");
  });

  test('"Nature (London) 227, 936 (1970)" has no title: no title search at all, OpenAlex included', async () => {
    const sources = mockSources();
    const r = await checkReference(ref(1, 'C. V. Vishveshwara, Nature (London) 227, 936 (1970).'), makeDeps(sources), controller());
    expect(sources.crossref.search).not.toHaveBeenCalled();
    expect(sources.openalex.search).not.toHaveBeenCalled();
    expect(r.status).toBe('cant_check');
  });

  test('a real title is still searched in OpenAlex', async () => {
    const sources = mockSources();
    await checkReference(ref(1, 'Jane Roe, John Smith. Graph neural networks for protein folding at scale. Nature Methods, 2019.'), makeDeps(sources), controller());
    expect(sources.openalex.search).toHaveBeenCalledTimes(1);
  });
});
