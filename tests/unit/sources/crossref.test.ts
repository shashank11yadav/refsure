import { beforeEach, describe, expect, test, vi } from 'vitest';
import { CONTACT_EMAIL } from '../../../src/config';
import { citation, fixtureJson } from '../helpers/fixtures';

vi.mock('../../../src/sources/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/sources/http')>();
  return { ...actual, fetchJson: vi.fn(), fetchText: vi.fn() };
});

import { fetchJson, SourceError } from '../../../src/sources/http';
import { crossref } from '../../../src/sources/crossref';

const fetchJsonMock = vi.mocked(fetchJson);

function respond(data: unknown): void {
  fetchJsonMock.mockResolvedValueOnce({ data, headers: new Headers() });
}
function requestedUrl(call = 0): URL {
  const url = fetchJsonMock.mock.calls[call]?.[0];
  if (url === undefined) throw new Error('no request was made');
  return new URL(url);
}

beforeEach(() => {
  fetchJsonMock.mockReset();
});

describe('crossref.lookupById', () => {
  test('maps a work to a WorkRecord', async () => {
    respond(fixtureJson('crossref-work.json'));
    const record = await crossref.lookupById(citation({ doi: '10.1038/nature14539' }));
    expect(record).toEqual({
      source: 'crossref',
      title: 'Deep learning',
      authors: ['lecun', 'bengio', 'hinton'],
      givenNames: ['yann', 'yoshua', 'geoffrey'],
      year: 2015,
      venue: 'Nature',
      // The journal names, volume and first page are kept too (they match title-less journal citations)
      venues: ['Nature'],
      shortVenues: ['Nature'],
      volume: '521',
      pages: ['436'],
      doi: '10.1038/nature14539',
      isRetracted: false,
      notes: [],
    });
  });

  test('always sends the project mailto and nothing from the citation text', async () => {
    respond(fixtureJson('crossref-work.json'));
    await crossref.lookupById(citation({ doi: '10.1038/nature14539', raw: 'SECRET-READING-HISTORY-TOKEN' }), new AbortController().signal);
    const url = requestedUrl();
    expect(url.origin).toBe('https://api.crossref.org');
    expect(url.pathname).toBe('/works/10.1038/nature14539');
    expect(url.searchParams.get('mailto')).toBe(CONTACT_EMAIL);
    expect(url.href).not.toContain('SECRET');
    expect(fetchJsonMock.mock.calls[0]?.[1]).toMatchObject({ source: 'crossref' });
  });

  test('marks a retracted work, strips the title prefix and keeps the correction note', async () => {
    respond(fixtureJson('crossref-work-retracted.json'));
    const record = await crossref.lookupById(citation({ doi: '10.1016/S0140-6736(97)11096-0' }));
    expect(record?.isRetracted).toBe(true);
    expect(record?.title).toBe('Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children');
    expect(record?.authors.slice(0, 3)).toEqual(['wakefield', 'murch', 'anthony']);
    expect(record?.notes).toEqual(['correction']);
    expect(record?.year).toBe(1998);
  });

  // Found by the accuracy evaluation: Hindawi and Wiley titles carry "[Retracted]", which kept a correctly cited
  // retracted paper below the title similarity that a retraction lookup needs.
  test.each(['[Retracted] Identifying markers with machine learning', '[RETRACTED ARTICLE] Identifying markers with machine learning', 'Retracted: Identifying markers with machine learning', 'WITHDRAWN: Identifying markers with machine learning'])('strips the notice prefix of %s', async (title) => {
    respond({ message: { DOI: '10.1155/2021/9939134', title: [title], author: [{ family: 'Chen', given: 'L' }], issued: { 'date-parts': [[2021]] }, 'updated-by': [{ type: 'retraction', DOI: '10.1155/2021/1' }] } });
    const record = await crossref.lookupById(citation({ doi: '10.1155/2021/9939134' }));
    expect(record?.title).toBe('Identifying markers with machine learning');
  });

  test('encodes each path segment of an awkward DOI', async () => {
    respond(fixtureJson('crossref-work.json'));
    await crossref.lookupById(citation({ doi: '10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-O#x?y' }));
    const url = requestedUrl();
    expect(url.pathname).toContain('%23x%3Fy');
    expect(url.search).toBe(`?mailto=${encodeURIComponent(CONTACT_EMAIL)}`);
  });

  test('returns null when Crossref does not know the DOI', async () => {
    fetchJsonMock.mockRejectedValueOnce(new SourceError('not_found_http', 'crossref', 'Not found (HTTP 404)'));
    expect(await crossref.lookupById(citation({ doi: '10.9999/nope' }))).toBeNull();
  });

  test('returns null without a request when there is no usable DOI', async () => {
    expect(await crossref.lookupById(citation({ arxivId: '1706.03762' }))).toBeNull();
    expect(await crossref.lookupById(citation({ doi: '10.12/short' }))).toBeNull();
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  test('lets other failures through unchanged', async () => {
    const failure = new SourceError('rate_limited', 'crossref', 'Rate limited (HTTP 429)');
    fetchJsonMock.mockRejectedValueOnce(failure);
    await expect(crossref.lookupById(citation({ doi: '10.1038/nature14539' }))).rejects.toBe(failure);
  });

  test.each([null, 'text', { status: 'ok' }, { message: [] }, { message: { DOI: 5 } }])('rejects the odd response %j as bad_response', async (data) => {
    respond(data);
    await expect(crossref.lookupById(citation({ doi: '10.1038/nature14539' }))).rejects.toMatchObject({ name: 'SourceError', kind: 'bad_response', source: 'crossref' });
  });

  test('survives odd field types and markup in a work', async () => {
    respond({
      message: {
        DOI: '10.1234/abcd',
        title: ['A <i>Fine</i> &amp; Dandy <script>alert(1)</script>title'],
        author: [{ family: 'Müller' }, { name: 'The Consortium' }, 42, { given: 'No Family' }, { family: 7 }],
        issued: { 'date-parts': [[null]] },
        published: { 'date-parts': [[2019, 3]] },
        'container-title': [3, 'Journal'],
        'updated-by': 'nonsense',
      },
    });
    const record = await crossref.lookupById(citation({ doi: '10.1234/abcd' }));
    expect(record).toMatchObject({ title: 'A Fine & Dandy alert(1)title', authors: ['muller', 'the consortium'], year: 2019, venue: 'Journal', isRetracted: false });
    // Given names stay in step with the surnames: none here, so none are kept.
    expect(record?.givenNames).toBeUndefined();
  });

  test('keeps given names in step with the surnames', async () => {
    respond({ message: { DOI: '10.1234/abcd', title: ['T'], author: [{ family: 'Xiaoming', given: 'Wang' }, { name: 'The Consortium' }, { family: 'Yan', given: 'Li' }] } });
    const record = await crossref.lookupById(citation({ doi: '10.1234/abcd' }));
    expect(record?.authors).toEqual(['xiaoming', 'the consortium', 'yan']);
    expect(record?.givenNames).toEqual(['wang', '', 'li']);
  });

  test('maps preprint relations to otherVersion', async () => {
    respond({
      message: {
        DOI: '10.1234/abcd',
        title: ['T'],
        relation: { 'has-preprint': [{ 'id-type': 'doi', id: '10.48550/arXiv.1706.03762' }, { 'id-type': 'uri', id: 'http://evil.example/' }] },
      },
    });
    expect((await crossref.lookupById(citation({ doi: '10.1234/abcd' })))?.otherVersion).toEqual({ arxivId: '1706.03762' });
    respond({ message: { DOI: '10.1234/abcd', title: ['T'], relation: { 'is-preprint-of': [{ 'id-type': 'doi', id: '10.5555/published' }] } } });
    expect((await crossref.lookupById(citation({ doi: '10.1234/abcd' })))?.otherVersion).toEqual({ doi: '10.5555/published' });
  });

  test('maps update types to notes; only a retraction retracts', async () => {
    respond({
      message: {
        DOI: '10.1234/abcd',
        title: ['T'],
        'updated-by': [
          { type: 'expression_of_concern', DOI: '10.1234/eoc' },
          { type: 'withdrawal', DOI: '10.1234/wd' },
          { type: 'erratum', DOI: '10.1234/er' },
        ],
      },
    });
    const record = await crossref.lookupById(citation({ doi: '10.1234/abcd' }));
    expect(record?.isRetracted).toBe(false);
    expect(record?.notes.sort()).toEqual(['correction', 'expression_of_concern', 'withdrawn']);
  });
});

describe('crossref.search', () => {
  test('a title written in TeX is searched as text (arxiv-html:2503.01913#18)', async () => {
    respond(fixtureJson('crossref-search-retracted.json'));
    await crossref.search(citation({ title: 'On the sandpile group of p_{4}\\times c_{n}', authors: ['chen'], year: 2008 }));
    expect(requestedUrl().searchParams.get('query.bibliographic')).toBe('On the sandpile group of p4 cn chen 2008');
  });

  test('queries title, first author and year with the polite pool and a field list', async () => {
    respond(fixtureJson('crossref-search-retracted.json'));
    await crossref.search(
      citation({ title: 'Attention is all you need', authors: ['vaswani', 'shazeer'], year: 2017, raw: 'SECRET-READING-HISTORY-TOKEN' }),
    );
    const url = requestedUrl();
    expect(url.pathname).toBe('/works');
    expect(url.searchParams.get('query.bibliographic')).toBe('Attention is all you need vaswani 2017');
    // 10, not 5: comments on a famous paper rank above the paper's own record.
    expect(url.searchParams.get('rows')).toBe('10');
    expect(url.searchParams.get('mailto')).toBe(CONTACT_EMAIL);
    expect(url.searchParams.get('select')?.split(',')).toEqual(
      expect.arrayContaining(['DOI', 'title', 'author', 'issued', 'container-title', 'updated-by', 'relation']),
    );
    expect(url.href).not.toContain('SECRET');
  });

  test('maps every item, including the retracted one and an institutional author', async () => {
    respond(fixtureJson('crossref-search-retracted.json'));
    const records = await crossref.search(citation({ title: 'Ileal-lymphoid-nodular hyperplasia' }));
    expect(records).toHaveLength(5);
    expect(records.map((r) => r.isRetracted)).toEqual([false, true, false, false, false]);
    expect(records[1]?.doi).toBe('10.1016/s0140-6736(97)11096-0');
    expect(records[3]?.authors).toEqual(['inserm']);
    expect(records.every((r) => r.source === 'crossref')).toBe(true);
  });

  test('does nothing without a title', async () => {
    expect(await crossref.search(citation({ authors: ['vaswani'] }))).toEqual([]);
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  test('skips items that lack a title or a valid DOI', async () => {
    respond({ message: { items: [{ DOI: '10.1234/ok', title: ['Fine'] }, { DOI: '10.1234/notitle' }, { DOI: 'not-a-doi', title: ['Bad'] }, 'junk'] } });
    const records = await crossref.search(citation({ title: 'Fine' }));
    expect(records.map((r) => r.doi)).toEqual(['10.1234/ok']);
  });

  test('rejects a response that is not a list', async () => {
    respond({ message: { items: 'no' } });
    await expect(crossref.search(citation({ title: 'Fine' }))).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

// The retracted "arsenic life" paper cited without a DOI can be missed because its own record ranks
// 12th, behind a dozen "Comment on ..." notes that carry (almost) its title.
describe('crossref.search: notices about a work are not the work', () => {
  const item = (n: number, title: string, extra: Record<string, unknown> = {}) => ({ DOI: `10.1000/x${n}`, title: [title], author: [{ family: 'Roe', given: 'J' }], issued: { 'date-parts': [[2011]] }, ...extra });
  const TITLE = 'A bacterium that can grow by using arsenic instead of phosphorus';

  test.each(['Comment on “A bacterium”', 'Comments on A bacterium', 'Reply to Smith', 'Response to Comments on A bacterium', 'Erratum: A bacterium', 'Correction to: A bacterium', 'Corrigendum to A bacterium'])('%s is left out', async (notice) => {
    respond({ message: { items: [item(1, notice), item(2, TITLE)] } });
    const records = await crossref.search(citation({ title: TITLE }));
    expect(records.map((r) => r.doi)).toEqual(['10.1000/x2']);
  });

  test('a notice is kept when the reference itself cites a notice', async () => {
    respond({ message: { items: [item(1, 'Comment on “A bacterium that can grow by using arsenic”'), item(2, TITLE)] } });
    const records = await crossref.search(citation({ title: 'Comment on “A bacterium that can grow by using arsenic”' }));
    expect(records.map((r) => r.doi)).toEqual(['10.1000/x1', '10.1000/x2']);
  });

  test('a retraction notice is not dropped: it is the record that carries the retraction', async () => {
    respond({ message: { items: [item(1, 'RETRACTED: ' + TITLE, { 'updated-by': [{ type: 'retraction', DOI: '10.1000/n1' }] })] } });
    const records = await crossref.search(citation({ title: TITLE }));
    expect(records).toHaveLength(1);
    expect(records[0]?.isRetracted).toBe(true);
    expect(records[0]?.title).toBe(TITLE);
  });

  test('when notices crowd the first page, the next page is read too', async () => {
    const first = [...Array.from({ length: 7 }, (_, i) => item(i, `Comment on “${TITLE}”`)), item(7, 'Faculty Opinions recommendation of A bacterium'), item(8, 'Life and death with arsenic'), item(9, 'Faculty Opinions recommendation of A bacterium (2)')];
    respond({ message: { items: first } });
    respond({ message: { items: [item(10, 'x'), item(12, 'RETRACTED: ' + TITLE, { 'updated-by': [{ type: 'retraction', DOI: '10.1000/n1' }] })] } });
    const records = await crossref.search(citation({ title: TITLE, authors: ['wolfe simon'], year: 2011 }));
    expect(fetchJsonMock).toHaveBeenCalledTimes(2);
    const second = requestedUrl(1);
    expect(second.searchParams.get('offset')).toBe('10');
    expect(second.searchParams.get('rows')).toBe('10');
    expect(second.searchParams.get('query.bibliographic')).toBe(requestedUrl(0).searchParams.get('query.bibliographic'));
    expect(records.find((r) => r.isRetracted)?.doi).toBe('10.1000/x12');
    expect(records.some((r) => r.title.startsWith('Comment on'))).toBe(false);
  });

  test('one page is enough when few notices were among the results', async () => {
    const page = [item(1, 'Comment on A bacterium'), item(2, 'Reply to Smith'), ...Array.from({ length: 8 }, (_, i) => item(i + 3, `Another paper ${i}`))];
    respond({ message: { items: page } });
    await crossref.search(citation({ title: TITLE }));
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
  });
});

describe('crossref: the other dates of a work', () => {
  const item = (extra: Record<string, unknown>) => ({ DOI: '10.1000/x1', title: ['A title'], author: [{ family: 'Roe', given: 'J' }], ...extra });
  const parts = (...y: number[]) => ({ 'date-parts': [y] });

  test('print, online and posted years are kept apart from the main year', async () => {
    respond({ message: item({ issued: parts(2022, 1), 'published-print': parts(2022, 3), 'published-online': parts(2021, 11), posted: parts(2019, 5), type: 'posted-content' }) });
    const record = await crossref.lookupById(citation({ doi: '10.1000/x1' }));
    expect(record?.year).toBe(2022);
    expect(record?.otherYears).toEqual([2021, 2019]);
  });

  test('the date a DOI was created counts only for a preprint', async () => {
    respond({ message: item({ issued: parts(2015), created: parts(2002), type: 'journal-article' }) });
    expect((await crossref.lookupById(citation({ doi: '10.1000/x1' })))?.otherYears).toBeUndefined();
    respond({ message: item({ issued: parts(2015), created: parts(2013), type: 'posted-content' }) });
    expect((await crossref.lookupById(citation({ doi: '10.1000/x1' })))?.otherYears).toEqual([2013]);
  });

  test('search asks for those dates', async () => {
    respond({ message: { items: [] } });
    await crossref.search(citation({ title: 'A title' }));
    expect(requestedUrl().searchParams.get('select')?.split(',')).toEqual(expect.arrayContaining(['published-print', 'published-online', 'posted', 'created']));
  });
});

describe('crossref: volume, pages and journal names', () => {
  const work = (extra: Record<string, unknown>) => ({ DOI: '10.1103/physrevlett.98.100401', title: ['An article'], author: [{ family: 'Roe', given: 'J' }], issued: { 'date-parts': [[2007]] }, ...extra });

  test('are read from the work', async () => {
    respond({ message: work({ volume: '98', page: '100401-1', 'article-number': '100401', 'container-title': ['Physical Review Letters'], 'short-container-title': ['Phys. Rev. Lett.'] }) });
    const record = await crossref.lookupById(citation({ doi: '10.1103/physrevlett.98.100401' }));
    expect(record).toMatchObject({ volume: '98', pages: ['100401'], venue: 'Physical Review Letters', venues: ['Physical Review Letters', 'Phys. Rev. Lett.'], shortVenues: ['Phys. Rev. Lett.'] });
  });

  test('a page range gives its first page; letters are lower-cased', async () => {
    respond({ message: work({ volume: '32', page: 'A054043' }) });
    expect((await crossref.lookupById(citation({ doi: '10.1103/physrevlett.98.100401' })))?.pages).toEqual(['a054043']);
    respond({ message: work({ volume: '32', page: '1945–1973', 'article-number': 'e17' }) });
    expect((await crossref.lookupById(citation({ doi: '10.1103/physrevlett.98.100401' })))?.pages).toEqual(['1945', 'e17']);
  });

  test('nothing is invented for a work without them', async () => {
    respond({ message: work({}) });
    const record = await crossref.lookupById(citation({ doi: '10.1103/physrevlett.98.100401' }));
    expect(record?.volume).toBeUndefined();
    expect(record?.pages).toBeUndefined();
    expect(record?.venues).toBeUndefined();
  });
});

// A reply with more rows than were asked for is cut to them before anything in it is read.
describe('crossref: no more rows than asked for', () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ DOI: `10.1234/n${i}`, title: [`Title number ${i}`] }));

  test('a search reads ten rows at most', async () => {
    respond({ message: { items: items(500) } });
    const records = await crossref.search(citation({ title: 'Title number', authors: ['someone'] }));
    expect(records.map((r) => r.doi)).toEqual(items(10).map((i) => i.DOI));
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
  });

  test('a title-less journal citation reads ten rows at most', async () => {
    respond({ message: { items: items(500) } });
    const records = await crossref.searchLocator(citation({ raw: 'E. Linder, Phys. Rev. D81, 127301 (2010) Cited by: §2.', authors: [] }));
    expect(records.map((r) => r.doi)).toEqual(items(10).map((i) => i.DOI));
  });
});

describe('crossref.searchLocator', () => {
  const cited = citation({ raw: 'E. Linder, Phys. Rev. D81, 127301 (2010) Cited by: §2.', authors: [] });

  test('asks once, with the reference as written, a year window and ten rows', async () => {
    respond({ message: { items: [] } });
    await crossref.searchLocator(cited);
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
    const url = requestedUrl();
    expect(url.pathname).toBe('/works');
    expect(url.searchParams.get('query.bibliographic')).toBe('E. Linder, Phys. Rev. D81, 127301 (2010)');
    // Ten answers, restricted to the cited year and its neighbours (the article was the sixth in the five-answer query)
    expect(url.searchParams.get('rows')).toBe('10');
    expect(url.searchParams.get('filter')).toBe('from-pub-date:2009,until-pub-date:2011');
    expect(url.searchParams.get('mailto')).toBe(CONTACT_EMAIL);
    expect(url.searchParams.get('select')?.split(',')).toEqual(expect.arrayContaining(['DOI', 'volume', 'page', 'article-number', 'container-title', 'short-container-title', 'issued']));
    expect(fetchJsonMock.mock.calls[0]?.[1]).toMatchObject({ source: 'crossref' });
  });

  test('keeps notices: a comment can be the article that is cited', async () => {
    respond({ message: { items: [{ DOI: '10.1234/x', title: ['Comment on a thing'], author: [], volume: '1', page: '2' }] } });
    expect(await crossref.searchLocator(cited)).toHaveLength(1);
  });

  test('sends nothing for a citation with no locator', async () => {
    expect(await crossref.searchLocator(citation({ raw: 'just some words' }))).toEqual([]);
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  test('rejects a response that is not a list', async () => {
    respond({ message: { items: 'no' } });
    await expect(crossref.searchLocator(cited)).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

// When the first answers hold no match, one more request: the DOI APS and IOP build from the locator,
// or else a search with the first author's surname. Both only add candidates; the engine still matches every part.
describe('crossref.searchLocatorAgain', () => {
  const work = (doi: string, extra: Record<string, unknown> = {}) => ({ message: { DOI: doi, title: ['An article'], author: [{ family: 'Astone', given: 'P.' }], issued: { 'date-parts': [[2010]] }, 'container-title': ['Physical Review D'], volume: '82', 'article-number': '022003', ...extra } });

  test('reads the record of the DOI APS builds from the locator', async () => {
    respond(work('10.1103/physrevd.82.022003'));
    const found = await crossref.searchLocatorAgain(citation({ raw: 'P. Astone et al., Phys. Rev. D 82, 022003 (2010).' }));
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
    const url = requestedUrl();
    expect(url.pathname).toBe('/works/10.1103/PhysRevD.82.022003');
    expect(url.searchParams.get('mailto')).toBe(CONTACT_EMAIL);
    expect(fetchJsonMock.mock.calls[0]?.[1]).toMatchObject({ source: 'crossref' });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ doi: '10.1103/physrevd.82.022003', volume: '82', pages: ['022003'] });
  });

  test('reads the record of the DOI IOP built for Classical and Quantum Gravity', async () => {
    respond(work('10.1088/0264-9381/29/23/235004', { 'container-title': ['Classical and Quantum Gravity'], volume: '29', page: '235004' }));
    await crossref.searchLocatorAgain(citation({ raw: 'S. M. Aston et al., Classical Quantum Gravity 29, 235004 (2012).' }));
    expect(requestedUrl().pathname).toBe('/works/10.1088/0264-9381/29/23/235004');
  });

  test('finds nothing, without failing, when Crossref has no work for the built DOI', async () => {
    fetchJsonMock.mockRejectedValueOnce(new SourceError('not_found_http', 'crossref', 'Not found (HTTP 404)'));
    expect(await crossref.searchLocatorAgain(citation({ raw: 'J. Roe et al., Phys. Rev. D 82, 999999 (2010).' }))).toEqual([]);
  });

  test('drops a record it cannot read', async () => {
    respond({ message: { title: ['No DOI here'] } });
    expect(await crossref.searchLocatorAgain(citation({ raw: 'P. Astone et al., Phys. Rev. D 82, 022003 (2010).' }))).toEqual([]);
  });

  test('passes on a failure of the service', async () => {
    fetchJsonMock.mockRejectedValueOnce(new SourceError('unavailable', 'crossref', 'down'));
    await expect(crossref.searchLocatorAgain(citation({ raw: 'P. Astone et al., Phys. Rev. D 82, 022003 (2010).' }))).rejects.toMatchObject({ kind: 'unavailable' });
  });

  test('for other journals, searches again with the first author', async () => {
    respond({ message: { items: [work('10.1063/1.4936974').message] } });
    const found = await crossref.searchLocatorAgain(citation({ raw: 'C. L. Mueller et al., Rev. Sci. Instrum. 87, 014502 (2016). Cited by: §2.' }));
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
    const url = requestedUrl();
    expect(url.pathname).toBe('/works');
    expect(url.searchParams.get('query.bibliographic')).toBe('C. L. Mueller et al., Rev. Sci. Instrum. 87, 014502 (2016).');
    expect(url.searchParams.get('query.author')).toBe('mueller');
    expect(url.searchParams.get('filter')).toBe('from-pub-date:2015,until-pub-date:2017');
    expect(url.searchParams.get('rows')).toBe('10');
    expect(url.searchParams.get('mailto')).toBe(CONTACT_EMAIL);
    expect(found).toHaveLength(1);
  });

  test('sends nothing when there is neither a DOI to build nor an author to search by', async () => {
    expect(await crossref.searchLocatorAgain(citation({ raw: 'Nature 571, 95 (2019).' }))).toEqual([]);
    expect(await crossref.searchLocatorAgain(citation({ raw: 'just some words' }))).toEqual([]);
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  test('rejects an author search response that is not a list', async () => {
    respond({ message: { items: 'no' } });
    await expect(crossref.searchLocatorAgain(citation({ raw: 'C. L. Mueller et al., Rev. Sci. Instrum. 87, 014502 (2016).' }))).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

describe('crossref: a subtitle kept apart from the title', () => {
  const work = (extra: Record<string, unknown>) => ({ DOI: '10.1000/x1', author: [{ family: 'Roe', given: 'J' }], issued: { 'date-parts': [[2020]] }, ...extra });

  test('is written after the title, as references write it', async () => {
    respond({ message: work({ title: ['Mayo'], subtitle: ['A Framework for Auto-generating Hardware Friendly Deep Neural Networks'] }) });
    expect((await crossref.lookupById(citation({ doi: '10.1000/x1' })))?.title).toBe('Mayo: A Framework for Auto-generating Hardware Friendly Deep Neural Networks');
  });

  // A search answer without the subtitle would make correct citations that write it look like invented ones.
  test('is asked for in a title search too, and written after the title there', async () => {
    respond({ message: { items: [work({ title: ['Mayo'], subtitle: ['A Framework for Auto-generating Hardware Friendly Deep Neural Networks'] })] } });
    const records = await crossref.search(citation({ title: 'Mayo: A Framework for Auto-generating Hardware Friendly Deep Neural Networks' }));
    expect(requestedUrl().searchParams.get('select')?.split(',')).toContain('subtitle');
    expect(records[0]?.title).toBe('Mayo: A Framework for Auto-generating Hardware Friendly Deep Neural Networks');
  });

  test('is not added twice, and its absence changes nothing', async () => {
    respond({ message: work({ title: ['Mayo: a framework for networks'], subtitle: ['A framework for networks'] }) });
    expect((await crossref.lookupById(citation({ doi: '10.1000/x1' })))?.title).toBe('Mayo: a framework for networks');
    respond({ message: work({ title: ['Mayo'] }) });
    expect((await crossref.lookupById(citation({ doi: '10.1000/x1' })))?.title).toBe('Mayo');
  });
});

// Inline markup in a record's title never splits a word ("CeCoIn<sub>5</sub>" is
// "CeCoIn5"), and a formula stands as a word of its own, its own tags and line breaks splitting nothing inside it.
describe('crossref: markup in a title', () => {
  const work = (title: string) => ({ message: { DOI: '10.1088/0953-8984/13/17/103', title: [title], author: [{ family: 'Petrovic', given: 'C' }], issued: { 'date-parts': [[2001]] } } });

  test.each([
    ['a subscript', 'Heavy-fermion superconductivity in CeCoIn<sub>5</sub> at 2.3 K', 'Heavy-fermion superconductivity in CeCoIn5 at 2.3 K'],
    ['italics and small capitals', 'The <i>in situ</i> growth of <scp>BERT</scp> models', 'The in situ growth of BERT models'],
    [
      'a MathML formula with no space around it',
      'Electronic structure of the<mml:math xmlns:mml="http://www.w3.org/1998/Math/MathML" display="inline"><mml:mrow><mml:msub><mml:mrow><mml:mtext>BaFe</mml:mtext></mml:mrow><mml:mn>2</mml:mn></mml:msub><mml:msub><mml:mrow><mml:mtext>As</mml:mtext></mml:mrow><mml:mn>2</mml:mn></mml:msub></mml:mrow></mml:math>family of iron-pnictide superconductors',
      'Electronic structure of the BaFe2As2 family of iron-pnictide superconductors',
    ],
    [
      'a MathML formula laid out on several lines',
      'Heavy-fermion superconductivity in \n<mml:math xmlns:mml="http://www.w3.org/1998/Math/MathML">\n  <mml:msub>\n    <mml:mi>CeCoIn</mml:mi>\n    <mml:mn>5</mml:mn>\n  </mml:msub>\n</mml:math>\n at 2.3 K',
      'Heavy-fermion superconductivity in CeCoIn5 at 2.3 K',
    ],
  ])('%s', async (_what, raw, plain) => {
    respond(work(raw));
    expect((await crossref.lookupById(citation({ doi: '10.1088/0953-8984/13/17/103' })))?.title).toBe(plain);
  });
});

// A record the service lists as a dataset or another kind of work that is not a paper
// says so, so that its other name is never read as "a different paper".
describe('crossref: what kind of work a record is', () => {
  const item = (type: unknown) => ({ DOI: '10.1000/x1', title: ['A record'], author: [{ family: 'Roe', given: 'J' }], issued: { 'date-parts': [[2020]] }, type });

  test.each(['dataset', 'database', 'component', 'grant'])('a %s is not a paper', async (type) => {
    respond({ message: item(type) });
    expect((await crossref.lookupById(citation({ doi: '10.1000/x1' })))?.nonPaper).toBe(true);
  });

  test.each(['journal-article', 'proceedings-article', 'book-chapter', 'posted-content', 'report', 'peer-review', 'other', undefined, 7])('a record of type %s is not marked', async (type) => {
    respond({ message: item(type) });
    expect((await crossref.lookupById(citation({ doi: '10.1000/x1' })))?.nonPaper).toBeUndefined();
  });

  test('a search result says so too', async () => {
    respond({ message: { items: [item('dataset')] } });
    expect((await crossref.search(citation({ title: 'A record' })))[0]?.nonPaper).toBe(true);
  });
});
