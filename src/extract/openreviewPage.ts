// Reading an OpenReview forum page for two things only: the paper's title and who may
// read it (DESIGN section 7.1). It fails closed, by one rule: "public" only if EVERY copy of
// this forum's note found in the page data is public and the search of that data was complete.
// A restricted copy anywhere makes the page confidential, anything unreadable, truncated or
// contradictory makes it unclear, and the title is handed back only for a public paper, so a
// confidential submission's title cannot leave through this function by mistake.
//
// The page structure read here is listed in tests/fixtures/pages/README.md. It was checked against
// real forum pages saved from a browser on 2026-10-29: an ICLR 2021 page (legacy forum layout) and
// three ICLR 2025 pages (the newer layout). Their data comes as Next.js app-router chunks
// (`self.__next_f.push`), not `__NEXT_DATA__`. A page loaded directly carries its forum note in the
// chunks; one reached by navigating inside the site carries the first page's chunks instead (no
// note), and then the label decides alone. The label is the "Readers:" line in the note's header
// (`#note_<forumId>`, legacy) or `.forum-note .forum-meta .readers`, "Everyone" (newer).

import { isRecord } from '../core/coerce';
import { isValidOpenReviewId } from '../core/identifiers';
import { squashSpace, textOf } from './domText';
import { detectPage } from './pageDetect';

export type Visibility = 'public' | 'confidential' | 'unclear';

export interface OpenReviewPageInfo {
  title?: string;
  forumId?: string;
  visibility: Visibility;
}

const MAX_DATA_CHARS = 10 * 1024 * 1024;
const MAX_CHUNK_SCRIPTS = 5_000;
const MAX_NODES = 250_000;
const MAX_DEPTH = 16;
// The app router streams React element trees, which nest far deeper than page props (26 levels on
// the saved pages).
const MAX_FLIGHT_DEPTH = 64;
const MAX_COPIES = 20;
const MAX_TITLE_CHARS = 500;
const MAX_LABEL_CHARS = 300;
const EVERYONE = 'everyone';
// An object that carries the forum id is a copy of the note only if it also looks like a note
// (the page's `query` object holds the same id and is not one).
const NOTE_KEYS = ['readers', 'forum', 'content', 'signatures', 'invitation', 'invitations', 'writers', 'nonreaders', 'replyto', 'cdate', 'tcdate', 'mdate', 'tmdate'];

type Json = Record<string, unknown>;

type PageData = { state: 'absent' } | { state: 'unreadable' } | { state: 'ok'; value: unknown };

// A script that is there but cannot be read is not the same as no script: the page then has
// data we could not see, so nothing else on the page may make it public.
function parseNextData(doc: Document): PageData {
  const script = doc.getElementById('__NEXT_DATA__');
  if (!script) return { state: 'absent' };
  const text = script.textContent;
  if (!text || text.length > MAX_DATA_CHARS) return { state: 'unreadable' };
  try {
    return { state: 'ok', value: JSON.parse(text) };
  } catch {
    return { state: 'unreadable' };
  }
}

// The app router's inline scripts: one that sets the queue up, then one push per chunk of the
// server's stream. Any other script that names the queue is one we cannot read.
const FLIGHT_START = /^\s*\(self\.__next_f\s*=\s*self\.__next_f\s*\|\|\s*\[\]\)\.push\(\[0\]\)\s*;?\s*(?:self\.__next_f\.push\(\[2,\s*null\]\)\s*;?\s*)?$/;
const FLIGHT_PUSH = /^\s*self\.__next_f\.push\(([\s\S]*)\)\s*;?\s*$/;

function flightChunks(doc: Document): string[] | 'absent' | 'unreadable' {
  const chunks: string[] = [];
  let seen = false;
  let size = 0;
  for (const script of Array.from(doc.getElementsByTagName('script'))) {
    const text = script.textContent ?? '';
    if (!text.includes('__next_f')) continue;
    seen = true;
    if (chunks.length >= MAX_CHUNK_SCRIPTS || text.length > MAX_DATA_CHARS) return 'unreadable';
    if (FLIGHT_START.test(text)) continue;
    let pushed: unknown;
    try {
      pushed = JSON.parse(FLIGHT_PUSH.exec(text)?.[1] ?? '');
    } catch {
      return 'unreadable';
    }
    // [1, text] is a chunk of the stream and [2, null] says there is no form state. Binary chunks
    // and form state are data this reader does not decode.
    if (!Array.isArray(pushed) || pushed.length !== 2) return 'unreadable';
    if (pushed[0] === 2 && pushed[1] === null) continue;
    if (pushed[0] !== 1 || typeof pushed[1] !== 'string') return 'unreadable';
    size += pushed[1].length;
    if (size > MAX_DATA_CHARS) return 'unreadable';
    chunks.push(pushed[1]);
  }
  return seen ? chunks : 'absent';
}

