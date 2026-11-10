// arXiv API (Atom). Parsed without a DOM (see atom.ts); every field is untrusted text.
// Requests are paced by the shared limiter (one per 3 s), so IDs are batched.

import { API } from '../config';
import { isValidArxivId, stripArxivVersion } from '../core/identifiers';
import { normalizeTitle } from '../core/normalize';
import type { ParsedCitation, RecordNote, WorkRecord } from '../core/types';
import { type AtomEntry, parseAtomFeed } from './atom';
import { cleanText, MAX_AUTHORS, surnamesOf, toYear, validDoi } from './guards';
import { fetchText, SourceError } from './http';
import type { Source } from './source';

const MAX_IDS_PER_REQUEST = 50;
const SEARCH_RESULTS = 5;
const MAX_QUERY_CHARS = 200;
const ABS_URL = /^https?:\/\/arxiv\.org\/abs\/(.+)$/;

// arXiv has no withdrawn field. A withdrawn paper's abstract or the authors' comment
// makes a withdrawal statement ("This paper has been withdrawn", "Withdrawn by the
// authors"); a mere mention ("withdrawal rates", "not withdrawn") is not one.
// Only a note, never a badge.
const WITHDRAWN_STATEMENT =
  /^\s*withdrawn\b|\bthis\s+(?:paper|submission|article|manuscript|preprint)\s+(?:has\s+been|is|was)\s+withdrawn\b|\bwithdrawn\s+by\s+(?:the\s+)?authors?\b/i;
const SUMMARY_WINDOW = 300;
const COMMENT_WINDOW = 1000;

function isWithdrawn(entry: AtomEntry): boolean {
  return (
    (entry.summary !== undefined && WITHDRAWN_STATEMENT.test(entry.summary.slice(0, SUMMARY_WINDOW))) ||
    (entry.comment !== undefined && WITHDRAWN_STATEMENT.test(entry.comment.slice(0, COMMENT_WINDOW)))
  );
}

/** The version-less arXiv ID of an entry, or undefined for the API's error entries and anything else. */
function entryId(entry: AtomEntry): string | undefined {
  const id = entry.id === undefined ? undefined : stripArxivVersion(ABS_URL.exec(entry.id)?.[1] ?? '');
  return id !== undefined && isValidArxivId(id) ? id : undefined;
}

// A year in a journal reference: "(2003)", or a 19xx/20xx number standing alone ("Phys.Rept.254:1-133,1995").
const JOURNAL_REF_YEAR = /\((1[89]\d{2}|20\d{2})\)|(?<![\d.:/-])(1[89]\d{2}|20\d{2})(?![\d-])/g;
/** How far from the posting date a journal year may be and still be read as one. */
const MAX_JOURNAL_REF_GAP = 10;

/**
 * The work's other date on arXiv: the year of the journal version that the authors recorded in its journal reference.
 * (The date of the latest version is not one: a famous paper may get a trivial revision years later.)
 */
export function arxivOtherYears(main: number | undefined, journalRef: string | undefined): number[] {
  const years = new Set<number>();
  if (journalRef !== undefined) {
    const found = [...journalRef.matchAll(JOURNAL_REF_YEAR)].map((m) => toYear(m[1] ?? m[2]));
    // A parenthesised year is the journal's; otherwise the last plausible one (volumes and pages come first).
    const inParens = [...journalRef.matchAll(JOURNAL_REF_YEAR)].find((m) => m[1] !== undefined);
    const pick = inParens !== undefined ? toYear(inParens[1]) : found.at(-1);
    if (pick !== undefined && (main === undefined || Math.abs(pick - main) <= MAX_JOURNAL_REF_GAP)) years.add(pick);
  }
  if (main !== undefined) years.delete(main);
  return [...years];
}

