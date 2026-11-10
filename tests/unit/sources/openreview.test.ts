import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { API } from '../../../src/config';
import { citation, fixtureJson, fixtureText } from '../helpers/fixtures';

vi.mock('../../../src/sources/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/sources/http')>();
  return { ...actual, fetchJson: vi.fn(wrapReal(actual)) };
});

// Most tests feed the adapter parsed fixtures; the 403 tests below go through the real http.ts and a stubbed fetch.
let passThrough = false;
function wrapReal(actual: typeof import('../../../src/sources/http')): typeof actual.fetchJson {
  return (url, opts) => {
    if (!passThrough) throw new Error('fetchJson called without a prepared answer');
    return actual.fetchJson(url, opts);
  };
}

import { fetchJson, SourceError } from '../../../src/sources/http';
import { openreview } from '../../../src/sources/openreview';

const fetchJsonMock = vi.mocked(fetchJson);
const fetchStub = vi.fn<typeof fetch>();

function respond(data: unknown): void {
  fetchJsonMock.mockResolvedValueOnce({ data, headers: new Headers() });
}

/** A Response that reports an allowlisted final URL, as a real fetch always does. */
function reply(body: string, status: number, contentType = 'application/json; charset=utf-8'): Response {
  const response = new Response(body, { status, headers: { 'content-type': contentType } });
  Object.defineProperty(response, 'url', { value: `${API.openreviewApi}/notes/search`, configurable: true });
  return response;
}

beforeEach(() => {
  passThrough = false;
  fetchJsonMock.mockClear();
  vi.stubGlobal('fetch', fetchStub);
  fetchStub.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openreview.search', () => {
  test('a title written in TeX is searched as text', async () => {
    respond(fixtureJson('openreview-search.json'));
    await openreview.search(citation({ title: '\\widetilde{O}(T^{-1}) convergence to (coarse) correlated equilibria', authors: ['mao'] }));
    expect(new URL(fetchJsonMock.mock.calls[0]?.[0] ?? '').searchParams.get('term')).toBe('O(T-1) convergence to (coarse) correlated equilibria');
  });

  test('maps recorded notes: title, surnames, venue year, forum id', async () => {
    respond(fixtureJson('openreview-search.json'));
    const records = await openreview.search(citation({ title: 'Attention is all you need', raw: 'SECRET-READING-HISTORY-TOKEN' }));
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      source: 'openreview',
      title: 'Tensor Product Attention Is All You Need',
      venue: 'NeurIPS 2025 spotlight',
      year: 2025,
      openreviewId: 'ECTxVRFhUa',
      isRetracted: false,
      notes: [],
    });
    expect(records[0]?.authors.length).toBeGreaterThan(2);
    expect(records[1]?.venue).toBe('CoRR 2025');
    expect(records.every((r) => /^[A-Za-z0-9_-]{6,64}$/.test(r.openreviewId ?? ''))).toBe(true);

    const url = new URL(fetchJsonMock.mock.calls[0]?.[0] ?? '');
    expect(url.origin + url.pathname).toBe('https://api2.openreview.net/notes/search');
    expect(url.searchParams.get('term')).toBe('Attention is all you need');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.href).not.toContain('SECRET');
    expect(fetchJsonMock.mock.calls[0]?.[1]).toMatchObject({ source: 'openreview' });
  });

  test('takes the year from the publication date, then the venue, and the creation date only as a last resort', async () => {
    const note = (extra: Record<string, unknown>): unknown => ({
      id: 'abcdef12',
      forum: 'abcdef12',
      content: { title: { value: 'T' }, authors: { value: ['Ada Lovelace'] }, ...extra },
    });
    respond({
      notes: [
        note({ venue: { value: 'ICLR 2024 poster' } }),
        { ...(note({}) as object), pdate: Date.UTC(2021, 5, 1) },
        { ...(note({}) as object), cdate: Date.UTC(2019, 0, 2) },
        note({}),
        { ...(note({ venue: { value: 'ICLR 2024 poster' } }) as object), pdate: Date.UTC(2025, 0, 5), cdate: Date.UTC(2023, 8, 28) },
      ],
    });
    const records = await openreview.search(citation({ title: 'T' }));
    expect(records.map((r) => r.year)).toEqual([2024, 2021, 2019, undefined, 2025]);
  });

  test('a mirrored record whose creation date is not its publication year keeps the venue year', async () => {
    // DBLP mirrors are created when imported (cdate), long after the paper appeared.
    respond({
      notes: [
        {
          id: 'mirror-1',
          forum: 'mirror-1',
          cdate: Date.UTC(2024, 9, 18),
          content: { title: { value: 'GAN Vocoder' }, authors: { value: ['Jaeseong You'] }, venue: { value: 'CoRR 2021' } },
        },
      ],
    });
    expect((await openreview.search(citation({ title: 'GAN Vocoder' })))[0]?.year).toBe(2021);
  });

  test('takes arXiv ids and DOIs from the links only when they validate, and never keeps a URL', async () => {
    respond({
      notes: [
        {
          id: 'k7l7p1yVZj',
          forum: 'k7l7p1yVZj',
          content: {
            title: { value: 'GAN Vocoder' },
            authors: { value: ['Jaeseong You'] },
            pdf: { value: 'http://arxiv.org/pdf/2103.05236v2' },
            html: { value: 'https://doi.org/10.21437/Interspeech.2021-41' },
          },
        },
      ],
    });
    const [record] = await openreview.search(citation({ title: 'GAN Vocoder' }));
    expect(record?.arxivId).toBe('2103.05236');
    expect(record?.doi).toBe('10.21437/Interspeech.2021-41');
    expect(JSON.stringify(record)).not.toContain('http');
  });

  test('skips notes without a title or with a hostile id; an empty result is fine', async () => {
    respond({
      notes: [
        { id: 'good-id-1', forum: 'good-id-1', content: { title: { value: 'Ok' } } },
        { id: 'x', forum: 'x', content: { title: { value: 'Short id' } } },
        { id: '../../etc', forum: '../../etc', content: { title: { value: 'Traversal' } } },
        { id: 'good-id-2', forum: 'good-id-2', content: {} },
        { id: 'good-id-3', forum: 'good-id-3', content: { title: { value: 7 } } },
        null,
      ],
    });
    expect((await openreview.search(citation({ title: 'Ok' }))).map((r) => r.openreviewId)).toEqual(['good-id-1']);
    respond({ notes: [], count: 0 });
    expect(await openreview.search(citation({ title: 'Ok' }))).toEqual([]);
  });

  test('rejects a response that has no notes list', async () => {
    respond({ notes: 'many' });
    await expect(openreview.search(citation({ title: 'Ok' }))).rejects.toMatchObject({ kind: 'bad_response', source: 'openreview' });
  });

  test('does nothing without a title', async () => {
    expect(await openreview.search(citation({}))).toEqual([]);
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });
});

