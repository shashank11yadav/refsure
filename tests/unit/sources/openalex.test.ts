import { beforeEach, describe, expect, test, vi } from 'vitest';
import { citation, fixtureJson } from '../helpers/fixtures';

vi.mock('../../../src/sources/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/sources/http')>();
  return { ...actual, fetchJson: vi.fn(), fetchText: vi.fn(), setSecret: vi.fn(actual.setSecret) };
});

type Http = typeof import('../../../src/sources/http');
type OpenAlexModule = typeof import('../../../src/sources/openalex');

let http: Http;
let openalex: OpenAlexModule['openalex'];

const KEY = 'oa-test-key-123456';

function respond(data: unknown, headers: Record<string, string> = {}): void {
  vi.mocked(http.fetchJson).mockResolvedValueOnce({ data, headers: new Headers(headers) });
}
function requestedUrl(call = 0): URL {
  const url = vi.mocked(http.fetchJson).mock.calls[call]?.[0];
  if (url === undefined) throw new Error('no request was made');
  return new URL(url);
}

// The adapter keeps its key and budget state at module level: load a fresh copy per test.
beforeEach(async () => {
  vi.resetModules();
  http = await import('../../../src/sources/http');
  openalex = (await import('../../../src/sources/openalex')).openalex;
  http.setSecret(undefined);
});

describe('openalex.lookupById', () => {
  test('maps a retracted work', async () => {
    respond(fixtureJson('openalex-work-retracted.json'));
    const record = await openalex.lookupById(citation({ doi: '10.1016/S0140-6736(97)11096-0' }));
    expect(record).toMatchObject({
      source: 'openalex',
      title: 'Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children',
      year: 1998,
      venue: 'The Lancet',
      doi: '10.1016/s0140-6736(97)11096-0',
      isRetracted: true,
      notes: [],
    });
    expect(record?.authors.slice(0, 3)).toEqual(['wakefield', 'murch', 'anthony']);
    expect(record?.authors).toHaveLength(13);
  });

  test('asks for a DOI lookup with a field list and no key when none is set', async () => {
    respond(fixtureJson('openalex-work-retracted.json'));
    await openalex.lookupById(citation({ doi: '10.1016/S0140-6736(97)11096-0' }));
    const url = requestedUrl();
    expect(url.origin).toBe('https://api.openalex.org');
    expect(url.pathname).toBe('/works/doi:10.1016/S0140-6736(97)11096-0');
    expect(url.searchParams.get('select')?.split(',')).toEqual(expect.arrayContaining(['title', 'is_retracted', 'authorships']));
    expect(url.searchParams.has('api_key')).toBe(false);
    expect(vi.mocked(http.fetchJson).mock.calls[0]?.[1]).toMatchObject({ source: 'openalex' });
  });

  test('looks an arXiv ID up through its DataCite DOI', async () => {
    respond(fixtureJson('openalex-work-retracted.json'));
    await openalex.lookupById(citation({ arxivId: '1706.03762v5' }));
    expect(requestedUrl().pathname).toBe('/works/doi:10.48550/arXiv.1706.03762');
  });

  test('returns null for an unknown ID and for a citation with no identifier', async () => {
    vi.mocked(http.fetchJson).mockRejectedValueOnce(new http.SourceError('not_found_http', 'openalex', 'Not found (HTTP 404)'));
    expect(await openalex.lookupById(citation({ doi: '10.9999/nope' }))).toBeNull();
    expect(await openalex.lookupById(citation({ title: 'x' }))).toBeNull();
    expect(vi.mocked(http.fetchJson)).toHaveBeenCalledTimes(1);
  });

  test('rejects a response that is not a work', async () => {
    respond([1, 2]);
    await expect(openalex.lookupById(citation({ doi: '10.1038/nature14539' }))).rejects.toMatchObject({ kind: 'bad_response', source: 'openalex' });
  });

  test('picks the preprint twin out of the locations, but only from a valid arXiv ID', async () => {
    respond({
      id: 'https://openalex.org/W1',
      doi: 'https://doi.org/10.1109/cvpr.2016.90',
      title: 'Deep Residual Learning',
      publication_year: 2016,
      locations: [
        { landing_page_url: 'https://doi.org/10.1109/cvpr.2016.90' },
        { landing_page_url: 'https://arxiv.org/abs/1512.03385' },
        { landing_page_url: 'https://arxiv.org/abs/not an id' },
      ],
    });
    const record = await openalex.lookupById(citation({ doi: '10.1109/cvpr.2016.90' }));
    expect(record?.otherVersion).toEqual({ arxivId: '1512.03385' });
    expect(record?.isRetracted).toBe(false);
  });

  test('ignores a non-boolean is_retracted and a hostile DOI', async () => {
    respond({ title: 'T', doi: 'javascript:alert(1)', is_retracted: 'yes', publication_year: 'soon', authorships: [null, { author: { display_name: 5 } }] });
    const record = await openalex.lookupById(citation({ doi: '10.1038/nature14539' }));
    expect(record).toMatchObject({ title: 'T', isRetracted: false, authors: [] });
    expect(record?.doi).toBeUndefined();
    expect(record?.year).toBeUndefined();
  });
});

