// OpenReview public API (api2). Search only: the API refuses single-note lookups to
// clients without a browser's challenge cookie, and a 401/403 from it must never be
// read as "this submission is confidential" (it is usually the bot challenge).

import { API } from '../config';
import { findArxivId, findDoi, isValidArxivId, isValidOpenReviewId, stripArxivVersion } from '../core/identifiers';
import type { ParsedCitation, WorkRecord } from '../core/types';
import { asArray, badResponse, cleanText, isRecord, MAX_AUTHORS, queryTitle, surnamesOf, toYear, validDoi } from './guards';
import { fetchJson, SourceError } from './http';
import { noLookup, type Source } from './source';

const LIMIT = 5;
const MAX_QUERY_TITLE = 300;
const VENUE_YEAR = /\b((?:19|20)\d{2})\b/;

/** `note.content[key].value` (API v2 wraps every field in `{ value }`). */
function contentValue(note: Record<string, unknown>, key: string): unknown {
  const content = note['content'];
  const field = isRecord(content) ? content[key] : undefined;
  return isRecord(field) ? field['value'] : undefined;
}

function yearFromDate(ms: unknown): number | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : toYear(date.getUTCFullYear());
}

function arxivIdFrom(value: unknown): string | undefined {
  const text = cleanText(value, 500);
  const found = text === undefined ? undefined : findArxivId(text);
  const bare = found === undefined ? undefined : stripArxivVersion(found);
  return bare !== undefined && isValidArxivId(bare) ? bare : undefined;
}

function toRecord(value: unknown): WorkRecord | undefined {
  if (!isRecord(value)) return undefined;
  const title = cleanText(contentValue(value, 'title'), 2000);
  const openreviewId = [value['forum'], value['id']].find((id): id is string => typeof id === 'string' && isValidOpenReviewId(id));
  if (title === undefined || openreviewId === undefined) return undefined;

  const venue = cleanText(contentValue(value, 'venue'));
  const venueYear = venue === undefined ? undefined : toYear(VENUE_YEAR.exec(venue)?.[1]);
  // pdate is when it was published; cdate is when the note was created, which for imported (DBLP mirror) notes can be years later.
  const year = yearFromDate(value['pdate']) ?? venueYear ?? yearFromDate(value['cdate']);
  const authorNames = contentValue(value, 'authors');
  const arxivId = arxivIdFrom(contentValue(value, 'pdf')) ?? arxivIdFrom(contentValue(value, 'html'));
  const htmlText = cleanText(contentValue(value, 'html'), 500);
  const doi = validDoi(htmlText === undefined ? undefined : findDoi(htmlText));
  return {
    source: 'openreview',
    title,
    authors: surnamesOf(asArray(authorNames).slice(0, MAX_AUTHORS)),
    ...(year !== undefined && { year }),
    ...(venue !== undefined && { venue }),
    ...(doi !== undefined && { doi }),
    ...(arxivId !== undefined && { arxivId }),
    openreviewId,
    isRetracted: false,
    notes: [],
  };
}

export const openreview = {
  name: 'openreview',

  /** Not supported: single notes cannot be fetched anonymously. */
  lookupById: noLookup,

  async search(c: ParsedCitation, signal?: AbortSignal): Promise<WorkRecord[]> {
    const title = queryTitle(c.title, MAX_QUERY_TITLE);
    if (title === undefined) return [];
    const params = new URLSearchParams({ term: title, limit: String(LIMIT), type: 'terms', content: 'title', source: 'forum' });
    let data: unknown;
    try {
      ({ data } = await fetchJson(`${API.openreviewApi}/notes/search?${params.toString()}`, { source: 'openreview', ...(signal && { signal }) }));
    } catch (error) {
      if (error instanceof SourceError && error.kind === 'forbidden') {
        throw new SourceError('unavailable', 'openreview', 'OpenReview refused the request (HTTP 401/403), often a bot check; this says nothing about the paper');
      }
      throw error;
    }
    const notes = isRecord(data) ? data['notes'] : undefined;
    if (!Array.isArray(notes)) throw badResponse('openreview');
    // No more than the notes asked for: a reply can be long, and every note read costs work.
    return notes.slice(0, LIMIT).flatMap((note) => {
      const record = toRecord(note);
      return record === undefined ? [] : [record];
    });
  },
} satisfies Source;