// Where `count` UTF-8 bytes from `start` end, or undefined if the text ends first or the count
// stops inside a character (a text row's length is given in bytes).
function afterBytes(text: string, start: number, count: number): number | undefined {
  let bytes = 0;
  let i = start;
  while (bytes < count) {
    if (i >= text.length) return undefined;
    const code = text.charCodeAt(i);
    const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
    i += 1;
  }
  return bytes === count ? i : undefined;
}

const UNREADABLE_ROW = Symbol('unreadable row');
// Tags whose rows carry a length instead of ending at a line end: text, then typed arrays.
const SIZED_ROW = /^([TAOoUSsLlGgMmV])([0-9a-f]{1,8}),/;

// A row's payload is JSON, or JSON after an upper-case tag (`I[...]` a module, `HL[...]` a hint,
// `E{...}` an error).
function parseRow(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    const tag = /^[A-Z]+/.exec(payload)?.[0];
    if (tag === undefined) return UNREADABLE_ROW;
    const rest = payload.slice(tag.length);
    if (rest === '') return null;
    try {
      return JSON.parse(rest);
    } catch {
      return UNREADABLE_ROW;
    }
  }
}

// Rows are `<hex id>:<payload>\n`. Text rows, `<hex id>:T<hex byte length>,<text>`, have no line end
// and are skipped (a string is never a note); typed-array rows are not read. Every row's value, or
// undefined when any row cannot be read or the text stops inside a row.
function flightRows(text: string): unknown[] | undefined {
  const values: unknown[] = [];
  let pos = 0;
  while (pos < text.length) {
    const colon = text.indexOf(':', pos);
    if (colon < 0 || colon - pos > 16 || !/^[0-9a-f]*$/.test(text.slice(pos, colon))) return undefined;
    const sized = SIZED_ROW.exec(text.slice(colon + 1, colon + 12));
    if (sized) {
      if (sized[1] !== 'T') return undefined;
      const end = afterBytes(text, colon + 1 + sized[0].length, parseInt(sized[2] ?? '', 16));
      if (end === undefined) return undefined;
      pos = end;
      continue;
    }
    const lineEnd = text.indexOf('\n', colon + 1);
    if (lineEnd < 0) return undefined;
    const value = parseRow(text.slice(colon + 1, lineEnd));
    if (value === UNREADABLE_ROW) return undefined;
    values.push(value);
    pos = lineEnd + 1;
  }
  return values;
}

function parseFlightData(doc: Document): PageData {
  const chunks = flightChunks(doc);
  if (chunks === 'absent' || chunks === 'unreadable') return { state: chunks };
  const rows = flightRows(chunks.join(''));
  return rows === undefined ? { state: 'unreadable' } : { state: 'ok', value: rows };
}

function readersVisibility(readers: unknown): Visibility {
  if (!Array.isArray(readers) || readers.length === 0 || !readers.every((r) => typeof r === 'string')) return 'unclear';
  return readers.includes(EVERYONE) ? 'public' : 'confidential';
}

interface Copy {
  readers: Visibility;
  /** False when the title field has its own readers list that does not include everyone. */
  titleOpen: boolean;
  title?: string;
}

// A title field can carry its own `readers`; the title is only usable when that is absent or
// includes everyone. Anything unreadable counts as restricted. In the app router's stream a string
// that starts with "$" is written "$$"; any other "$" string points elsewhere and is not a title.
function copyOf(record: Json, flight: boolean): Copy {
  const content = record['content'];
  const field = isRecord(content) ? content['title'] : undefined;
  let titleOpen = !isRecord(field) || !('readers' in field) || readersVisibility(field['readers']) === 'public';
  let value = isRecord(field) ? field['value'] : field;
  if (flight && typeof value === 'string' && value.startsWith('$')) {
    if (value.startsWith('$$')) value = value.slice(1);
    else titleOpen = false;
  }
  const title = typeof value === 'string' ? squashSpace(value).slice(0, MAX_TITLE_CHARS).trim() : '';
  return { readers: readersVisibility(record['readers']), titleOpen, ...(titleOpen && title !== '' && { title }) };
}

interface Scan {
  /** Every object in the data that is a copy of this forum's note, whatever its `forum` field says. */
  copies: Copy[];
  /** A note of a different forum was found. */
  otherForum: boolean;
  /** False when a cap stopped the walk, so something may have gone unseen. */
  complete: boolean;
}