describe('openalex.search', () => {
  test('searches by title and maps results, ignoring the notice text in meta', async () => {
    const fixture = fixtureJson('openalex-search.json');
    expect(JSON.stringify(fixture)).toContain('AI agent'); // the recorded notice is addressed to agents
    respond(fixture, { 'x-ratelimit-remaining-usd': '0.098' });
    const records = await openalex.search(citation({ title: 'Attention is all you need', authors: ['vaswani'], year: 2017 }));
    expect(records).toHaveLength(5);
    expect(records[0]).toMatchObject({ title: 'Attention Is All You Need', doi: '10.65215/2q58a426', year: 2025, authors: expect.arrayContaining(['vaswani', 'shazeer']) });
    expect(records[3]?.venue).toBe('Briefings in Bioinformatics');
    expect(vi.mocked(http.fetchJson)).toHaveBeenCalledTimes(1); // nothing was followed up
    const url = requestedUrl();
    expect(url.pathname).toBe('/works');
    expect(url.searchParams.get('search')).toBe('Attention is all you need');
    expect(url.searchParams.get('per-page')).toBe('5');
  });

  test('a title written in TeX is searched as text', async () => {
    respond(fixtureJson('openalex-search.json'));
    await openalex.search(citation({ title: '\\widetilde{O}(T^{-1}) convergence to (coarse) correlated equilibria' }));
    expect(requestedUrl().searchParams.get('search')).toBe('O(T-1) convergence to (coarse) correlated equilibria');
  });

  test('does nothing without a title', async () => {
    expect(await openalex.search(citation({ authors: ['x'] }))).toEqual([]);
    expect(vi.mocked(http.fetchJson)).not.toHaveBeenCalled();
  });

  test('searches go through the search lane, lookups by id do not (a refused search must not pause the free lookups)', async () => {
    respond({ results: [] });
    await openalex.search(citation({ title: 'T' }));
    respond(fixtureJson('openalex-work-retracted.json'));
    await openalex.lookupById(citation({ doi: '10.1016/S0140-6736(97)11096-0' }));
    const calls = vi.mocked(http.fetchJson).mock.calls;
    expect(calls[0]?.[1]).toMatchObject({ lane: 'search' });
    expect(calls[1]?.[1]).not.toHaveProperty('lane');
  });

  test('rejects a response with no results list', async () => {
    respond({ results: 'no' });
    await expect(openalex.search(citation({ title: 'T' }))).rejects.toMatchObject({ kind: 'bad_response' });
  });
  test('keeps the work id (W and digits) taken from the openalex.org address, and nothing else from it', async () => {
    respond(fixtureJson('openalex-search.json'));
    const records = await openalex.search(citation({ title: 'Attention is all you need' }));
    expect(records.map((r) => r.openalexId)).toEqual(['W2626778328', 'W3163652268', 'W2997150500', 'W4390678101', 'W7124707810']);

    const work = (id: unknown) => ({ id, title: 'T' });
    // Two searches, since a search reads five works at most.
    respond({ results: [work('https://openalex.org/W123'), work('https://evil.example/W123'), work('https://openalex.org/A5103024730'), work('W123')] });
    respond({ results: [work('https://openalex.org/W123?x=1'), work('http://openalex.org/W123'), work(7)] });
    const odd = [...(await openalex.search(citation({ title: 'T' }))), ...(await openalex.search(citation({ title: 'T' })))];
    expect(odd.map((r) => r.openalexId)).toEqual(['W123', undefined, undefined, undefined, undefined, undefined, undefined]);
  });

});

