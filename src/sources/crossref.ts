// Crossref REST API. Requests join the "polite pool" with the project's mailto
// (config.ts); the only things that leave the machine are the DOI or the citation's
// title, first author and year, and, for a journal citation that has no title, the
// reference's own text (authors, journal, volume, pages, year), its first author's surname or the DOI its publisher
// built from journal, volume and page.

import { CONTACT_EMAIL, API } from '../config';
import { normalizeTitle } from '../core/normalize';
import { type JournalLocator, journalLocator, locatorQuery } from '../core/journalLocator';
import { locatorFirstSurname, publisherDoi } from '../core/locatorHints';
import { LOCATOR_YEAR_WINDOW } from '../core/thresholds';
import { isValidArxivId, isValidDoi, stripArxivVersion } from '../core/identifiers';
import type { ParsedCitation, RecordNote, WorkRecord } from '../core/types';
import { decodeXmlEntities } from './atom';
import { asArray, badResponse, cleanText, firstText, isNoticeTitle, isNonPaperType, isRecord, MAX_AUTHORS, queryTitle, toYear, validDoi, withoutMarkup, withoutNoticePrefix } from './guards';
import { fetchJson, SourceError } from './http';
import type { Source } from './source';

const SEARCH_FIELDS = 'DOI,title,subtitle,author,issued,published,published-print,published-online,posted,created,container-title,short-container-title,volume,page,article-number,type,relation,updated-by';
// A journal citation without a title is matched on journal, volume, page and year. Crossref ranks by text similarity, which
// weighs a page number little, so the search is held to the cited year and its neighbours and asks for ten answers.
const LOCATOR_ROWS = 10;
const ROWS = 10;
// Comments and replies on a famous work can fill the first page. With this many of them there, the work's own record
// may be on the next page, so that one is read too.
const CROWDED_BY_NOTICES = 3;
const MAX_QUERY_TITLE = 300;
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;

interface Updates {
  retracted: boolean;
  noticeDoi?: string;
  notes: RecordNote[];
}

/** Titles can carry JATS/HTML/MathML markup and entities; keep the words (withoutMarkup). */
function plainTitle(value: unknown): string {
  const raw = firstText(value, 2000) ?? '';
  return withoutNoticePrefix(cleanText(decodeXmlEntities(withoutMarkup(raw)), 2000) ?? '');
}

/**
 * Crossref keeps a subtitle apart from the title ("Mayo" and "A Framework for Auto-generating Hardware Friendly Deep
 * Neural Networks"); references write them together. A subtitle the title already holds is not added twice.
 */
function withSubtitle(title: string, subtitle: string): string {
  if (title === '' || subtitle === '' || normalizeTitle(title).includes(normalizeTitle(subtitle))) return title;
  return `${title}: ${subtitle}`;
}

function authorsOf(item: Record<string, unknown>): { authors: string[]; givenNames: string[] } {
  const authors: string[] = [];
  const givenNames: string[] = [];
  for (const author of asArray(item['author']).slice(0, MAX_AUTHORS)) {
    if (!isRecord(author)) continue;
    const family = normalizeTitle(cleanText(author['family'], 200) ?? '');
    const institution = normalizeTitle(cleanText(author['name'], 200) ?? '');
    // An institutional author has no surname to take apart: compare it whole.
    const name = family !== '' ? family : institution;
    if (name === '') continue;
    authors.push(name);
    givenNames.push(family !== '' ? normalizeTitle(cleanText(author['given'], 200) ?? '') : '');
  }
  return { authors, givenNames };
}

function yearOf(item: Record<string, unknown>): number | undefined {
  for (const key of ['issued', 'published', 'published-print', 'published-online']) {
    const field = item[key];
    const parts = isRecord(field) ? asArray(field['date-parts'])[0] : undefined;
    const year = toYear(asArray(parts)[0]);
    if (year !== undefined) return year;
  }
  return undefined;
}

function yearsOf(item: Record<string, unknown>, keys: string[]): number[] {
  const years: number[] = [];
  for (const key of keys) {
    const field = item[key];
    const year = toYear(asArray(isRecord(field) ? asArray(field['date-parts'])[0] : undefined)[0]);
    if (year !== undefined) years.push(year);
  }
  return years;
}

/**
 * The record's other dates, apart from its main year. The date a DOI was created says little about a journal article
 * (backfiles are registered years later) but is the posting date of a preprint.
 */
function otherYearsOf(item: Record<string, unknown>, main: number | undefined): number[] {
  const keys = ['published-print', 'published-online', 'posted', ...(item['type'] === 'posted-content' ? ['created'] : [])];
  return [...new Set(yearsOf(item, keys))].filter((y) => y !== main);
}

