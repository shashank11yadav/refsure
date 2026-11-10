// Stand-ins for the lookup services (Crossref, OpenAlex, arXiv, OpenReview, DBLP), answered through
// Playwright's `context.route`. The extension's CSP `connect-src` blocks a localhost mock server, so the real
// allowlisted URLs are intercepted instead.
//
// The "world" these fakes describe is built from the references of an arXiv fixture paper, read with the real
// extractor and parser: nearly every reference exists with matching title, authors and year, so it comes out
// Verified. A few are altered on purpose so every kind of result appears in one run:
//   notFound       - no source knows it                      -> Not found
//   detailsDiffer  - the year is moved 4 years                -> Details differ
//   retracted      - Crossref lists a retraction              -> Retracted
//   cantCheck      - OpenAlex answers with a web page         -> Can't check
// (Shapes follow tests/fixtures/api/*, which are recordings of the real services.)

import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { effectiveCitation } from '../../src/core/classify';
import { normalizeTitle } from '../../src/core/normalize';
import { parseCitation } from '../../src/core/parseCitation';
import { extractArxivReferences } from '../../src/extract/arxivHtml';

export interface WorldEntry {
  index: number;
  title: string;
  /** Lower-case surnames in cited order. */
  authors: string[];
  year?: number;
  doi: string;
  arxivId?: string;
}

export interface Scenarios {
  notFound: number;
  detailsDiffer: number;
  retracted: number;
  cantCheck: number;
}

export interface World {
  entries: WorldEntry[];
  scenarios: Scenarios;
  /** How many references the fixture has. */
  total: number;
}

export function referencesOf(htmlPath: string): ReturnType<typeof extractArxivReferences> {
  const window = new Window();
  const doc = new window.DOMParser().parseFromString(readFileSync(htmlPath, 'utf8'), 'text/html');
  const refs = extractArxivReferences(doc as unknown as Document);
  void window.happyDOM.close();
  return refs;
}

