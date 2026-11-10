// OpenAlex API. Lookups by ID are free; searches are metered per IP (or per key).
// The optional key travels only as the `api_key` query parameter of OpenAlex URLs and
// is registered with http.ts, which refuses to send it anywhere else. Nothing in an
// OpenAlex response (including `meta.notice`) is ever acted on: only work fields are read.

import { API, RATE } from '../config';
import { findArxivId, isValidArxivId, isValidDoi, isValidOpenAlexWorkId, stripArxivVersion } from '../core/identifiers';
import type { ParsedCitation, WorkRecord } from '../core/types';
import { asArray, badResponse, cleanText, isNonPaperType, isRecord, MAX_AUTHORS, queryTitle, surnamesOf, toYear, validDoi, withoutMarkup, withoutNoticePrefix } from './guards';
import { fetchJson, setSecret, SourceError } from './http';
import { MAX_DELAY_MS } from './rateLimiter';
import type { Source } from './source';

const WORK_FIELDS = 'id,doi,title,publication_year,authorships,primary_location,is_retracted,locations';
const ROWS = 5;
const MAX_QUERY_TITLE = 300;
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;
const OPENALEX_ID_PREFIX = 'https://openalex.org/';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RESET_MS = 60 * 60 * 1000;

let apiKey: string | undefined;
/** Searches are refused locally until this time once OpenAlex says the budget is spent. */
let searchesBlockedUntil = 0;

function arxivIdFrom(url: unknown): string | undefined {
  if (typeof url !== 'string' || !/^https?:\/\/arxiv\.org\/abs\//i.test(url)) return undefined;
  const id = findArxivId(url);
  const bare = id === undefined ? undefined : stripArxivVersion(id);
  return bare !== undefined && isValidArxivId(bare) ? bare : undefined;
}

/** "W2626778328" from "https://openalex.org/W2626778328"; the address itself is never kept. */
function workIdFrom(id: unknown): string | undefined {
  if (typeof id !== 'string' || !id.startsWith(OPENALEX_ID_PREFIX)) return undefined;
  const bare = id.slice(OPENALEX_ID_PREFIX.length);
  return isValidOpenAlexWorkId(bare) ? bare : undefined;
}

function toRecord(value: unknown): WorkRecord | undefined {
  if (!isRecord(value)) return undefined;
  const doi = validDoi(value['doi']);
  const rawTitle = value['title'];
  const title = withoutNoticePrefix(cleanText(typeof rawTitle === 'string' ? withoutMarkup(rawTitle.slice(0, 8000)) : rawTitle, 2000) ?? '');
  const authors = surnamesOf(
    asArray(value['authorships'])
      .slice(0, MAX_AUTHORS)
      .map((a) => (isRecord(a) && isRecord(a['author']) ? a['author']['display_name'] : undefined)),
  );
  const year = toYear(value['publication_year']);
  const location = value['primary_location'];
  const source = isRecord(location) ? location['source'] : undefined;
  const venue = isRecord(source) ? cleanText(source['display_name']) : undefined;
  // The work's type is not in the field list asked for; the location's raw type (Crossref's or DataCite's) is.
  const nonPaper = isNonPaperType(value['type']) || (isRecord(location) && isNonPaperType(location['raw_type']));
  const openalexId = workIdFrom(value['id']);

  // A work whose own DOI is the arXiv one is the preprint; otherwise an arXiv location is its preprint twin.
  const ownArxiv = doi === undefined ? undefined : ARXIV_DOI.exec(doi)?.[1];
  const ownArxivId = ownArxiv !== undefined && isValidArxivId(stripArxivVersion(ownArxiv)) ? stripArxivVersion(ownArxiv) : undefined;
  let twinArxivId: string | undefined;
  for (const l of asArray(value['locations'])) {
    twinArxivId = isRecord(l) ? arxivIdFrom(l['landing_page_url']) : undefined;
    if (twinArxivId !== undefined) break;
  }
  return {
    source: 'openalex',
    title,
    authors,
    ...(year !== undefined && { year }),
    ...(venue !== undefined && { venue }),
    ...(doi !== undefined && { doi }),
    ...(ownArxivId !== undefined && { arxivId: ownArxivId }),
    ...(openalexId !== undefined && { openalexId }),
    isRetracted: value['is_retracted'] === true,
    notes: [],
    ...(nonPaper && { nonPaper: true as const }),
    ...(ownArxivId === undefined && twinArxivId !== undefined && { otherVersion: { arxivId: twinArxivId } }),
  };
}

function urlFor(path: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params);
  if (apiKey !== undefined) query.set('api_key', apiKey);
  return `${API.openalex}${path}?${query.toString()}`;
}

