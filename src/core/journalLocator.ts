// Journal citations that carry no title ("C. Brans, R.H. Dicke, Phys. Rev. 124, 925 (1961)") are common in physics.
// There is nothing to search by, but the journal, volume, first page and year name one article. This module reads that
// locator from the text and decides whether a Crossref record is the article it names. It is deliberately strict:
// a match turns a "Can't check" into Verified (or Retracted, through the usual retraction lookup), or into Details differ
// when words in front of the journal's name are a title the record does not carry (journalNameLead). It never produces
// Not found or Wrong ID.
import { authorZone, recordAuthorsInZone, zoneNamesSomeone } from './authorZone';
import { withoutListLabel } from './labels';
import { foldGermanSpelling, normalizeTitle, surnameForms } from './normalize';
import { readsAsNatureStyleLocator } from './parseCitation';
import { citesSeveralWorks } from './severalWorks';
import type { ParsedCitation, WorkRecord } from './types';
import { knownYears, yearAgrees } from './years';

const MAX_TEXT_CHARS = 600;
const MAX_QUERY_CHARS = 300;
const MIN_YEAR = 1900;
const MAX_YEAR = 2030;
const MAX_BEFORE_WORDS = 40;

export interface JournalLocator {
  /** Everything in front of the volume: the authors, perhaps a title, and the journal at its end. */
  before: string;
  /** Digits only, without leading zeros ("081" is "81"). A series letter stuck to it ("D81") moves to `before`. */
  volume: string;
  /** First page or article number, lower case, without leading zeros when it is a plain number. */
  page: string;
  year: number;
}

// One alternative per way of writing the locator. All of them are anchored at the start, take the shortest text in
// front of the volume, and have no nested quantifiers, so a hostile text (capped above) costs little.
const TITLE_CASE_OR_MONTH = String.raw`(?:\p{L}{3,9}\.?,?\s+)?`;
const PAGE = String.raw`(?:pp?\.\s*)?(?<page>\p{L}{0,4}\d{1,12})(?:\s*[–—-]\s*\d{1,8})?`;
const NUMBER_AND_PART = String.raw`(?:no\.?\s*[\w-]{1,8}\s*,\s*)?`;
const VOLUME = String.raw`\s+(?<vol>\p{Lu}?\d{1,4})`;
const YEAR = String.raw`(?<year>(?:19|20)\d{2})[a-z]?`;
const LOCATORS: RegExp[] = [
  // "Phys. Rev. Lett. 98, 100401 (2007)", "Annalen Phys. 347(13), 533 (1913)", "Phys. Rev. D 101, no.10, 106023 (2020)"
  new RegExp(String.raw`^(?<pre>.{2,500}?)${VOLUME}(?:\s?\([\p{L}\d-]{1,8}\))?\s*,\s*${NUMBER_AND_PART}${PAGE}\s*\(\s*${TITLE_CASE_OR_MONTH}${YEAR}\s*\)`, 'u'),
  // "Nucl. Phys. B 474 (1996) 122", "Nanophotonics 8 (Nov., 2019) 1945–1973"
  new RegExp(String.raw`^(?<pre>.{2,500}?)${VOLUME}\s*\(\s*${TITLE_CASE_OR_MONTH}${YEAR}\s*\)\s*,?\s*${NUMBER_AND_PART}${PAGE}(?=$|[\s,.;\[(])`, 'u'),
  // "Expert Syst Appl. 2009;36(3):4626-36"
  new RegExp(String.raw`^(?<pre>.{2,500}?)\.?\s+${YEAR};\s*(?<vol>\d{1,4})(?:\([\w-]{1,8}\))?\s*:\s*(?<page>\p{L}{0,4}\d{1,12})`, 'u'),
  // "Rev. Mod. Phys., vol. 82, no. 2, pp. 277-306, 2010"
  new RegExp(String.raw`^(?<pre>.{2,500}?)\s+vol\.?\s*(?<vol>\d{1,4})\s*,\s*${NUMBER_AND_PART}${PAGE}\s*,?\s*\(?${TITLE_CASE_OR_MONTH}${YEAR}`, 'u'),
];
// What follows the reference proper in arXiv's rendering.
const TAIL_MARKER = /\s(?:Cited by:|External Links:)/;

