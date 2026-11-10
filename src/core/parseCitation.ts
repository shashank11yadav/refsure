// Turning the raw text of one bibliography entry into the pieces the lookup
// engine searches with: identifiers, title, author surnames, year and kind.
//
// The input is untrusted page text, so everything here is a single pass or a
// regex without nested quantifiers on overlapping classes, and the amount of
// text looked at is capped. A reference is read as a list of "segments"
// (authors, title, venue...) cut at sentence ends, using the bibliography's own
// blocks when the page provides them.

import { findArxivId, findDoi, stripArxivVersion } from './identifiers';
import { withoutLeadingLabel } from './labels';
import { joinLineEndHyphens, surnamesFrom } from './normalize';
import { withoutNoteField } from './noteField';
import type { ParsedCitation, RawReference } from './types';

// Real entries are a few hundred characters (a long author list can reach a few
// thousand). Anything beyond the cap is ignored, and anything past the "plausible"
// length is almost certainly not one reference, so it never gets a high score.
const MAX_INPUT_CHARS = 20_000;
// A 60-author list is about 1k chars, so 4k is a heuristic, not a measured limit; revisit if long-author entries are mis-scored.
const PLAUSIBLE_LENGTH = 4_000;
const MAX_AUTHOR_CHARS = 6_000;
const MAX_TITLE_CHARS = 300;
const MAX_SEGMENTS = 12;
const MAX_VENUE_CHARS = 200;
const MAX_SURNAMES = 200;
const MAX_QUOTED_TITLE_CHARS = 320;
const MAX_QUOTE_SEARCH_CHARS = 3_000;
const MAX_PREFIX_WORDS = 400;
const MAX_TOKEN_CHARS = 12;
const OVERLONG_CONFIDENCE = 0.3;
const FRAGMENT_CONFIDENCE = 0.3;

const MIN_YEAR = 1900;
const MAX_YEAR = 2030;

// --- Cleaning -----------------------------------------------------------------

// Plain loops rather than /[...]+$/: a regex that must reach the end of the string
// retries from every start inside a long run of punctuation, which is quadratic.
const TRAILING_JUNK = ' \t\n\r.,;:';

function trimEnd(s: string, chars: string = TRAILING_JUNK): string {
  let end = s.length;
  while (end > 0 && chars.includes(s.charAt(end - 1))) end--;
  return s.slice(0, end);
}

function clean(s: string): string {
  const text = s
    .slice(0, MAX_INPUT_CHARS)
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, (c) => (c === '\n' || c === '\r' || c === '\t' ? c : ' '));
  return joinLineEndHyphens(text).replace(/\s+/g, ' ').trim();
}

const LEADING_LABEL = /^(?:\[\s*\d{1,4}\s*\]|\[[A-Za-z][^\]\s]{0,20}\]|\(\s*\d{1,4}\s*\)|\d{1,4}[.)])\s+/;
// "(2017) " left behind after the label "Belinkov et al." was removed.
const LEADING_YEAR = /^\(\s*(?:19|20)\d{2}[a-z]?\s*\)\s*/;

function withoutLabel(text: string, label: string): string {
  let t = text;
  const l = clean(label);
  // The label must end at a word edge, so a label "1" does not eat the start of "1000 Genomes...".
  if (l !== '' && t.startsWith(l) && (t.length === l.length || !/[\p{L}\p{N}]/u.test(t.charAt(l.length)))) t = t.slice(l.length).trim().replace(LEADING_YEAR, '');
  return withoutLeadingLabel(t.replace(LEADING_LABEL, ''));
}

// --- Segmenting ---------------------------------------------------------------

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
const isUpper = (ch: string): boolean => ch !== '' && ch !== ch.toLowerCase();
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
const OPENERS = new Set(['"', '“', '‘', '(', '[', '«']);

// A single capital, "T.-Y", "U.S": the dotted forms that stand for given names.
// A lower-case single letter is an initial too: "Pinto, H. P. d. O.".
const INITIAL_TOKEN = /^(?:(?:\p{Lu}\.-?)*\p{Lu}|\p{Ll})$/u;

// Words whose full stop does not end a sentence.
const ABBREVIATIONS = new Set(['vs', 'e.g', 'i.e', 'no', 'vol', 'pp', 'p', 'ed', 'eds', 'dr', 'mr', 'mrs', 'ms', 'st', 'jr', 'sr', 'fig', 'figs', 'proc', 'conf', 'int', 'trans', 'univ', 'inc', 'ltd', 'co', 'cf', 'ca', 'dept', 'eq', 'sec', 'ch', 'md', 'adv']);

// Lower-case words that still start a new segment ("... translation. arXiv preprint ...").
const LOWER_STARTERS = new Set(['arxiv', 'corr', 'in', 'url', 'doi', 'http', 'https', 'www', 'pp', 'pages', 'accessed', 'available', 'proceedings', 'journal', 'technical', 'tech', 'preprint', 'version', 'biorxiv', 'medrxiv', 'ssrn']);