describe('openalex: no more rows than asked for', () => {
  test('a search reads five works at most', async () => {
    const works = Array.from({ length: 200 }, (_, i) => ({ id: `https://openalex.org/W${i + 1}`, title: `Title number ${i}` }));
    respond({ results: works });
    const records = await openalex.search(citation({ title: 'Title number' }));
    expect(records.map((r) => r.openalexId)).toEqual(['W1', 'W2', 'W3', 'W4', 'W5']);
  });
});

describe('openalex budget', () => {
  test('a 429 that asks for a long wait means the daily budget is spent', async () => {
    vi.mocked(http.fetchJson).mockRejectedValueOnce(new http.SourceError('rate_limited', 'openalex', 'Rate limited (HTTP 429)', 14_538_000));
    await expect(openalex.search(citation({ title: 'T' }))).rejects.toMatchObject({ name: 'SourceError', kind: 'budget_exhausted', source: 'openalex' });
    // Later searches fail fast without spending a request; free ID lookups still go through.
    await expect(openalex.search(citation({ title: 'T' }))).rejects.toMatchObject({ kind: 'budget_exhausted' });
    expect(vi.mocked(http.fetchJson)).toHaveBeenCalledTimes(1);
    respond(fixtureJson('openalex-work-retracted.json'));
    expect(await openalex.lookupById(citation({ doi: '10.1016/S0140-6736(97)11096-0' }))).not.toBeNull();
  });

  // The key is set again at the start of every run and on every settings change: only a new key has a new budget.
  const spendBudget = async (): Promise<void> => {
    vi.mocked(http.fetchJson).mockRejectedValueOnce(new http.SourceError('rate_limited', 'openalex', 'Rate limited (HTTP 429)', 14_538_000));
    await expect(openalex.search(citation({ title: 'T' }))).rejects.toMatchObject({ kind: 'budget_exhausted' });
  };

  test('setting the same key again keeps a spent budget spent', async () => {
    openalex.setApiKey(KEY);
    await spendBudget();
    openalex.setApiKey(KEY);
    openalex.setApiKey(`  ${KEY} `);
    await expect(openalex.search(citation({ title: 'T' }))).rejects.toMatchObject({ kind: 'budget_exhausted' });
    expect(vi.mocked(http.fetchJson)).toHaveBeenCalledTimes(1);
  });

  test('setting no key again keeps a spent budget spent', async () => {
    openalex.setApiKey(undefined);
    await spendBudget();
    openalex.setApiKey(undefined);
    openalex.setApiKey('  ');
    await expect(openalex.search(citation({ title: 'T' }))).rejects.toMatchObject({ kind: 'budget_exhausted' });
    expect(vi.mocked(http.fetchJson)).toHaveBeenCalledTimes(1);
  });

  test('a different key has its own budget', async () => {
    await spendBudget();
    openalex.setApiKey(KEY);
    respond({ results: [] });
    expect(await openalex.search(citation({ title: 'T' }))).toEqual([]);
    await spendBudget();
    openalex.setApiKey(`${KEY}-other`);
    respond({ results: [] });
    expect(await openalex.search(citation({ title: 'T' }))).toEqual([]);
    await spendBudget();
    openalex.setApiKey(undefined);
    respond({ results: [] });
    expect(await openalex.search(citation({ title: 'T' }))).toEqual([]);
  });

  test('a refused key leaves the budget as it was', async () => {
    openalex.setApiKey(KEY);
    await spendBudget();
    expect(() => openalex.setApiKey('short')).toThrow(RangeError);
    await expect(openalex.search(citation({ title: 'T' }))).rejects.toMatchObject({ kind: 'budget_exhausted' });
  });

  test('a brief rate limit stays a rate limit', async () => {
    const failure = new http.SourceError('rate_limited', 'openalex', 'Rate limited (HTTP 429)', 2000);
    vi.mocked(http.fetchJson).mockRejectedValueOnce(failure);
    await expect(openalex.search(citation({ title: 'T' }))).rejects.toBe(failure);
    respond({ results: [] });
    expect(await openalex.search(citation({ title: 'T' }))).toEqual([]);
  });

  test('a successful answer that reports no money left stops the next search', async () => {
    respond({ results: [] }, { 'x-ratelimit-remaining-usd': '0', 'x-ratelimit-reset': '3600' });
    expect(await openalex.search(citation({ title: 'T' }))).toEqual([]);
    await expect(openalex.search(citation({ title: 'T' }))).rejects.toMatchObject({ kind: 'budget_exhausted' });
    expect(vi.mocked(http.fetchJson)).toHaveBeenCalledTimes(1);
  });

  test('x-ratelimit-reset is seconds until the budget resets (recorded: 14538 about 4 h before midnight UTC)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-21T20:00:00Z'));
      respond({ results: [] }, { 'x-ratelimit-remaining-usd': '0', 'x-ratelimit-reset': '3600' });
      await openalex.search(citation({ title: 'T' }));
      vi.setSystemTime(new Date('2026-10-21T20:59:00Z'));
      await expect(openalex.search(citation({ title: 'T' }))).rejects.toMatchObject({ kind: 'budget_exhausted' });
      vi.setSystemTime(new Date('2026-10-21T21:01:00Z'));
      respond({ results: [] });
      expect(await openalex.search(citation({ title: 'T' }))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('plenty of budget left does not block anything', async () => {
    respond({ results: [] }, { 'x-ratelimit-remaining-usd': '0.05' });
    respond({ results: [] }, { 'x-ratelimit-remaining-usd': 'junk' });
    await openalex.search(citation({ title: 'T' }));
    await openalex.search(citation({ title: 'T' }));
    expect(vi.mocked(http.fetchJson)).toHaveBeenCalledTimes(2);
  });
});