function plainPage(page: string): string {
  const p = page.toLowerCase();
  return /^\d+$/.test(p) ? String(Number(p)) : p;
}

function plainVolume(volume: string): string {
  return String(Number(volume));
}

function textOf(c: ParsedCitation): string {
  const cut = withoutListLabel(c.raw.slice(0, MAX_TEXT_CHARS * 2).replace(/\s+/g, ' ').trim());
  const tail = TAIL_MARKER.exec(cut);
  return (tail === null ? cut : cut.slice(0, tail.index)).trim();
}

/**
 * The journal locator of a citation that has no title and no identifier, or undefined. Complete means a journal in front
 * of a volume, a first page or article number, and a year. A citation that has an identifier or a title is looked up
 * the ordinary way; so is nothing that is not a paper. An entry that cites several works has none.
 */
export function journalLocator(c: ParsedCitation): JournalLocator | undefined {
  if ((c.title !== undefined && normalizeTitle(c.title) !== '') || c.doi !== undefined || c.arxivId !== undefined) return undefined;
  if (c.kind !== 'paper' && c.kind !== 'unknown') return undefined;
  const text = textOf(c);
  // An entry that cites several works would be Verified on whichever one the locator reads.
  if (text.length > MAX_TEXT_CHARS || citesSeveralWorks(text)) return undefined;
  for (const pattern of LOCATORS) {
    const groups = pattern.exec(text)?.groups;
    if (groups === undefined) continue;
    const { pre = '', vol = '', page = '', year = '' } = groups;
    const yearNumber = Number(year);
    if (yearNumber < MIN_YEAR || yearNumber > MAX_YEAR || !/\p{L}{2,}/u.test(pre) || page === '') continue;
    const series = /^\p{Lu}/u.test(vol) ? vol.charAt(0) : '';
    const digits = vol.replace(/^\p{Lu}/u, '');
    if (digits === '') continue;
    return { before: series === '' ? pre : `${pre} ${series}`, volume: plainVolume(digits), page: plainPage(page), year: yearNumber };
  }
  return undefined;
}

/**
 * The title-less reading of a Nature-style entry with a complete journal locator, or undefined. Such an entry is searched
 * by its title first; when that ends in Not found or in the unreadable Can't check, the engine looks it up by this
 * reading, as it did before the title was read (only Verified or Retracted can come of it).
 */
export function natureStyleLocatorReading(c: ParsedCitation): ParsedCitation | undefined {
  if (!readsAsNatureStyleLocator(c.raw)) return undefined;
  return titledLocatorReading(c);
}

/**
 * The title-less reading of any titled reference with no identifier and a complete journal locator ("C. Petrovic, ...,
 * Heavy-fermion superconductivity in cecoin5 at 2.3 k, Journal of Physics: Condensed Matter 13, L337 (2001)."), or
 * undefined. The title stays in front of the journal, with the authors, where matchesLocator passes over it.
 */
export function titledLocatorReading(c: ParsedCitation): ParsedCitation | undefined {
  if (c.title === undefined || c.doi !== undefined || c.arxivId !== undefined) return undefined;
  const reading: ParsedCitation = { raw: c.raw, authors: [], kind: c.kind, confidence: c.confidence };
  if (c.year !== undefined) reading.year = c.year;
  return journalLocator(reading) === undefined ? undefined : reading;
}

// Links and DOIs, taken out before a locator is read past an identifier: in "version 2 (2022), 10.48505/nims.3739" the
// DOI's "10" is no page.
const LINK_OR_DOI = /\bhttps?:\/\/\S+|\b(?:doi:\s*)?10\.\d{4,9}\/\S+/gi;

/**
 * The title-less reading of a titled reference whose only identifier, a DOI, led to a record that is no paper (a
 * dataset, software): read, with its links and DOIs taken out, as one with no identifier (titledLocatorReading), or
 * undefined when it has no complete journal locator then.
 */
export function locatorReadingPastNonPaperDoi(c: ParsedCitation): ParsedCitation | undefined {
  if (c.title === undefined || c.arxivId !== undefined) return undefined;
  const plain: ParsedCitation = { ...c, raw: c.raw.replace(LINK_OR_DOI, ' ').replace(/\s+/g, ' ').trim() };
  delete plain.doi;
  return titledLocatorReading(plain);
}