/** First page and article number, lower case: a citation gives either, and a work lists one or both. */
function pagesOf(item: Record<string, unknown>): string[] {
  const first = cleanText(item['page'], 40)?.split(/[–—-]/)[0]?.trim().toLowerCase();
  const article = cleanText(item['article-number'], 40)?.toLowerCase();
  return [...new Set([first, article].filter((p): p is string => p !== undefined && p !== ''))];
}

function namesOf(value: unknown): string[] {
  return [...new Set(asArray(value).flatMap((v) => cleanText(v, 300) ?? []))];
}

function updatesOf(item: Record<string, unknown>): Updates {
  const updates: Updates = { retracted: false, notes: [] };
  for (const update of asArray(item['updated-by'])) {
    if (!isRecord(update)) continue;
    const type = update['type'];
    if (type === 'retraction') {
      updates.retracted = true;
      const notice = validDoi(update['DOI']);
      if (notice !== undefined && updates.noticeDoi === undefined) updates.noticeDoi = notice;
    } else if (type === 'expression_of_concern') {
      updates.notes.push('expression_of_concern');
    } else if (type === 'withdrawal' || type === 'removal') {
      updates.notes.push('withdrawn');
    } else if (type === 'correction' || type === 'corrigendum' || type === 'erratum' || type === 'addendum' || type === 'partial_retraction') {
      updates.notes.push('correction');
    }
  }
  updates.notes = [...new Set(updates.notes)];
  return updates;
}

function otherVersionOf(item: Record<string, unknown>): WorkRecord['otherVersion'] {
  const relation = item['relation'];
  if (!isRecord(relation)) return undefined;
  for (const kind of ['has-preprint', 'is-preprint-of']) {
    for (const related of asArray(relation[kind])) {
      if (!isRecord(related) || related['id-type'] !== 'doi') continue;
      const doi = validDoi(related['id']);
      if (doi === undefined) continue;
      const arxivId = ARXIV_DOI.exec(doi)?.[1];
      if (arxivId !== undefined && isValidArxivId(stripArxivVersion(arxivId))) return { arxivId: stripArxivVersion(arxivId) };
      return { doi };
    }
  }
  return undefined;
}

function toRecord(value: unknown): WorkRecord | undefined {
  if (!isRecord(value)) return undefined;
  const doi = validDoi(value['DOI']);
  if (doi === undefined) return undefined;
  const updates = updatesOf(value);
  const venue = firstText(value['container-title']);
  const year = yearOf(value);
  const otherYears = otherYearsOf(value, year);
  const volume = cleanText(value['volume'], 40);
  const pages = pagesOf(value);
  const shortVenues = namesOf(value['short-container-title']);
  const venues = [...new Set([...namesOf(value['container-title']), ...shortVenues])];
  const otherVersion = otherVersionOf(value);
  const { authors, givenNames } = authorsOf(value);
  return {
    source: 'crossref',
    title: withSubtitle(plainTitle(value['title']), plainTitle(value['subtitle'])),
    authors,
    ...(givenNames.some((g) => g !== '') && { givenNames }),
    ...(year !== undefined && { year }),
    ...(otherYears.length > 0 && { otherYears }),
    ...(venue !== undefined && { venue }),
    ...(venues.length > 0 && { venues }),
    ...(shortVenues.length > 0 && { shortVenues }),
    ...(volume !== undefined && { volume }),
    ...(pages.length > 0 && { pages }),
    doi,
    isRetracted: updates.retracted,
    notes: updates.notes,
    ...(isNonPaperType(value['type']) && { nonPaper: true as const }),
    ...(otherVersion !== undefined && { otherVersion }),
  };
}

function messageOf(data: unknown): unknown {
  return isRecord(data) ? data['message'] : undefined;
}

/** The raw work for a DOI, or null when Crossref does not know it. */
async function fetchWork(doi: string, signal: AbortSignal | undefined): Promise<Record<string, unknown> | null> {
  if (!isValidDoi(doi)) return null;
  // The single-work route rejects `select`, so the whole record comes back.
  const path = doi.split('/').map(encodeURIComponent).join('/');
  const url = `${API.crossref}/works/${path}?${new URLSearchParams({ mailto: CONTACT_EMAIL }).toString()}`;
  let data: unknown;
  try {
    ({ data } = await fetchJson(url, { source: 'crossref', ...(signal && { signal }) }));
  } catch (error) {
    if (error instanceof SourceError && error.kind === 'not_found_http') return null;
    throw error;
  }
  const message = messageOf(data);
  if (!isRecord(message)) throw badResponse('crossref');
  return message;
}