export function buildWorld(htmlPath: string): World {
  const refs = referencesOf(htmlPath);
  const entries: WorldEntry[] = [];
  for (const ref of refs) {
    const c = effectiveCitation(parseCitation(ref));
    if (c.title === undefined || c.authors.length === 0 || c.confidence < 0.6 || c.kind !== 'paper') continue;
    entries.push({
      index: ref.index,
      title: c.title,
      authors: c.authors,
      ...(c.year !== undefined && { year: c.year }),
      doi: c.doi ?? `10.99999/refsure.e2e.${ref.index}`,
      ...(c.arxivId !== undefined && { arxivId: c.arxivId }),
    });
  }
  // The altered references are plain ones (no identifier in the text), spread across the list.
  const plain = entries.filter((e) => e.arxivId === undefined && !/10\.\d{4,}\//.test(refs[e.index - 1]?.text ?? '') && e.year !== undefined);
  const pick = (n: number): WorldEntry => {
    const entry = plain[Math.floor((plain.length * n) / 5)];
    if (entry === undefined) throw new Error('The fixture has too few plain references for the e2e scenarios');
    return entry;
  };
  const scenarios: Scenarios = { notFound: pick(1).index, detailsDiffer: pick(2).index, retracted: pick(3).index, cantCheck: pick(4).index };
  return { entries, scenarios, total: refs.length };
}

export interface Reply {
  status: number;
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Reply => ({ status, contentType: 'application/json', body: JSON.stringify(value), headers });

function capitalise(surname: string): string {
  return surname.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function crossrefItem(entry: WorldEntry, scenarios: Scenarios): Record<string, unknown> {
  const year = entry.index === scenarios.detailsDiffer && entry.year !== undefined ? entry.year + 4 : entry.year;
  return {
    DOI: entry.doi,
    title: [entry.title],
    author: entry.authors.map((surname, i) => ({ given: 'A.', family: capitalise(surname), sequence: i === 0 ? 'first' : 'additional' })),
    ...(year !== undefined && { issued: { 'date-parts': [[year]] } }),
    'container-title': ['Journal of Fixture Studies'],
    type: 'journal-article',
    ...(entry.index === scenarios.retracted && { 'updated-by': [{ DOI: '10.99999/refsure.e2e.notice', type: 'retraction', label: 'Retraction', source: 'retraction-watch' }] }),
  };
}

function atomFeed(entries: WorldEntry[]): string {
  const items = entries.map((e) => {
    const names = e.authors.map((surname) => `<author><name>A. ${capitalise(surname)}</name></author>`).join('');
    return `<entry><id>http://arxiv.org/abs/${e.arxivId ?? ''}v1</id><title>${e.title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title><published>${e.year ?? 2000}-01-01T00:00:00Z</published><summary>Summary.</summary>${names}</entry>`;
  });
  return `<?xml version='1.0' encoding='UTF-8'?><feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom"><id>https://arxiv.org/api/e2e</id><title>arXiv Query</title><updated>2026-01-01T00:00:00Z</updated><opensearch:itemsPerPage>${entries.length}</opensearch:itemsPerPage><opensearch:totalResults>${entries.length}</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex>${items.join('')}</feed>`;
}

export class FakeApi {
  /** Every API request, in order, with the time it arrived (ms since this object was made). */
  readonly requests: { at: number; url: string }[] = [];
  private readonly started = Date.now();
  /** Extra time before an answer: a number, or a function of the request and the time since the first API request. */
  delayMs: number | ((url: URL, sinceFirstMs: number) => number) = 0;
  /** While true every service answers with a web page where data should be, the way a service behind a bot check does. */
  down = false;
  /** While set, every service answers 503 with this Retry-After (seconds), the way a service in maintenance does. */
  retryAfterSeconds: number | undefined;

  constructor(private readonly world: World) {}

  /** Answers one request, or undefined for a host that is not an API. */
  async respond(url: URL): Promise<Reply | undefined> {
    const known = ['api.crossref.org', 'api.openalex.org', 'export.arxiv.org', 'api2.openreview.net', 'dblp.org'];
    if (!known.includes(url.hostname)) return undefined;
    const now = Date.now() - this.started;
    const first = this.requests[0]?.at ?? now;
    this.requests.push({ at: now, url: url.href });
    const wait = typeof this.delayMs === 'function' ? this.delayMs(url, now - first) : this.delayMs;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (this.retryAfterSeconds !== undefined) return { status: 503, contentType: 'text/plain', body: 'Down for maintenance', headers: { 'retry-after': String(this.retryAfterSeconds) } };
    return this.down ? { status: 200, contentType: 'text/html', body: '<html><body>Just a moment...</body></html>' } : this.answer(url);
  }

  private answer(url: URL): Reply {
    const { world } = this;
    const { scenarios } = world;
    const removed = new Set([scenarios.notFound, scenarios.cantCheck]);
    const visible = world.entries.filter((e) => !removed.has(e.index));

    switch (url.hostname) {
      case 'api.crossref.org': {
        if (url.pathname.startsWith('/works/')) {
          const doi = decodeURIComponent(url.pathname.slice('/works/'.length)).toLowerCase();
          const entry = visible.find((e) => e.doi.toLowerCase() === doi);
          return entry === undefined ? json({ status: 'failed', message: 'Resource not found.' }, 404) : json({ status: 'ok', message: crossrefItem(entry, scenarios) });
        }
        // query.bibliographic is "<title> <first surname> <year>": a record answers when the query starts with its title.
        const query = normalizeTitle(url.searchParams.get('query.bibliographic') ?? '');
        const hits = visible.filter((e) => query.startsWith(normalizeTitle(e.title))).slice(0, 5);
        return json({ status: 'ok', message: { items: hits.map((e) => crossrefItem(e, scenarios)), 'items-per-page': 5, query: {} } });
      }
      case 'api.openalex.org': {
        const headers = { 'x-ratelimit-remaining-usd': '0.09', 'x-ratelimit-reset': '3600' };
        if (url.pathname.startsWith('/works/doi:')) return json({ id: 'https://openalex.org/W1', is_retracted: false }, 200, headers);
        const searched = normalizeTitle(url.searchParams.get('search') ?? '');
        const stuck = world.entries.find((e) => e.index === scenarios.cantCheck);
        // A web page where JSON should be: what a bot-check page looks like. The answer is "unavailable", never "not found".
        if (stuck !== undefined && searched === normalizeTitle(stuck.title)) return { status: 200, contentType: 'text/html', body: '<html><body>Just a moment...</body></html>' };
        return json({ meta: { count: 0 }, results: [] }, 200, headers);
      }
      case 'export.arxiv.org': {
        const ids = url.searchParams.get('id_list');
        if (ids !== null) {
          const wanted = ids.split(',');
          return { status: 200, contentType: 'application/atom+xml', body: atomFeed(visible.filter((e) => e.arxivId !== undefined && wanted.includes(e.arxivId))) };
        }
        return { status: 200, contentType: 'application/atom+xml', body: atomFeed([]) };
      }
      case 'api2.openreview.net':
        return json({ notes: [], count: 0 });
      default:
        // DBLP: no hits.
        return json({ result: { hits: { '@sent': '0', '@total': '0' } } });
    }
  }
}