/**
 * Does a titled reference give a complete journal locator (journal, volume, first page and year), its links and DOIs
 * taken out? A titled journal paper that nothing matched is then Not found even when its DOI leads to a dataset.
 */
export function hasFullJournalLocator(c: ParsedCitation): boolean {
  if (c.title === undefined) return false;
  const reading: ParsedCitation = { raw: c.raw.replace(LINK_OR_DOI, ' ').replace(/\s+/g, ' ').trim(), authors: [], kind: c.kind, confidence: c.confidence };
  if (c.year !== undefined) reading.year = c.year;
  return journalLocator(reading) !== undefined;
}

/** What is sent to Crossref: the reference as written (authors, journal, volume, pages, year), without arXiv's trailing notes. */
export function locatorQuery(c: ParsedCitation): string {
  return textOf(c).slice(0, MAX_QUERY_CHARS);
}

/** Cache key part: the same article cited under the same names. */
export function locatorKey(loc: JournalLocator): string {
  return `${journalWords(loc.before).slice(-4).join(' ')}|${loc.volume}|${loc.page}|${loc.year}`;
}

// ------------------------------------------------------------------ journal names

// Words that carry no part of a journal's name, in either its long or its abbreviated form. Single letters are not
// here: they are series ("Phys. Rev. A").
const STOP_WORDS = new Set(['of', 'the', 'and', 'for', 'in', 'on', 'der', 'des', 'de', 'la', 'le', 'et', 'with', 'to', 'und', 'an']);
const DOTTED_ABBREVIATION = /^\p{Lu}\p{Ll}{1,4}\.$/u;
// An initial may stand for one of these words and no other: "J. Math. Phys.", "Z. Phys.".
const INITIAL_WORDS = new Set(['j', 'z']);
// A bracketed place name at the end of the journal's name, as the parser reads it (parseCitation.ts).
const PLACE_AFTER_JOURNAL = /\s\(\p{Lu}[\p{L}.]{1,12}(?:\s\p{Lu}[\p{L}.]{0,12})?\)\s*$/u;

function journalWords(text: string): string[] {
  // Crossref sends some journal names with their ampersand still escaped ("Perception &amp; Psychophysics").
  const normal = normalizeTitle(text.replace(/&amp;/gi, ' & '));
  return normal === '' ? [] : normal.split(' ').filter((w) => !STOP_WORDS.has(w));
}

// Abbreviations that are the beginning of two different words in journal names. "J. Phys." is the Journal of Physics,
// not of Physiology; "Mat." is Materials, not Mathematics. The words an abbreviation must not be taken to stand for.
const NOT_EXPANDED_TO: Readonly<Record<string, readonly string[]>> = {
  phys: ['physiol', 'physician'],
  mat: ['math'],
  math: ['mater', 'matter'],
  chem: ['chemother'],
  med: ['mediev'],
};

/** "Rev" and "Review", "Rept" and "Reports", "J" and "Journal": one is the other cut short (letters kept in order). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.charAt(0) !== long.charAt(0)) return false;
  if (NOT_EXPANDED_TO[short]?.some((word) => long.startsWith(word)) === true) return false;
  if (short.length === 1) return INITIAL_WORDS.has(short);
  let next = 0;
  for (const ch of long) if (ch === short.charAt(next)) next++;
  return next === short.length;
}

// Places in a journal's full name that citations leave out: "Proceedings of the Royal Society of London" is "Proc. R. Soc.".
const PLACE_WORDS = new Set(['london', 'edinburgh', 'dublin']);

/**
 * The name as citations shorten it: without the place it is printed in, and without what follows its series letter
 * ("Proceedings of the Royal Society of London. A. Mathematical and Physical Sciences" is cited "Proc. R. Soc. A").
 */
function citedForms(words: string[]): string[][] {
  const unplaced = words.filter((w) => !PLACE_WORDS.has(w));
  const forms = [words, unplaced];
  for (const form of [words, unplaced]) {
    const series = form.findIndex((w, i) => i >= 2 && w.length === 1);
    if (series >= 0 && series < form.length - 1) forms.push(form.slice(0, series + 1));
  }
  return forms;
}

