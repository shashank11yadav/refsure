// A small, purpose-built reader for the arXiv Atom feed. The service worker has no
// DOMParser, and a general XML parser is more code than we want to trust with untrusted
// input, so this extracts exactly the fields we use in a single linear pass:
// no regular expression runs over the whole document and no entity is ever expanded
// beyond the five predefined ones and numeric references.
//
// A document that is not a complete Atom feed (an HTML error page, an empty body, a
// truncated transfer) is a bad_response: a partial feed must never read as "no results".

import { SourceError } from './http';

export const MAX_ATOM_CHARS = 5_000_000;
const MAX_ENTRIES = 500;
const SOURCE = 'arxiv';
const MAX_FIELD_CHARS = 50_000;
const MAX_AUTHORS = 1000;

function malformed(reason: string): SourceError {
  return new SourceError('bad_response', SOURCE, `The arXiv response was not a complete Atom feed (${reason})`);
}

export interface AtomFeed {
  entries: AtomEntry[];
  /** `opensearch:totalResults` of the feed itself, when it is a plain count. */
  totalResults?: number;
}

export interface AtomEntry {
  id?: string;
  title?: string;
  authors: string[];
  published?: string;
  summary?: string;
  /** `arxiv:comment` */
  comment?: string;
  /** `arxiv:doi` */
  doi?: string;
  /** `arxiv:journal_ref` */
  journalRef?: string;
}

type EntryField = 'id' | 'title' | 'published' | 'summary' | 'comment' | 'doi' | 'journalRef';

const FIELD_OF_TAG: Readonly<Record<string, EntryField>> = {
  id: 'id',
  title: 'title',
  published: 'published',
  summary: 'summary',
  'arxiv:comment': 'comment',
  'arxiv:doi': 'doi',
  'arxiv:journal_ref': 'journalRef',
};

const NAMED_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

/** The five predefined XML entities and numeric references, one level only. Anything else stays as written. */
export function decodeXmlEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(lt|gt|amp|quot|apos));/g, (_match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? '';
    const code = dec !== undefined ? Number(dec) : parseInt(hex ?? '', 16);
    return isXmlChar(code) ? String.fromCodePoint(code) : '�';
  });
}

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  /** Index just after the closing ">". */
  next: number;
}

/** Reads the tag starting at `start` (the "<"). Quoted attribute values may contain ">". Undefined when unterminated. */
function readTag(xml: string, start: number): Tag | undefined {
  let i = start + 1;
  const closing = xml.charAt(i) === '/';
  if (closing) i += 1;
  const nameStart = i;
  while (i < xml.length && !/[\s/>]/.test(xml.charAt(i))) i += 1;
  const name = xml.slice(nameStart, i);
  let quote = '';
  let last = '';
  for (; i < xml.length; i += 1) {
    const ch = xml.charAt(i);
    if (quote !== '') {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return { name, closing, selfClosing: last === '/', next: i + 1 };
    }
    if (quote === '' && !/\s/.test(ch)) last = ch;
  }
  return undefined;
}

/**
 * The entries of an Atom feed. Throws a bad_response SourceError unless the document is a
 * complete feed (a `<feed>` root that is closed): too large, DOCTYPE (we never define
 * entities), not Atom, truncated, or too many entries.
 */
export function parseAtomFeed(xml: string): AtomFeed {
  if (xml.length > MAX_ATOM_CHARS) throw malformed('too large');

  const entries: AtomEntry[] = [];
  let entry: AtomEntry | undefined;
  let inAuthor = false;
  /** The element whose text is being collected, and the text so far. */
  let field: EntryField | 'name' | 'totalResults' | undefined;
  let sawRoot = false;
  let feedClosed = false;
  let totalResults: number | undefined;
  let text = '';

  const collect = (chunk: string): void => {
    if (field === undefined || text.length >= MAX_FIELD_CHARS) return;
    text += chunk.slice(0, MAX_FIELD_CHARS - text.length);
  };

  let pos = 0;
  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos);
    if (lt === -1) {
      if (field !== undefined) collect(decodeXmlEntities(xml.slice(pos, pos + MAX_FIELD_CHARS)));
      break;
    }
    if (field !== undefined) collect(decodeXmlEntities(xml.slice(pos, Math.min(lt, pos + MAX_FIELD_CHARS))));

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) break;
      pos = end + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) break;
      collect(xml.slice(lt + 9, Math.min(end, lt + 9 + MAX_FIELD_CHARS)));
      pos = end + 3;
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) break;
      pos = end + 2;
    } else if (xml.startsWith('<!', lt)) {
      if (/^<!doctype/i.test(xml.slice(lt, lt + 9))) throw malformed('it has a DOCTYPE declaration');
      const end = xml.indexOf('>', lt + 2);
      if (end === -1) break;
      pos = end + 1;
    } else {
      const tag = readTag(xml, lt);
      if (tag === undefined) break;
      pos = tag.next;
      if (!sawRoot) {
        if (tag.closing || tag.name !== 'feed') throw malformed('no feed element');
        sawRoot = true;
        if (tag.selfClosing) {
          feedClosed = true;
          break;
        }
        continue;
      }
      if (tag.selfClosing) continue;

      if (!tag.closing) {
        if (tag.name === 'opensearch:totalResults' && entry === undefined && field === undefined) {
          field = 'totalResults';
          text = '';
        } else if (tag.name === 'entry') {
          entry ??= { authors: [] };
        } else if (entry !== undefined && field === undefined) {
          if (tag.name === 'author') {
            inAuthor = true;
          } else if (inAuthor && tag.name === 'name') {
            field = 'name';
            text = '';
          } else if (!inAuthor && FIELD_OF_TAG[tag.name] !== undefined) {
            field = FIELD_OF_TAG[tag.name];
            text = '';
          }
        }
      } else if (field === 'totalResults' && tag.name === 'opensearch:totalResults') {
        const value = text.trim();
        if (/^\d{1,9}$/.test(value)) totalResults = Number(value);
        field = undefined;
        text = '';
      } else if (entry === undefined && tag.name === 'feed') {
        feedClosed = true;
        break;
      } else if (entry !== undefined) {
        const closes = field === 'name' ? tag.name === 'name' : field !== undefined && FIELD_OF_TAG[tag.name] === field;
        if (closes && field !== undefined && field !== 'totalResults') {
          const value = text.trim();
          if (field === 'name') {
            if (value !== '' && entry.authors.length < MAX_AUTHORS) entry.authors.push(value);
          } else if (value !== '' && entry[field] === undefined) {
            entry[field] = value;
          }
          field = undefined;
          text = '';
        } else if (tag.name === 'author') {
          inAuthor = false;
          field = undefined;
          text = '';
        } else if (tag.name === 'entry') {
          if (entries.length >= MAX_ENTRIES) throw malformed('too many entries');
          entries.push(entry);
          entry = undefined;
          inAuthor = false;
          field = undefined;
          text = '';
        }
      }
    }
  }
  if (!sawRoot) throw malformed('no feed element');
  if (!feedClosed) throw malformed('the feed is cut off');
  return { entries, ...(totalResults !== undefined && { totalResults }) };
}