describe('openalex.setApiKey', () => {
  test('registers the trimmed key with http.ts and appends it to OpenAlex URLs only', async () => {
    openalex.setApiKey(`  ${KEY}  `);
    expect(vi.mocked(http.setSecret)).toHaveBeenCalledWith(KEY);
    respond({ results: [] });
    await openalex.search(citation({ title: 'T' }));
    respond(fixtureJson('openalex-work-retracted.json'));
    await openalex.lookupById(citation({ doi: '10.1016/S0140-6736(97)11096-0' }));
    expect(requestedUrl(0).searchParams.get('api_key')).toBe(KEY);
    expect(requestedUrl(1).searchParams.get('api_key')).toBe(KEY);
    expect(requestedUrl(0).origin).toBe('https://api.openalex.org');
  });

  test('never reaches other sources', async () => {
    openalex.setApiKey(KEY);
    const { crossref } = await import('../../../src/sources/crossref');
    const { arxiv } = await import('../../../src/sources/arxiv');
    const { openreview } = await import('../../../src/sources/openreview');
    const { dblp } = await import('../../../src/sources/dblp');
    vi.mocked(http.fetchJson).mockImplementation((url) => {
      const data = new URL(url).pathname.startsWith('/works/') ? { message: { DOI: '10.1234/abcd', title: ['T'] } } : { message: { items: [] }, notes: [], result: { hits: {} } };
      return Promise.resolve({ data, headers: new Headers() });
    });
    vi.mocked(http.fetchText).mockResolvedValue('<feed></feed>');
    await crossref.search(citation({ title: 'T' }));
    await crossref.lookupById(citation({ doi: '10.1234/abcd' }));
    await arxiv.search(citation({ title: 'T' }));
    await arxiv.lookupMany(['1706.03762']);
    await openreview.search(citation({ title: 'T' }));
    await dblp.search(citation({ title: 'T' }));
    const urls = [...vi.mocked(http.fetchJson).mock.calls, ...vi.mocked(http.fetchText).mock.calls].map((call) => call[0]);
    expect(urls.length).toBeGreaterThanOrEqual(6);
    for (const url of urls) {
      expect(url).not.toContain(KEY);
      expect(url).not.toContain('api_key');
    }
  });

  test('a key that is too short is refused with a clear error and is not kept', async () => {
    expect(() => openalex.setApiKey('short')).toThrow(RangeError);
    respond({ results: [] });
    await openalex.search(citation({ title: 'T' }));
    expect(requestedUrl().searchParams.has('api_key')).toBe(false);
  });

  test('a blank or undefined key clears it', async () => {
    openalex.setApiKey(KEY);
    openalex.setApiKey('   ');
    respond({ results: [] });
    await openalex.search(citation({ title: 'T' }));
    expect(requestedUrl().searchParams.has('api_key')).toBe(false);
    openalex.setApiKey(KEY);
    openalex.setApiKey(undefined);
    respond({ results: [] });
    await openalex.search(citation({ title: 'T' }));
    expect(requestedUrl(1).searchParams.has('api_key')).toBe(false);
    expect(vi.mocked(http.setSecret)).toHaveBeenLastCalledWith(undefined);
  });

  test('the key never appears in an error the adapter throws or passes on', async () => {
    openalex.setApiKey(KEY);
    respond({ results: 'bad shape' });
    const shape = await openalex.search(citation({ title: 'T' })).catch((e: unknown) => e);
    expect(shape).toBeInstanceOf(Error);
    expect(String((shape as Error).message)).not.toContain(KEY);

    vi.mocked(http.fetchJson).mockRejectedValueOnce(new http.SourceError('network', 'openalex', 'Network error (https://api.openalex.org)'));
    const network = await openalex.lookupById(citation({ doi: '10.1038/nature14539' })).catch((e: unknown) => e);
    expect(String((network as Error).message)).not.toContain(KEY);

    vi.mocked(http.fetchJson).mockRejectedValueOnce(new http.SourceError('rate_limited', 'openalex', 'Rate limited (HTTP 429)', 9_000_000));
    const budget = await openalex.search(citation({ title: 'T' })).catch((e: unknown) => e);
    expect(String((budget as Error).message)).not.toContain(KEY);
  });
});