function toRecord(entry: AtomEntry, arxivId: string): WorkRecord | undefined {
  const title = cleanText(entry.title, 2000);
  if (title === undefined) return undefined;
  const year = toYear(entry.published?.slice(0, 4));
  const venue = cleanText(entry.journalRef);
  const otherYears = arxivOtherYears(year, venue);
  const doi = validDoi(entry.doi);
  const notes: RecordNote[] = isWithdrawn(entry) ? ['withdrawn'] : [];
  return {
    source: 'arxiv',
    title,
    authors: surnamesOf(entry.authors.slice(0, MAX_AUTHORS)),
    ...(year !== undefined && { year }),
    ...(otherYears.length > 0 && { otherYears }),
    ...(venue !== undefined && { venue }),
    arxivId,
    isRetracted: false,
    notes,
    ...(doi !== undefined && { otherVersion: { doi } }),
  };
}

function badFeed(reason: string): SourceError {
  return new SourceError('bad_response', 'arxiv', `The arXiv response could not be trusted (${reason})`);
}

/**
 * The entries of a well-formed feed. Anything else (an HTML error page, a truncated feed, an
 * arXiv error entry, a count that disagrees with `opensearch:totalResults`) fails loudly:
 * it must never read as "no such paper".
 */
async function query(params: string, maxResults: number, signal: AbortSignal | undefined): Promise<AtomEntry[]> {
  const xml = await fetchText(`${API.arxivApi}?${params}`, { source: 'arxiv', kind: 'xml', ...(signal && { signal }) });
  const { entries, totalResults } = parseAtomFeed(xml);
  if (entries.some((entry) => entry.id?.includes('/api/errors'))) throw badFeed('arXiv reported an error');
  // The feed carries at most `maxResults` entries of the `totalResults` it matched.
  if (totalResults !== undefined && entries.length !== Math.min(totalResults, maxResults)) throw badFeed('the entry count disagrees with the feed total');
  return entries;
}

async function lookupMany(ids: string[], signal?: AbortSignal): Promise<Map<string, WorkRecord>> {
  const wanted = [...new Set(ids.filter(isValidArxivId).map(stripArxivVersion))];
  const found = new Map<string, WorkRecord>();
  for (let i = 0; i < wanted.length; i += MAX_IDS_PER_REQUEST) {
    const batch = wanted.slice(i, i + MAX_IDS_PER_REQUEST);
    const entries = await query(`id_list=${batch.map(encodeURIComponent).join(',')}&max_results=${batch.length}`, batch.length, signal);
    for (const entry of entries) {
      const id = entryId(entry);
      // Only what we asked for: a response cannot add records for other IDs.
      if (id === undefined || !batch.includes(id) || found.has(id)) continue;
      const record = toRecord(entry, id);
      if (record !== undefined) found.set(id, record);
    }
  }
  return found;
}

export const arxiv = {
  name: 'arxiv',

  async lookupById(c: ParsedCitation, signal?: AbortSignal): Promise<WorkRecord | null> {
    if (c.arxivId === undefined || !isValidArxivId(c.arxivId)) return null;
    return (await lookupMany([c.arxivId], signal)).get(stripArxivVersion(c.arxivId)) ?? null;
  },

  /** Batched lookup, at most 50 IDs per request. Unknown or invalid IDs are simply absent from the map. */
  lookupMany,

  /** Title search. The title is reduced to plain words first, so it cannot add query syntax. */
  async search(c: ParsedCitation, signal?: AbortSignal): Promise<WorkRecord[]> {
    const words = normalizeTitle(c.title ?? '').slice(0, MAX_QUERY_CHARS).trim();
    if (words === '') return [];
    const params = `search_query=${encodeURIComponent(`ti:"${words}"`)}&max_results=${SEARCH_RESULTS}`;
    const records: WorkRecord[] = [];
    for (const entry of await query(params, SEARCH_RESULTS, signal)) {
      const id = entryId(entry);
      const record = id === undefined ? undefined : toRecord(entry, id);
      if (record !== undefined) records.push(record);
    }
    return records;
  },
} satisfies Source & { lookupMany(ids: string[], signal?: AbortSignal): Promise<Map<string, WorkRecord>> };
