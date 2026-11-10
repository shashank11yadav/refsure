import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { WorkRecord } from '../../../src/core/types';
import { fixtureJson } from '../helpers/fixtures';

vi.mock('../../../src/sources/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/sources/http')>();
  return { ...actual, fetchJson: vi.fn(), fetchText: vi.fn() };
});

import { fetchJson, SourceError } from '../../../src/sources/http';
import { retraction } from '../../../src/sources/retraction';

const fetchJsonMock = vi.mocked(fetchJson);

const RETRACTED_DOI = '10.1016/s0140-6736(97)11096-0';
const NOTICE_DOI = '10.1016/s0140-6736(10)60175-4';

const record = (overrides: Partial<WorkRecord> = {}): WorkRecord => ({
  source: 'crossref',
  title: 'A work',
  authors: ['someone'],
  isRetracted: false,
  notes: [],
  ...overrides,
});

/** Routes each request to a canned answer by host and DOI. */
function route(answers: { crossref?: Record<string, unknown>; openalex?: Record<string, unknown>; crossrefFails?: SourceError; openalexFails?: SourceError; crossrefFailsFor?: string[] }): void {
  fetchJsonMock.mockImplementation((url) => {
    const parsed = new URL(url);
    const doi = decodeURIComponent(parsed.pathname.replace(/^\/works\/(doi:)?/, '')).toLowerCase();
    const isCrossref = parsed.origin === 'https://api.crossref.org';
    const failure = isCrossref ? (answers.crossrefFails ?? (answers.crossrefFailsFor?.includes(doi) ? new SourceError('network', 'crossref', 'Network error') : undefined)) : answers.openalexFails;
    if (failure) return Promise.reject(failure);
    const found = (isCrossref ? answers.crossref : answers.openalex)?.[doi];
    if (found === undefined) return Promise.reject(new SourceError('not_found_http', isCrossref ? 'crossref' : 'openalex', 'Not found (HTTP 404)'));
    return Promise.resolve({ data: found, headers: new Headers() });
  });
}

const crossrefRetracted = fixtureJson('crossref-work-retracted.json');
const openalexRetracted = fixtureJson('openalex-work-retracted.json');
const crossrefClean = { message: { DOI: '10.1234/clean', title: ['Clean'] } };
const openalexClean = { id: 'https://openalex.org/W1', title: 'Clean', is_retracted: false };

beforeEach(() => {
  fetchJsonMock.mockReset();
});