function workPathFor(c: ParsedCitation): string | undefined {
  let doi = c.doi !== undefined && isValidDoi(c.doi) ? c.doi : undefined;
  if (doi === undefined && c.arxivId !== undefined && isValidArxivId(c.arxivId)) doi = `10.48550/arXiv.${stripArxivVersion(c.arxivId)}`;
  return doi === undefined ? undefined : `/works/doi:${doi.split('/').map(encodeURIComponent).join('/')}`;
}

/** The raw work for a DOI path, or null when OpenAlex does not know it. */
async function fetchWork(path: string, fields: string, signal: AbortSignal | undefined): Promise<Record<string, unknown> | null> {
  let data: unknown;
  try {
    ({ data } = await fetchJson(urlFor(path, { select: fields }), { source: 'openalex', ...(signal && { signal }) }));
  } catch (error) {
    if (error instanceof SourceError && error.kind === 'not_found_http') return null;
    throw error;
  }
  if (!isRecord(data)) throw badResponse('openalex');
  return data;
}

function budgetExhausted(retryAfterMs?: number): SourceError {
  return new SourceError('budget_exhausted', 'openalex', 'The OpenAlex search budget for today is used up', retryAfterMs);
}

/** Remembers a "no money left" announcement from a successful response. */
function noteBudget(headers: Headers): void {
  const raw = headers.get('x-ratelimit-remaining-usd');
  const remaining = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(remaining) || remaining >= RATE.openalex.searchCostUsd - 1e-9) return;
  // x-ratelimit-reset is seconds until the budget resets (recorded 14538 about four hours before midnight UTC).
  const reset = Number(headers.get('x-ratelimit-reset'));
  const waitMs = Number.isFinite(reset) && reset > 0 ? Math.min(reset * 1000, DAY_MS) : DEFAULT_RESET_MS;
  searchesBlockedUntil = Date.now() + waitMs;
}

export const openalex = {
  name: 'openalex',

  /**
   * Sets (or, with undefined or a blank string, clears) the user's API key. Validation lives in
   * http.ts: a non-blank key shorter than 8 characters throws a RangeError and is not kept.
   */
  setApiKey(key: string | undefined): void {
    const trimmed = key?.trim() ?? '';
    const next = trimmed === '' ? undefined : trimmed;
    // A rejected key throws here and leaves the previous key (and its budget state) in place.
    setSecret(next);
    // This runs at the start of every check and on every settings change, so only a new key may forget
    // a spent budget: a different key has a different budget, the same key (or still none) does not.
    if (next !== apiKey) searchesBlockedUntil = 0;
    apiKey = next;
  },

  async lookupById(c: ParsedCitation, signal?: AbortSignal): Promise<WorkRecord | null> {
    const path = workPathFor(c);
    if (path === undefined) return null;
    const work = await fetchWork(path, WORK_FIELDS, signal);
    if (work === null) return null;
    const record = toRecord(work);
    if (record === undefined) throw badResponse('openalex');
    return record;
  },

  async search(c: ParsedCitation, signal?: AbortSignal): Promise<WorkRecord[]> {
    const title = queryTitle(c.title, MAX_QUERY_TITLE);
    if (title === undefined) return [];
    if (Date.now() < searchesBlockedUntil) throw budgetExhausted();

    let result: Awaited<ReturnType<typeof fetchJson>>;
    try {
      result = await fetchJson(urlFor('/works', { search: title, 'per-page': String(ROWS), select: WORK_FIELDS }), { source: 'openalex', lane: 'search', ...(signal && { signal }) });
    } catch (error) {
      // http.ts gives up at once on a 429 that asks for a long wait: that is the daily budget, not a busy moment.
      if (error instanceof SourceError && error.kind === 'rate_limited' && error.retryAfterMs !== undefined && error.retryAfterMs > MAX_DELAY_MS) {
        searchesBlockedUntil = Date.now() + Math.min(error.retryAfterMs, DAY_MS);
        throw budgetExhausted(error.retryAfterMs);
      }
      throw error;
    }
    noteBudget(result.headers);
    const results = isRecord(result.data) ? result.data['results'] : undefined;
    if (!Array.isArray(results)) throw badResponse('openalex');
    // No more than the rows asked for: a reply can be long, and every row read costs work.
    return results.slice(0, ROWS).flatMap((item) => {
      const record = toRecord(item);
      return record !== undefined && record.title !== '' ? [record] : [];
    });
  },

  /** For retraction checks: is the work for this DOI flagged retracted? Null when OpenAlex has no such work. Free. */
  async retractionOf(doi: string, signal?: AbortSignal): Promise<{ retracted: boolean } | null> {
    const path = workPathFor({ raw: '', doi, authors: [], kind: 'paper', confidence: 1 });
    if (path === undefined) return null;
    const work = await fetchWork(path, 'id,is_retracted', signal);
    return work === null ? null : { retracted: work['is_retracted'] === true };
  },
} satisfies Source & { setApiKey(key: string | undefined): void; retractionOf(doi: string, signal?: AbortSignal): Promise<{ retracted: boolean } | null> };
