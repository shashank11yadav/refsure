import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { API } from '../../../src/config';
import { citation, fixtureJson, fixtureText } from '../helpers/fixtures';

vi.mock('../../../src/sources/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/sources/http')>();
  return { ...actual, fetchJson: vi.fn(wrapReal(actual)) };
});

// Most tests feed the adapter parsed fixtures; the challenge tests go through the real http.ts and a stubbed fetch.
let passThrough = false;
function wrapReal(actual: typeof import('../../../src/sources/http')): typeof actual.fetchJson {
  return (url, opts) => {
    if (!passThrough) throw new Error('fetchJson called without a prepared answer');
    return actual.fetchJson(url, opts);
  };
}

import { fetchJson, SourceError } from '../../../src/sources/http';
import { dblp } from '../../../src/sources/dblp';

const fetchJsonMock = vi.mocked(fetchJson);
const fetchStub = vi.fn<typeof fetch>();

function respond(data: unknown): void {
  fetchJsonMock.mockResolvedValueOnce({ data, headers: new Headers() });
}
function reply(body: string, status: number, contentType: string): Response {
  const response = new Response(body, { status, headers: { 'content-type': contentType } });
  Object.defineProperty(response, 'url', { value: API.dblp, configurable: true });
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

describe('dblp.search', () => {
  test('a title written in TeX is searched as text', async () => {
    respond(fixtureJson('dblp-search.sample.json'));
    await dblp.search(citation({ title: '\\widetilde{O}(T^{-1}) convergence to (coarse) correlated equilibria', authors: ['mao'] }));
    expect(new URL(fetchJsonMock.mock.calls[0]?.[0] ?? '').searchParams.get('q')).toBe('O(T-1) convergence to (coarse) correlated equilibria mao');
  });

  test('maps hits (handwritten sample in the documented format; the live API only answers with a challenge)', async () => {
    respond(fixtureJson('dblp-search.sample.json'));
    const records = await dblp.search(citation({ title: 'Attention is all you need', authors: ['vaswani'], year: 2017, raw: 'SECRET-READING-HISTORY-TOKEN' }));
    expect(records).toHaveLength(3);
    expect(records[0]).toEqual({
      source: 'dblp',
      title: 'Attention is All you Need',
      authors: ['vaswani', 'shazeer', 'parmar'],
      year: 2017,
      venue: 'NIPS',
      dblpKey: 'conf/nips/VaswaniSPUJGKP17',
      isRetracted: false,
      notes: [],
    });
    // A single author arrives as an object; the disambiguation number is not part of the name.
    expect(records[1]).toMatchObject({ authors: ['smith'], doi: '10.48550/ARXIV.1706.03762', arxivId: '1706.03762', venue: 'CoRR' });
    // Odd values are dropped rather than trusted.
    expect(records[2]).toMatchObject({ title: 'Untitled authorless entry', authors: [], venue: 'ICML' });
    expect(records[2]?.year).toBeUndefined();
    expect(records[2]?.doi).toBeUndefined();

    const url = new URL(fetchJsonMock.mock.calls[0]?.[0] ?? '');
    expect(url.origin + url.pathname).toBe('https://dblp.org/search/publ/api');
    expect(url.searchParams.get('q')).toBe('Attention is all you need vaswani');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('h')).toBe('5');
    expect(url.href).not.toContain('SECRET');
    expect(fetchJsonMock.mock.calls[0]?.[1]).toMatchObject({ source: 'dblp' });
  });

  test('no hits is an empty list', async () => {
    respond({ result: { hits: { '@total': '0', '@computed': '0', '@sent': '0', '@first': '0' } } });
    expect(await dblp.search(citation({ title: 'Nothing like it' }))).toEqual([]);
  });

  test('rejects a response of the wrong shape', async () => {
    respond({ result: { hits: { hit: 'many' } } });
    await expect(dblp.search(citation({ title: 'T' }))).rejects.toMatchObject({ kind: 'bad_response', source: 'dblp' });
    respond('nope');
    await expect(dblp.search(citation({ title: 'T' }))).rejects.toMatchObject({ kind: 'bad_response', source: 'dblp' });
  });

  test('does nothing without a title', async () => {
    expect(await dblp.search(citation({}))).toEqual([]);
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  test('lookupById is not supported and never asks the network', async () => {
    expect(await dblp.lookupById(citation({ doi: '10.1038/nature14539' }))).toBeNull();
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });
  test('keeps the record key only when it has the documented shape; the url field is never used', async () => {
    const hit = (key: unknown, url: unknown) => ({ info: { title: 'Some title', authors: { author: { text: 'Ann Roe' } }, key, url } });
    respond({ result: { hits: { hit: [hit('conf/icml/Roe19', 'https://evil.example/x'), hit('../../evil', 'https://dblp.org/rec/x'), hit('conf/icml/a?b=1', undefined), hit(42, undefined)] } } });
    const records = await dblp.search(citation({ title: 'Some title' }));
    expect(records.map((r) => r.dblpKey)).toEqual(['conf/icml/Roe19', undefined, undefined, undefined]);
    expect(JSON.stringify(records)).not.toContain('evil.example');
  });

});

describe('dblp: no more rows than asked for', () => {
  test('a search reads five hits at most', async () => {
    const hit = Array.from({ length: 200 }, (_, i) => ({ info: { title: `Title number ${i}.`, year: '2020' } }));
    respond({ result: { hits: { hit } } });
    const records = await dblp.search(citation({ title: 'Title number' }));
    expect(records.map((r) => r.title)).toEqual(['Title number 0', 'Title number 1', 'Title number 2', 'Title number 3', 'Title number 4']);
  });
});

describe('dblp bot challenge', () => {
  test('the recorded challenge page is "unavailable", not an empty or parsed answer', async () => {
    passThrough = true;
    fetchStub.mockResolvedValue(reply(fixtureText('dblp-challenge.html'), 202, 'text/html; charset=utf-8'));
    const error = await dblp.search(citation({ title: 'Attention is all you need' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ kind: 'unavailable', source: 'dblp' });
  });

  test('any refusal or odd answer from DBLP means unavailable (it is best-effort)', async () => {
    passThrough = true;
    fetchStub.mockResolvedValue(reply('denied', 403, 'text/plain'));
    await expect(dblp.search(citation({ title: 'Attention is all you need' }))).rejects.toMatchObject({ kind: 'unavailable', source: 'dblp' });
    fetchStub.mockResolvedValue(reply('{', 200, 'application/json'));
    await expect(dblp.search(citation({ title: 'Attention is all you need' }))).rejects.toMatchObject({ kind: 'unavailable', source: 'dblp' });
  });

  test('a timeout or rate limit keeps its own kind', async () => {
    const failure = new SourceError('timeout', 'dblp', 'Request timed out');
    fetchJsonMock.mockRejectedValueOnce(failure);
    await expect(dblp.search(citation({ title: 'T' }))).rejects.toBe(failure);
  });
});