/** Crossref's answers for a title-less reference as written, held to the cited year and its neighbours. */
async function locatorSearch(c: ParsedCitation, locator: JournalLocator, extra: Record<string, string>, signal: AbortSignal | undefined): Promise<WorkRecord[]> {
  const window = `from-pub-date:${locator.year - LOCATOR_YEAR_WINDOW},until-pub-date:${locator.year + LOCATOR_YEAR_WINDOW}`;
  const params = new URLSearchParams({ 'query.bibliographic': locatorQuery(c), ...extra, filter: window, rows: String(LOCATOR_ROWS), select: SEARCH_FIELDS, mailto: CONTACT_EMAIL });
  const { data } = await fetchJson(`${API.crossref}/works?${params.toString()}`, { source: 'crossref', ...(signal && { signal }) });
  const message = messageOf(data);
  const items = isRecord(message) ? message['items'] : undefined;
  if (!Array.isArray(items)) throw badResponse('crossref');
  // No more than the rows asked for: a reply can be long, and every row read costs work.
  return items.slice(0, LOCATOR_ROWS).flatMap((item) => toRecord(item) ?? []);
}

export const crossref = {
  name: 'crossref',

  async lookupById(c: ParsedCitation, signal?: AbortSignal): Promise<WorkRecord | null> {
    if (c.doi === undefined) return null;
    const work = await fetchWork(c.doi, signal);
    if (work === null) return null;
    const record = toRecord(work);
    if (record === undefined) throw badResponse('crossref');
    return record;
  },

  async search(c: ParsedCitation, signal?: AbortSignal): Promise<WorkRecord[]> {
    const title = queryTitle(c.title, MAX_QUERY_TITLE);
    if (title === undefined) return [];
    const query = [title, c.authors[0], c.year?.toString()].filter((part): part is string => part !== undefined && part !== '').join(' ');
    // A reference that itself cites a comment or a reply is looking for exactly such a record.
    const wantsNotice = isNoticeTitle(title);
    const records: WorkRecord[] = [];
    for (let offset = 0; ; offset += ROWS) {
      const params = new URLSearchParams({ 'query.bibliographic': query, rows: String(ROWS), select: SEARCH_FIELDS, mailto: CONTACT_EMAIL });
      if (offset > 0) params.set('offset', String(offset));
      const { data } = await fetchJson(`${API.crossref}/works?${params.toString()}`, { source: 'crossref', ...(signal && { signal }) });
      const message = messageOf(data);
      const items = isRecord(message) ? message['items'] : undefined;
      if (!Array.isArray(items)) throw badResponse('crossref');
      let notices = 0;
      for (const item of items.slice(0, ROWS)) {
        const record = toRecord(item);
        if (record === undefined || record.title === '') continue;
        if (!wantsNotice && isNoticeTitle(record.title)) notices++;
        else records.push(record);
      }
      if (offset > 0 || notices < CROWDED_BY_NOTICES || items.length < ROWS) return records;
    }
  },

  /**
   * Candidates for a journal citation that has no title (see core/journalLocator): Crossref is asked once, with the
   * reference as written. Comments and replies are kept, since one of them can be the article that is cited.
   */
  async searchLocator(c: ParsedCitation, signal?: AbortSignal): Promise<WorkRecord[]> {
    const locator = journalLocator(c);
    return locator === undefined ? [] : locatorSearch(c, locator, {}, signal);
  },

  /**
   * More candidates, when the first answers held none that matches: with one named author the
   * reference is a weak query, and errata of the same volume come first. For APS and IOP journals, the record of the DOI
   * the publisher built from journal, volume and page; for others, the same search with the first author's surname.
   * One request at most. The built DOI is only a candidate, never an identifier the reference gave: a record for some
   * other article fails the engine's locator match and is dropped, and a DOI Crossref does not know gives nothing.
   */
  async searchLocatorAgain(c: ParsedCitation, signal?: AbortSignal): Promise<WorkRecord[]> {
    const locator = journalLocator(c);
    if (locator === undefined) return [];
    const doi = publisherDoi(c, locator);
    if (doi !== undefined) {
      const work = await fetchWork(doi, signal);
      const record = work === null ? undefined : toRecord(work);
      return record === undefined ? [] : [record];
    }
    const author = locatorFirstSurname(c, locator);
    return author === undefined ? [] : locatorSearch(c, locator, { 'query.author': author }, signal);
  },

  /** For retraction checks: does the work for this DOI carry a formal retraction? Null when Crossref has no such work. */
  async retractionOf(doi: string, signal?: AbortSignal): Promise<{ retracted: boolean; noticeDoi?: string } | null> {
    const work = await fetchWork(doi, signal);
    if (work === null) return null;
    const { retracted, noticeDoi } = updatesOf(work);
    return { retracted, ...(noticeDoi !== undefined && { noticeDoi }) };
  },
} satisfies Source & { retractionOf(doi: string, signal?: AbortSignal): Promise<{ retracted: boolean; noticeDoi?: string } | null>; searchLocator(c: ParsedCitation, signal?: AbortSignal): Promise<WorkRecord[]>; searchLocatorAgain(c: ParsedCitation, signal?: AbortSignal): Promise<WorkRecord[]> };