/**
 * The names a record gives its journal, as words: the abbreviated ones first (they are what a citation abbreviates
 * from), then the full ones, each also without and inside a bracket ("EPL (Europhysics Letters)"), and each as a citation
 * shortens it (citedForms).
 */
function journalNames(r: WorkRecord): string[][] {
  const all = r.venues ?? (r.venue === undefined ? [] : [r.venue]);
  const short = r.shortVenues ?? [];
  const names = new Set<string>();
  for (const venue of [...short, ...all.filter((v) => !short.includes(v))]) {
    names.add(venue);
    names.add(venue.replace(/\([^()]*\)/g, ' '));
    for (const inner of venue.matchAll(/\(([^()]{2,80})\)/g)) names.add(inner[1] ?? '');
  }
  const forms = new Map<string, string[]>();
  for (const name of names) for (const form of citedForms(journalWords(name))) forms.set(form.join(' '), form);
  return [...forms.values()].filter((words) => words.join('').length >= 4);
}

// A one-letter initial may stand for any word of the name that starts with it ("R." for "Royal" in "Mon. Not. R. Astron.
// Soc.") when at least this many other words of the name match: alone, a letter is a series ("Phys. Rev. A").
const MIN_WORDS_BESIDE_AN_INITIAL = 3;

/** Does the cited run of words abbreviate the name, word for word? */
function abbreviates(cited: string[], name: string[]): boolean {
  let matched = 0;
  let initials = 0;
  for (const [i, word] of cited.entries()) {
    const full = name[i] ?? '';
    if (sameWord(word, full)) matched++;
    else if (word.length === 1 && full.length > 1 && full.startsWith(word)) initials++;
    else return false;
  }
  return initials === 0 || matched >= MIN_WORDS_BESIDE_AN_INITIAL;
}

// "Astrophys. J. Lett. 528, L17": letters filed under the journal itself, whose page then carries the "L".
const LETTERS_TOKEN = /^Lett(?:ers)?\.?$/i;

/**
 * Does the text in front of the volume end with one of the record's journal names (abbreviated or in full)? Returns what
 * stands in front of that name (the authors, perhaps a title), or undefined when no name fits. Anchored at the end:
 * "Physical Review" does not fit "Phys. Rev. D". With `lettersPage` (the cited page is an "L" page the record carries), a
 * final "Lett." or "Letters" may stand after the record's name.
 */
function journalEndsText(before: string, r: WorkRecord, lettersPage = false): string | undefined {
  // "Nature (London)", "Ann. Phys. (N.Y.)": the place a journal was printed is not a word of its name.
  const tokens = before.replace(PLACE_AFTER_JOURNAL, '').split(/\s+/).filter((t) => t !== '');
  if (tokens.length > MAX_BEFORE_WORDS * 4) return undefined;
  const found = nameAtEnd(tokens, r);
  if (found !== undefined || !lettersPage || !LETTERS_TOKEN.test(tokens.at(-1) ?? '')) return found;
  return nameAtEnd(tokens.slice(0, -1), r);
}

function nameAtEnd(tokens: string[], r: WorkRecord): string | undefined {
  const flat: { word: string; token: number }[] = [];
  tokens.forEach((token, i) => {
    for (const word of journalWords(token)) flat.push({ word, token: i });
  });
  for (const name of journalNames(r)) {
    if (name.length > flat.length) continue;
    const tail = flat.slice(flat.length - name.length);
    if (!abbreviates(tail.map((cited) => cited.word), name)) continue;
    const start = tail[0]?.token ?? 0;
    // Whatever stands in front of the journal is authors and perhaps a title ("... liquid metal stream. Appl. Phys.
    // Lett."). A short dotted word right in front of it ("Phys.") is more likely the start of a longer journal name.
    if (DOTTED_ABBREVIATION.test(tokens[start - 1] ?? '')) continue;
    return tokens.slice(0, start).join(' ');
  }
  return undefined;
}

// ------------------------------------------------------------------ words in front of the journal's name