// Breadth-first with caps on nodes, depth and copies. Hitting any cap is recorded, because the
// part not walked could hold a restricted copy.
function scan(data: unknown, forumId: string, flight: boolean): Scan {
  const copies: Copy[] = [];
  let otherForum = false;
  let complete = true;
  const queue: Array<[unknown, number]> = [[data, 0]];
  for (let head = 0; head < queue.length; head++) {
    if (head >= MAX_NODES || copies.length > MAX_COPIES) {
      complete = false;
      break;
    }
    const entry = queue[head];
    if (!entry) break;
    const [value, depth] = entry;
    if (typeof value !== 'object' || value === null) continue;
    if (isRecord(value)) {
      const id = value['id'];
      if (id === forumId && NOTE_KEYS.some((key) => key in value)) copies.push(copyOf(value, flight));
      else if (typeof id === 'string' && id !== forumId && value['forum'] === id && isValidOpenReviewId(id)) otherForum = true;
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (typeof child !== 'object' || child === null) continue;
      if (depth + 1 > (flight ? MAX_FLIGHT_DEPTH : MAX_DEPTH) || queue.length >= MAX_NODES) complete = false;
      else queue.push([child, depth + 1]);
    }
  }
  return { copies, otherForum, complete };
}

// Restricted wins first, whatever else the page holds; then anything unreadable, contradictory or
// unfinished is unclear. undefined means the data holds no forum note at all.
function judge(found: Scan): Visibility | undefined {
  const levels = found.copies.map((c) => c.readers);
  if (levels.includes('confidential')) return 'confidential';
  if (levels.includes('unclear') || found.otherForum || !found.complete) return 'unclear';
  return levels.length === 0 ? undefined : 'public';
}

type Label = 'everyone' | 'restricted' | undefined;

// "Readers: Everyone" is everyone; any other "Readers: ..." line is restricted.
function readersLine(text: string): Label {
  if (/^readers:\s*everyone$/i.test(text)) return 'everyone';
  return /^readers:/i.test(text) ? 'restricted' : undefined;
}

// Author-written content: rendered markdown, note fields and typeset math. TeX can give a math node any id and class
// (\cssId, \class), and MathJax may write real text in it, so nothing in here is ever the paper's own label or link.
const AUTHOR_CONTENT = 'mjx-container, math, .markdown-rendered, .note_contents, .note_content_value, .note-content, .note-content-value';

function inAuthorContent(element: Element): boolean {
  return element.closest(AUTHOR_CONTENT) !== null;
}

// True when the element sits in one of the note's fields (its abstract, say) or in other author-written content.
function inField(element: Element, note: Element): boolean {
  if (inAuthorContent(element)) return true;
  for (let node: Element | null = element; node && node !== note; node = node.parentElement) {
    const classes = node.classList;
    if (['note_contents', 'note_content_value', 'note-content', 'note-content-value'].some((c) => classes.contains(c))) return true;
  }
  return false;
}

// The labels found by `selector` in the forum note's own header, never in a nested note (a reply)
// or in a field of the note; every one must say everyone.
function noteLabel(note: Element, selector: string, read: (text: string) => Label): Label {
  let label: Label;
  for (const item of Array.from(note.querySelectorAll(selector))) {
    if (inField(item, note)) continue;
    const owner = item.parentElement?.closest('.note, .forum-note');
    if (owner && owner !== note) continue;
    const found = read(textOf([item], MAX_LABEL_CHARS));
    if (found === 'restricted') return 'restricted';
    if (found === 'everyone') label = 'everyone';
  }
  return label;
}

// Legacy layout: `#note_<forumId>`, its meta items that read "Readers: ...". The reply filters
// ("Visible To") are not meta items, and each reply is a note of its own. An element with that id
// inside author-written content (a reply's math) is not the header, and says nothing.
function legacyLabel(doc: Document, forumId: string): Label {
  const header = doc.getElementById(`note_${forumId}`);
  return header && !inAuthorContent(header) ? noteLabel(header, '.meta_row .item', readersLine) : undefined;
}

// The note's own links, whose `id` names a forum: its pdf link in the title row, and the Revisions
// (`/revisions?id=`) and BibTeX (`/forum?id=…#`) links in its meta row. The "Versions" dropdown is
// skipped (it lists other forums of the same work), and so is anything in a field, a reply or math.
const OWN_LINK_PATHS = ['/pdf', '/revisions', '/forum'];
function linkedForumIds(note: Element): string[] {
  return Array.from(note.querySelectorAll('.forum-title a[href], .forum-meta a[href]')).flatMap((link) => {
    if (inField(link, note) || link.closest('.dropdown-menu') !== null) return [];
    const owner = link.parentElement?.closest('.note, .forum-note');
    if (owner && owner !== note) return [];
    try {
      const url = new URL(link.getAttribute('href') ?? '', 'https://openreview.net/');
      const id = url.searchParams.get('id');
      return url.hostname === 'openreview.net' && OWN_LINK_PATHS.includes(url.pathname) && id !== null ? [id] : [];
    } catch {
      return [];
    }
  });
}

