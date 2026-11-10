import { beforeEach, describe, expect, test, vi } from 'vitest';
import { citation, fixtureText } from '../helpers/fixtures';

vi.mock('../../../src/sources/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/sources/http')>();
  return { ...actual, fetchJson: vi.fn(), fetchText: vi.fn() };
});

import { fetchText, SourceError } from '../../../src/sources/http';
import { arxiv } from '../../../src/sources/arxiv';

const fetchTextMock = vi.mocked(fetchText);

function requestedUrl(call = 0): URL {
  const url = fetchTextMock.mock.calls[call]?.[0];
  if (url === undefined) throw new Error('no request was made');
  return new URL(url);
}

const entryXml = (id: string, title = 'T'): string =>
  `<entry><id>http://arxiv.org/abs/${id}v1</id><title>${title}</title><published>2020-01-01T00:00:00Z</published><author><name>Ada Lovelace</name></author></entry>`;
const feed = (...entries: string[]): string => `<feed>${entries.join('')}</feed>`;
const feedOf = (total: number, ...entries: string[]): string => `<feed><opensearch:totalResults>${total}</opensearch:totalResults>${entries.join('')}</feed>`;
const errorEntry = '<entry><id>https://arxiv.org/api/errors#incorrect_id_format_for_x</id><title>Error</title><summary>incorrect id format for x</summary></entry>';

beforeEach(() => {
  fetchTextMock.mockReset();
});

describe('arxiv.lookupById', () => {
  test('maps a recorded entry', async () => {
    fetchTextMock.mockResolvedValueOnce(fixtureText('arxiv-1706.03762.atom.xml'));
    const record = await arxiv.lookupById(citation({ arxivId: '1706.03762v3' }));
    expect(record).toEqual({
      source: 'arxiv',
      title: 'Attention Is All You Need',
      authors: ['vaswani', 'shazeer', 'parmar', 'uszkoreit', 'jones', 'gomez', 'kaiser', 'polosukhin'],
      year: 2017,
      arxivId: '1706.03762',
      isRetracted: false,
      notes: [],
    });
    const url = requestedUrl();
    expect(url.origin + url.pathname).toBe('https://export.arxiv.org/api/query');
    expect(url.searchParams.get('id_list')).toBe('1706.03762');
    expect(fetchTextMock.mock.calls[0]?.[1]).toMatchObject({ source: 'arxiv', kind: 'xml' });
  });

  test('adds a withdrawn note for a withdrawn paper, and keeps the journal reference as venue', async () => {
    fetchTextMock.mockResolvedValueOnce(fixtureText('arxiv-withdrawn-1005.4018.atom.xml'));
    const record = await arxiv.lookupById(citation({ arxivId: '1005.4018' }));
    expect(record?.notes).toEqual(['withdrawn']);
    expect(record?.isRetracted).toBe(false);
    expect(record?.venue).toBe('Journal of Computing, Volume 2, Issue 5, May 2010');
    expect(record?.year).toBe(2010);
  });

  test('uses the DOI the authors gave as otherVersion', async () => {
    fetchTextMock.mockResolvedValueOnce(fixtureText('arxiv-with-doi-1602.03837.atom.xml'));
    const record = await arxiv.lookupById(citation({ arxivId: '1602.03837' }));
    expect(record?.otherVersion).toEqual({ doi: '10.1103/PhysRevLett.116.061102' });
    expect(record?.doi).toBeUndefined();
  });

  test('returns null for an ID arXiv does not list, and for a malformed one without asking', async () => {
    fetchTextMock.mockResolvedValueOnce(feed());
    expect(await arxiv.lookupById(citation({ arxivId: '9999.99999' }))).toBeNull();
    expect(await arxiv.lookupById(citation({ arxivId: 'not an id&x=1' }))).toBeNull();
    expect(await arxiv.lookupById(citation({ doi: '10.1/x' }))).toBeNull();
    expect(fetchTextMock).toHaveBeenCalledTimes(1);
  });

  test('passes failures on', async () => {
    const failure = new SourceError('rate_limited', 'arxiv', 'Rate limited (HTTP 429)');
    fetchTextMock.mockRejectedValueOnce(failure);
    await expect(arxiv.lookupById(citation({ arxivId: '1706.03762' }))).rejects.toBe(failure);
  });

  test('an unparseable document is a bad_response', async () => {
    fetchTextMock.mockResolvedValueOnce('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><feed/>');
    await expect(arxiv.lookupById(citation({ arxivId: '1706.03762' }))).rejects.toMatchObject({ kind: 'bad_response', source: 'arxiv' });
  });
});