describe('retraction.check', () => {
  test('Crossref update data marks the cited version and names the notice', async () => {
    route({ crossref: { [RETRACTED_DOI]: crossrefRetracted }, openalex: { [RETRACTED_DOI]: { ...(openalexRetracted as object), is_retracted: false } } });
    expect(await retraction.check(record({ doi: RETRACTED_DOI }))).toEqual({ retracted: true, version: 'cited', noticeDoi: NOTICE_DOI });
  });

  test('OpenAlex alone is enough, with no notice DOI', async () => {
    route({ crossref: { '10.1234/clean': crossrefClean }, openalex: { '10.1234/clean': openalexRetracted } });
    expect(await retraction.check(record({ doi: '10.1234/clean' }))).toEqual({ retracted: true, version: 'cited' });
  });

  test('only free ID lookups: Crossref by DOI and OpenAlex by DOI, with a mailto and no search', async () => {
    route({ crossref: { '10.1234/clean': crossrefClean }, openalex: { '10.1234/clean': openalexClean } });
    expect(await retraction.check(record({ doi: '10.1234/clean' }))).toEqual({ retracted: false });
    const urls = fetchJsonMock.mock.calls.map((call) => new URL(call[0]));
    expect(urls.map((u) => u.origin).sort()).toEqual(['https://api.crossref.org', 'https://api.openalex.org']);
    for (const url of urls) expect(url.pathname).toMatch(/^\/works\/(doi:)?10\.1234\/clean$/);
    expect(urls.every((u) => !u.searchParams.has('search') && !u.searchParams.has('query.bibliographic'))).toBe(true);
  });

  test('checks the other version too and says which one carries the retraction', async () => {
    route({
      crossref: { '10.1234/preprint': crossrefClean, [RETRACTED_DOI]: crossrefRetracted },
      openalex: { '10.1234/preprint': openalexClean, [RETRACTED_DOI]: openalexClean },
    });
    const result = await retraction.check(record({ doi: '10.1234/preprint', otherVersion: { doi: RETRACTED_DOI, arxivId: '1706.03762' } }));
    expect(result).toEqual({ retracted: true, version: 'other', noticeDoi: NOTICE_DOI });
  });

  test('the cited version wins when both are retracted', async () => {
    route({ crossref: { [RETRACTED_DOI]: crossrefRetracted, '10.1234/other': crossrefRetracted }, openalex: {} });
    const result = await retraction.check(record({ doi: RETRACTED_DOI, otherVersion: { doi: '10.1234/other' } }));
    expect(result.version).toBe('cited');
  });

  test('a work known to neither service is not retracted', async () => {
    route({});
    expect(await retraction.check(record({ doi: '10.1234/unknown' }))).toEqual({ retracted: false });
  });

  test('a record with no DOI and no arXiv ID has nothing to look up', async () => {
    expect(await retraction.check(record({ openreviewId: 'abcdef12' }))).toEqual({ retracted: false });
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  test('an arXiv-only record is checked in OpenAlex through its DataCite DOI, and not in Crossref', async () => {
    route({ openalex: { '10.48550/arxiv.1706.03762': openalexRetracted } });
    expect(await retraction.check(record({ source: 'arxiv', arxivId: '1706.03762' }))).toEqual({ retracted: true, version: 'cited' });
    const urls = fetchJsonMock.mock.calls.map((call) => new URL(call[0]));
    expect(urls).toHaveLength(1);
    expect(urls[0]?.origin).toBe('https://api.openalex.org');
    expect(urls[0]?.pathname).toBe('/works/doi:10.48550/arXiv.1706.03762');
  });

  test('an arXiv-only other version counts too, and a versioned ID is stripped', async () => {
    route({ crossref: { '10.1234/pub': crossrefClean }, openalex: { '10.1234/pub': openalexClean, '10.48550/arxiv.1706.03762': openalexRetracted } });
    const result = await retraction.check(record({ doi: '10.1234/pub', otherVersion: { arxivId: '1706.03762v5' } }));
    expect(result).toEqual({ retracted: true, version: 'other' });
  });

  test('an arXiv-only version unknown to OpenAlex is not retracted', async () => {
    route({});
    expect(await retraction.check(record({ source: 'arxiv', arxivId: '1706.03762' }))).toEqual({ retracted: false });
  });

  test('a failing OpenAlex lookup for an arXiv-only record is a failure, not "not retracted"', async () => {
    route({ openalexFails: new SourceError('network', 'openalex', 'Network error') });
    await expect(retraction.check(record({ source: 'arxiv', arxivId: '1706.03762' }))).rejects.toMatchObject({ kind: 'network' });
  });

  test('a service that failed does not turn the other one\'s "unknown work" into an answer', async () => {
    route({ crossrefFails: new SourceError('network', 'crossref', 'Network error'), openalex: {} });
    await expect(retraction.check(record({ doi: '10.1234/clean' }))).rejects.toMatchObject({ name: 'SourceError', kind: 'network', source: 'crossref' });
    route({ crossref: {}, openalexFails: new SourceError('rate_limited', 'openalex', 'Rate limited') });
    await expect(retraction.check(record({ doi: '10.1234/clean' }))).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  test('neither service knowing the work, with no failure, is simply not retracted', async () => {
    route({ crossref: {}, openalex: {} });
    expect(await retraction.check(record({ doi: '10.1234/clean' }))).toEqual({ retracted: false });
  });

  test('a positive answer survives the other service failing', async () => {
    route({ crossrefFails: new SourceError('network', 'crossref', 'Network error'), openalex: { '10.1234/clean': openalexRetracted } });
    expect(await retraction.check(record({ doi: '10.1234/clean' }))).toMatchObject({ retracted: true });
  });

  test('Crossref (which carries the Retraction Watch data) failing means OpenAlex alone cannot say "not retracted"', async () => {
    route({ crossrefFails: new SourceError('network', 'crossref', 'Network error'), openalex: { '10.1234/clean': openalexClean } });
    await expect(retraction.check(record({ doi: '10.1234/clean' }))).rejects.toMatchObject({ name: 'SourceError', source: 'crossref' });
  });

  test('a clean answer from Crossref is enough when OpenAlex fails', async () => {
    route({ crossref: { '10.1234/clean': crossrefClean }, openalexFails: new SourceError('network', 'openalex', 'Network error') });
    expect(await retraction.check(record({ doi: '10.1234/clean' }))).toEqual({ retracted: false });
  });

  test('Crossref failing on the other version means the check is incomplete even if the cited version is clean', async () => {
    route({
      crossref: { '10.1234/clean': crossrefClean },
      crossrefFailsFor: ['10.1234/other'],
      openalex: { '10.1234/clean': openalexClean, '10.1234/other': openalexClean },
    });
    await expect(retraction.check(record({ doi: '10.1234/clean', otherVersion: { doi: '10.1234/other' } }))).rejects.toMatchObject({ source: 'crossref' });
  });

  test('when every lookup fails the check fails instead of saying "not retracted"', async () => {
    route({ crossrefFails: new SourceError('rate_limited', 'crossref', 'Rate limited'), openalexFails: new SourceError('network', 'openalex', 'Network error') });
    await expect(retraction.check(record({ doi: '10.1234/clean' }))).rejects.toMatchObject({ name: 'SourceError' });
  });

  test('an abort is passed on, not swallowed', async () => {
    const controller = new AbortController();
    controller.abort();
    fetchJsonMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(retraction.check(record({ doi: '10.1234/clean' }), controller.signal)).rejects.toThrow();
  });

  test('ignores an invalid DOI in otherVersion', async () => {
    route({ crossref: { '10.1234/clean': crossrefClean }, openalex: { '10.1234/clean': openalexClean } });
    await retraction.check(record({ doi: '10.1234/clean', otherVersion: { doi: '../../etc/passwd' } }));
    expect(fetchJsonMock).toHaveBeenCalledTimes(2);
  });

  test('only a formal retraction counts: a withdrawal or expression of concern does not', async () => {
    const concern = { message: { DOI: '10.1234/c', title: ['C'], 'updated-by': [{ type: 'expression_of_concern', DOI: '10.1234/eoc' }, { type: 'withdrawal', DOI: '10.1234/wd' }] } };
    route({ crossref: { '10.1234/c': concern }, openalex: {} });
    expect(await retraction.check(record({ doi: '10.1234/c' }))).toEqual({ retracted: false });
  });
});
