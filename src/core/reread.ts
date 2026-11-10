// Reading a reference again with the record in hand: the record's title and authors show where the parser cut the
// reference wrongly. The re-read only moves the reference's own words between its title, author and venue parts; it
// never takes a word from the record, and no word of the cited title may vanish unless the text sets it apart.
import { recordNameCount } from './authorZone';
import { citedTitleSimilarity, foldGermanSpelling, normalizeTitle, surnameForms, titleWords } from './normalize';
import { VERIFIED_TITLE } from './thresholds';
import { isJournalChunk, JOURNAL_FIRST_WORD, opensJournalName } from './parseCitation';
import type { ParsedCitation, WorkRecord } from './types';

/** Fewest words a record title must have for a window of the cited title to be matched against it. */
const MIN_WINDOW_WORDS = 3;
/** How many words shorter or longer than the record's title the matching window of the cited title may be. */
const WINDOW_SLACK = 2;
/** Most words a venue fragment left after a title may have ("Nucl", "Nucl. Phys", "J. Differential Geom"). */
const MAX_VENUE_TAIL_WORDS = 3;
/** Fewest words a record title must have to be looked for, word for word, in the reference text. */
const MIN_VERBATIM_TITLE_WORDS = 4;
// Words that belong in a list of names without being anyone's surname.
const NAME_LIKE_WORDS = new Set(['and', 'et', 'al', 'van', 'von', 'de', 'der', 'den', 'del', 'della', 'di', 'da', 'du', 'la', 'le', 'ter', 'ten', 'dos', 'das', 'do']);
// Not "part": "Part 2" of a work is another work.
const VOLUME_WORDS = new Set(['vol', 'volume', 'no', 'number', 'edition', 'edn', 'ed']);

/** A word of the cited title as compared, and the punctuation the text puts after it. */
interface Word {
  text: string;
  /** The whitespace-separated piece of the cited title the word comes from, as written. */
  token: string;
  /** A comma or semicolon follows: a list of names, or the end of one part of the reference. */
  comma: boolean;
  /** A comma, semicolon or full stop follows: the reference may move from one part to the next here. */
  stop: boolean;
}

/**
 * The cited title's words, each with the punctuation that follows it in the text. Undefined when reading it word by
 * word does not give the same words as reading it whole (LaTeX across spaces, say): the re-read is then not tried.
 */