// Markup in a record's title never splits a word ("CeCoIn<sub>5</sub>" is "CeCoIn5").
describe('openalex: markup in a title', () => {
  const work = (over: Record<string, unknown> = {}) => ({
    id: 'https://openalex.org/W6948275427',
    doi: 'https://doi.org/10.48505/nims.3739',
    title: 'MDR SuperCon Datasheet',
    publication_year: 2022,
    authorships: [{ author: { display_name: 'Materials Database Group' } }],
    primary_location: { source: { display_name: 'Materials Data Repository', type: 'repository' }, raw_type: 'Collection' },
    is_retracted: false,
    locations: [],
    ...over,
  });

  test('a subscript in the title is joined to its word', async () => {
    respond(work({ title: 'Heavy-fermion superconductivity in CeCoIn<sub>5</sub> at 2.3 K', primary_location: { raw_type: 'journal-article' } }));
    expect((await openalex.lookupById(citation({ doi: '10.48505/nims.3739' })))?.title).toBe('Heavy-fermion superconductivity in CeCoIn5 at 2.3 K');
  });

  // Only known markup is taken out. A "<" and ">" in the text itself stay, and a line break or a block
  // tag is a space.
  test.each([
    ['comparison signs in the text', 'Stability when n<k and k>m in sparse recovery', 'Stability when n<k and k>m in sparse recovery'],
    ['a line break between words', 'A <i>p</i>-adic<br/>approach to things', 'A p-adic approach to things'],
    ['a paragraph tag', '<p>Spin ice</p><p>in frustrated magnets</p>', 'Spin ice in frustrated magnets'],
    ['an unknown tag-like word', 'Bounds for <unknown> inputs in Ho<sub>2</sub>Ti<sub>2</sub>O<sub>7</sub>', 'Bounds for <unknown> inputs in Ho2Ti2O7'],
    ['old presentational markup', 'A WIDE <font>GaAs</font>/<font>GaAlAs</font> QUANTUM WELL', 'A WIDE GaAs/GaAlAs QUANTUM WELL'],
    ['emphasis and spans', 'The <em>in situ</em> growth of <strong>large</strong> <span class="x">crystals</span>', 'The in situ growth of large crystals'],
    ['an unclosed formula', 'Unclosed <mml:math> formula then words follow', 'Unclosed formula then words follow'],
    ['an element symbol after "<"', 'Doping when x<Mn and Mo>y in alloys', 'Doping when x<Mn and Mo>y in alloys'],
    // One-letter words other than i and b are text, and JATS tags are markup.
    ['"p<q and q>r"', 'Bounds when p<q and q>r hold', 'Bounds when p<q and q>r hold'],
    ['"n<a and b>m"', 'Regret for n<a and b>m', 'Regret for n<a and b>m'],
    ['"x<s and t>y" and "x<u and v>y"', 'Rates when x<s and t>y or x<u and v>y', 'Rates when x<s and t>y or x<u and v>y'],
    ['a JATS line break', 'Spin ice<jats:break/>in frustrated magnets', 'Spin ice in frustrated magnets'],
    ['JATS styled content', 'A <jats:styled-content style="x">B</jats:styled-content> C', 'A B C'],
    ['JATS italics and subscripts', 'The <jats:italic>in situ</jats:italic> growth of CeCoIn<jats:sub>5</jats:sub>', 'The in situ growth of CeCoIn5'],
  ])('%s', async (_what, raw, plain) => {
    respond(work({ title: raw, primary_location: { raw_type: 'journal-article' } }));
    expect((await openalex.lookupById(citation({ doi: '10.48505/nims.3739' })))?.title).toBe(plain);
  });
});