// Newer layout: the one `.forum-note`, its `.forum-meta .readers` item, which reads "Everyone"
// (no "Readers:" prefix) for a public note and names groups otherwise. Anything but exactly
// Everyone is restricted; more than one forum note on the page is restricted too. The header
// carries no element id, so an Everyone counts only with positive evidence that the note is this
// forum's: one of its own links names the forum id and none names another. A restricted label
// counts whatever the links say.
function forumNoteLabel(doc: Document, forumId: string): Label {
  const notes = doc.querySelectorAll('.forum-note');
  const note = notes[0];
  if (!note) return undefined;
  if (notes.length > 1) return 'restricted';
  const label = noteLabel(note, '.forum-meta .readers', (text) => {
    const line = readersLine(text);
    if (line !== undefined) return line;
    return /^everyone$/i.test(text) ? 'everyone' : 'restricted';
  });
  if (label !== 'everyone') return label;
  const ids = linkedForumIds(note);
  return ids.includes(forumId) && ids.every((id) => id === forumId) ? 'everyone' : undefined;
}

// The header line of the page's layout, and also the first element marked `.readers` outside
// author-written content when it reads "Readers: ..." (the paper's own, on pages built that way).
// The layouts are exclusive: the legacy header and that fallback are read only on a page without a
// `.forum-note`. Any one that is restricted makes the label restricted.
function readersLabel(doc: Document, forumId: string): Label {
  const newer = doc.querySelector('.forum-note') !== null;
  const element = newer ? undefined : Array.from(doc.querySelectorAll('.readers')).find((el) => !inAuthorContent(el));
  const labels = [newer ? undefined : legacyLabel(doc, forumId), forumNoteLabel(doc, forumId), element ? readersLine(textOf([element], MAX_LABEL_CHARS)) : undefined];
  if (labels.includes('restricted')) return 'restricted';
  return labels.includes('everyone') ? 'everyone' : undefined;
}

// Data that found a note decides; the label can only make it less public. The label alone decides
// only when the page has no forum-note data at all.
function withLabel(fromData: Visibility | undefined, label: Label): Visibility {
  if (fromData === 'confidential' || fromData === 'unclear') return fromData;
  if (fromData === 'public') return label === 'restricted' ? 'unclear' : 'public';
  if (label === 'everyone') return 'public';
  return label === 'restricted' ? 'confidential' : 'unclear';
}

function normalised(title: string): string {
  return title.normalize('NFKC').toLowerCase();
}

// Every copy must allow the title, and the copies that carry one must agree on it.
function agreedTitle(copies: Copy[]): string | undefined {
  if (!copies.every((c) => c.titleOpen)) return undefined;
  const titles = copies.flatMap((c) => (c.title === undefined ? [] : [c.title]));
  const first = titles[0];
  return first !== undefined && titles.every((t) => normalised(t) === normalised(first)) ? first : undefined;
}

function metaTitle(doc: Document): string | undefined {
  const raw = doc.querySelector('meta[name="citation_title"]')?.getAttribute('content');
  const title = raw ? squashSpace(raw).slice(0, MAX_TITLE_CHARS).trim() : '';
  return title === '' ? undefined : title;
}

export function readOpenReviewPage(doc: Document): OpenReviewPageInfo {
  // Only an OpenReview forum or pdf address says which paper this page is about.
  const address = typeof doc.URL === 'string' ? detectPage(doc.URL) : undefined;
  const forumId = address?.kind === 'openreview' ? address.forumId : undefined;
  if (forumId === undefined) return { visibility: 'unclear' };

  const label = readersLabel(doc, forumId);
  const sources: Array<[PageData, boolean]> = [
    [parseNextData(doc), false],
    [parseFlightData(doc), true],
  ];
  if (sources.some(([data]) => data.state === 'unreadable')) {
    // Data we could not read says nothing; the label may only make the page less public.
    return { forumId, visibility: label === 'restricted' ? 'confidential' : 'unclear' };
  }

  // Both kinds of page data are searched, and judged as one.
  const found: Scan = { copies: [], otherForum: false, complete: true };
  for (const [data, flight] of sources) {
    if (data.state !== 'ok') continue;
    const part = scan(data.value, forumId, flight);
    found.copies.push(...part.copies);
    found.otherForum ||= part.otherForum;
    found.complete &&= part.complete;
  }
  const visibility = withLabel(judge(found), label);
  if (visibility !== 'public') return { forumId, visibility };

  // The page title and meta tags can show a title the note restricts, so they are read only when
  // there is no forum-note data at all and the label alone made the page public.
  const title = found.copies.length > 0 ? agreedTitle(found.copies) : metaTitle(doc);
  return { ...(title !== undefined && { title }), forumId, visibility };
}