function wordsWithBreaks(title: string): Word[] | undefined {
  const out: Word[] = [];
  for (const token of title.split(/\s+/)) {
    const words = titleWords(token);
    const end = /[,;.]["'’”)\]]*$/.exec(token)?.[0] ?? '';
    const comma = /^[,;]/.test(end);
    const stop = end !== '';
    if (words.length === 0) {
      const last = out.at(-1);
      // A lone ";" or "," between words.
      if (last !== undefined) {
        last.comma ||= /[,;]/.test(token);
        last.stop ||= /[,;.]/.test(token);
      }
      continue;
    }
    words.forEach((text, i) => out.push({ text, token, comma: i === words.length - 1 && comma, stop: i === words.length - 1 && stop }));
  }
  return out.map((w) => w.text).join(' ') === titleWords(title).join(' ') ? out : undefined;
}

/**
 * A reference whose parsed "title" still carries its author list, as some styles leave it ("O.J. Ganor and A.
 * Hanany, Small E(8) instantons and tensionless noncritical strings, Nucl", "Large sample properties of matching
 * estimators for average treatment effects; Alberto Abadie and Guido W Imbens"), or was cut at a full stop inside
 * the title, or keeps a volume number. When a window of the cited title matches the record's title, the words on one
 * side of it are the names of the record's authors, set apart from the window by punctuation, and the other side is
 * empty or a short venue fragment that punctuation sets apart too, the reference is read again with that window as
 * the title and those authors. Otherwise it is returned unchanged.
 */
export function resplitWithRecord(c: ParsedCitation, r: WorkRecord): ParsedCitation {
  if (c.title === undefined || normalizeTitle(c.title) === '' || normalizeTitle(r.title) === '') return c;
  if (citedTitleSimilarity(c.title, r.title) >= VERIFIED_TITLE) return c;
  const whole = titleCutShort(c.title, c.raw, r);
  if (whole !== undefined) return { ...c, title: whole };
  const cited = wordsWithBreaks(c.title);
  const wanted = titleWords(r.title).length;
  if (cited === undefined || wanted < MIN_WINDOW_WORDS || cited.length <= wanted) return c;
  let best: { sim: number; start: number; end: number } | undefined;
  for (let len = Math.max(MIN_WINDOW_WORDS, wanted - WINDOW_SLACK); len <= wanted + WINDOW_SLACK; len++) {
    for (let start = 0; start + len <= cited.length; start++) {
      const sim = citedTitleSimilarity(textOf(cited.slice(start, start + len)), r.title);
      if (sim >= VERIFIED_TITLE && (best === undefined || sim > best.sim)) best = { sim, start, end: start + len };
    }
  }
  if (best === undefined) return c;
  const before = cited.slice(0, best.start);
  const window = cited.slice(best.start, best.end);
  const after = cited.slice(best.end);
  const title = textOf(window);
  // "Methods of information geometry, volume 191": only a volume or edition follows the title.
  if (before.length === 0 && isVolumeTail(after)) return { ...c, title };
  if (c.authors.length > 0 || r.authors.length === 0) return c;
  // Every word that leaves the title must be set apart from it by the text's own punctuation: "J. Smith, A. Jones,
  // Quantum deep learning" does not give up "Quantum" to the names, nor "Deep learning revisited; J. Smith" its "revisited".
  if (before.length > 0 && before.at(-1)?.stop !== true) return c;
  if (after.length > 0 && window.at(-1)?.stop !== true) return c;
  const names = namesOfRecord(before.length > 0 ? before : after, r);
  if (names === undefined) return c;
  if (before.length > 0 && !(after.length === 0 ? titleTail(c) === undefined : isVenueTail(after, c))) return c;
  return { ...c, title, authors: names };
}

/**
 * The reference as compared with a record: the words the parser cut off after the title at a full stop or comma are
 * kept with it when they read as more of the title ("Attention is all you need. A survey of graph applications. In
 * NeurIPS", "... strings. Part II, Nucl. Phys.", "... children. Erratum, Lancet"), see titleTail, so that a title with
 * invented words after it is not taken for the record's. The words are the reference's own.
 */
export function withTitleTail(c: ParsedCitation): ParsedCitation {
  const tail = titleTail(c);
  return tail === undefined || c.title === undefined ? c : { ...c, title: `${c.title}. ${tail}` };
}

// A journal citation's venue as the "Surname, I., Title. J. Stat. Phys. 113, 389–410 (2003)." reading leaves it: the
// journal's name, then volume, pages and the year in brackets.
const JOURNAL_LOCATOR_VENUE = /\s\d{1,4},\s*[^()]{1,40}\((?:19|20)\d{2}\)\.?$/u;
// The SIAM reading leaves the journal's name, a comma, then the volume and (year): "Structural Safety, 12 (1993), pp. 167–186".
const SIAM_LOCATOR_VENUE = /^([^,()]{1,80}),\s(?:\d{1,4}\s)?\((?:19|20)\d{2}\)(?:,|\.?$)/u;
const VENUE_JOINERS = new Set(['and', 'of', 'in', 'on', 'for', 'the', 'their', 'its', 'de', 'der', 'des', 'du', 'la', 'le', 'et', 'und', 'fur', 'die']);
// Abbreviations that open a journal's or a proceedings' name and that a record's venue often leaves out: "Adv. Neural Inf.
// Process. Syst." against "Neural Information Processing Systems", "Proc." before a conference's name.
const DROPPED_OPENING_ABBREVIATIONS = new Set(['adv', 'proc', 'conf', 'int', 'intl', 'annu', 'ann', 'trans', 'j']);

/** The record's venue names ("Journal of Statistical Physics", "J. Stat. Phys."), each as its words (lower case). */
function recordVenueNames(r: WorkRecord): string[][] {
  return [r.venue, ...(r.venues ?? []), ...(r.shortVenues ?? [])].flatMap((v) => (v === undefined ? [] : [titleWords(v)])).filter((w) => w.length > 0);
}

/**
 * How well the journal-name words read as an abbreviation of one of the record's venue names, taken in order: the venue
 * words they abbreviate ("Stat." for "Statistical", "Nat" for "Nature", with or without the full stop), less the cited
 * words that abbreviate none of them before the last one that does. Joining words and series letters cost nothing, and
 * nor do words after the last match ("Phys Rev E Stat Nonlin Soft Matter Phys" for Physical Review E).
 */
function abbreviationScore(tokens: string[], names: string[][]): number {
  let best = 0;
  for (const name of names) {
    let next = 0;
    let covered = 0;
    let skipped = 0;
    let pending = 0;
    for (const token of tokens) {
      const stem = titleWords(token)[0] ?? '';
      // A joining word ("of", "and") says nothing: "Journal of Physics" must not read as the Journal of ... Physics.
      if (VENUE_JOINERS.has(stem)) continue;
      // A lone capital without a full stop is a series letter: it matches only that letter ("Physica A"), not any word it
      // begins ("arXiv"). With a full stop it abbreviates ("J." for "Journal").
      const series = stem.length === 1 && !token.endsWith('.');
      const found = name.findIndex((w, i) => i >= next && !VENUE_JOINERS.has(w) && (series ? w === stem : w.startsWith(stem)));
      if (found >= 0) {
        next = found + 1;
        covered++;
        skipped += pending;
        pending = 0;
      } else if (stem.length > 1) pending++;
    }
    best = Math.max(best, covered - skipped);
  }
  return best;
}

/**
 * The reference as compared with a record, when its venue ends in volume, pages and (year): the venue keeps only the
 * run of words that reads, in order, as an abbreviation of the record's venue ("J. Stat. Phys." for the Journal of
 * Statistical Physics, "Nat Phys" for Nature Physics); the words before that run go back to the title ("... properties.
 * Physical Origins. Phys. Rev. Lett. 113" against Physical Review Letters), so a sentence added after the title is
 * compared as part of it. When nothing in the name abbreviates the record's venue, or the record has none, whole words go
 * back and abbreviations stay. Only the reference's own words move, and never the whole journal name.
 */
export function withVenueLead(c: ParsedCitation, r: WorkRecord): ParsedCitation {
  if (c.title === undefined || c.venue === undefined) return c;
  const siamFound = JOURNAL_LOCATOR_VENUE.test(c.venue) ? undefined : SIAM_LOCATOR_VENUE.exec(c.venue)?.[1];
  // "arXiv preprint arXiv:2605.19989, (2026), https://..." names a repository, not a journal: nothing to re-read.
  const siamName = siamFound !== undefined && isJournalChunk(siamFound) ? siamFound : undefined;
  if (siamName === undefined && !JOURNAL_LOCATOR_VENUE.test(c.venue)) return c;
  const text = c.raw.replace(/\s+/g, ' ');
  const at = text.lastIndexOf(c.title);
  const venueAt = at < 0 ? -1 : text.indexOf(c.venue, at + c.title.length);
  if (venueAt < 0 || !/^[\s.,]*$/.test(text.slice(at + c.title.length, venueAt))) return c;
  const name = siamName ?? c.venue.slice(0, c.venue.search(/\s\d{1,4},/));
  // In a SIAM name "&" is the joining word "and" ("Statistics & Computing"): with no word of its own it would end the
  // re-read below before the record check, and leave any "& " chunk cut off the title.
  const tokens = (siamName === undefined ? name : name.replace(/(^|\s)&(?=\s|$)/g, '$1and')).split(' ');
  const stems = tokens.map((t) => titleWords(t)[0] ?? '');
  if (stems.some((s) => s === '')) return c;
  const names = recordVenueNames(r);
  // SIAM style with a name of whole words ("..., Asymptotic importance sampling, Structural Safety, 12 (1993)"): only the
  // comma says the title ended there, so the name is a journal's only when every word of it reads, in order, as the
  // record's venue; otherwise all of it goes back to the title ("..., Revisited Methods, 12 (1993)" against Structural
  // Safety, or any name against a record with no venue).
  if (siamName !== undefined && !tokens.some((t) => t.endsWith('.'))) {
    const content = stems.filter((s) => !VENUE_JOINERS.has(s)).length;
    if (names.length > 0 && abbreviationScore(tokens, names) >= content) return c;
    return { ...c, title: text.slice(at, venueAt + name.length).replace(/[\s.,;:]+$/, ''), venue: c.venue.slice(name.length).replace(/^[\s,]+/, '') };
  }
  // The venue starts where the rest of the name reads best as the record's venue: "Phys. Rev. Lett." in "Physical Origins.
  // Phys. Rev. Lett." against Physical Review Letters ("Physical" alone would abbreviate it too, but "Origins" breaks the
  // run), all of "Physica B: Physics of Condensed Matter" against Physica B: Condensed Matter.
  let moved = -1;
  let bestScore = 0;
  for (let k = 0; k < stems.length && names.length > 0; k++) {
    const score = abbreviationScore(tokens.slice(k), names);
    // A tie goes to the later start: a sentence that opens with the venue's own word ("Science Advances. Science 113")
    // reads as well as the venue alone, and the venue alone is what the reference cites.
    if (score > 0 && score >= bestScore) {
      bestScore = score;
      moved = k;
    }
  }
  if (moved < 0) {
    // No venue to read it against (none on the record, a repository's, one in another language): whole words go back,
    // but abbreviations, series letters and a journal's opening word ("Physica A", "Theory Probab. Appl.") stay.
    moved = 0;
    const stays = (i: number): boolean => {
      const token = tokens[i] ?? '';
      return token.endsWith('.') || /^\p{Lu}$/u.test(token) || opensJournalName(token.replace(/[,:;]$/, ''), tokens[i + 1] ?? '');
    };
    while (moved < tokens.length && !stays(moved)) moved++;
    moved = afterAddedSentence(tokens, stems, moved);
  }
  // A joining word stays with the name it joins; so does an opening abbreviation the record's venue leaves out, when it is
  // written as one ("Adv."; "Advances." is a sentence).
  const staysWithName = (i: number): boolean => {
    const token = tokens[i] ?? '';
    const stem = stems[i] ?? '';
    return VENUE_JOINERS.has(stem) || (bestScore > 0 && token === `${token.charAt(0)}${stem.slice(1)}.` && DROPPED_OPENING_ABBREVIATIONS.has(stem));
  };
  while (moved > 0 && staysWithName(moved - 1)) moved--;
  if (moved === 0 || moved >= tokens.length) return c;
  const lead = tokens.slice(0, moved).join(' ');
  return { ...c, title: text.slice(at, venueAt + lead.length).replace(/[\s.,;:]+$/, ''), venue: c.venue.slice(lead.length).trim() };
}

// Abbreviations that open real journals' names besides those in JOURNAL_OPENERS, often before "J." or another opening
// word ("Electron. J. Probab.", "Bull. Amer. Math. Soc.", "Br. J. Psychol.", "Phil. Trans. R. Soc. A"). A word here is
// never taken for a sentence added before the journal; none of them is a word a title would end a sentence with.
const MORE_JOURNAL_OPENERS = new Set([
  'abh', 'afr', 'amer', 'angew', 'algebr', 'arab', 'atmos', 'aust', 'br', 'braz', 'catal', 'combin', 'czech', 'electron', 'engl', 'environ', 'ergod', 'egypt', 'found', 'front', 'geophys', 'glasg',
  'helv', 'hung', 'insur', 'iran', 'ital', 'lond', 'mater', 'methodol', 'mex', 'mol', 'nord', 'pac', 'pak', 'part', 'phil', 'philos', 'pol', 'port', 'psychon', 'quart', 'radiat', 'russ',
  'scand', 'semicond', 'span', 'statist', 'stoch', 'stud', 'supercond', 'theoret', 'turk', 'ukr',
]);

/** Can this word open a journal's name: a usual first word or abbreviation of one, or a known first word followed by its name? */
function opensName(tokens: string[], stems: string[], i: number): boolean {
  const stem = stems[i] ?? '';
  return JOURNAL_OPENERS.has(stem) || MORE_JOURNAL_OPENERS.has(stem) || opensJournalName(tokens[i] ?? '', tokens[i + 1] ?? '');
}

/** One word with a capital and a full stop that opens no journal's name ("Models.", "Bounds."): a sentence's last word. */
function isSentenceWord(tokens: string[], stems: string[], i: number): boolean {
  const stem = stems[i] ?? '';
  return /^\p{Lu}\p{Ll}+\.$/u.test(tokens[i] ?? '') && !JOURNAL_OPENERS.has(stem) && !MORE_JOURNAL_OPENERS.has(stem) && !DROPPED_OPENING_ABBREVIATIONS.has(stem);
}

/**
 * With no venue to read the journal's name against: where the name starts when the words in front of it are a sentence
 * added after the title, or `from`. The sentence is one word written like an abbreviation ("Models.", "Bounds.") or a
 * journal's opening word and one such word ("Probability Bounds.", "Physical Origins."), and it counts only when what
 * follows reads as a journal's name on its own: two words or more that open as one ("J. Stat. Phys.", "Phys. Rev.
 * Lett."). "Phys. Rev." and "Ann. Stat." keep their first word (it opens journals, and "Rev." or "Stat." alone is no
 * journal), and so do "Electron. J. Probab." and the like (MORE_JOURNAL_OPENERS). Only the first words are looked at:
 * inside a name an abbreviation is part of it.
 */
function afterAddedSentence(tokens: string[], stems: string[], from: number): number {
  let end = -1;
  if (isSentenceWord(tokens, stems, from)) end = from + 1;
  else if (JOURNAL_FIRST_WORD.test(tokens[from] ?? '') && isSentenceWord(tokens, stems, from + 1)) end = from + 2;
  if (end < 0 || tokens.length - end < 2) return from;
  return isJournalChunk(tokens.slice(end).join(' ')) && opensName(tokens, stems, end) ? end : from;
}

function textOf(words: Word[]): string {
  return words.map((w) => w.text).join(' ');
}

/** "volume 191", "vol 2", "2nd edition": a volume or edition number and nothing else. */
function isVolumeTail(words: Word[]): boolean {
  if (words.length === 0 || words.length > 3) return false;
  const plain = words.map((w) => w.text);
  return plain.some((w) => VOLUME_WORDS.has(w)) && plain.every((w) => VOLUME_WORDS.has(w) || /^\d+(?:st|nd|rd|th)?$/.test(w));
}

// Words that never start a journal's name in a reference: parts, notices, numbers.
const NOT_VENUE_WORDS = new Set(['part', 'parts', 'section', 'chapter', 'vol', 'volume', 'no', 'erratum', 'errata', 'addendum', 'addenda', 'corrigendum', 'comment', 'comments', 'reply', 'response', 'retraction', 'correction', 'note', 'notes', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'first', 'second', 'third']);
const NOTICE_WORDS = new Set(['erratum', 'errata', 'addendum', 'addenda', 'corrigendum', 'comment', 'comments', 'reply', 'response', 'retraction', 'correction']);
// Roman numerals of a sequel ("II", "III"); single letters are left alone: "Phys. Rev. D", "Phys. Rev. X".
const ROMAN = /^(?:II|III|IV|VI|VII|VIII|IX|XI|XII)$/;
// The first words of journals' names and abbreviations, as compared (lower case): what a venue fragment may open with.
const JOURNAL_OPENERS = new Set(['nucl', 'phys', 'physica', 'j', 'jour', 'journal', 'ann', 'annu', 'annals', 'commun', 'comm', 'lett', 'rev', 'class', 'gen', 'int', 'mod', 'prog', 'theor', 'adv', 'eur', 'astrophys', 'astron', 'mon', 'proc', 'rep', 'rept', 'living', 'nuovo', 'z', 'zh', 'sov', 'fortsch', 'fortschr', 'lect', 'math', 'acta', 'bull', 'trans', 'chin', 'jpn', 'can', 'am', 'sci', 'nat', 'nature', 'science', 'lancet', 'jhep', 'jcap', 'ptep', 'sigma', 'prl', 'prd', 'pnas', 'ieee', 'acm', 'siam', 'rend', 'pub', 'publ', 'mem', 'appl', 'opt', 'chem', 'biol', 'comput', 'neural', 'mach', 'stat', 'probab', 'geom', 'differ']);
// Whole words that may stand in a venue fragment without a full stop.
const VENUE_TAIL_WORDS = new Set(['nature', 'science', 'lancet', 'physics', 'journal']);
const MAX_ABBREVIATION_LETTERS = 6;

/** Where the cited title ends in the reference's text (spaces collapsed), or undefined when it cannot be found there. */
function afterTitle(c: ParsedCitation): string | undefined {
  if (c.title === undefined) return undefined;
  const text = c.raw.replace(/\s+/g, ' ');
  const at = text.indexOf(c.title);
  return at < 0 ? undefined : text.slice(at + c.title.length);
}

/**
 * The start of a venue cut short by the parser, left at the end of the title ("..., Nucl" before ". Phys. B 474",
 * "..., J. Differential Geom"): at most three words, each written with a capital and either abbreviated (six letters
 * or fewer, then a full stop), an acronym, or a venue word; no sequel numeral, part, notice or number word; and the
 * last one runs straight into the venue the parser read ("Nucl" + ". Phys. B"). "a review", "revisited", "with fluxes",
 * "Part II", "three loops" or "Erratum" are words of the title, not a venue.
 */
function isVenueTail(words: Word[], c: ParsedCitation): boolean {
  if (words.filter((w) => !/^\d+$/.test(w.text)).length > MAX_VENUE_TAIL_WORDS) return false;
  const rest = afterTitle(c);
  if (rest === undefined || c.venue === undefined) return false;
  const gap = rest.indexOf(c.venue);
  if (gap < 0 || !/^[.,]?\s*$/.test(rest.slice(0, gap))) return false;
  // A journal abbreviation has no comma inside, and opens with a journal's usual first word ("Nucl", "Phys", "J"):
  // "QCD, Nucl", "AdS. Nucl" or "Revis. Nucl" put an invented word in front of the venue.
  if (words.slice(0, -1).some((w) => w.comma) || !JOURNAL_OPENERS.has(words.find((w) => !/^\d+$/.test(w.text))?.text ?? '')) return false;
  return words.every((w, i) => {
    if (/^\d+$/.test(w.text)) return true;
    const token = w.token.replace(/[,;:]+$/, '');
    const letters = token.replace(/[^\p{L}]/gu, '');
    if (!/^\p{Lu}/u.test(letters) || ROMAN.test(letters) || NOT_VENUE_WORDS.has(w.text)) return false;
    const dotted = token.endsWith('.') || (i === words.length - 1 && rest.startsWith('.'));
    return (dotted && letters.length <= MAX_ABBREVIATION_LETTERS) || /^\p{Lu}{2,6}$/u.test(letters) || VENUE_TAIL_WORDS.has(w.text);
  });
}

// What starts a conference paper's venue after a title ("In NeurIPS", "Proceedings of", "arXiv preprint"), and what
// starts any venue: journal words and the like, an abbreviation ("Nucl.", "Phys."), an acronym ("JHEP").
const CONFERENCE_START = /^(?:Proceedings|Proc\.|Advances|Conference|Workshop|Symposium|arXiv|ArXiv|arxiv|CoRR|Preprint|preprint|NeurIPS|NIPS|ICML|ICLR|CVPR|ICCV|ECCV|ACL|EMNLP|NAACL|EACL|COLING|AAAI|IJCAI|KDD|SIGIR|WWW|CHI|UAI|AISTATS|COLT|TMLR|ICASSP|INTERSPEECH|Interspeech|MICCAI|ICRA|IROS|CoRL|CoNLL|bioRxiv|medRxiv)[.,:;]?$/;
const VENUE_START = /^(?:Journal|J\.|Transactions|Trans\.|Technical|Tech\.|Annals|Bulletin|Lancet|Nature|Science|Physical|Review|Letters|PhD|Ph\.D\.|Master's|Thesis|URL|DOI|doi|https?:\/\/\S*|www\.\S*)[.,:;]?$/;
// Words after a title that open a note about the reference, not more of its title.
const NOTE_OPENERS = new Set(['published', 'presented', 'accepted', 'submitted', 'to', 'available', 'accessed', 'retrieved', 'contributed', 'talk', 'invited', 'poster', 'oral', 'spotlight', 'also', 'see', 'reprinted', 'translated', 'originally', 'edited', 'eds', 'ed', 'version', 'extended', 'full', 'preliminary', 'short', 'long', 'camera', 'under', 'manuscript', 'unpublished', 'personal', 'private', 'lecture', 'supplementary', 'supplement', 'in', 'online', 'best', 'award', 'winner', 'code', 'source', 'data', 'models', 'project', 'website', 'slides', 'video', 'github', 'equal', 'corresponding']);
// Words of a title that say nothing either way.
const LEAD_CONNECTORS = new Set(['a', 'an', 'the', 'of', 'and', 'on', 'for', 'at', 'to', 'in', 'with', 'by', 'from', 'de', 'der', 'des', 'la', 'le', 'und', 'et', 'al']);
const MAX_LEAD_WORDS = 12;

/** Does this word start a venue, and which kind: a conference's ("In NeurIPS", "Proceedings") or any ("Nucl.", "Lancet")? */
function venueStart(token: string, next: string): 'conference' | 'any' | undefined {
  if (token === '') return undefined;
  if (CONFERENCE_START.test(token) || (/^[Ii]n:?$/.test(token) && /^\p{Lu}/u.test(next))) return 'conference';
  const bare = token.replace(/[.,;:]+$/, '');
  const letters = bare.replace(/[^\p{L}]/gu, '');
  const acronym = /^\p{Lu}{2,8}$/u.test(letters) && letters === bare && !ROMAN.test(letters);
  return VENUE_START.test(token) || /^\p{Lu}\p{Ll}{0,5}\.$/u.test(token) || acronym ? 'any' : undefined;
}

/**
 * The words right after the parsed title, up to the end of their clause, when they read as more of the title: the
 * parser cut the title at a full stop or comma, and a venue follows them at once. A sequel ("Part II", "II"), a notice
 * ("Erratum") or a number word ("Two loop corrections") before any venue; a plain subtitle ("A survey of graph
 * applications") only before a conference's venue ("In NeurIPS"), since journals' records drop subtitles that
 * references keep ("Antiferromagnetism. The triangular Ising net. Phys. Rev."). A clause followed by anything else (a
 * publisher, a number, "International Journal ...") is left alone, and so are notes ("Published as a conference paper
 * at ICLR") and "Erratum in:".
 */
function titleTail(c: ParsedCitation): string | undefined {
  const rest = afterTitle(c);
  if (rest === undefined) return undefined;
  const tokens = rest.replace(/^[\s.,;:]+/, '').split(' ').filter((t) => t !== '');
  const lead: string[] = [];
  for (let i = 0; i < tokens.length && i <= MAX_LEAD_WORDS; i++) {
    const token = tokens[i] ?? '';
    if (/^[\d([]/.test(token)) return undefined;
    const start = venueStart(token, tokens[i + 1] ?? '');
    // "..., GNN. J. Mach. Learn. Res.": an acronym that is no venue's, closed by a full stop or comma, right before a
    // venue, is a word of the title.
    if (start !== undefined && lead.length === 0 && isStrayAcronym(token) && venueStart(tokens[i + 1] ?? '', tokens[i + 2] ?? '') !== undefined) return token.replace(/[.,;:]+$/, '');
    if (start !== undefined) return isTitleLead(lead, token, start) ? lead.join(' ').replace(/[.,;:]+$/, '') : undefined;
    lead.push(token);
    if (/[.,;:]$/.test(token)) {
      const next = tokens[i + 1] ?? '';
      const after = venueStart(next, tokens[i + 2] ?? '');
      return after !== undefined && isTitleLead(lead, next, after) ? lead.join(' ').replace(/[.,;:]+$/, '') : undefined;
    }
  }
  return undefined;
}

// Acronyms that name a venue or a publisher, which may stand before a journal's name ("IEEE Trans.", "ACM, J.").
const VENUE_ACRONYMS = new Set(['ACS', 'RSC', 'IEEE', 'ACM', 'SIAM', 'AMS', 'AIP', 'APS', 'IOP', 'OSA', 'SPIE', 'PMLR', 'JHEP', 'JCAP', 'PRL', 'PRD', 'PNAS', 'JMLR', 'TMLR', 'MIT', 'IET', 'IEE', 'AAAI', 'IJCAI', 'ICML', 'ICLR', 'CVPR', 'ICCV', 'ECCV', 'ACL', 'EMNLP', 'NAACL', 'NIPS', 'KDD', 'WWW', 'CHI', 'UAI', 'COLT', 'USA', 'UK']);

/** An all-capital acronym that names no venue, closed by a full stop or comma ("GNN.", "QCD,"). */
function isStrayAcronym(token: string): boolean {
  const bare = token.replace(/[.,]+$/, '');
  return bare !== token && /^\p{Lu}{2,8}$/u.test(bare) && !ROMAN.test(bare) && !VENUE_ACRONYMS.has(bare);
}

// Words that make a run after a title a sequel or a survey of the work, not the work: "Revisited.", "A survey.".
const SEQUEL_OR_SURVEY = new Set(['revisited', 'reloaded', 'redux', 'sequel', 'continued', 'followup', 'follow', 'update', 'updated', 'survey', 'review', 'overview', 'tutorial', 'primer', 'perspective', 'retrospective', 'commentary']);
const ARTICLES = new Set(['a', 'an', 'the']);

/**
 * The clause right after the parsed title, up to its full stop, when it reads as words of a title (a lower-case word, no
 * number, not the start of a venue): "MapReduce. Fault-tolerant scheduling for heterogeneous clusters. Communications
 * of the ACM". Undefined when what follows is a venue, a year or nothing.
 */
export function titleLikeClauseAfter(c: ParsedCitation): string | undefined {
  const rest = afterTitle(c);
  if (rest === undefined) return undefined;
  const clause = /^(.*?)[.;](?:\s|$)/.exec(rest.replace(/^[\s.,;:]+/, ''))?.[1]?.trim() ?? '';
  const tokens = clause.split(' ').filter((t) => t !== '');
  if (tokens.length < 2 || /\d/.test(clause) || venueStart(tokens[0] ?? '', tokens[1] ?? '') !== undefined) return undefined;
  const plain = tokens.some((token) => /^\p{Ll}/u.test(token) && token.length >= 3 && !LEAD_CONNECTORS.has(normalizeTitle(token)));
  return plain ? clause : undefined;
}

/** Does a run of words, followed by the start of a venue (`next`, of kind `start`), read as part of a title (see titleTail)? */
function isTitleLead(lead: string[], next: string, start: 'conference' | 'any'): boolean {
  // "Note: arXiv preprint 2609.25525": BibTeX's note field (noteField.ts) says something about the work, it is no part of
  // its title, in any case and as "Notes:". Only with its colon: "Note on the method. In NeurIPS" may be a sentence added
  // to the title.
  if (/^notes?:$/i.test(lead[0] ?? '')) return false;
  const first = normalizeTitle(lead[0] ?? '');
  if (first === '' || NOTE_OPENERS.has(first.split(' ')[0] ?? '')) return false;
  // "Erratum: Phys. Rev. D ...", "Erratum in: Lancet": the reference names its erratum besides the work.
  if (NOTICE_WORDS.has(first) && (/:$/.test(lead[0] ?? '') || /^(?:in|ibid)\b/i.test(lead[1] ?? next))) return false;
  const bare = lead.map((token) => token.replace(/[.,;:]+$/, ''));
  // A sequel numeral anywhere ("Part II", "II"); a part, notice or number word as the first word ("Two loop corrections");
  // a sequel or survey word first after an article ("Revisited", "A survey").
  const firstWord = normalizeTitle(bare.find((token) => !ARTICLES.has(normalizeTitle(token))) ?? '').split(' ')[0] ?? '';
  if (bare.some((token) => ROMAN.test(token)) || NOT_VENUE_WORDS.has(first) || SEQUEL_OR_SURVEY.has(firstWord)) return true;
  return start === 'conference' && bare.some((token) => /^\p{Ll}/u.test(token) && token.length >= 3 && !LEAD_CONNECTORS.has(normalizeTitle(token)));
}

/**
 * The record's title, when the reference writes it out in full and the parsed title is only a part of it: the parser
 * stopped at a full stop inside the title ("Hamiltonian Monte Carlo in inverse problems. Ill-Conditioning and
 * multimodality."). The words returned are the reference's own: they stand in it word for word. Undefined otherwise.
 */
function titleCutShort(title: string, raw: string, r: WorkRecord): string | undefined {
  const record = titleWords(r.title);
  const cited = titleWords(title);
  if (record.length < MIN_VERBATIM_TITLE_WORDS || cited.length >= record.length) return undefined;
  if (!` ${titleWords(raw).join(' ')} `.includes(` ${record.join(' ')} `)) return undefined;
  return ` ${record.join(' ')} `.includes(` ${cited.join(' ')} `) ? record.join(' ') : undefined;
}

/**
 * The record's surnames that a run of words names, if the run is nothing but names: surnames of the record (at least
 * two of its first three, or all of them if it has fewer), initials, joining words, and at most one other word per
 * surname found, standing between the same commas as one of them (a given name: "Guido W Imbens").
 */
function namesOfRecord(run: Word[], r: WorkRecord): string[] | undefined {
  if (run.length === 0) return undefined;
  const words = run.map((w) => foldGermanSpelling(w.text));
  const found: string[] = [];
  const used = new Set<number>();
  for (const author of r.authors) {
    const forms = surnameForms(author);
    for (let i = 0; i < words.length; i++) {
      if (used.has(i)) continue;
      // A multi-word form ("van den poel") must appear as consecutive words.
      const hit = forms.find((form) => form.split(' ').every((w, k) => words[i + k] === w));
      if (hit === undefined) continue;
      for (let k = 0; k < hit.split(' ').length; k++) used.add(i + k);
      found.push(author);
      break;
    }
  }
  const needed = Math.min(2, recordNameCount(r));
  const firstThree = r.authors.slice(0, 3).filter((a) => found.includes(a)).length;
  if (needed === 0 || firstThree < needed) return undefined;
  // The run split at its commas: a given name shares its piece with a surname.
  const piece: number[] = [];
  let at = 0;
  for (const w of run) {
    piece.push(at);
    if (w.comma) at++;
  }
  const namedPieces = new Set([...used].map((i) => piece[i]));
  const others = words.map((w, i) => ({ w, i })).filter(({ w, i }) => !used.has(i) && w.length > 1 && !NAME_LIKE_WORDS.has(w));
  if (others.length > found.length) return undefined;
  return others.every(({ i }) => namedPieces.has(piece[i])) ? found : undefined;
}