// "Smith, J. and Jones, K. (2019)": a surname, a comma, then dotted initials.
const LAST_FIRST_START = /^[\p{L}'’ -]{2,40},\s*\p{Lu}\.(?:[\s-]?\p{Lu}\.)*(?=[\s,;:(]|$)/u;

// Vancouver: "Mikolov T, Chen K, ..." (surname, then initials without dots). Two authors are
// needed so that "Green AI. CoRR" stays a title and a venue.
const NAME_INITIALS = String.raw`\p{Lu}[\p{L}'’-]+(?: \p{Lu}[\p{L}'’-]+){0,2} \p{Lu}{1,3}`;
const VANCOUVER_START = new RegExp(`^${NAME_INITIALS},\\s+${NAME_INITIALS}(?=[,.\\s]|$)`, 'u');
const VANCOUVER_INITIALS = /^\p{Lu}{1,3}$/u;
// "Smith, J. et al.": "et al." belongs to the author run, not to the title.
const ET_AL_WORD = /^et\b/i;
const ET_AL_ONLY = /^et\.? al\.?$/i;

interface Style {
  lastFirst: boolean;
  vancouver: boolean;
}

// Capitalised words that start the venue part ("... baseline? In AAAI", "...? Nature 5, 2019"),
// as opposed to the next words of a title that merely contains a question or exclamation
// mark. "In" must not be "In-context", and a bare "To" is a common title word.
const VENUE_STARTER = /^(?:In(?![-\w])|To appear|(?:Proceedings|Proc|Journal|Transactions|Trans|Advances|Adv|arXiv|ArXiv|CoRR|Technical|Tech|Preprint|Version|URL|Accessed|Available|DOI|ISBN|IEEE|ACM|Nature|Science|Physical|Phys|Neural|Springer|Elsevier|Wiley|Annals|Bulletin|Review|Cell|Lancet|PLOS|PNAS)\b)/;

const SHORT_CLAUSE_WORDS = 6;
const CLAUSE_SCAN_CHARS = 120;

// After "?" or "!": a short clause that carries a year or volume/pages, or is followed
// directly by one ("Neural Computation, 2020." / "Nature. 2019;5:1-3."), is a venue.
function shortVenueClause(text: string, from: number): boolean {
  const limit = Math.min(text.length, from + CLAUSE_SCAN_CHARS);
  let end = from;
  while (end < limit && !(text.charAt(end) === '.' && (end + 1 >= text.length || isSpace(text.charAt(end + 1))))) end++;
  if (end >= limit && end < text.length) return false;
  const clause = text.slice(from, end);
  if (clause.split(' ').length > SHORT_CLAUSE_WORDS) return false;
  if (/\d/.test(clause)) return true;
  let after = end + 1;
  while (after < text.length && isSpace(text.charAt(after))) after++;
  return isDigit(text.charAt(after));
}

// "Hinton G. Reducing the dimensionality ...": a lone surname and one unpunctuated initial
// at the very start, with a title-length clause after the full stop. "Quoc V. Le. Title"
// differs because "Le" ends the clause at once.
const SURNAME_ONLY = /^\p{Lu}[\p{L}'’-]+$/u;
const MIN_TITLE_WORDS_AFTER_INITIAL = 3;

function singleVancouverAuthor(text: string, tokenStart: number, next: number): boolean {
  if (tokenStart === 0 || tokenStart > 40 || !SURNAME_ONLY.test(text.slice(0, tokenStart).trim())) return false;
  let end = next;
  const limit = Math.min(text.length, next + CLAUSE_SCAN_CHARS);
  while (end < limit && !(text.charAt(end) === '.' && (end + 1 >= text.length || isSpace(text.charAt(end + 1))))) end++;
  const words = text.slice(next, end).split(' ');
  // "Sarah E. Kreps, Miles ..." / "Samuel R. Bowman and George Dahl" are given-first author lists.
  if (words[0]?.endsWith(',') === true || /^(?:and|&)$/i.test(words[1] ?? '')) return false;
  return words.length >= MIN_TITLE_WORDS_AFTER_INITIAL;
}

function wordAfter(text: string, from: number): string {
  let end = from;
  while (end < text.length && end - from < 20 && !isSpace(text.charAt(end))) end++;
  return text.slice(from, end);
}

// "openai.com, 2017": a bare domain starts the venue/link part.
const DOMAIN_START = /^[a-z0-9-]{2,30}\.(?:com|org|net|io|edu|gov|ai)\b/;

function startsNewSegment(next: string, word: string): boolean {
  if (next === '') return true;
  if (isUpper(next) || isDigit(next) || OPENERS.has(next)) return true;
  const lower = word.toLowerCase();
  if (lower.startsWith('http') || lower.startsWith('www.') || lower.includes('://') || DOMAIN_START.test(lower)) return true;
  return LOWER_STARTERS.has(/^[a-z]+/.exec(lower)?.[0] ?? '');
}

// A title that starts in lower case ("mixup: Beyond ...", "fairseq: A fast ...") still
// follows a full stop; the colon right after its first word gives it away.
function startsLowerTitle(word: string): boolean {
  if (word.length < 3 || word.includes('/')) return false;
  if (word.endsWith(':') && !word.includes('.')) return true;
  // "wav2vec 2.0", "mt5", "e-SNLI": a lower-case name with a digit or capital inside.
  return /^[a-z][a-z-]*[A-Z0-9]/.test(word);
}

// In "Last, F." style the dotted initials after a comma are an author's, and a
// full stop that ends them ends the author list.
function endsLastFirstInitials(text: string, tokenStart: number): boolean {
  let pos = tokenStart;
  for (let hops = 0; hops < 6; hops++) {
    let k = pos - 1;
    while (k >= 0 && isSpace(text.charAt(k))) k--;
    if (k < 0) return false;
    if (text.charAt(k) === ',') return true;
    if (text.charAt(k) !== '.') return false;
    let s = k;
    while (s > 0 && k - s <= MAX_TOKEN_CHARS && !isSpace(text.charAt(s - 1))) s--;
    if (k - s > MAX_TOKEN_CHARS || !INITIAL_TOKEN.test(text.slice(s, k))) return false;
    pos = s;
  }
  return false;
}

/** Cuts a reference into sentence-like segments, keeping each one's own full stop or question mark. */
function splitSegments(text: string, style: Style): string[] {
  const { lastFirst, vancouver } = style;
  const segments: string[] = [];
  let start = 0;
  const n = text.length;
  for (let i = 0; i < n && segments.length < MAX_SEGMENTS - 1; i++) {
    const ch = text.charAt(i);
    if (ch !== '.' && ch !== '?' && ch !== '!') continue;
    // "Zettlemoyer, L.: Title": the colon after an initial's full stop ends the authors.
    const colonAfterInitial = ch === '.' && text.charAt(i + 1) === ':' && isSpace(text.charAt(i + 2));
    if (i + 1 >= n || !(isSpace(text.charAt(i + 1)) || colonAfterInitial)) continue;
    let next = i + (colonAfterInitial ? 2 : 1);
    while (next < n && isSpace(text.charAt(next))) next++;
    const word = wordAfter(text, next);
    const nextChar = text.charAt(next);

    let boundary: boolean;
    if (ch !== '.') {
      // "Is BERT really robust? A strong baseline ...": a capitalised word after "?" or "!"
      // continues the title unless it starts the venue.
      boundary = isUpper(nextChar) ? VENUE_STARTER.test(word) || shortVenueClause(text, next) : startsNewSegment(nextChar, word);
    } else {
      let tokenStart = i;
      while (tokenStart > start && i - tokenStart <= MAX_TOKEN_CHARS && !isSpace(text.charAt(tokenStart - 1))) tokenStart--;
      const token = i - tokenStart <= MAX_TOKEN_CHARS ? text.slice(tokenStart, i) : '';
      if (vancouver && segments.length === 0 && VANCOUVER_INITIALS.test(token)) {
        boundary = true;
      } else if (segments.length === 0 && start === 0 && /^\p{Lu}$/u.test(token) && singleVancouverAuthor(text, tokenStart, next)) {
        boundary = true;
      } else if (INITIAL_TOKEN.test(token)) {
        boundary = colonAfterInitial || (lastFirst && endsLastFirstInitials(text, tokenStart) && !/^(?:and|&)$/i.test(word) && !/^\p{L}\./u.test(word) && !ET_AL_WORD.test(word));
      } else if (token.toLowerCase() === 'al') {
        boundary = colonAfterInitial || isUpper(nextChar) || isDigit(nextChar) || OPENERS.has(nextChar);
      } else if (colonAfterInitial) {
        boundary = false;
      } else if (ABBREVIATIONS.has(token.toLowerCase())) {
        boundary = false;
      } else {
        boundary = startsNewSegment(nextChar, word) || startsLowerTitle(word) || (/^(?:19|20)\d{2}[a-z]?$/.test(token) && nextChar !== '');
      }
    }
    if (!boundary) continue;
    segments.push(text.slice(start, i + 1).trim());
    start = next;
    i = next - 1;
  }
  const rest = text.slice(start).trim();
  if (rest !== '') segments.push(rest);
  return segments.filter((s) => s !== '');
}

// --- Classifying segments -------------------------------------------------------

const YEAR_ONLY = /^\(?\s*(?:[A-Za-z]{3,9}\.?\s+)?(?:19|20)\d{2}[a-z]?\s*\)?\.?$/;
const URL_SEGMENT = /^(?:URL|url|Available|Accessed|Retrieved|doi:?|DOI:?|ISBN|https?:\/\/|www\.)/;
const VENUE_SEGMENT = /^(?:[Ii]n:?\s|Proceedings|Proc\.|Journal|Transactions|Advances\s|arXiv|ArXiv|CoRR|Technical [Rr]eport\s*(?:[,.]|$)|Tech\.? ?[Rr]eport\s*(?:[,.]|$)|Preprint|Version|To appear)/;

const NAME_CONNECTORS = new Set(['and', 'of', 'for', 'the', 'de', 'la', 'le', 'van', 'von', 'der', 'den', 'del', 'della', 'di', 'da', 'du', 'ter', 'ten', 'dos', 'das', 'do', 'bin', 'ibn', 'al', 'el', 'y', 'e', 'in', 'on', 'at', 'et']);

function withoutEtAl(s: string): string {
  return s.replace(/,?\s*\bet\.?\s*al\b\.?/gi, '');
}

/** True when the text reads like a list of names, a person's or an organisation's. */
function looksLikeAuthors(seg: string): boolean {
  if (seg.length < 2 || seg.length > MAX_AUTHOR_CHARS) return false;
  if (/[\d:?!"“”]/.test(seg)) return false;
  const words = withoutEtAl(seg)
    .split(/[\s,;&]+/)
    .filter((w) => w !== '' && w !== '.');
  if (words.length === 0 || words.length > MAX_PREFIX_WORDS) return false;
  let lower = 0;
  for (const w of words) {
    if (w.length > 30) return false;
    if (w.length <= 2 && w.replace('.', '').length === 1) continue;
    const first = w.charAt(0);
    if (first === first.toLowerCase() && first !== first.toUpperCase() && !NAME_CONNECTORS.has(w.toLowerCase())) lower++;
  }
  return lower <= 1;
}

// A name written all in lower case, as some authors spell their own ("yelong shen"): two or three plain words.
const LOWER_CASE_NAME = /^\p{Ll}[\p{Ll}'’-]+(?: \p{Ll}[\p{Ll}'’-]+){1,2}$/u;
const MIN_NAMES_WITH_LOWER_CASE = 3;

/**
 * looksLikeAuthors, also allowing one name written all in lower case ("E. J. Hu, yelong shen, P. Wallis, ..."): only in
 * a list of three names or more whose other names read as names, and never a word that joins names ("of", "the", "and").
 */
function looksLikeNamesWithOneLowerCase(seg: string): boolean {
  if (looksLikeAuthors(seg)) return true;
  if (seg.length > MAX_AUTHOR_CHARS) return false;
  const pieces = withoutEtAl(seg)
    .split(/\s*[,;]\s*|\s+(?:and|&)\s+/)
    .map((p) => p.replace(/^(?:and|&)\s+/, '').trim())
    .filter((p) => p !== '');
  if (pieces.length < MIN_NAMES_WITH_LOWER_CASE) return false;
  const lower = pieces.filter((p) => LOWER_CASE_NAME.test(p));
  const name = lower[0];
  if (lower.length !== 1 || name === undefined || name.split(' ').some((w) => NAME_CONNECTORS.has(w))) return false;
  return looksLikeAuthors(pieces.filter((p) => p !== name).join(', '));
}

// --- Titles ---------------------------------------------------------------------

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?';
const TRAILING_DATE = new RegExp(`[,;]\\s*(?:${MONTH}\\s+)?(?:\\d{1,2}\\s+)?(?:19|20)\\d{2}[a-z]?\\.?$`, 'i');
const TRAILING_PAREN_YEAR = /\s*\(\s*(?:19|20)\d{2}[a-z]?\s*\)\.?$/;
// A bracket at the end whose year follows a comma or a month is a date or a publisher's imprint, not part of the title: "(Oct., 2011)",
// "(Cambridge University Press, 2005)", "(CRC, Florida, 2011-12)". The brackets are not nested, so this stays linear.
const TRAILING_IMPRINT = new RegExp(`\\s*\\((?:[^()]{0,120}?,\\s*|${MONTH}\\s+)(?:19|20)\\d{2}(?:\\s*[-–]\\s*\\d{2,4})?[a-z]?\\s*\\)\\.?$`, 'i');
// The same bracket cut open by a comma split ("(Cambridge Univ. Press") or by the sentence cut ("(Oct").
const TRAILING_OPEN_BRACKET = /\s*\([^()]{0,120}$/;
// "vol. 9" left in front of a removed imprint.
const TRAILING_VOLUME = /,\s*vol(?:ume)?\.?\s*\d{1,4}$/i;
const WRAPPING_QUOTES = /^[“"‘']\s*([\s\S]*?)\s*[”"’']$/;
const ARXIV_VENUE_ONLY = /^(?:arxiv\s+(?:preprint|e-?prints?)\b|arxiv\s*:|corr\s+abs\b)/i;

function cleanTitle(s: string): string | undefined {
  let t = s.trim();
  // "Too Big?." keeps its question mark; a plain full stop or comma goes.
  t = trimEnd(t);
  const quoted = WRAPPING_QUOTES.exec(t);
  if (quoted?.[1] !== undefined && !/[“”"]/.test(quoted[1])) t = quoted[1];
  t = t.replace(TRAILING_PAREN_YEAR, '').replace(TRAILING_DATE, '');
  t = trimEnd(t).trim();
  const bare = t.replace(TRAILING_IMPRINT, '').replace(TRAILING_OPEN_BRACKET, '');
  if (bare !== t) t = trimEnd(bare.replace(TRAILING_VOLUME, '')).trim();
  if (t.length < 2 || t.length > MAX_TITLE_CHARS) return undefined;
  const nonSpace = t.replace(/\s+/g, '');
  const letters = nonSpace.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2 || letters.length / nonSpace.length < 0.6) return undefined;
  // "et al." is what is left when the author run was cut in the wrong place; an author run
  // ("Mikolov T, Chen K, ...") is never a title.
  if (ET_AL_ONLY.test(t) || VANCOUVER_START.test(t)) return undefined;
  // "arXiv preprint arXiv:2001.01234" is where the paper is, not what it is called.
  if (ARXIV_VENUE_ONLY.test(t)) return undefined;
  // A sentence with a web address in it ("... available for download at http://...") is a note, not a title.
  if (/https?:\/\/|\bwww\./i.test(t)) return undefined;
  return t;
}

// --- Year -----------------------------------------------------------------------

// Things that look like years but are not: URLs, DOIs, arXiv ids, page ranges,
// volume:page references and access dates.
const NOT_YEAR_PATTERNS: RegExp[] = [
  /(?:https?:\/\/|www\.)\S*/gi,
  /\b10\.\d{4,9}\/\S*/g,
  /\barxiv\s*:\s*\S*/gi,
  /\babs\/\S*/g,
  /\b\d{4}\.\d{4,5}(?:v\d+)?\b/g,
  /\b(?:accessed|retrieved)\b[^.]{0,40}/gi,
  // Case-sensitive: an author's initial "P. 2003" is not a page.
  /\b(?:pp?\.?|[Pp]ages?)\s*\d+(?:\s*[–—-]\s*\d+)?/g,
  /\b\d+\s*(?:\([^)\s]{1,8}\))?\s*:\s*\d+(?:\s*[–—-]\s*\d+)?/g,
  // An erratum in brackets after the work ("(1975) [erratum: Commun. Math. Phys. 46, 206 (1976)]") has its own year.
  /\[\s*(?:errat(?:um|a)|addend(?:um|a)|corrigend(?:um|a))\b[^[\]]{0,200}\]/gi,
];
// A year in round brackets, alone or after a month ("(2019)", "(Nov., 2019)", "(July 2020)").
const BRACKETED_YEAR = /\((?:[A-Za-z]{3,9}\.?,?\s+)?((?:19|20)\d{2})[a-z]?\)/g;
const YEAR_TOKEN = /(?<![\d.])((?:19|20)\d{2})[a-z]?(?!\d)/g;

function findYear(body: string, title: string | undefined): number | undefined {
  let scrub = body;
  if (title !== undefined) {
    const at = scrub.indexOf(title);
    if (at >= 0) scrub = `${scrub.slice(0, at)} ${scrub.slice(at + title.length)}`;
  }
  for (const pattern of NOT_YEAR_PATTERNS) scrub = scrub.replace(pattern, ' ');
  const plain: { value: number; at: number }[] = [];
  for (const m of scrub.matchAll(YEAR_TOKEN)) {
    const value = Number(m[1]);
    if (value >= MIN_YEAR && value <= MAX_YEAR) plain.push({ value, at: m.index });
  }
  // "Nanophotonics 8 (Nov., 2019) 1945–1973": a year in brackets is the year; page numbers can look like years.
  const bracketed: { value: number; at: number; afterVolume: boolean }[] = [];
  for (const m of scrub.matchAll(BRACKETED_YEAR)) {
    const value = Number(m[1]);
    if (value >= MIN_YEAR && value <= MAX_YEAR) bracketed.push({ value, at: m.index, afterVolume: AFTER_VOLUME.test(scrub.slice(Math.max(0, m.index - 12), m.index)) });
  }
  // "Proc. R. Soc. B 287 (1937), 20200568": a bracketed number right after a volume is its issue when the reference gives
  // another year, a bracketed one elsewhere ("McKee ... (2020) Title") or a plain one before it ("McKee A. 2020. Title").
  // Alone, it is the year ("Nucl. Phys. B 360 (1991) 145").
  const standalone = bracketed.filter((b) => !b.afterVolume);
  if (standalone.length > 0) return standalone.at(-1)?.value;
  const first = bracketed[0];
  if (first === undefined) return plain.at(-1)?.value;
  const before = plain.filter((p) => p.at < first.at && isDateYear(scrub, p.at));
  return before.at(-1)?.value ?? bracketed.at(-1)?.value;
}

// A volume just before a bracket: a number after the journal's name ("Sciences 287 (", "B 360 (", "Rev. D81 ("), not one
// after a comma or a dash, which is a page ("Gen. Rel. Grav. 40, 1997 (2008)").
const AFTER_VOLUME = /(?:^|[^\d\s,;:–—-])\s*\p{Lu}?\d{1,4}\s*$/u;

/**
 * A plain four-digit number at `at` that stands as a date ("McKee A, ... MJ. 2020. The sensory ..."): alone between spaces
 * or a sentence's punctuation, not in a range, a volume designation or a longer number ("1945–1973", "Vol. 2016/2017").
 */
function isDateYear(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 6), at);
  const after = text.slice(at + 4, at + 7);
  return /(?:^|\s)$/.test(before) && !/\b(?:vol|no|pp?)\.?\s*$/i.test(before) && /^[a-z]?(?:[.,;:)](?:\s|$)|[.)]?$)/.test(after);
}

// --- Kind -----------------------------------------------------------------------

// Evidence that an entry is a paper: a venue word, "In CVPR", volume:pages. The text
// checked has the title and author list removed, so titles and initials cannot trigger it.
const VENUE_WORDS = /\b(?:proc|trans|adv|syst)\.|\b(?:proceedings|conference|journal|transactions|workshop|symposium|advances in|arxiv|corr|preprint|biorxiv|letters|annals|bulletin|magazine|quarterly|review of|nature|science)\b/i;
// Pages or "volume:pages". Also a book's: "(Princeton U. Press, 1999), p. 123" is a book cited at a page.
const LOCATOR_WORDS = /\bpp?\.\s*\d|\bpages\s+\d|\b\d+\s*(?:\([^)\s]{1,8}\))?\s*:\s*\d+/i;
// A publisher's imprint in brackets that names a press: "(Cambridge U. Press, 1996)", "(Psychology press, 2012)".
const IMPRINT_PRESS = /\([^()]{0,120}\bPress\b[^()]{0,80}\)/i;
const IN_VENUE = /(?:^|[.,”"]\s*)\b[Ii]n:?\s+\p{Lu}/u;
const PUBLISHER_WORDS = /\b(?:press|publishers?|publishing|wiley|springer|pearson|elsevier|mcgraw|prentice|o'reilly|addison|morgan kaufmann|de gruyter|birkh(?:ä|a)user|north-holland|world scientific)\b|\bISBN\b/i;
// APA and Chicago book entries end "New York: Farrar, Straus and Giroux." with a city and a publisher whose name has no publishing word.
const PUBLISHER_PLACE = /\b(?:New York|London|Oxford|Cambridge|Boston|Chicago|Berlin|Heidelberg|Princeton|Amsterdam|Paris|Philadelphia|Washington)\s*:\s+\p{Lu}/u;
const SOFTWARE_HOSTS = /\b(?:https?:\/\/)?(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|pypi\.org|sourceforge\.net|npmjs\.com|crates\.io)\//i;
const ZENODO_DOI = /^10\.5281\//;

// Real items that are not papers and not in the databases. A thesis or work in preparation can still carry a
// venue word or an identifier, in which case it is read as the paper it says it is (the checks below come first).
const THESIS_OR_UNPUBLISHED = /\b(?:thesis|dissertation)\b|\b(?:in preparation|private communication|personal communication|unpublished)\b/i;
const TALK = /\b(?:talk|seminar|keynote|lecture)\s+(?:given|presented|delivered)\b/i;
const DATASET_HOSTS = /\bkaggle\b/i;
// A note about when a page was read, or arXiv's "External Links: Link" (the address itself is dropped from the text):
// the entry points at a web page. "Document" or "ISBN" after "External Links:" belong to papers and books.
const WEB_ACCESS_NOTE = /\b(?:accessed(?:\s+on)?\b|retrieved\s+(?:from|on)\b|external links:\s*link\b(?!\s*,)|online\s*;\s*accessed\b)|\[online\]/i;
// Volume and pages ("76, 1210", "5:12-19", "pp. 3") mean a journal or proceedings entry even when its venue has no venue word.
const MONTH_DAY_YEAR = new RegExp(`\\b${MONTH}\\s+\\d{1,2},\\s*(?:19|20)\\d{2}`, 'gi');
const VOLUME_AND_PAGES = /\b\d{1,4}\s*(?:\(\d{1,3}\))?\s*[,:]\s*(?:pp?\.\s*)?\p{L}?\d|\bpp?\.\s*\d/u;

// "Springer Science & Business Media" is a book publisher: its "Science" is no journal.
const SPRINGER_SBM = /\bSpringer\s+Science\s*(?:&|\+|and)\s*Business\s+Media\b/gi;
// Other publishers whose names hold a venue word ("Springer Nature", "Elsevier Science", "Science Press"): a publisher
// alone is no venue, so the name reads as a publisher's.
const PUBLISHER_WITH_VENUE_WORD = /\bSpringer\s+Nature\b|\bNature\s+(?:Publishing(?:\s+Group)?|Portfolio)\b|\bElsevier\s+Science\b|\bScience\s+(?:Press|Publishers?|Publishing)\b/gi;
// Blogs and news sites whose names hold a venue word: "Towards Data Science", "Science Daily" are no journals.
const NEWS_WITH_VENUE_WORD = /\bTowards\s+Data\s+Science\b|\bScience\s?Daily\b|\bScience\s?Alert\b|\bPopular\s+Science\b|\bLive\s?Science\b|\bScience\s+News\b/gi;
// "W. H. Press, Astrophys. J. 170, L105", "Press, W. H.": an author called Press, not a publisher. Only where a name can
// stand (the start, or after a comma, a semicolon or "and"): "Cambridge U. Press" and "Princeton U. P. Press" are
// publishers, and "U." is University. At most four initials, so the scan stays linear on hostile text.
const AUTHOR_PRESS = /(^|[,;]\s?|\band\s|&\s)(?:(?!U\.\s?(?:P\.\s?)?Press\b)(?:\p{Lu}\.\s?){1,4}Press\b|Press,\s?\p{Lu}\.)/gu;

function classify(text: string, doi: string | undefined, arxivId: string | undefined, body: string): ParsedCitation['kind'] {
  const rest = text.replace(SPRINGER_SBM, 'Springer').replace(PUBLISHER_WITH_VENUE_WORD, ' Publisher ').replace(NEWS_WITH_VENUE_WORD, ' ').replace(AUTHOR_PRESS, '$1 ');
  const zenodo = doi !== undefined && ZENODO_DOI.test(doi);
  // A note's words and numbers ("Note: Official Journal of the European Union, L 130, pp. 134–202") are no venue.
  const published = withoutNoteField(rest);
  const venue = VENUE_WORDS.test(published) || IN_VENUE.test(published) || (LOCATOR_WORDS.test(published) && !IMPRINT_PRESS.test(published));
  if (/\bISBN\b/.test(rest) && arxivId === undefined && (doi === undefined || zenodo)) return 'book';
  if (arxivId !== undefined || (doi !== undefined && !zenodo)) return 'paper';
  // A talk's own venue ("... Symposium") must not make it a paper.
  if (TALK.test(body)) return 'web';
  if (venue) return 'paper';
  if (THESIS_OR_UNPUBLISHED.test(body)) return 'book';
  if (DATASET_HOSTS.test(body)) return 'software';
  if (WEB_ACCESS_NOTE.test(body) && !VOLUME_AND_PAGES.test(rest.replace(MONTH_DAY_YEAR, ' '))) return 'web';
  if (PUBLISHER_WORDS.test(rest) || PUBLISHER_PLACE.test(rest)) return 'book';
  if (/\bgithub\b/i.test(rest)) return 'software';
  if (zenodo || SOFTWARE_HOSTS.test(rest)) return 'software';
  if (/(?:https?:\/\/|www\.)\S/i.test(rest)) return 'web';
  return 'unknown';
}

// --- Putting it together --------------------------------------------------------

interface Layout {
  authorText: string | undefined;
  title: string | undefined;
  venue: string | undefined;
  /** How much the segmentation can be trusted: from "page gave us blocks" down to a guess. */
  structure: 'blocks' | 'quoted' | 'segments' | 'guess' | 'none';
}

function isYearOnly(seg: string): boolean {
  return YEAR_ONLY.test(seg);
}

function isNonTitle(seg: string): boolean {
  return isYearOnly(seg) || URL_SEGMENT.test(seg) || VENUE_SEGMENT.test(seg);
}

function venueFrom(segments: string[]): string | undefined {
  const seg = segments.find((s) => !isYearOnly(s) && !/^(?:URL|url|Available|Accessed|Retrieved|doi|DOI|ISBN|https?:\/\/|www\.)/.test(s));
  if (seg === undefined) return undefined;
  const v = trimEnd(seg.replace(/^[Ii]n:?\s+/, ''));
  return v === '' ? undefined : v.slice(0, MAX_VENUE_CHARS);
}

// A part number cut off after a title ("Quantum Theory of Gravity. II. The Manifestly Covariant Theory."): the numeral
// alone, or the numeral and the part's own title in one segment ("I. The Canonical Theory.").
const PART_START = /^((?:Part\s+)?(?:I|II|III|IV|V|VI|VII|VIII|IX|X)\.)(?:\s+(\S[\s\S]*))?$/;
// An initial in a list of names: "I. Goodfellow and Y. Bengio, editors" are people, not a part's title.
const NAME_INITIAL = /(?:^|\s)\p{Lu}\.(?=\s|$)/u;

/** A part's own title: words of a title, not a venue, a number or names. */
function isPartTitle(segment: string): boolean {
  return !isNonTitle(segment) && !/[\d,]/.test(segment) && !NAME_INITIAL.test(segment) && segment.trim().split(/\s+/).length >= 2;
}

/**
 * The title that starts at segments[at], with a part number that follows it and the part's own title ("Quantum Theory of
 * Gravity. II. The Manifestly Covariant Theory"), so that part II is never compared as part I. Returns the title's text
 * and the segments after it. A numeral followed by names ("I. Goodfellow and Y. Bengio, editors") is an initial.
 */
function titleWithPart(segments: string[], at: number): { title: string; after: string[] } {
  const title = segments[at] ?? '';
  const next = segments[at + 1] ?? '';
  const part = PART_START.exec(next);
  if (part === null) return { title, after: segments.slice(at + 1) };
  const [, numeral = '', rest] = part;
  if (rest === undefined) {
    const own = segments[at + 2];
    // The part's own title, when a venue still follows it.
    if (own !== undefined && at + 3 < segments.length && isPartTitle(own)) return { title: `${title} ${numeral} ${own}`, after: segments.slice(at + 3) };
    return { title: `${title} ${numeral}`, after: segments.slice(at + 2) };
  }
  if (isPartTitle(rest)) return { title: `${title} ${numeral} ${rest}`, after: segments.slice(at + 2) };
  // "I. Physical Review B 64, 1": the numeral, then the venue (no names in front of its numbers).
  const firstDigit = rest.search(/\d/);
  if (firstDigit > 0 && !/,/.test(rest.slice(0, firstDigit)) && !NAME_INITIAL.test(rest.slice(0, firstDigit))) return { title: `${title} ${numeral}`, after: [rest, ...segments.slice(at + 2)] };
  return { title, after: segments.slice(at + 1) };
}

function layoutFromSegments(segments: string[], structured: boolean, lastFirst: boolean): Layout {
  const first = segments[0];
  if (first === undefined) return { authorText: undefined, title: undefined, venue: undefined, structure: 'none' };
  const hasAuthors = (lastFirst && LAST_FIRST_START.test(first)) || looksLikeAuthors(first);
  if (!hasAuthors) {
    // No author list: the first segment is the title ("The Albert blog. URL ...").
    return { authorText: undefined, title: cleanTitle(first), venue: venueFrom(segments.slice(1)), structure: structured ? 'blocks' : 'guess' };
  }
  let i = 1;
  while (i < segments.length && isYearOnly(segments[i] ?? '')) i++;
  const candidate = segments[i];
  if (candidate !== undefined && !isNonTitle(candidate)) {
    const { title, after } = titleWithPart(segments, i);
    return { authorText: first, title: cleanTitle(title), venue: venueFrom(after), structure: structured ? 'blocks' : 'segments' };
  }
  // "PyTorch. https://github.com/..., 2019.": a name then only a link, so the name is the title.
  if (candidate !== undefined && URL_SEGMENT.test(candidate) && /^(?:https?:\/\/|www\.|URL|url)/.test(candidate)) {
    return { authorText: undefined, title: cleanTitle(first), venue: undefined, structure: 'guess' };
  }
  return { authorText: first, title: undefined, venue: venueFrom(segments.slice(i)), structure: 'none' };
}

const QUOTE_OPEN = /["“]/;
// BibLaTeX sometimes writes a full stop after a given name in a list of names ("Leonid. Chekhov and Nicolas Orantin",
// "and Victor. Rodriguez"): a capitalised word, a full stop, then one capitalised word that ends the name.
const DOTTED_GIVEN_NAME = /(^|,\s|\band\s|&\s)(\p{Lu}\p{Ll}+)\.\s(\p{Lu}[\p{L}'’-]+)(?=\s*(?:,|\band\b|&|$))/gu;

function withoutDottedGivenNames(names: string): string {
  return names.replace(DOTTED_GIVEN_NAME, '$1$2 $3');
}

/** "A. Vaswani, N. Shazeer et al., "Attention is all you need," in NeurIPS, 2017." */
function layoutFromQuotedTitle(text: string): Layout | undefined {
  const head = text.slice(0, MAX_QUOTE_SEARCH_CHARS);
  const open = head.search(QUOTE_OPEN);
  if (open < 0) return undefined;
  const closeAt = /["”]/.exec(head.slice(open + 1, open + 1 + MAX_QUOTED_TITLE_CHARS));
  if (closeAt === null) return undefined;
  const content = head.slice(open + 1, open + 1 + closeAt.index);
  const after = head.charAt(open + 2 + closeAt.index);
  const endsWithPunctuation = /[,.?!]$/.test(content.trim());
  // A closing quote followed by ":" or a letter is a scare-quoted word inside a title.
  if (!endsWithPunctuation && (after === ':' || /\p{L}/u.test(after))) return undefined;
  const prefix = trimEnd(trimEnd(head.slice(0, open)).replace(/\s*\b(?:19|20)\d{2}[a-z]?$/, ''));
  if (prefix !== '') {
    const names = withoutDottedGivenNames(prefix);
    if (/[a-z]{2}\.\s/.test(withoutEtAl(names)) || !looksLikeAuthors(names)) return undefined;
  }
  const title = cleanTitle(content);
  if (title === undefined) return undefined;
  const venue = venueFrom(splitSegments(head.slice(open + 2 + closeAt.index).replace(/^[\s,.]+/, ''), { lastFirst: false, vancouver: false }));
  return { authorText: prefix === '' ? undefined : prefix, title, venue, structure: 'quoted' };
}

// Physics-style entries are authors and a venue citation, with no title: "C. Brans, R.H. Dicke, Phys. Rev. 124,
// 925 (1961)". The venue's words (capitalised or not, usually abbreviated: "Phys. Rev. D", "Psychological review",
// "Lect. Notes Phys.") come right before "volume, page (year)", "pp. pages (year)" or a bare "ACRONYM (year)".
// Only when everything in front of them reads as an author list is the entry taken as title-less; anything
// else (a title before the venue) keeps the ordinary reading. The text is capped first, and the author part
// is the shortest one that works, so the scan stays short.
const BARE_JOURNAL_MAX_CHARS = 400;
const AUTHORS_THEN = String.raw`^(.{2,300}?,\s+)`;
// One bracketed place name may follow the journal's words: "Nature (London)", "Ann. Phys. (N.Y.)", "J. Phys. (Paris)".
const VENUE_WORDS_RE = String.raw`((?:[\p{L}&'’.:-]+\s+){1,12}?(?:\(\p{Lu}[\p{L}.]{1,12}(?:\s\p{Lu}[\p{L}.]{0,12})?\)\s+)?)`;
const YEAR_PAREN = String.raw`\s*\((?:19|20)\d{2}[a-z]?\)`;
// "DOI 10.1088/...", "ISSN 2157...", "eprint 2105.04278" may follow. The entry may end with a comma or a semicolon, as some
// PDFs print it ("Phys. Rev. D 89, 024003 (2014),").
// An erratum in brackets may follow too ("(2018), [Erratum: Rev.Mod.Phys. 94, 029901 (2022)]"): a note on the same work.
// Used only inside BARE_VENUES, on text of at most BARE_JOURNAL_MAX_CHARS with whitespace collapsed: on its own, over
// a long run of spaces, this pattern takes seconds.
const TAIL = String.raw`(?:[.,;]?\s*\[\s*(?:[Ee]rrat(?:um|a)|[Aa]ddend(?:um|a)|[Cc]orrigend(?:um|a))\b[^[\]\n]{0,150}\])?(?:[.,;]?\s+(?:DOI|doi|arXiv|ISSN|ISBN|eprint|https?:\/\/)[^\n]{0,150})?[.,;]?$`;
// Article numbers run to ten digits (PNAS "e2405839122").
const VOLUME_PAGE = String.raw`(\p{Lu}?\d{1,4}(?:\(\d{1,3}\))?(?:-[A-Za-z]+)?,\s*(?:no\.\s*\d+,\s*)?\p{L}{0,4}\d{1,12}(?:[–-]\d{1,6})?)`;
const PAGES_ONLY = String.raw`(pp?\.\s*\d{1,6}(?:[–-]\d{1,6})?)`;
// "Nucl. Phys. B537, 10.1016/S0550-3213(98)00668-3 (1999)": the article's DOI where the page goes. The DOI may hold
// brackets of its own; the year in brackets after it closes it.
const VOLUME_DOI = String.raw`(\p{Lu}?\d{1,4},\s*10\.\d{4,9}\/[^\s,]{1,80}?)`;
const BARE_VENUES: RegExp[] = [
  new RegExp(`${AUTHORS_THEN}${VENUE_WORDS_RE}${VOLUME_PAGE}${YEAR_PAREN}${TAIL}`, 'u'),
  new RegExp(`${AUTHORS_THEN}${VENUE_WORDS_RE}${PAGES_ONLY}${YEAR_PAREN}${TAIL}`, 'u'),
  new RegExp(`${AUTHORS_THEN}${VENUE_WORDS_RE}${VOLUME_DOI}${YEAR_PAREN}${TAIL}`, 'u'),
  // "EMNLP (2014)": capitals only, so a book title before a bracket ("Remembering (Cambridge, 1932)") is not taken.
  new RegExp(`${AUTHORS_THEN}((?:\\p{Lu}{3,10}\\s+){1,2}?)()${YEAR_PAREN}${TAIL}`, 'u'),
];

// A sentence that ends inside the words before the volume is a title, not part of a journal's name: its last two words,
// the last in lower case, then a full stop and a capital ("... internal regret. Journal of ...", "Generic quantum spin
// ice. Phys. Rev. B"). "Proc. natl. Acad." is an abbreviation (the word before it has a full stop). The sentence may open
// in lower case or with a symbol ("k-means clustering of ...", "de Sitter vacua ..."). A journal's name half spelled out
// with a lower-case abbreviation ("Zeitschrift für angew. Math. Mech.", "J. reine angew. Math.") reads the same way: it
// is taken as a title here, and the locator fallback takes it as the journal when the record's journal name accounts
// for it (journalLocator.ts, titleAsJournal).
const TITLE_SENTENCE = /(?:^|\s)[\p{L}'’-]+\s\p{Ll}[\p{L}'’-]{2,}\.\s+\p{Lu}/u;

// Nature style ends the names with the last author's initials: "Blum, A. & Mansour, Y. From external ...".
const SURNAME_THEN_COMMA = /\p{Lu}[\p{L}'’-]+,\s+$/u;
const LEADING_INITIALS = /^\p{Lu}\.(?:[\s-]?\p{Lu}\.){0,3}\s+/u;

/**
 * The title-less journal reading of an entry. With `ignoreTitleSentence`, a Nature-style title sentence does not stop it:
 * the reading the entry would have had if its title were part of the journal's name (natureStyleLocatorText).
 */
function layoutFromBareJournal(text: string, ignoreTitleSentence = false): Layout | undefined {
  if (text.length > BARE_JOURNAL_MAX_CHARS) return undefined;
  for (const pattern of BARE_VENUES) {
    const found = pattern.exec(text);
    if (found === null) continue;
    const [, authorPart = '', venueWords = '', locator = ''] = found;
    if (!looksLikeAuthors(trimEnd(authorPart, ', '))) continue;
    // "Surname, I. & Surname, I. Title. Journal ..." (Nature style): the initials after the last surname are that author's,
    // and a title sentence after them means the entry has a title. Only in this style, where the names are plain.
    if (LAST_FIRST_START.test(`${authorPart}${venueWords}`)) {
      const venueText = SURNAME_THEN_COMMA.test(authorPart) ? venueWords.replace(LEADING_INITIALS, '') : venueWords;
      if (!ignoreTitleSentence && TITLE_SENTENCE.test(venueText)) continue;
    }
    // "Gretton, A., Smola, A.: A kernel two-sample test. J. Mach. Learn. Res. 13(1), 723 (2012)": a colon after an
    // initial ends a Springer-style author list, and what follows it is a title, not the start of a journal's name.
    if (/(?:^|\s)\p{Lu}\.:\s/u.test(venueWords)) continue;
    // No author list is reported: with no title the author part is read from the raw text by the identifier
    // checks (src/core/authorZone.ts), as for any title-less reference, which also keeps given/family-swapped names working.
    return { authorText: undefined, title: undefined, venue: `${venueWords}${locator}`.trim().slice(0, MAX_VENUE_CHARS), structure: 'none' };
  }
  return undefined;
}

// "Authors, Title, Journal vol (year) page [eprint]": every part is cut by a comma (INSPIRE and BibTeX styles in
// physics). The authors are the leading comma-chunks that are "A. B. Surname" names (several may share one chunk
// with "and"; "et al." ends the list); the title runs up to the first chunk that carries a number (volume, year,
// page, eprint), which starts the venue. Anything else, in particular an entry whose first non-name chunk
// already has a number (no title), is left to the other readings.
const COMMA_STYLE_MAX_CHARS = 1500;
const COMMA_STYLE_MAX_CHUNKS = 80;
// Initials, then a surname that may have particles and further capitalised words ("de Quay", "Le Sage", "v. Borczyskowski")
// and a suffix ("Jr").
const INITIALS_NAME = /^(?:\p{Lu}\.[\s-]*){1,4}(?:(?:\p{Ll}{1,4}\.?|\p{Lu}[\p{L}'’-]+)\s+){0,3}\p{Lu}[\p{L}'’-]+(?:\s+(?:Jr|Sr|II|III|IV)\.?)?$/u;
const IN_BOOK = /^in\s+\p{Lu}/u;
// What follows a book's name: pages, a volume, editors, a publisher, or "(City, year)".
const BOOK_MARKER = /\b(?:pp?|vols?|eds?)\.|\b(?:edited by|Press|Publish(?:ing|ers?)|Springer|Wiley|Elsevier)\b|\([^()]*,\s*(?:19|20)\d{2}\)/;
// What a venue's name opens with ("in Proceedings of ...", "in Advances in ...", "in International Conference on ...",
// "in Annual Meeting of ...") or an acronym of three or more capitals ("in NeurIPS", "in ICML", "in CVPR"). A
// conference paper cited as "Title, in Venue, year" has no book marker. "International" and "Annual" count only when an
// event or journal word follows ("in the International Space Station" is a phrase of the title). An acronym counts only
// when the chunk is just the acronym (it may carry a suffix, "NAACL-HLT", "IJCAI-19", "IEEE/CVF"), with at most a year,
// Proceedings, Workshop or Conference after it, or when the acronym is followed by a venue word ("in IEEE Conference
// on ...", "in USENIX Security Symposium", "in NeurIPS Datasets and Benchmarks Track"). "in DNA repair pathways",
// "in IEEE 802.11 networks" and "in COVID-19 patients" have neither, so they are phrases of the title.
const VENUE_OPENER = String.raw`(?:the\s+)?(?:Proceedings|Proc\.|Advances|Conference|Workshop|Symposium|Findings)\b|(?:International|Annual)\s+(?:Conference|Workshop|Symposium|Congress|Meeting|Colloquium|Joint|Journal|Review)\b`;
const ACRONYM = String.raw`(?:the\s+)?(?=[\p{L}]{3,12}\b)(?:\p{Ll}*\p{Lu}){3,}\p{Ll}*(?:[-/][\p{L}\d]+)*`;
// The venue word must close the name: up to three capitalised words after the acronym, then the word, then "on"/"of",
// a bracket or the end of the chunk ("in IEEE Journal publishing models" is a phrase of the title).
const VENUE_WORD = String.raw`(?:Conference|Symposium|Workshops?|Transactions|Journal|Meeting|Proceedings)(?=\s+(?:on|of)\b|\s*(?:\(|$))`;
const VENUE_ACRONYM = String.raw`${ACRONYM}(?:\s+(?:\d{4}|Proceedings|Workshop|Conference))*\s*$|${ACRONYM}(?:\s+\p{Lu}[\p{L}-]*){0,3}?\s+${VENUE_WORD}|${ACRONYM}\b.*\bTrack\s*$`;
const IN_VENUE_NAME = new RegExp(String.raw`^in\s+(?:${VENUE_OPENER}|${VENUE_ACRONYM})`, 'u');
const OPEN_MONTH = new RegExp(`\\(\\s*${MONTH}\\s*$`, 'i');
// A number ends at a space, comma, bracket or full stop, but "802.11" and "3.5" are one number inside a phrase ("in IEEE 802.11 networks").
const STANDALONE_NUMBER = /(?:^|[\s([])\p{Lu}?\d{1,4}(?=$|[\s,;:)\]-]|\.(?!\d))|\d{4}/u;

// A chunk that is only a publisher ("Oxford U. Press", "Cambridge University Press", "Springer") ends a title, as a volume does.
// A publisher may be named in whole words after its name ("Springer New York", "Springer Science & Business Media", "John
// Wiley & Sons"): capitalised words and "&" or "and" only, so a title that opens with a publisher's name ("Springer and the
// rise of open access") is no publisher.
const PUBLISHER_CHUNK =
  /^(?:\p{Lu}[\p{L}'’&-]*\.?\s+){0,4}(?:(?:U\.|Univ\.|University)\s*(?:P\.\s*)?)?Press\.?$|^(?:Springer(?:-Verlag)?|(?:John\s+)?Wiley|Elsevier|McGraw-Hill|Prentice[ -]Hall|Addison[ -]Wesley|Academic Press|Birkh(?:ä|a)user|Dover|North[- ]Holland|World\s+Scientific|Chapman\s*(?:&|and)\s*Hall(?:\/CRC)?)(?:\s+(?:\p{Lu}[\p{L}'’-]*|&|and)){0,5}\.?$/u;

function isNameChunk(chunk: string): boolean {
  // "A, B, and C, Title": the last name of the list comes after "and".
  const parts = chunk.replace(/\s+et\s+al\.?$/i, '').replace(/^(?:and|&)\s+(?=\p{Lu})/u, '').split(/\s+(?:and|&)\s+/);
  return parts.every((part) => INITIALS_NAME.test(part.trim()));
}

// A word that makes a book's name that of a proceedings volume or a meeting: "in Gravitational Waves: Proceedings, of the
// 8th Edoardo Amaldi Conference, ...".
const PROCEEDINGS_WORD = /\b(?:Proceedings|Conference|Symposium|Workshop|Meeting|Congress|Colloquium)\b|\bProc\./;
// A journal's volume, page and year after it: the phrase is then part of the title ("Open access, in NASA Conference
// proceedings archives, Phys. Rev. D 12, 345 (2020)").
const JOURNAL_LOCATOR_AFTER = /\b\p{Lu}?\d{1,4}(?:\(\d{1,3}\))?,\s*\p{L}{0,4}\d{1,12}(?:\s*[–-]\s*\d{1,6})?\s*\(/u;

/**
 * Does the chunk open ", in <Book>" with something after it that reads like a book's pages, editors or publisher, does it
 * read as a venue itself, or does the name it opens hold a proceedings or meeting word before its first number, with no
 * journal's volume and page after it?
 */
function startsBook(chunks: string[], at: number): boolean {
  const chunk = chunks[at] ?? '';
  if (!IN_BOOK.test(chunk)) return false;
  const rest = chunks.slice(at).join(', ');
  if (IN_VENUE_NAME.test(chunk) || BOOK_MARKER.test(rest)) return true;
  let end = at;
  while (end < chunks.length && !STANDALONE_NUMBER.test(chunks[end] ?? '')) end++;
  return PROCEEDINGS_WORD.test(chunks.slice(at, end).join(', ')) && !JOURNAL_LOCATOR_AFTER.test(rest);
}

// SIAM: "S.-K. Au and J. L. Beck, Title, Probabilistic Eng. Mech., 16 (2001), pp. 263–277, https://doi.org/...". The
// journal has a chunk of its own, then comes "<volume> (<year>)" (or "(<year>)" alone), then pages, a link or the end.
const VOLUME_YEAR_CHUNK = /^(?:\d{1,4}\s)?\((?:19|20)\d{2}\)\.?$/;
const AFTER_VOLUME_YEAR = /^(?:pp?\.\s?\p{L}?\d|\p{L}?\d{1,12}(?:\s*[–-]\s*\p{L}?\d{1,12})?\.?$|https?:\/\/|doi\b)/iu;
// The words of a journal's name, whole or abbreviated ("Structural Safety", "Probabilistic Eng. Mech.", "SIAM/ASA J.
// Uncertain. Quant.", "J. Phys. A: Math. Theor."), with the words that join them: in English ("Stochastic Processes and
// their Applications"), French and German ("Journal de Mathématiques Pures et Appliquées", "Annales de l'Institut
// Fourier", "Journal für die Reine und Angewandte Mathematik"). A whole word may end in a colon ("ESAIM: Math. Model."),
// and an acronym may be dotted ("Proc. Natl. Acad. Sci. U.S.A.").
const JOURNAL_CHUNK_WORD = /^(?:\p{Lu}[\p{L}'’-]*[.:]?|\p{Lu}+\/\p{Lu}+|(?:\p{Lu}\.){2,4}|[dl]['’]\p{Lu}[\p{L}'’-]*\.?|of|and|&|in|on|for|the|their|its|de|des|du|la|le|et|für|der|die|und)$/u;
// Journals whose name opens in lower case: a closed list, so that a lower-case word at the end of a title is never read as one.
const LOWER_CASE_JOURNAL_OPENER = /^(?:npj|eLife|iScience|mBio|mSystems|mSphere|eNeuro|eClinicalMedicine|eBioMedicine|iMeta)$/;
const MAX_JOURNAL_CHUNK_WORDS = 8;
// REVTeX: "J. Z. Kim, O. Lesser, and D. Chowdhury, Title (2026), arXiv:2606.12520 [cond-mat.supr-con] .": the year in
// brackets closes the title's chunk and the arXiv identifier follows.
const TITLE_THEN_YEAR = /^(.*\S)\s+(\((?:19|20)\d{2}[a-z]?\))$/;
const ARXIV_CHUNK = /^arXiv:\s?\S/i;

/** Does a comma-separated chunk read as a journal's name, whole or abbreviated ("Structural Safety", "Ann. Stat.")? */
export function isJournalChunk(chunk: string): boolean {
  const words = chunk.split(' ');
  const [first = '', ...rest] = words;
  const opens = /^\p{Lu}/u.test(first) ? JOURNAL_CHUNK_WORD.test(first) : LOWER_CASE_JOURNAL_OPENER.test(first.replace(/\.$/, ''));
  return words.length <= MAX_JOURNAL_CHUNK_WORDS && opens && rest.every((w) => JOURNAL_CHUNK_WORD.test(w));
}

/**
 * The SIAM or REVTeX arXiv reading of a comma-style entry whose first chunk with a number is `j`: the title's chunks
 * and the venue, or undefined when the entry has neither shape. In SIAM style the chunk before the volume and year is
 * the journal's name; whether it really is a journal (and not the end of the title) is settled with the record in hand
 * (reread.ts, withVenueLead).
 */
function siamOrRevtexSplit(chunks: string[], k: number, j: number): { titleChunks: string[]; venue: string } | undefined {
  const at = chunks[j] ?? '';
  const next = chunks[j + 1];
  if (VOLUME_YEAR_CHUNK.test(at) && (next === undefined || AFTER_VOLUME_YEAR.test(next)) && j - 1 > k && isJournalChunk(chunks[j - 1] ?? '')) {
    return { titleChunks: chunks.slice(k, j - 1), venue: chunks.slice(j - 1).join(', ') };
  }
  const titled = TITLE_THEN_YEAR.exec(at);
  // "Title, Nature Physics (2024), arXiv:..." (an accepted paper with no volume yet): after the title's own chunks, a year
  // chunk that reads as a journal, or a status ("in press", "to appear"), is the venue; the other readings take the
  // title without it.
  const venueBeforeYear = titled?.[1] !== undefined && j > k && (isJournalChunk(titled[1]) || /^(?:in press|to appear|accepted|submitted|forthcoming)$/i.test(titled[1]));
  if (titled?.[1] !== undefined && next !== undefined && ARXIV_CHUNK.test(next) && !venueBeforeYear) {
    return { titleChunks: [...chunks.slice(k, j), titled[1]], venue: [titled[2] ?? '', ...chunks.slice(j + 1)].join(', ') };
  }
  return undefined;
}

function layoutFromCommaStyle(text: string): Layout | undefined {
  if (text.length > COMMA_STYLE_MAX_CHARS) return undefined;
  const chunks = text.split(/,\s+/);
  if (chunks.length < 3 || chunks.length > COMMA_STYLE_MAX_CHUNKS) return undefined;
  let k = 0;
  while (k < chunks.length) {
    const chunk = chunks[k] ?? '';
    if (/^et\s+al\.?$/i.test(chunk)) {
      k++;
      break;
    }
    if (!isNameChunk(chunk)) break;
    k++;
    if (/\s+et\s+al\.?$/i.test(chunk)) break;
  }
  if (k === 0 || k >= chunks.length) return undefined;
  let j = k;
  // A chunk that opens a bracket on a month ("Journal of Stuff (Oct.,") starts the venue even before its first number.
  // So does ", in <Book>" (a chapter).
  while (j < chunks.length && !STANDALONE_NUMBER.test(chunks[j] ?? '') && !OPEN_MONTH.test(chunks[j] ?? '') && !startsBook(chunks, j) && !PUBLISHER_CHUNK.test(chunks[j] ?? '')) j++;
  // "T. Nagamiya, in Solid State Physics, Vol. 20 (Elsevier, 1968) pp. 305–411": a chapter cited by its book alone has no
  // title. The book's name is where it appeared; read as the title it would be compared with the volume's own record.
  // As for a journal citation with no title, no author list is reported (the identifier checks read the raw text).
  if (j === k && startsBook(chunks, k)) return { authorText: undefined, title: undefined, venue: chunks.slice(k).join(', ').slice(0, MAX_VENUE_CHARS), structure: 'none' };
  const authorText = chunks.slice(0, k).join(', ');
  // A sentence break or a leading "and" means the entry is full-stop style ("A, B, and C. Title. In CVPR, 2014"):
  // the other readings handle that.
  const titleOf = (titleChunks: string[], minWords: number): string | undefined => {
    const title = cleanTitle(titleChunks.join(', '));
    if (title === undefined || title.split(/\s+/).length < minWords || /^(?:and|&)\b/i.test(titleChunks[0] ?? '') || /[\p{Ll}\d)]\.\s+\p{Lu}/u.test(title)) return undefined;
    return title;
  };
  const split = j < chunks.length ? siamOrRevtexSplit(chunks, k, j) : undefined;
  // The journal's chunk and "<volume> (<year>)", or " (<year>), arXiv:", mark where the title ends, so two words are
  // enough ("Deep learning, Nature, 521 (2015)").
  const splitTitle = split === undefined ? undefined : titleOf(split.titleChunks, 2);
  if (split !== undefined && splitTitle !== undefined) return { authorText, title: splitTitle, venue: split.venue.slice(0, MAX_VENUE_CHARS), structure: 'segments' };
  // No title chunk, or no venue after it: not this style.
  if (j === k || j >= chunks.length) return undefined;
  // Three words at least, or two when the venue or the publisher itself follows ("Batch normalization, in Proceedings of
  // ...", "Matrix Computations, Johns Hopkins University Press, ...").
  const title = titleOf(chunks.slice(k, j), IN_VENUE_NAME.test(chunks[j] ?? '') || PUBLISHER_CHUNK.test(chunks[j] ?? '') ? 2 : 3);
  if (title === undefined) return undefined;
  return { authorText, title, venue: chunks.slice(j).join(', ').slice(0, MAX_VENUE_CHARS), structure: 'segments' };
}

// "Authors (year) Title. Venue.": the year in brackets, with no full stop, ends the authors (arXiv's own rendering of
// a bibliography). Only when everything before the bracket reads as an author list, which may hold one name written in
// lower case: the bracketed year marks where the names end.
const AUTHORS_THEN_YEAR = /^(.{2,600}?)\s+\((?:19|20)\d{2}[a-z]?\)\s+(?=\S)/u;

function layoutFromAuthorsYear(text: string): Layout | undefined {
  if (text.length > PLAUSIBLE_LENGTH) return undefined;
  const found = AUTHORS_THEN_YEAR.exec(text);
  const authorText = found?.[1];
  if (found === null || authorText === undefined || !looksLikeNamesWithOneLowerCase(authorText)) return undefined;
  const segments = splitSegments(text.slice(found[0].length), { lastFirst: false, vancouver: false });
  const { title: titleText, after } = titleWithPart(segments, 0);
  const title = cleanTitle(titleText);
  if (title === undefined) return undefined;
  return { authorText, title, venue: venueFrom(after), structure: 'segments' };
}

// "Surname, I., Surname, I. and Surname, I., Title. J. Stat. Phys. 113, 389–410 (2003)." (mathematics journals): each
// name is a surname, a comma and initials, the list ends with a comma, and the entry ends with an abbreviated journal,
// volume, pages and the year in brackets, or with a publisher, its city and the year. The title is what lies between.
const SURNAME_INITIALS_MAX_CHARS = 1500;
const MAX_LISTED_NAMES = 30;
// One name ("Grosskinsky, S.", "Schütz, G.M.", "Chakrabarti, B. K", "Barkley Rosser, J. J.", "Ding, N"), with what joins it
// to the one before, followed by a comma or "and". Sticky, so the list is read name by name from the start.
const LISTED_NAME = /(?:,\s(?:and\s|&\s)?|\s(?:and|&)\s)?\p{Lu}[\p{L}'’-]+(?:\s\p{Lu}[\p{L}'’-]+)?,\s\p{Lu}\.?(?:[\s-]?\p{Lu}\.?){0,3}(?=,|\s(?:and|&)\s)/uy;
const NAME_THEN_INITIALS = /^\p{Lu}[\p{L}'’-]+(?:\s\p{Lu}[\p{L}'’-]+)?,\s\p{Lu}\.?(?:[\s-]?\p{Lu}\.?){0,3}(?=[\s,:;]|$)/u;
// Volume, pages or an article number ("Paper No.10"), and the year in brackets, at the end.
const JOURNAL_LOCATOR_END = /\s\d{1,4},\s*(?:(?:Paper|Art\.|Article)\s*(?:No\.?\s*)?)?\p{L}?\d{1,7}(?:\s*[–—-]\s*\p{L}?\d{1,7})?\s*\((?:19|20)\d{2}\)\.?$/u;
// The words of an abbreviated journal's name: "J.", "Stat.", "Probab.", "Physica", "A", "in", "Appl.".
const JOURNAL_ABBREVIATION = /^\p{Lu}\p{Ll}{0,7}\.$/u;
const JOURNAL_WORD = /^\p{Lu}\p{Ll}{0,11}$/u;
const JOURNAL_JOINER = /^(?:in|of|and|&|de|der|für)$/;
// A sequel, part or roman numeral ends a title, never starts a journal: "Part II", "I.", "III".
const NOT_A_JOURNAL_WORD = /^(?:Part|(?:I|II|III|IV|V|VI|VII|VIII|IX|X)\.?)$/;
// Words that end a sentence added to a title, never a journal's abbreviation: notices, sequels and the like ("Reply.",
// "A Review.", "New Results.", "Extended Version.").
const NOT_AN_ABBREVIATION = /^(?:Reply|Review|Survey|Abstract|Comment|Comments|Erratum|Errata|Addendum|Corrigendum|Correction|Note|Notes|Remarks|Results|Revisited|Overview|Summary|Version|Continued|Discussion|Rejoinder|Sequel|Preprint)\.$/;
// Abbreviations that never open a journal's name, only a part, a supplement or a note of the work ("Pt. Two.", "Suppl.
// Material.", "Corr."); "Suppl." may stand inside one ("Astrophys. J. Suppl. Ser."), so only the first word is checked.
const NEVER_OPENS_A_JOURNAL = /^(?:Pt|Pts|Suppl|Corr|Ext|Abstr|Gen|Vol|Vols|No|Nos|Sect|Ch|Chap|Ser|Ed|Eds|Repr|Transl|Add|Cont|Fig|Tab|App)\.$/;
// Journals whose name opens with a whole word: "Physica A", "Nonlinearity", "Theory Probab. Appl.", "Annals of ...".
export const JOURNAL_FIRST_WORD = /^(?:Physica|Nonlinearity|Bernoulli|Econometrica|Biometrika|Chaos|Entropy|Nature|Science|Theory|Journal|Annals|Advances|Communications|Proceedings|Transactions|Inventiones|Compositio|Acta|Physical|Nuclear|Electronic|Probability|Mathematika)$/;
// A publisher and its city: "Cambridge University Press, Cambridge (1987)", "5th ed. Cambridge ...", "Springer-Verlag, Berlin".
const PUBLISHER_AFTER_TITLE =
  /[.,]\s+(?:\d{1,2}(?:st|nd|rd|th)\s+ed(?:ition)?\.?\s+)?(?:(?:\p{Lu}[\p{L}'’&-]*\s+){0,3}(?:(?:University|Univ\.|U\.)\s+)?Press|Springer(?:-Verlag)?|De\s+Gruyter|Wiley|Elsevier|Birkh(?:ä|a)user|North[- ]Holland|World\s+Scientific|Dover|American\s+Mathematical\s+Society|Chapman\s*(?:&|and)\s*Hall|Clarendon|Pergamon|Addison[- ]Wesley|McGraw[- ]Hill|Prentice[- ]Hall)\b/u;
const YEAR_IN_BRACKETS_END = /\((?:19|20)\d{2}\)\.?$/;
// A book series and its number before the publisher: ". Grundlehren Math. Wiss. 320".
const SERIES_AND_NUMBER = /[.,]\s+(?:\p{Lu}[\p{L}]*\.?\s+){1,5}\d{1,4}$/u;

/**
 * Does a journal's name open here with a whole word ("Physica A", "Theory Probab. Appl.", "Annals of ...")? Only when
 * the name goes on at once with an abbreviation, a series letter, or "of"/"in".
 */
export function opensJournalName(word: string, next: string): boolean {
  const isAbbreviation = JOURNAL_ABBREVIATION.test(next) && !NOT_AN_ABBREVIATION.test(next);
  return JOURNAL_FIRST_WORD.test(word) && (isAbbreviation || /^\p{Lu}$/u.test(next) || /^(?:of|in)$/.test(next));
}

/** The journal's name at the end of `head` (the entry before its volume): where it starts, or -1 if no journal is there. */
function journalStart(head: string): number {
  const tokens = head.split(' ');
  const isAbbreviation = (t: string): boolean => JOURNAL_ABBREVIATION.test(t) && !NOT_AN_ABBREVIATION.test(t);
  let k = tokens.length;
  while (k > 0 && tokens.length - k < 8) {
    const t = tokens[k - 1] ?? '';
    if (NOT_A_JOURNAL_WORD.test(t) || !(isAbbreviation(t) || JOURNAL_WORD.test(t) || JOURNAL_JOINER.test(t))) break;
    k--;
  }
  // The journal opens with an abbreviation ("J. Stat. Phys.") or a known first word ("Physica A"), right after the full
  // stop that ends the title. Whole words before it are the end of the title ("... properties. A New Approach. Physica A"),
  // so an added sentence stays in the title. A comma ends the title only before an abbreviation, after a lower-case word
  // ("... at criticality, Stoch. Process. Appl."): a Title Case title is never cut at its own comma.
  for (let i = Math.max(k, 1); i < tokens.length; i++) {
    const before = tokens[i - 1] ?? '';
    const t = tokens[i] ?? '';
    if (NEVER_OPENS_A_JOURNAL.test(t)) continue;
    // A journal's first word counts only when its name goes on at once: "Theory Probab. Appl.", "Physica A", "Annals of"
    // ("Theory and Models." and "Entropy Bounds." are sentences added to the title).
    const firstWord = opensJournalName(t, tokens[i + 1] ?? '');
    const afterFullStop = before.endsWith('.') && (isAbbreviation(t) || firstWord);
    const afterComma = before.endsWith(',') && /^\p{Ll}/u.test(before) && isAbbreviation(t);
    if (!afterFullStop && !afterComma) continue;
    const journal = tokens.slice(i);
    // A journal's name here is abbreviated ("J. Stat. Phys.") or a word and a series letter ("Physica A").
    if (!journal.some(isAbbreviation) && !/^\p{Lu}$/u.test(journal.at(-1) ?? '')) return -1;
    return tokens.slice(0, i).join(' ').length + 1;
  }
  return -1;
}

function layoutFromSurnameInitials(text: string): Layout | undefined {
  if (text.length > SURNAME_INITIALS_MAX_CHARS) return undefined;
  let end = 0;
  for (let names = 0; names < MAX_LISTED_NAMES; names++) {
    LISTED_NAME.lastIndex = end;
    const found = LISTED_NAME.exec(text);
    if (found === null || (names === 0 && found[0].charAt(0) !== text.charAt(0))) break;
    end = LISTED_NAME.lastIndex;
  }
  if (end === 0 || !text.startsWith(', ', end)) return undefined;
  const authorText = text.slice(0, end);
  const body = text.slice(end + 2);
  // Another name after the list is a list this reading did not end ("Fischer, P., Brox, T.: U-net ...", Springer's style).
  if (NAME_THEN_INITIALS.test(body)) return undefined;
  let titleText: string | undefined;
  let venue: string | undefined;
  const locator = JOURNAL_LOCATOR_END.exec(body);
  if (locator !== null) {
    const at = journalStart(body.slice(0, locator.index));
    if (at < 0) return undefined;
    titleText = body.slice(0, at);
    venue = body.slice(at);
  } else if (YEAR_IN_BRACKETS_END.test(body)) {
    const publisher = PUBLISHER_AFTER_TITLE.exec(body);
    if (publisher === null) return undefined;
    titleText = body.slice(0, publisher.index).replace(SERIES_AND_NUMBER, '');
    venue = body.slice(publisher.index).replace(/^[.,]\s+/, '');
  }
  const title = titleText === undefined ? undefined : cleanTitle(titleText);
  if (title === undefined || title.split(/\s+/).length < 2) return undefined;
  return { authorText, title, venue: venue?.slice(0, MAX_VENUE_CHARS), structure: 'segments' };
}

const STRUCTURE_SCORE: Record<Layout['structure'], number> = { blocks: 0.2, quoted: 0.2, segments: 0.15, guess: 0.05, none: 0 };

function scoreConfidence(layout: Layout, authors: string[], year: number | undefined, hasId: boolean, length: number): number {
  let score = 0;
  if (layout.title !== undefined) {
    const words = layout.title.split(/\s+/).length;
    score += words >= 2 ? 0.35 : 0.25;
    score += STRUCTURE_SCORE[layout.structure];
  }
  if (authors.length >= 1) score += 0.2;
  if (authors.length >= 2) score += 0.05;
  if (year !== undefined) score += 0.1;
  if (hasId) score += 0.1;
  score = Math.min(1, score);
  // A one- or two-word "title" with no authors, year or identifier ("see above", "ibid.", "Editorial") is a
  // fragment, not a reference: too little to search for, and searching for it can only produce a false verdict.
  if (layout.title !== undefined && layout.title.split(/\s+/).length < 3 && authors.length === 0 && year === undefined && !hasId) score = Math.min(score, FRAGMENT_CONFIDENCE);
  return length > PLAUSIBLE_LENGTH ? Math.min(score, OVERLONG_CONFIDENCE) : Math.round(score * 100) / 100;
}

// "Dudzik, A., et al. (2020)" leaves a parenthesised year on the author text.
function cleanAuthorText(s: string): string {
  // AAAI style puts "and" after the last semicolon ("Belkin, M.; and Niyogi, P."), which
  // surnamesFrom would read as part of the next name.
  return trimEnd(withoutDottedGivenNames(s.replace(/\s*\(\s*(?:19|20)\d{2}[a-z]?\s*\)\.?$/, '').replace(/;\s*(?:and|&)\s+/gi, '; ')), ' .');
}

// Block lists come from the page, so how many are read is bounded like everything else.
function boundedBlocks(blocks: string[] | undefined): string[] {
  const out: string[] = [];
  let budget = MAX_INPUT_CHARS;
  for (const raw of (blocks ?? []).slice(0, MAX_SEGMENTS)) {
    const b = clean(raw.slice(0, budget));
    if (b === '') continue;
    out.push(b);
    budget -= b.length;
    if (budget <= 0) break;
  }
  return out;
}

// "Note: Data: Harvard Dataverse, https://doi.org/...", "Data available at ...", "Dataset: doi:...": what follows names
// the data behind the work, so a DOI there is the data's, not the reference's own (it would match the dataset's record).
// From the clause to the end of the entry: such a clause is the last thing in it.
const DATA_CLAUSE =
  /\b(?:(?:Data(?:\s*sets?)?|Datasets?|Data\s+(?:and|&)\s+code|Code\s+(?:and|&)\s+data)\s*:|(?:Data(?:\s*sets?)?|Datasets?|Data\s+(?:and|&)\s+code)\s+(?:(?:is|are)\s+)?(?:publicly\s+|freely\s+|openly\s+)?(?:available|deposited|archived|accessible)\s+(?:at|in|from|on|via)\b)[\s\S]*$/i;

/** The text up to a data clause after the title: the title's own words are no clause ("Big Data: ..."). */
function withoutDataClause(text: string, title: string | undefined): string {
  const at = title === undefined ? -1 : text.indexOf(title);
  const from = at < 0 || title === undefined ? 0 : at + title.length;
  const clause = DATA_CLAUSE.exec(text.slice(from));
  return clause === null ? text : text.slice(0, from + clause.index);
}

// arXiv's rendering ends an entry with "Cited by: §1, §2.2". It is a note about the paper, not about the reference.
const CITED_BY_TAIL = /\s*\bCited by:.*$/;

/**
 * Is this a Nature-style entry that reads as a journal citation with no title once its title sentence is taken for part
 * of the journal's name ("Lee, S., Onoda, S. & Balents, L. Generic quantum spin ice. Phys. Rev. B 86, 104412 (2012).")?
 * Such an entry is searched by its title; this says it may also be looked up by its journal locator, as it was before
 * the title was read.
 */
export function readsAsNatureStyleLocator(raw: string): boolean {
  const body = withoutLabel(clean(raw).replace(CITED_BY_TAIL, ''), '');
  if (!LAST_FIRST_START.test(body) || layoutFromQuotedTitle(body) !== undefined || layoutFromSurnameInitials(body) !== undefined) return false;
  return layoutFromBareJournal(body) === undefined && layoutFromBareJournal(body, true) !== undefined;
}

export function parseCitation(ref: RawReference): ParsedCitation {
  const blocks = boundedBlocks(ref.blocks).map((b) => b.replace(CITED_BY_TAIL, '')).filter((b) => b !== '');
  const structured = blocks.length >= 2;
  const text = withoutLabel(clean(ref.text).replace(CITED_BY_TAIL, ''), ref.label);
  const body = structured ? blocks.join(' ') : text !== '' ? text : (blocks[0] ?? '');
  const lead = structured ? (blocks[0] ?? '') : body;
  const lastFirst = LAST_FIRST_START.test(lead);
  const style: Style = { lastFirst, vancouver: VANCOUVER_START.test(lead) };

  const layout: Layout =
    layoutFromQuotedTitle(body) ??
    layoutFromSurnameInitials(body) ??
    layoutFromBareJournal(body) ??
    layoutFromAuthorsYear(body) ??
    layoutFromCommaStyle(body) ??
    layoutFromSegments(
      structured ? blocks.flatMap((b) => splitSegments(b, style)) : splitSegments(body, style),
      structured,
      lastFirst,
    );

  const withoutData = withoutDataClause(body, layout.title);
  const doi = findDoi(withoutData);
  const arxivRaw = findArxivId(body);
  const arxivId = arxivRaw === undefined ? undefined : stripArxivVersion(arxivRaw);
  const authors = layout.authorText === undefined ? [] : surnamesFrom(cleanAuthorText(layout.authorText)).slice(0, MAX_SURNAMES);
  const year = findYear(body, layout.title);
  // What is left once the title and author list are removed is venue, publisher and links.
  let rest = layout.title === undefined ? body : body.replace(layout.title, ' ');
  if (layout.authorText !== undefined) rest = rest.replace(layout.authorText, ' ');

  const citation: ParsedCitation = {
    raw: ref.text,
    authors,
    // A data clause's link and words are the data's, not the reference's.
    kind: classify(withoutDataClause(rest, undefined), doi, arxivId, withoutData),
    confidence: scoreConfidence(layout, authors, year, doi !== undefined || arxivId !== undefined, body.length),
  };
  if (doi !== undefined) citation.doi = doi;
  if (arxivId !== undefined) citation.arxivId = arxivId;
  if (layout.title !== undefined) citation.title = layout.title;
  if (year !== undefined) citation.year = year;
  if (layout.venue !== undefined) citation.venue = layout.venue;
  return citation;
}
