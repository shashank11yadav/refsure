// One numbered entry can cite more than one work: "E. Goetz et al., in Gravitational Waves: Proceedings ..., 2009;
// E. Goetz and R. L. Savage Jr., Classical Quantum Gravity 27, 084024 (2010)." RefSure checks one work at a time, and
// the parts of such an entry mix: the first work's "title" meets the second work's journal and volume, and a real
// entry can end in Not found. So such an entry is Can't check, and never Verified on one of its works alone.
//
// An erratum, an addendum, a corrigendum, a reprint or a translation cited beside the work is the same work, not a second;
// so is a bracketed part that holds only a journal locator (the same article printed again, "[Int. J. Theor. Phys. 38,
// 1113 (1999)]"). An erratum is often given in a "Note: ..." field.

import { NOTE_FIELD } from './noteField';

// Longer than any real entry that holds a few works; the scans below are linear, the cap only bounds the cost.
const MAX_CHARS = 4000;
const MAX_CLAUSES = 40;

// Words that make a part a note on the same work, and an erratum's page "019901(E)".
const NOTE_WORDS = String.raw`errat(?:um|a)|addend(?:um|a)|corrigend(?:um|a)|err\.|reprint(?:ed)?|republished|translat(?:ed|ion)|english\s+version`;
const NOTE_WORD = new RegExp(String.raw`\b(?:${NOTE_WORDS})`, 'i');
const SAME_WORK_NOTE = new RegExp(String.raw`\b(?:${NOTE_WORDS})|\(E\)`, 'i');
// The text after a locator, up to the next one or ";", that is only such a note: " [erratum].", " (Erratum).", ", Erratum.",
// " (E).", " (Erratum to Phys. Rev. D 82, 104001).".
const ONLY_A_NOTE = new RegExp(String.raw`^[\s,.]*(?:\[~+\]|\(E\)|\(\s*(?:${NOTE_WORDS})[^()]{0,200}\)|(?:${NOTE_WORDS})\s*)[\s,.]*$`, 'i');
// A clause that opens with a note: "Erratum: ...", "Erratum-ibid. 96, 019901 (2006)", "[erratum]".
const OPENS_WITH_NOTE = new RegExp(String.raw`^\s*(?:\[~+\]|\(?\s*(?:${NOTE_WORDS}))`, 'i');
// A bracketed part, not nested: "[erratum: Commun. Math. Phys. 46, 206 (1976)]", "[Sov. Phys. JETP 16, 433 (1963)]".
const BRACKETED = /\[[^[\]]{0,300}\]/g;
// A journal's name and nothing else: capitalised or dotted words, a bracketed place ("Ann. Phys. (Berlin)"), a series
// letter. No lower-case title words and no "and" between names.
const JOURNAL_NAME_ONLY = /^(?:(?:\p{Lu}[\p{L}.'’-]*|\(\p{Lu}[\p{L}.]{0,12}(?:\s\p{Lu}[\p{L}.]{0,12})?\)|of|der|für|de|&)[\s,]+){1,10}$/u;

// A journal locator: "27, 084024 (2010)", "D 89, 024003 (2014)", "Nucl. Phys. B 72 (1974) 461". The year is captured.
const LOCATOR =
  /(?<![\d.])\p{Lu}?\d{1,4}(?:\s?\([\p{L}\d-]{1,8}\))?,\s*(?:pp?\.\s*)?\p{L}{0,4}\d{1,12}(?:\(E\))?(?:\s*[–—-]\s*\d{1,8})?\s*\(\s*(?:\p{L}{3,9}\.?,?\s+)?((?:19|20)\d{2})[a-z]?\s*\)|(?<![\d.])\p{Lu}?\d{1,4}\s*\(\s*((?:19|20)\d{2})[a-z]?\s*\)\s*,?\s*\p{L}{0,4}\d{1,12}(?![\d.])/gu;

// One person named with initials first ("E. Goetz", "R. L. Savage Jr.", "C.-J. Haster", "C. Van Den Broeck").
const PERSON = String.raw`\p{Lu}\.(?:\s?-?\p{Lu}\.){0,3}\s?(?:(?:\p{Ll}{1,4}|\p{Lu}[\p{L}'’-]+)\s){0,2}\p{Lu}[\p{L}'’-]+(?:\s(?:Jr|Sr)\.?|\s(?:II|III|IV))?`;
// A clause that opens with a list of such names and goes on after a comma: another work's authors.
const OPENS_WITH_NAMES = new RegExp(String.raw`^(?:and\s+)?${PERSON}(?:(?:,\s(?:and\s)?|\s(?:and|&)\s)${PERSON}){0,30}(?:,?\s+et\s+al\.?)?,\s+\S`, 'u');
const YEAR = /(?<!\d)(?:19|20)\d{2}(?!\d)/;

// A person named in a bracket, which then cites another work: initials first and a comma or "and" after the name
// ("[A. Smith, ...]", "[A. Smith and B. Jones ...]"), or a surname and a comma first ("[Smith, Phys. Rev. Lett. ...]").
const NAME_IN_BRACKET = new RegExp(String.raw`(?:^|[\s:(])${PERSON}(?=,|\s(?:and|&)\s|\s+et\s+al\b)|^\p{Lu}\p{Ll}[\p{L}'’-]*,\s|\s(?:and|&)\s`, 'u');
// The names that open an entry, initials first ("J. Doe, A. Roe, ..."): the first work's own authors.
const LEADING_NAMES = new RegExp(String.raw`^(?:and\s+)?${PERSON}(?:(?:,\s(?:and\s)?|\s(?:and|&)\s)${PERSON}){0,30}(?:,?\s+et\s+al\.?)?`, 'u');
// Where another work's authors may begin: after ";", ",", ". " or " and ".
const SEPARATOR = /[;,.]\s*|\s(?=and\s)/g;
// A volume and page with no year after them ("Phys. Rev. D 82, 104001,"): a work whose year is left out.
const LOCATOR_WITHOUT_YEAR = /(?<![\d.])\p{Lu}?\d{1,4},\s*\p{L}{0,4}\d{1,12}(?![\d.]|\s*\()/u;
// What may follow the first work's locator and still be its own: its DOI, its arXiv id, a bracketed eprint.
const OWN_IDENTIFIERS = /^(?:[\s,.]*(?:\[\s*)?(?:doi:?\s*|DOI\s+|https?:\/\/(?:dx\.)?doi\.org\/|arXiv:\s*|eprint\s+)[^\s,;[\]]+(?:\s*\[[^[\]]{0,20}\])?\]?)*/i;
// An identifier, and a year in brackets after it: "arXiv:1001.00001 (2010)", "doi:10.1103/PhysRevD.82.1".
const IDENTIFIER_THEN_YEAR = /(?:doi:?\s*|DOI\s+|https?:\/\/(?:dx\.)?doi\.org\/|arXiv:\s*)[^\s,;[\]]+(?:\s*\(\s*(?:19|20)\d{2}[a-z]?\s*\))?/i;
const MAX_SEPARATORS = 200;

/**
 * A bracketed part that holds only a journal locator, "[Int. J. Theor. Phys. 38, 1113 (1999)]", "[Sov. Phys. JETP 20,
 * 1018 (1965)]": the same work printed again (a republication, a translation, a reprint). No names, no title.
 */
function onlyJournalLocator(part: string): boolean {
  const inner = part.slice(1, -1).trim().replace(/[.,;]+$/, '');
  const locators = [...inner.matchAll(LOCATOR)];
  const first = locators[0];
  if (locators.length !== 1 || first === undefined) return false;
  if (inner.slice(first.index + first[0].length).trim() !== '') return false;
  const before = `${inner.slice(0, first.index).trim()} `;
  return !OPENS_WITH_NAMES.test(inner) && JOURNAL_NAME_ONLY.test(before);
}

/**
 * The text with the notes on the same work taken out, each the same length so that places in it are places in the
 * text: a "Note: ..." field, a bracketed erratum or reprint with its own locator, a bracketed republication. A bracket
 * that holds only a note word ("[erratum]") becomes "[~~~~~~~]", which marks the locator just before it. A note marks
 * only itself: a bracket that names a person is another work, and what stands outside a note is never taken out.
 */
function notesMasked(text: string): string {
  const blank = (part: string): string => ' '.repeat(part.length);
  return text.replace(NOTE_FIELD, blank).replace(BRACKETED, (part) => {
    if (NAME_IN_BRACKET.test(part.slice(1, -1).trim())) return part;
    if (onlyJournalLocator(part)) return blank(part);
    if (!SAME_WORK_NOTE.test(part)) return part;
    return /\d/.test(part) ? blank(part) : `[${'~'.repeat(part.length - 2)}]`;
  });
}

/**
 * Another work's author list after a semicolon: the clause before it ends a work (it holds a year), and the clause opens
 * with names written initials first and goes on with a venue that has a number. A semicolon between names ("Belkin, M.;
 * and Niyogi, P. 2003.") has no year before it, and "2009;36(3):4626" has no names after it. A clause that opens with a
 * note ("Erratum: ...") is the same work's.
 */
function secondAuthorList(text: string): boolean {
  const clauses = text.split(/;\s*/).slice(0, MAX_CLAUSES);
  let workEnded = false;
  for (const clause of clauses) {
    if (OPENS_WITH_NOTE.test(clause)) continue;
    if (workEnded && OPENS_WITH_NAMES.test(clause) && /\d/.test(clause)) return true;
    if (YEAR.test(clause)) workEnded = true;
  }
  return false;
}

/** The journal locators of the text that are not notes on the same work, in order. */
function ownLocators(text: string): RegExpExecArray[] {
  const found = [...text.matchAll(LOCATOR)];
  const own: RegExpExecArray[] = [];
  let previousEnd = 0;
  for (const [i, m] of found.entries()) {
    // A note stands before the locator in its own clause ("Erratum: ...", "; Erratum-ibid. 96, ..."), never before the
    // entry's first locator (a title may say "translation"); or in it ("019901(E)"); or after it, alone ("(1967) [erratum]",
    // "(2011) (E)"). An "(E)" before a locator is the previous locator's.
    const before = i === 0 ? '' : (text.slice(previousEnd, m.index).split(';').pop() ?? '');
    previousEnd = m.index + m[0].length;
    const next = found[i + 1]?.index ?? text.length;
    const after = text.slice(previousEnd, next).split(';')[0] ?? '';
    if (NOTE_WORD.test(before) || /\(E\)/.test(m[0]) || ONLY_A_NOTE.test(after)) continue;
    own.push(m);
  }
  return own;
}

/** Two journal locators with different years, neither of them a note on the same work. */
function locatorsOfSeveralYears(text: string): boolean {
  const years = new Set<string>();
  for (const m of ownLocators(text)) {
    const year = m[1] ?? m[2];
    if (year !== undefined) years.add(year);
    if (years.size > 1) return true;
  }
  return false;
}

function normalized(raw: string): string {
  return raw.slice(0, MAX_CHARS).replace(/\s+/g, ' ').trim();
}

/** Does this entry cite more than one work (and not just the same work with an erratum, a reprint or a translation)? */
export function citesSeveralWorks(raw: string): boolean {
  const text = notesMasked(normalized(raw));
  return secondAuthorList(text) || locatorsOfSeveralYears(text);
}

/** Does another work's author list open after a separator in text[0, end), past the entry's own leading names? */
function namesWithin(text: string, end: number): boolean {
  const lead = LEADING_NAMES.exec(text)?.[0].length ?? 0;
  let seen = 0;
  for (const m of text.slice(0, end).matchAll(SEPARATOR)) {
    if (++seen > MAX_SEPARATORS) return true;
    const at = m.index + m[0].length;
    if (at > lead && at < end && OPENS_WITH_NAMES.test(text.slice(at, at + 400))) return true;
  }
  return false;
}

/**
 * The text of the first work of an entry that cites several: everything up to the end of its journal locator, or of its
 * identifier with its year ("arXiv:1001.00001 (2010)"), and the identifiers that follow ("J. Doe, Title, Phys. Rev. D 82,
 * 1 (2010), doi:...", then "; A. Einstein, ...", ", Phys. Rev. D 83, 2 (2011)" or ". B. Roe, ..."), whatever separates it
 * from the next work. The same boundaries as citesSeveralWorks: another author list or another locator. Undefined when
 * the cut is not clear: when the part has no year, when another author list or a volume and page with no year come
 * before its end (the first work's year is left out, so the first year is the second work's), or when the part still
 * reads as several works.
 */
export function firstWorkText(raw: string): string | undefined {
  const text = normalized(raw);
  const masked = notesMasked(text);
  const lead = LEADING_NAMES.exec(masked)?.[0].length ?? 0;
  const locator = ownLocators(masked)[0];
  const id = IDENTIFIER_THEN_YEAR.exec(masked);
  // The first work ends with the first of them that makes a complete part ("doi:..., Phys. Rev. D 82, 1 (2010)": the DOI
  // alone has no year, the locator after it does).
  const anchors = [locator, id ?? undefined].filter((m) => m !== undefined).sort((x, y) => x.index - y.index);
  for (const anchor of anchors) {
    if (LOCATOR_WITHOUT_YEAR.test(masked.slice(lead, anchor.index))) return undefined;
    const anchorEnd = anchor.index + anchor[0].length;
    const end = anchorEnd + (OWN_IDENTIFIERS.exec(masked.slice(anchorEnd))?.[0].length ?? 0);
    if (namesWithin(masked, end)) return undefined;
    const first = text.slice(0, end).replace(/[\s,;.]+$/, '');
    if (YEAR.test(first)) return citesSeveralWorks(first) ? undefined : first;
  }
  return undefined;
}
