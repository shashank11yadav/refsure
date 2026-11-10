// Where a reference names its authors. A record's surnames are looked for there and nowhere else: the words of
// a title or a venue ("Long short-term memory", "Journal of Field Robotics", "Li-ion") name no one, and counting
// them would let a made-up identifier pass as the right one.
import { withoutLeadingLabel, withoutListLabel } from './labels';
import { foldGermanSpelling, joinLineEndHyphens, normalizeTitle, surnameForms } from './normalize';
import type { ParsedCitation, WorkRecord } from './types';

// Real entries are far shorter; the cap keeps the scan cheap on hostile text.
const MAX_ZONE_SOURCE_CHARS = 20_000;
// The author part of a reference ends, at the latest, at the first digit (a year, volume, page or identifier),
// link, identifier prefix, or venue word that is never a name.
const ZONE_END =
  /\d|https?:\/\/|\bwww\.|\b(?:doi|DOI|arXiv|arxiv)\s*:|\b(?:Proc|Proceedings|Journal|Transactions|Trans|ArXiv|arXiv|CoRR|Nature|Science|Phys|Physical|Rev|Lett|PNAS|IEEE|ACM|Advances|Conference|Workshop|Symposium|Preprint|preprint|Retrieved|Accessed|Available|URL)\b/;
// Lower-case words that belong in a list of names.
const NAME_WORDS = new Set(['and', 'et', 'al', 'van', 'von', 'de', 'der', 'den', 'del', 'della', 'di', 'da', 'du', 'la', 'le', 'ter', 'ten', 'dos', 'das', 'do', 'bin', 'ibn', 'el', 'y', 'e']);
const MIN_LOWER_TITLE_WORDS = 2;
// A title may hold a digit ("Tendances des annees 1990 ...", "Carence en B12 ..."); a venue part with a volume
// ("M. Mueller, Nature 571, 95") has numbers but hardly any ordinary lower-case words.
const MIN_LOWER_TITLE_WORDS_WITH_DIGIT = 3;

/**
 * Does a parsed title that opens the reference read as a title, rather than as the names (and venue) of a
 * title-less style that the parser took for one ("Jane Roe and John Smith", "M. Mueller, Nature 571, 95")?
 * A title has ordinary lower-case words; a run of names has none, and a venue part brings digits, so a title
 * with a digit needs a few more of them.
 */
function readsAsTitle(title: string): boolean {
  let lower = 0;
  for (const word of title.split(/\s+/)) {
    const first = word.charAt(0);
    if (first !== first.toUpperCase() && !NAME_WORDS.has(word.toLowerCase())) lower++;
  }
  return lower >= (/\d/.test(title) ? MIN_LOWER_TITLE_WORDS_WITH_DIGIT : MIN_LOWER_TITLE_WORDS);
}

/**
 * The author part of a reference as written. It is the text before the first venue/volume/year/identifier
 * token, and also before the parsed title when that title is preceded by an author run or reads as a real
 * title. A leading "title" that reads as names stays in, so title-less styles keep their author list.
 */
function authorZoneText(c: ParsedCitation): string {
  const flat = joinLineEndHyphens(c.raw.slice(0, MAX_ZONE_SOURCE_CHARS).replace(/\p{Cf}/gu, '')).replace(/\s+/g, ' ');
  const text = withoutLeadingLabel(withoutListLabel(flat));
  const end = text.search(ZONE_END);
  let cut = end < 0 ? text.length : end;
  if (c.title !== undefined && normalizeTitle(c.title) !== '') {
    const at = text.indexOf(c.title);
    if (at >= 0 && (/\p{L}/u.test(text.slice(0, at)) || readsAsTitle(c.title))) cut = Math.min(cut, at);
  }
  return text.slice(0, cut);
}

/** The author part of a reference, normalised (see authorZoneText). */
export function authorZone(c: ParsedCitation): string {
  return normalizeTitle(authorZoneText(c));
}