// Where the journal's name ends in a title-less reading's venue: at the volume and page ("Nucl. Phys. B537, 443", "Phys.
// Rev. D 82, 022003"), the volume and a DOI in the page's place, or a page range ("pp. 12–14"). A year is no volume
// ("Qwen2.5 technical report, 2025"). A series letter stuck to the volume ("B537") is the name's last word.
const VENUE_NAME_END = /\s(?:(\p{Lu})?\d{1,4}(?:\(\d{1,3}\))?(?:-[A-Za-z]+)?,\s*(?:no\.\s*\d+,\s*)?(?:\p{L}{0,4}\d|10\.\d{4,9}\/)|pp?\.\s*\d)/u;
// What opens an author list rather than a title: initials, "et al.", "and" ("Abbott, B. P. et al. Phys. Rev. Lett. ...",
// read with "B. P. et al." in front of the journal).
const NAME_LEAD = /^(?:(?:\p{Lu}\.(?:-?\p{Lu}\.)*|et|al\.|and|&)\s+)+/u;
// A word that may stand in a journal's name as citations write it: an abbreviation ("Phys.", "J."), a series letter, an
// acronym ("JHEP"), initials ("U.S.A."), a joining word, or a whole word journals' names are made of. Used only when no
// journal name of the record fits: with one that fits, every other word in front of it is the title's.
const JOURNAL_SHAPED = /^(?:\p{Lu}\p{Ll}{0,8}\.|\p{Lu}|[\p{Lu}\d]{2,8}|(?:\p{Lu}\.){2,4}|of|the|and|&|in|on|for|de|der|des|du|la|le|et|für|und|Physica|Nature|Science|Lancet|Journal|Physics|Physical|Review|Letters|Reports|Annals|Annalen|Nuclear|Acta|Proceedings|Transactions|Bulletin|Communications|Advances|Zeitschrift|Nuovo|Cimento)$/u;

// A publisher's acronym that may open a journal's name without being part of the record's ("ACS. Appl. Mater. Inter.").
const PUBLISHER_BEFORE_NAME = /(?:^|\s)(?:ACS|RSC)[.,:]?$/;
// Words that stand in a list of names without being anyone's surname.
const NAME_JOINERS = new Set(['and', '&', 'et', 'al']);
const INITIALS = /^\p{Lu}\.(?:-?\p{Lu}\.)*,?$/u;

/**
 * The text without the rest of an author list in front of it ("Y. Bengio and G. Hinton. Deep learning", where the
 * reading kept only "Y. LeCun," as the authors): initials, joining words and the record's surnames, up to the last of
 * them that a full stop or comma closes. A word that opens a title with an author's name ("Hopfield networks") is not
 * closed so, and stays.
 */
function withoutRecordNames(text: string, r: WorkRecord): string {
  const surnames = new Set(r.authors.flatMap((a) => surnameForms(normalizeTitle(a))));
  const tokens = text.split(' ');
  let cut = 0;
  for (const [i, token] of tokens.entries()) {
    const word = foldGermanSpelling(normalizeTitle(token));
    if (!INITIALS.test(token) && !NAME_JOINERS.has(word) && !surnames.has(word)) break;
    if (/[.,]$/.test(token)) cut = i + 1;
  }
  return tokens.slice(cut).join(' ');
}

// Words that make a piece of an author list a group's name ("LIGO Scientific Collaboration", "Planck Team").
const GROUP_WORDS = /\b(?:collaborations?|collaborators|consortium|group|team|project|network|investigators|members|et\s+al)\b/i;

/**
 * A title the reading took for the end of the author list, cut from it by a comma ("M. G. Alford, K. Rajagopal, and F.
 * Wilczek, DARK MATTER FROM LOCKED QUARKS, Nucl. Phys. B537, ..."): the pieces between the last name and the journal
 * that are no name. A name has an initial, a bracket, a group's word or a surname of the record, or is one word; the
 * first piece always opens the author list. Undefined when the journal follows a name.
 */
function titleAmongNames(raw: string, venue: string, r: WorkRecord): string | undefined {
  const text = raw.replace(/\s+/g, ' ').slice(0, MAX_TEXT_CHARS * 2);
  const at = text.indexOf(venue);
  if (at <= 0) return undefined;
  const pieces = text.slice(0, at).replace(/[\s,;]+$/, '').split(/,\s+/);
  const surnames = new Set(r.authors.flatMap((a) => surnameForms(normalizeTitle(a))));
  const isName = (piece: string): boolean => {
    const words = piece.split(' ').filter((w) => w !== '');
    if (words.length < 2 || /\p{Lu}\./u.test(piece) || /[()[\]]/.test(piece) || GROUP_WORDS.test(piece)) return true;
    return words.some((w) => surnames.has(foldGermanSpelling(normalizeTitle(w))));
  };
  let first = pieces.length;
  while (first > 1 && !isName(pieces[first - 1] ?? '')) first--;
  const title = pieces.slice(first).join(', ').trim();
  return title === '' ? undefined : title;
}