describe('withdrawn detection', () => {
  const lookup = async (summary: string, comment?: string): Promise<string[] | undefined> => {
    const extra = `<summary>${summary}</summary>${comment === undefined ? '' : `<arxiv:comment>${comment}</arxiv:comment>`}`;
    fetchTextMock.mockResolvedValueOnce(feed(entryXml('1234.5678').replace('</title>', `</title>${extra}`)));
    return (await arxiv.lookupById(citation({ arxivId: '1234.5678' })))?.notes;
  };

  test('a withdrawal statement in the summary or comment is flagged', async () => {
    expect(await lookup('This paper has been withdrawn by the author due to a crucial error.')).toEqual(['withdrawn']);
    expect(await lookup('Withdrawn.')).toEqual(['withdrawn']);
    expect(await lookup('Title: An unlikely result Authors: T.M. Other Comments: This paper has been withdrawn Abstract: This paper has been withdrawn by the author due to errors')).toEqual(['withdrawn']);
    expect(await lookup('Fine abstract', 'Withdrawn: the data were wrong')).toEqual(['withdrawn']);
    expect(await lookup('Fine abstract', '  This submission has been withdrawn')).toEqual(['withdrawn']);
    expect(await lookup('Fine abstract', '12 pages. Withdrawn by the authors')).toEqual(['withdrawn']);
  });

  test('ordinary papers and mere mentions are not flagged', async () => {
    expect(await lookup('We study samples that were withdrawn from patients and report results.')).toEqual([]);
    expect(await lookup('Fine abstract', '12 pages, 3 figures')).toEqual([]);
    expect(await lookup('x'.repeat(500) + ' This paper has been withdrawn')).toEqual([]);
    expect(await lookup('Fine abstract', 'added discussion of withdrawal rates')).toEqual([]);
    expect(await lookup('Fine abstract', 'the claim is not withdrawn')).toEqual([]);
    expect(await lookup('Fine abstract', 'Author requested a withdrawal of the old version')).toEqual([]);
  });
});

describe('arxiv.lookupMany', () => {
  test('sends ids in batches of at most 50 and merges the results by version-less id', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `2001.${String(i + 1).padStart(5, '0')}`);
    fetchTextMock.mockImplementation((url) => {
      const asked = (new URL(url).searchParams.get('id_list') ?? '').split(',');
      return Promise.resolve(feed(...asked.map((id) => entryXml(id, `Paper ${id}`))));
    });
    const found = await arxiv.lookupMany(ids.map((id, i) => (i === 0 ? `${id}v2` : id)));
    expect(fetchTextMock).toHaveBeenCalledTimes(3);
    const sizes = fetchTextMock.mock.calls.map((call) => new URL(call[0]).searchParams.get('id_list')?.split(',').length);
    expect(sizes).toEqual([50, 50, 20]);
    for (const call of fetchTextMock.mock.calls) {
      expect(new URL(call[0]).searchParams.get('max_results')).toBe(String(new URL(call[0]).searchParams.get('id_list')?.split(',').length));
    }
    expect(found.size).toBe(120);
    expect(found.get('2001.00001')?.title).toBe('Paper 2001.00001');
    expect(found.get('2001.00001v2')).toBeUndefined();
  });

  test('skips invalid and duplicate ids and omits unknown ones', async () => {
    fetchTextMock.mockResolvedValueOnce(
      feed(
        entryXml('1706.03762'),
        entryXml('hep-th/9901001'),
        '<entry><id>http://evil.example/abs/1706.03763v1</id><title>Spoof</title></entry>',
      ),
    );
    const found = await arxiv.lookupMany(['1706.03762', '1706.03762v2', 'bad id', 'hep-th/9901001', '1111.11111']);
    expect([...found.keys()].sort()).toEqual(['1706.03762', 'hep-th/9901001']);
    const asked = requestedUrl().searchParams.get('id_list');
    expect(asked).toBe('1706.03762,hep-th/9901001,1111.11111');
  });

  test('an ID missing from a well-formed feed means it does not exist', async () => {
    fetchTextMock.mockResolvedValueOnce(feedOf(1, entryXml('1706.03762')));
    const found = await arxiv.lookupMany(['1706.03762', '9999.99999']);
    expect([...found.keys()]).toEqual(['1706.03762']);
    fetchTextMock.mockResolvedValueOnce(feedOf(0));
    expect(await arxiv.lookupById(citation({ arxivId: '9999.99999' }))).toBeNull();
  });

  test.each([
    ['an HTML error page', '<html>Rate exceeded</html>'],
    ['an empty body', ''],
    ['a truncated feed', feed(entryXml('1706.03762'), entryXml('1706.03763')).slice(0, -30)],
    ['an arXiv error entry', feed(errorEntry)],
    ['an error entry beside a real one', feed(entryXml('1706.03762'), errorEntry)],
    ['more entries than totalResults', feedOf(1, entryXml('1706.03762'), entryXml('1706.03763'))],
  ])('%s is a bad_response, never "not found"', async (_name, body) => {
    fetchTextMock.mockResolvedValue(body);
    await expect(arxiv.lookupMany(['1706.03762', '1706.03763'])).rejects.toMatchObject({ name: 'SourceError', kind: 'bad_response', source: 'arxiv' });
    await expect(arxiv.lookupById(citation({ arxivId: '1706.03762' }))).rejects.toMatchObject({ kind: 'bad_response', source: 'arxiv' });
    await expect(arxiv.search(citation({ title: 'Some title' }))).rejects.toMatchObject({ kind: 'bad_response', source: 'arxiv' });
  });

  test('fewer entries than totalResults promised is a bad_response', async () => {
    fetchTextMock.mockResolvedValueOnce(feedOf(2, entryXml('1706.03762')));
    await expect(arxiv.lookupMany(['1706.03762', '1706.03763'])).rejects.toMatchObject({ kind: 'bad_response', source: 'arxiv' });
  });

  test('a later batch that fails fails the whole lookup', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `2001.${String(i + 1).padStart(5, '0')}`);
    fetchTextMock.mockResolvedValueOnce(feed()).mockResolvedValueOnce('<html>Rate exceeded</html>');
    await expect(arxiv.lookupMany(ids)).rejects.toMatchObject({ kind: 'bad_response' });
  });

  test('search compares totalResults with the page size, not with itself', async () => {
    const five = Array.from({ length: 5 }, (_, i) => entryXml(`1706.0376${i}`));
    fetchTextMock.mockResolvedValueOnce(feedOf(1234, ...five));
    expect(await arxiv.search(citation({ title: 'Some title' }))).toHaveLength(5);
    fetchTextMock.mockResolvedValueOnce(feedOf(1234, ...five.slice(0, 3)));
    await expect(arxiv.search(citation({ title: 'Some title' }))).rejects.toMatchObject({ kind: 'bad_response' });
  });

  test('makes no request for no valid ids', async () => {
    expect((await arxiv.lookupMany([])).size).toBe(0);
    expect((await arxiv.lookupMany(['zzz'])).size).toBe(0);
    expect(fetchTextMock).not.toHaveBeenCalled();
  });
});