/** 32-bit FNV-1a over the string read forwards or backwards, as eight hex digits. Stable, not a security measure. */
function fnv1a(s: string, backwards: boolean): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(backwards ? s.length - 1 - i : i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// A fingerprint longer than this (a long author list) is kept as a 64-bit hash, so cache keys stay small.
const MAX_FINGERPRINT_CHARS = 200;

/**
 * Who the author zone names, as a stable fingerprint: the sorted, de-duplicated words of the whole normalised
 * zone, initials included ("zone:j roe smith"), so "X. Wang" and "Y. Wang" differ; a 64-bit hash of the same
 * when that is long ("zone#0123456789abcdef"); '' when the zone is empty (a bare identifier). The verdict on a
 * title-less reference depends on these names, so its cache key must too.
 */
export function authorZoneFingerprint(c: ParsedCitation): string {
  const zone = authorZone(c);
  if (zone === '') return '';
  const words = [...new Set(zone.split(' '))].sort().join(' ');
  return words.length <= MAX_FINGERPRINT_CHARS ? `zone:${words}` : `zone#${fnv1a(words, false)}${fnv1a(words, true)}`;
}

// A word that could be someone's surname: Latin script (after the folding normalizeTitle does), two letters or more.
const LATIN_NAME_WORD = /^\p{Script=Latin}{2,}$/u;

// Words that make a run of names an organisation, not a person ("Gemini Team", "Meta AI", "CMS Collaboration").
const ORG_WORDS = new Set(['team', 'inc', 'corp', 'corporation', 'ltd', 'llc', 'google', 'openai', 'deepmind', 'meta', 'microsoft', 'nvidia', 'anthropic', 'ibm', 'amazon', 'apple', 'baidu', 'alibaba', 'tencent', 'consortium', 'collaboration', 'group', 'lab', 'laboratory', 'institute', 'university', 'society', 'association', 'committee', 'organization', 'organisation', 'foundation', 'project', 'ai']);
// Where one name ends and the next begins in an author list.
const NAME_RUN_BREAK = /\s*(?:[,;&]|\band\b)\s*/i;
// One capitalised word and nothing else ("OpenAI", "DeepMind"): at the end of the zone, an organisation's name.
// One character class and an optional full stop that it cannot match: no backtracking, linear in the run's length.
const SINGLE_CAPITALISED_WORD = /^\p{Lu}[\p{L}\p{N}'’-]+\.?$/u;

/**
 * Does the author zone name a person, i.e. hold a Latin-script word that could be a surname? Initials, "and",
 * "et al." and particles alone do not, nor does a zone in another script, which the record's romanised surnames
 * cannot be compared with, nor an organisation: a run of names with an organisation word in it ("Gemini Team,
 * Google", "Meta AI") or a single capitalised word that ends the zone ("OpenAI."). A zone that names no person
 * says nothing either way: it is neither agreement with a record nor evidence against one.
 */
export function zoneNamesSomeone(c: ParsedCitation): boolean {
  const runs = authorZoneText(c).split(NAME_RUN_BREAK);
  let last = runs.length - 1;
  while (last >= 0 && normalizeTitle(runs[last] ?? '') === '') last--;
  return runs.some((run, i) => {
    const words = normalizeTitle(run).split(' ');
    if (words.some((w) => ORG_WORDS.has(w))) return false;
    if (i === last && SINGLE_CAPITALISED_WORD.test(run.trim())) return false;
    return words.some((w) => LATIN_NAME_WORD.test(w) && !NAME_WORDS.has(w));
  });
}

/** The record's first three surnames (with their given names, where known), in the form the text comparison uses. */
function recordNames(r: WorkRecord): { family: string; given: string }[] {
  return r.authors
    .slice(0, 3)
    .map((name, i) => ({ family: normalizeTitle(name), given: normalizeTitle(r.givenNames?.[i] ?? '') }))
    .filter((n) => n.family !== '');
}

export function recordNameCount(r: WorkRecord): number {
  return recordNames(r).length;
}

/**
 * A record whose given and family names were entered the wrong way round ("X. Wang" stored as family
 * "Xiaoming", given "Wang"): its given name appears in the zone next to the initial of its "family" name.
 * Only for a single-word family field; the initial keeps a common given name elsewhere in the text from counting.
 */
function swappedNameCited(family: string, given: string, tokens: string[]): boolean {
  if (family.includes(' ') || given.length < 2 || given.includes(' ')) return false;
  const g = foldGermanSpelling(given);
  const initial = family.charAt(0);
  for (let j = 0; j < tokens.length; j++) {
    if (tokens[j] === g && (tokens[j - 2] === initial || tokens[j - 1] === initial || tokens[j + 1] === initial)) return true;
  }
  return false;
}

/** How many of the record's first three authors the author zone names, in any of their usual written forms. */
export function recordAuthorsInZone(c: ParsedCitation, r: WorkRecord): number {
  const zone = foldGermanSpelling(authorZone(c));
  if (zone === '') return 0;
  const padded = ` ${zone} `;
  const tokens = zone.split(' ');
  return recordNames(r).filter(({ family, given }) => surnameForms(family).some((form) => padded.includes(` ${form} `)) || swappedNameCited(family, given, tokens)).length;
}
