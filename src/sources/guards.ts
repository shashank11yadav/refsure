// Small runtime guards shared by the adapters. Every API response is untrusted:
// nothing is read with a cast, and a field of the wrong type is treated as absent.

import { plainQueryText, surnamesFrom } from '../core/normalize';
import { isValidDoi } from '../core/identifiers';
import { SourceError } from './http';
import type { SourceName } from '../core/types';

const MAX_TEXT = 1000;
// Real consortium papers list a few hundred authors; anything beyond is noise or an attack.
export const MAX_AUTHORS = 500;
const MIN_YEAR = 1400;
const MAX_YEAR = 2100;

export { isRecord } from '../core/coerce';

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The text of a field: control and bidi-formatting characters removed, whitespace collapsed, length capped. */
export function cleanText(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .slice(0, max * 4)
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return text === '' ? undefined : text;
}

// A formula (MathML, or a JATS inline formula) in a record's title, with its own markup inside.
const FORMULA = /<((?:[A-Za-z][\w.-]{0,20}:)?(?:math|inline-formula))\b[^<>]{0,500}>([\s\S]{0,4000}?)<\/\1\s*>/g;
// Any tag, inside a formula only: everything there is the formula's own markup.
const TAG = /<\/?[A-Za-z][^<>]{0,200}>/g;
// Outside a formula only known markup is taken out, so a "<" in the text itself ("n<k and k>m") stays: HTML and JATS
// elements (in any case), MathML's (lower case, as MathML writes them), and line breaks and block tags, which stand
// between words. Elements that are no title markup at all ("<script>") are known too, and go the same way.
// Of one-letter names only i and b are read as tags: "p<q and q>r" is text.
const HTML_NAMES = 'sub|sup|i|b|em|strong|scp|sc|span|font|small|big|tt|strike|del|ins|mark|code|var|cite|abbr|italic|bold|underline|monospace|roman|sans-serif|inline-formula|tex-math|alternatives|script|style|iframe|object|embed|img|svg|link|meta|input|form|button|label|jats:[A-Za-z][\\w.-]{0,30}|mml:[A-Za-z]{1,20}';
const MATHML_NAMES = 'math|semantics|annotation(?:-xml)?|none|m(?:i|n|o|s|row|text|space|sub|sup|subsup|frac|sqrt|root|over|under|underover|style|fenced|table|tr|td|padded|phantom|enclose|multiscripts|prescripts)';
const tagOf = (names: string, flags: string): RegExp => new RegExp(`<\\/?(?:${names})(?=[\\s/>])[^<>]{0,200}>`, flags);
const HTML_TAG = tagOf(HTML_NAMES, 'gi');
const MATHML_TAG = tagOf(MATHML_NAMES, 'g');
const BLOCK_TAG = tagOf('(?:jats:)?(?:br|p|div|title|hr|li|ul|ol|sec|list-item)|jats:break', 'gi');

/**
 * A record's title without its markup. An inline tag joins what it wraps to its word ("CeCoIn<sub>5</sub>" is "CeCoIn5",
 * "<i>in situ</i>" is "in situ"); a line break or a block tag is a space. A formula stands as a word of its own, even when
 * the service prints it with no space around it ("the<mml:math>…BaFe2As2…</mml:math>family"), and its own tags and line
 * breaks split nothing inside it. Anything else between "<" and ">" is text and stays.
 */
export function withoutMarkup(text: string): string {
  return text
    .replace(FORMULA, (_whole, _name: string, inner: string) => ` ${inner.replace(/>\s+</g, '><').replace(TAG, '')} `)
    .replace(BLOCK_TAG, ' ')
    .replace(HTML_TAG, '')
    .replace(MATHML_TAG, '');
}

/** A cited title as the text of a search: cleaned, capped and with any TeX resolved ("\\widetilde{O}(T^{-1})" is "O(T-1)"). */
export function queryTitle(value: unknown, max: number): string | undefined {
  const text = cleanText(value, max);
  return text === undefined ? undefined : cleanText(plainQueryText(text), max);
}

/** The first non-empty string of a string or an array of values. */
export function firstText(value: unknown, max = MAX_TEXT): string | undefined {
  for (const item of Array.isArray(value) ? value : [value]) {
    const text = cleanText(item, max);
    if (text !== undefined) return text;
  }
  return undefined;
}

export function toYear(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d{4}$/.test(value.trim()) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= MIN_YEAR && n <= MAX_YEAR ? n : undefined;
}

/** The lower-case surname of one author's full name, as written in any common order. */
export function surnameOf(name: unknown): string | undefined {
  const text = cleanText(name, 200);
  return text === undefined ? undefined : surnamesFrom(text)[0];
}

export function surnamesOf(names: Iterable<unknown>): string[] {
  const out: string[] = [];
  for (const name of names) {
    const surname = surnameOf(name);
    if (surname !== undefined) out.push(surname);
    if (out.length >= MAX_AUTHORS) break;
  }
  return out;
}

export function validDoi(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const doi = value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  return isValidDoi(doi) ? doi : undefined;
}

/** A title as the services print it, without the "RETRACTED:" or "[Retracted]" prefix some publishers add to the record. */
export function withoutNoticePrefix(title: string): string {
  // "RETRACTED:", "RETRACTED ARTICLE:", "WITHDRAWN:" and the bracketed "[Retracted]" some publishers use.
  return title.replace(/^\s*(?:(?:retracted|withdrawn)\s*(?:article)?\s*:|\[\s*(?:retracted|withdrawn)\s*(?:article)?\s*\])\s*/i, '').trim();
}

// Notes that comment on, answer or amend another work. A search for a famous paper returns dozens of them,
// each carrying nearly the paper's own title, and they rank above the paper's own record.
const NOTICE_TITLE = /^\s*(?:comments?\s+on|repl(?:y|ies)\s+to|responses?\s+to|errat(?:um|a)|corrigend(?:um|a)|corrections?\s+to)\b/i;

/** Is this title that of a comment, reply, erratum or correction rather than of a work in its own right? */
export function isNoticeTitle(title: string): boolean {
  return NOTICE_TITLE.test(title);
}

// Kinds of work that are not papers, as Crossref types ("dataset", "component") and DataCite resource types ("Collection",
// "PhysicalObject") name them, compared without case or punctuation. Texts of any kind (an article, a preprint, a report,
// "Text", "Other") are not here: a title that differs from one of those may well be a wrong identifier.
const NON_PAPER_TYPES = new Set(['dataset', 'database', 'component', 'grant', 'collection', 'software', 'image', 'audiovisual', 'sound', 'model', 'workflow', 'physicalobject', 'interactiveresource', 'computationalnotebook', 'service', 'instrument', 'award', 'project', 'event', 'outputmanagementplan', 'studyregistration']);

/** Does the service's type for a work say it is not a paper (a dataset, software, a collection)? */
export function isNonPaperType(value: unknown): boolean {
  return typeof value === 'string' && NON_PAPER_TYPES.has(value.toLowerCase().replace(/[^a-z]/g, ''));
}

export function badResponse(source: SourceName): SourceError {
  return new SourceError('bad_response', source, 'The response did not have the expected shape');
}