// A record the service lists as a dataset or another kind of work that is not a paper
// says so. OpenAlex lists NIMS SuperCon's DataCite DOI as "MDR SuperCon Datasheet", raw type "Collection", in a
// repository. The field list asked for is unchanged (the location carries its raw type), so stored answers still serve.
describe('openalex: what kind of work a record is', () => {
  const work = (over: Record<string, unknown> = {}) => ({
    id: 'https://openalex.org/W6948275427',
    doi: 'https://doi.org/10.48505/nims.3739',
    title: 'MDR SuperCon Datasheet',
    publication_year: 2022,
    authorships: [{ author: { display_name: 'Materials Database Group' } }],
    primary_location: { source: { display_name: 'Materials Data Repository', type: 'repository' }, raw_type: 'Collection' },
    is_retracted: false,
    locations: [],
    ...over,
  });

  test.each(['Collection', 'Dataset', 'dataset', 'Software', 'Image', 'Audiovisual', 'PhysicalObject', 'Workflow', 'Model', 'InteractiveResource', 'component'])('raw type %s is not a paper', async (rawType) => {
    respond(work({ primary_location: { source: { display_name: 'Materials Data Repository', type: 'repository' }, raw_type: rawType } }));
    expect((await openalex.lookupById(citation({ doi: '10.48505/nims.3739' })))?.nonPaper).toBe(true);
  });

  test('the work type, when it is given, counts too', async () => {
    respond(work({ type: 'dataset', primary_location: {} }));
    expect((await openalex.lookupById(citation({ doi: '10.48505/nims.3739' })))?.nonPaper).toBe(true);
  });

  test.each(['journal-article', 'JournalArticle', 'Preprint', 'Text', 'Report', 'BookChapter', 'posted-content', 'Other', undefined, 3])('raw type %s is not marked', async (rawType) => {
    respond(work({ primary_location: { source: { display_name: 'arXiv', type: 'repository' }, raw_type: rawType } }));
    expect((await openalex.lookupById(citation({ doi: '10.48505/nims.3739' })))?.nonPaper).toBeUndefined();
  });

  test('a repository alone does not make a record a non-paper', async () => {
    respond(work({ primary_location: { source: { display_name: 'Zenodo', type: 'repository' } } }));
    expect((await openalex.lookupById(citation({ doi: '10.48505/nims.3739' })))?.nonPaper).toBeUndefined();
  });

  test('the field list asked for stays the same', async () => {
    respond(work());
    await openalex.lookupById(citation({ doi: '10.48505/nims.3739' }));
    expect(requestedUrl().searchParams.get('select')).toBe('id,doi,title,publication_year,authorships,primary_location,is_retracted,locations');
  });
});