describe('openreview: no more rows than asked for', () => {
  test('a search reads five notes at most', async () => {
    const notes = Array.from({ length: 200 }, (_, i) => ({ id: `note${String(i).padStart(4, '0')}x`, forum: `forum${String(i).padStart(4, '0')}x`, content: { title: { value: `Title number ${i}` } } }));
    respond({ notes });
    const records = await openreview.search(citation({ title: 'Title number' }));
    expect(records.map((r) => r.title)).toEqual(['Title number 0', 'Title number 1', 'Title number 2', 'Title number 3', 'Title number 4']);
  });
});

describe('openreview.lookupById', () => {
  test('is not supported and never asks the network', async () => {
    expect(await openreview.lookupById(citation({ doi: '10.1038/nature14539', arxivId: '1706.03762' }))).toBeNull();
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });
});

describe('openreview access refusals', () => {
  test('the recorded bot-challenge 403 is "unavailable", never a confidentiality finding', async () => {
    passThrough = true;
    fetchStub.mockResolvedValue(reply(fixtureText('openreview-403-challenge.json'), 403));
    const error = await openreview.search(citation({ title: 'Attention is all you need' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ kind: 'unavailable', source: 'openreview' });
    expect(String((error as Error).message).toLowerCase()).not.toMatch(/confidential|private|not public/);
  });

  test.each([401, 403])('any HTTP %i is unavailable', async (status) => {
    passThrough = true;
    fetchStub.mockResolvedValue(reply('{"name":"ForbiddenError"}', status));
    await expect(openreview.search(citation({ title: 'Attention is all you need' }))).rejects.toMatchObject({ kind: 'unavailable', source: 'openreview' });
  });

  test('other failures keep their own kind', async () => {
    const failure = new SourceError('rate_limited', 'openreview', 'Rate limited (HTTP 429)');
    fetchJsonMock.mockRejectedValueOnce(failure);
    await expect(openreview.search(citation({ title: 'Attention is all you need' }))).rejects.toBe(failure);
  });
});