/**
 * The words of a title-less reading's journal name that are not shaped like a journal's, normalised ("dark matter from
 * locked quarks" in "Dark matter from locked quarks. Nucl. Phys. B537, 443"), or '' when there are none. The verdict on
 * such a reading rests on them (journalNameLead), so the result cache's key carries them.
 */
export function journalNameExtraWords(c: ParsedCitation): string {
  if ((c.title !== undefined && normalizeTitle(c.title) !== '') || c.venue === undefined) return '';
  const venue = c.venue.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
  const end = VENUE_NAME_END.exec(venue);
  if (end === null) return '';
  const tokens = venue.slice(0, end.index).replace(PLACE_AFTER_JOURNAL, '').split(' ');
  return normalizeTitle(tokens.filter((t) => t !== '' && !JOURNAL_SHAPED.test(t.replace(/[,:;]$/, ''))).join(' '));
}

/**
 * A title-less journal reading (no title, the venue "Dark matter from locked quarks. Nucl. Phys. B537, 443"): the words of
 * the venue in front of the journal's name that the record's journal name does not account for, word by word in its
 * full or abbreviated forms as journalEndsText reads them. Those words are a title the parser took into the journal's
 * name, and are compared as one: `{ title, venue }`. 'unaccounted' when no name of the record fits (the record has none,
 * or another journal's) and the venue holds more than words shaped like a journal's: they cannot be told from a title.
 * Undefined when there is nothing to move: a title, no venue or none with a volume, pages or DOI after the name, or a
 * venue that is the journal's name alone ("P. Astone et al., Phys. Rev. D 82, 022003 (2010)", "Nature (London) 227, 936").
 */
export function journalNameLead(c: ParsedCitation, r: WorkRecord): { title: string; venue: string } | 'unaccounted' | undefined {
  if ((c.title !== undefined && normalizeTitle(c.title) !== '') || c.venue === undefined) return undefined;
  const venue = c.venue.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
  // Only a journal's name before its volume, pages or DOI is read so: a venue with none is some other reading.
  const end = VENUE_NAME_END.exec(venue);
  if (end === null) return undefined;
  const series = end[1] ?? '';
  const name = `${venue.slice(0, end.index)}${series === '' ? '' : ` ${series}`}`;
  const front = journalEndsText(name, r, true);
  if (front === undefined) {
    const tokens = name.replace(PLACE_AFTER_JOURNAL, '').split(' ').filter((t) => t !== '');
    return tokens.every((t) => JOURNAL_SHAPED.test(t.replace(/[,:;]$/, ''))) ? undefined : 'unaccounted';
  }
  const lead = withoutRecordNames(`${front} `.replace(NAME_LEAD, '').trim(), r);
  // The record's journal name is found, so whatever else stands in front of it is the title, however it is written (in
  // capitals, one short word): only initials, joining words ("The" before "European Physical Journal B") and one
  // publisher's acronym right before the name ("ACS. Appl. Mater. Inter." against a record without it) are not.
  if (journalWords(lead.replace(PUBLISHER_BEFORE_NAME, '')).length === 0) {
    const title = titleAmongNames(c.raw, venue, r);
    return title === undefined ? undefined : { title, venue };
  }
  const title = lead.replace(/[\s.,;:]+$/, '');
  const at = venue.indexOf(lead);
  return { title, venue: at < 0 ? venue : venue.slice(at + lead.length).replace(/^[\s.,;:]+/, '') };
}

// ------------------------------------------------------------------ matching a record

function namesSomeone(c: ParsedCitation, authorText: string): ParsedCitation | undefined {
  const pseudo: ParsedCitation = { raw: authorText, authors: [], kind: c.kind, confidence: c.confidence };
  return zoneNamesSomeone(pseudo) && authorZone(pseudo) !== '' ? pseudo : undefined;
}