// A batch of 30 ids whose answer is about 110 KB, with a 200- and a 265-author entry, once failed twice in a live
// run, while the same request by hand answered at once. The answer itself is read whole and well inside the size caps,
// so the failure was in getting it: the first attempt ended 15.0 s after the paper started, which is the request
// timeout (a timeout is not retried by http.ts).
describe('arxiv.lookupMany on a large batch', () => {
  const people = (n: number): string => Array.from({ length: n }, (_, i) => `<author><name>Author Number${i} Surname${i}</name></author>`).join('');
  const bigEntry = (id: string, authors: number): string =>
    `<entry><id>http://arxiv.org/abs/${id}v2</id><title>Technical report ${id}</title><published>2024-12-27T00:00:00Z</published><summary>${'An abstract sentence. '.repeat(100)}</summary>${people(authors)}</entry>`;
  const ids = Array.from({ length: 30 }, (_, i) => `2412.${String(10_000 + i)}`);

  test('a 30-id answer of over 100 KB with hundreds of authors per entry is read whole', async () => {
    const xml = feedOf(30, ...ids.map((id, i) => bigEntry(id, i === 7 ? 200 : i === 26 ? 265 : 8)));
    expect(xml.length).toBeGreaterThan(100_000);
    fetchTextMock.mockResolvedValueOnce(xml);
    const found = await arxiv.lookupMany(ids);
    expect(found.size).toBe(30);
    expect(found.get(ids[26] ?? '')?.authors).toHaveLength(265);
    expect(fetchTextMock).toHaveBeenCalledTimes(1);
  });
});

describe('arxiv.search', () => {
  test('searches by exact title with a small page', async () => {
    fetchTextMock.mockResolvedValueOnce(fixtureText('arxiv-1706.03762.atom.xml'));
    const records = await arxiv.search(citation({ title: 'Attention Is All You Need!', authors: ['vaswani'], raw: 'SECRET-READING-HISTORY-TOKEN' }));
    expect(records.map((r) => r.arxivId)).toEqual(['1706.03762']);
    const url = requestedUrl();
    expect(url.searchParams.get('search_query')).toBe('ti:"attention is all you need"');
    expect(url.searchParams.get('max_results')).toBe('5');
    expect(url.href).not.toContain('SECRET');
  });

  test('a TeX macro in the title leaves its argument in the query, not its name (arxiv-html:2609.00504#16)', async () => {
    fetchTextMock.mockResolvedValueOnce(feed());
    await arxiv.search(citation({ title: '\\widetilde{O}(T^{-1}) convergence to (coarse) correlated equilibria in full-information general-sum Markov games' }));
    expect(requestedUrl().searchParams.get('search_query')).toBe('ti:"o t 1 convergence to coarse correlated equilibria in full information general sum markov games"');
  });

  test('cannot be used to inject query syntax through a title', async () => {
    fetchTextMock.mockResolvedValueOnce(feed());
    await arxiv.search(citation({ title: 'x" OR all:secret&max_results=9999 AND (y)' }));
    const url = requestedUrl();
    expect(url.searchParams.get('search_query')).toBe('ti:"x or all secret maxresults 9999 and y"');
    expect(url.searchParams.get('max_results')).toBe('5');
  });

  test('does nothing without a usable title', async () => {
    expect(await arxiv.search(citation({}))).toEqual([]);
    expect(await arxiv.search(citation({ title: '!!!' }))).toEqual([]);
    expect(fetchTextMock).not.toHaveBeenCalled();
  });
});
