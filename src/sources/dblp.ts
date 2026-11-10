// DBLP search API. Best-effort: at the time of writing it answers with an anti-bot
// challenge page instead of JSON, which http.ts reports as 'unavailable'. Any refusal
// or odd answer from DBLP is "unavailable" here, and DBLP is never required for a verdict.

import { API } from '../config';
import { findArxivId, isValidArxivId, isValidDblpKey, stripArxivVersion } from '../core/identifiers';
import type { ParsedCitation, WorkRecord } from '../core/types';
import { badResponse, cleanText, firstText, isRecord, MAX_AUTHORS, queryTitle, surnamesOf, toYear, validDoi } from './guards';
import { fetchJson, SourceError } from './http';
import { noLookup, type Source } from './source';

const HITS = 5;
const MAX_QUERY_TITLE = 300;
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;

function authorNames(authors: unknown): string[] {
  const list = isRecord(authors) ? authors['author'] : undefined;
  const names: string[] = [];
  for (const author of (Array.isArray(list) ? list : [list]).slice(0, MAX_AUTHORS)) {
    const text = cleanText(isRecord(author) ? author['text'] : author, 200);
    // Homonyms are told apart by a trailing number ("John Smith 0001").
    if (text !== undefined) names.push(text.replace(/\s+\d{4}$/, ''));
  }
  return names;
}

function toRecord(hit: unknown): WorkRecord | undefined {
  const info = isRecord(hit) ? hit['info'] : undefined;
  if (!isRecord(info)) return undefined;
  const title = cleanText(info['title'], 2000)?.replace(/\.$/, '');
  if (title === undefined || title === '') return undefined;
  const year = toYear(info['year']);
  const venue = firstText(info['venue']);
  const doi = validDoi(info['doi']);
  const doiArxiv = doi === undefined ? undefined : ARXIV_DOI.exec(doi)?.[1];
  const ee = firstText(info['ee'], 500);
  const found = (doiArxiv !== undefined ? stripArxivVersion(doiArxiv) : undefined) ?? (ee === undefined ? undefined : findArxivId(ee));
  const arxivId = found !== undefined && isValidArxivId(stripArxivVersion(found)) ? stripArxivVersion(found) : undefined;
  // The record's key, checked against its documented shape; the hit's `url` field is never used as a link.
  const key = info['key'];
  const dblpKey = typeof key === 'string' && isValidDblpKey(key) ? key : undefined;
  return {
    source: 'dblp',
    title,
    authors: surnamesOf(authorNames(info['authors'])),
    ...(year !== undefined && { year }),
    ...(venue !== undefined && { venue }),
    ...(doi !== undefined && { doi }),
    ...(arxivId !== undefined && { arxivId }),
    ...(dblpKey !== undefined && { dblpKey }),
    isRetracted: false,
    notes: [],
  };
}

export const dblp = {
  name: 'dblp',

  /** Not supported: DBLP has no lookup by DOI or arXiv ID that we rely on. */
  lookupById: noLookup,

  async search(c: ParsedCitation, signal?: AbortSignal): Promise<WorkRecord[]> {
    const title = queryTitle(c.title, MAX_QUERY_TITLE);
    if (title === undefined) return [];
    const q = [title, c.authors[0]].filter((part): part is string => part !== undefined && part !== '').join(' ');
    const params = new URLSearchParams({ q, format: 'json', h: String(HITS) });
    let data: unknown;
    try {
      ({ data } = await fetchJson(`${API.dblp}?${params.toString()}`, { source: 'dblp', ...(signal && { signal }) }));
    } catch (error) {
      if (error instanceof SourceError && (error.kind === 'forbidden' || error.kind === 'bad_response' || error.kind === 'not_found_http')) {
        throw new SourceError('unavailable', 'dblp', 'DBLP did not answer with search results (it often shows a bot check)');
      }
      throw error;
    }
    const result = isRecord(data) ? data['result'] : undefined;
    const hits = isRecord(result) ? result['hits'] : undefined;
    if (!isRecord(hits)) throw badResponse('dblp');
    const hit = hits['hit'];
    if (hit === undefined) return [];
    if (!Array.isArray(hit) && !isRecord(hit)) throw badResponse('dblp');
    // No more than the hits asked for: a reply can be long, and every hit read costs work.
    return (Array.isArray(hit) ? hit.slice(0, HITS) : [hit]).flatMap((h) => {
      const record = toRecord(h);
      return record === undefined ? [] : [record];
    });
  },
} satisfies Source;