function authorsAgree(c: ParsedCitation, authorText: string, r: WorkRecord): boolean {
  const pseudo = namesSomeone(c, authorText);
  // Nothing in front of the journal that names a person: there are no authors to compare.
  if (pseudo === undefined) return true;
  return r.authors.length > 0 && recordAuthorsInZone(pseudo, r) >= 1;
}

/** Does the reference name a person in front of the journal (so that an author of the record could back it up)? */
export function locatorNamesAuthors(c: ParsedCitation, loc: JournalLocator, r: WorkRecord): boolean {
  const authorText = journalEndsText(loc.before, r, isLettersPage(loc));
  return authorText !== undefined && namesSomeone(c, authorText) !== undefined;
}

/** Does this record carry the locator's volume, first page or article number, and year (whatever its journal)? */
export function carriesLocatorNumbers(c: ParsedCitation, loc: JournalLocator, r: WorkRecord): boolean {
  if (r.volume === undefined || !/^\d{1,4}$/.test(r.volume) || plainVolume(r.volume) !== loc.volume) return false;
  if (!(r.pages ?? []).some((p) => plainPage(p) === loc.page)) return false;
  const dated = { ...c, year: loc.year };
  return knownYears(r).length > 0 && yearAgrees(dated, r);
}

/** Does this record carry every part of the locator: volume, first page or article number, year, journal and, when named, an author? */
export function matchesLocator(c: ParsedCitation, loc: JournalLocator, r: WorkRecord): boolean {
  if (!carriesLocatorNumbers(c, loc, r)) return false;
  const authorText = journalEndsText(loc.before, r, isLettersPage(loc));
  return authorText !== undefined && authorsAgree(c, authorText, r);
}

// ------------------------------------------------------------------ a "title" that is the journal's name

const INITIAL_TOKEN = /^\p{Lu}\.$/u;
const TOKEN_EDGE = /^[^\p{L}\d]+|[^\p{L}\d]+$/gu;

/** Do the cited words stand, in order and each as the whole word or its abbreviation, inside the name, from its first word? */
function accountedFor(cited: string[], name: string[]): boolean {
  if (cited.length === 0 || !sameWord(cited[0] ?? '', name[0] ?? '')) return false;
  let at = 1;
  for (const word of cited.slice(1)) {
    while (at < name.length && !sameWord(word, name[at] ?? '')) at++;
    if (at === name.length) return false;
    at++;
  }
  return true;
}

function bareToken(t: string): string {
  return t.replace(TOKEN_EDGE, '').toLowerCase();
}

/** Where the "title" starts among the tokens in front of the volume, or -1. */
function titleAt(tokens: string[], title: string): number {
  const wanted = title.split(/\s+/).map(bareToken).filter((t) => t !== '');
  if (wanted.length === 0) return -1;
  return tokens.findIndex((_t, i) => wanted.every((w, k) => bareToken(tokens[i + k] ?? '') === w));
}

function tokensBefore(loc: JournalLocator): string[] {
  return loc.before.replace(PLACE_AFTER_JOURNAL, '').split(/\s+/).filter((t) => t !== '');
}

/**
 * Nature style whose "title" is the start of the journal's name, half spelled out ("Prandtl, L. Zeitschrift für angew.
 * Math. Mech. 5, 136 (1925)", read with the title "Zeitschrift für angew"): the author text in front of that "title" when
 * one of the record's journal names accounts for every word from the "title" to the volume, in order and as
 * abbreviations ("anorg." for "anorganische"; a journal word left out, "und allgemeine", is allowed). An initial right in
 * front of the "title" may open the name ("J. reine angew. Math."). Undefined when no name accounts for it: a title that
 * is a title ("Generic quantum spin ice" before "Phys. Rev. B") never is.
 */
function authorsBeforeTitleAsJournal(loc: JournalLocator, title: string, r: WorkRecord): string | undefined {
  const tokens = tokensBefore(loc);
  if (tokens.length > MAX_BEFORE_WORDS * 4) return undefined;
  const at = titleAt(tokens, title);
  if (at <= 0) return undefined;
  const names = journalNames(r);
  const starts = INITIAL_TOKEN.test(tokens[at - 1] ?? '') && at > 1 ? [at, at - 1] : [at];
  for (const start of starts) {
    const cited = journalWords(tokens.slice(start).join(' '));
    if (cited.length >= 2 && names.some((name) => accountedFor(cited, name))) return tokens.slice(0, start).join(' ');
  }
  return undefined;
}

/**
 * Is the cited "title" of a Nature-style entry the start of this record's journal name (authorsBeforeTitleAsJournal),
 * with the volume, page and year the record carries? With `authors`, a person must be named in front of it, and the
 * record must list one of them: then the record may be Verified as for a title-less journal citation.
 */
export function titleIsJournal(c: ParsedCitation, loc: JournalLocator, title: string, r: WorkRecord, authors: boolean): boolean {
  if (!carriesLocatorNumbers(c, loc, r)) return false;
  const authorText = authorsBeforeTitleAsJournal(loc, title, r);
  if (authorText === undefined) return false;
  if (!authors) return true;
  return namesSomeone(c, authorText) !== undefined && authorsAgree(c, authorText, r);
}

// Particles a journal's name keeps in lower case, in the languages its old names are in.
const NAME_PARTICLES = new Set(['of', 'for', 'the', 'and', 'in', 'on', 'für', 'fur', 'der', 'des', 'die', 'und', 'zur', 'de', 'del', 'della', 'di', 'du', 'la', 'le', 'et', 'van', 'von', 'voor']);
// The nouns old journal names open with. A short title in sentence case ("Quantum spin ice", "Primordial black holes")
// is shaped much like a journal's name cut at an abbreviation, and an invented one on an invented locator must stay Not
// found; what tells "Zeitschrift für anorg" from it is this first word. Kept short and closed on purpose: it only keeps an
// entry from Not found, and every word added widens that.
const JOURNAL_HEAD_NOUNS = new Set(['zeitschrift', 'journal', 'annals', 'annalen', 'archiv', 'archive', 'archives', 'berichte', 'bulletin', 'comptes', 'proceedings', 'transactions', 'rendiconti', 'acta', 'memoires', 'memoirs', 'monatshefte', 'nachrichten', 'abhandlungen', 'sitzungsberichte', 'izvestiya']);
// An initial that stands for a journal's first word ("J." for Journal, "Z." for Zeitschrift: "J. reine angew. Math.").
const JOURNAL_INITIAL = /^[JZ]\.$/;

/**
 * Could this Nature-style "title" be the start of a journal's name, cut at a lower-case abbreviation ("Zeitschrift für
 * anorg", "Archive for rational mech", "reine angew" after "J.")? It opens with a journal's head noun, or with a lower-case
 * word right after a journal's initial that follows the author's own initial ("Weil, A. J. reine angew."); and it is two
 * to five words, the last a short lower-case word, with at most one other lower-case word that is not a particle. Used
 * only to keep such an entry from Not found when no record holds its locator; it never makes anything Verified.
 */
export function mayBeJournalStart(loc: JournalLocator, title: string): boolean {
  const words = title.trim().split(/\s+/);
  const last = words.at(-1) ?? '';
  if (words.length < 2 || words.length > 5 || !/^\p{Ll}{2,5}$/u.test(last)) return false;
  const lower = words.slice(0, -1).filter((w) => /^\p{Ll}/u.test(w) && !NAME_PARTICLES.has(w));
  if (lower.length > 1) return false;
  const first = words[0] ?? '';
  if (JOURNAL_HEAD_NOUNS.has(normalizeTitle(first))) return true;
  const tokens = tokensBefore(loc);
  const at = titleAt(tokens, title);
  return /^\p{Ll}/u.test(first) && at >= 2 && JOURNAL_INITIAL.test(tokens[at - 1] ?? '') && INITIAL_TOKEN.test(tokens[at - 2] ?? '');
}

/** The cited first page is a letters journal's ("L17"); matchesLocator has already found it on the record. */
function isLettersPage(loc: JournalLocator): boolean {
  return /^l\d/.test(loc.page);
}

/** The one record that matches the locator, or undefined when none does or when two do (then it is not clear which is meant). */
export function locatorMatch(c: ParsedCitation, loc: JournalLocator, records: WorkRecord[]): WorkRecord | undefined {
  const found = records.filter((r) => matchesLocator(c, loc, r));
  const [only] = found;
  return found.length === 1 ? only : undefined;
}
