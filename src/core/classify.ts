// Decides a reference's final status. Pure: the engine does the lookups and hands the evidence here.
import { authorZone, recordAuthorsInZone, recordNameCount, zoneNamesSomeone } from './authorZone';
import { authorOverlap, citedTitleSimilarity, dropsShortSubtitle, joinLineEndHyphens, normalizeTitle, titleSimilarity, titleWords } from './normalize';
import { withoutNoteField } from './noteField';
import { AUTHOR_OK, AUTHOR_SLACK, CANDIDATE_TITLE, MIN_PARSE_CONFIDENCE, NO_AUTHOR_TITLE, STRONG_TITLE, STRONG_TITLE_NO_AUTHORS, VERIFIED_TITLE, WRONG_ID_TITLE, YEAR_TOLERANCE } from './thresholds';
import { resplitWithRecord, titleLikeClauseAfter, withTitleTail, withVenueLead } from './reread';
import { hasFullJournalLocator, journalNameLead } from './journalLocator';
import { citesSeveralWorks } from './severalWorks';
import { joinAnd, SOURCE_NAME, sourceName } from './status';
import { yearAgrees } from './years';
import { REQUIRED_SOURCES } from './types';
import type { CheckResult, FieldDiff, ParsedCitation, RecordNote, Retraction, SourceName, WorkRecord } from './types';

const MAX_UNRELIABLE_ID_CHARS = 1000;
/** Words of text about a reference (identifiers and pure numbers aside) that count as something the record could contradict. */
const MIN_DESCRIPTIVE_WORDS = 3;
/** Fewest words (not counting numbers) a cited title may have to be called a Wrong ID; fewest words to be strong without a parsed author list. */
const MIN_CREDIBLE_TITLE_WORDS = 3;
const MIN_NO_AUTHOR_STRONG_WORDS = 4;
const ID_MISMATCH = "The identifier points to a record that doesn't match the other details";
/** Added to every Not found reason, so the badge, the panel and the report all say what the status does not mean. */
const NOT_FOUND_NOTE = "This means it isn't in these databases, not that it doesn't exist";
const ID_UNCONFIRMED = "Couldn't confirm the identifier matches this reference";
const NON_PAPER_ID = 'The identifier leads to a dataset or similar record listed under another name, so it couldn\'t be compared with this reference';
/** At least this share of a cited title's content words being boilerplate makes it no title at all. */
const BOILERPLATE_SHARE = 0.5;
const BOILERPLATE_WORDS = new Set(['retrieved', 'accessed', 'available', 'supplementary', 'material', 'data', 'software', 'version', 'online', 'dataset', 'code', 'repository', 'zenodo', 'figshare', 'github', 'appendix', 'web', 'page', 'site', 'url', 'doi', 'link']);
// Words that carry no content of their own, and dates, left out of that share.
const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'of', 'for', 'at', 'on', 'in', 'to', 'from', 'this', 'that', 'and', 'or', 'by', 'with', 'is', 'are', 'as']);
const MONTHS = new Set(['jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september', 'oct', 'october', 'nov', 'november', 'dec', 'december']);
// First words of a venue name: "Proceedings of the National Academy of Sciences 117(5), 2345" is a venue and volume.
const VENUE_FIRST_WORDS = new Set(['proceedings', 'proc', 'journal', 'transactions', 'trans', 'annals', 'bulletin', 'nature', 'nat', 'science', 'sci', 'cell', 'lancet', 'phys', 'physical', 'rev', 'review', 'lett', 'letters', 'pnas', 'ieee', 'acm', 'advances', 'conference', 'conf', 'international', 'plos', 'bmj', 'jama', 'arxiv', 'corr']);

export type Verdict = Pick<CheckResult, 'status' | 'reason' | 'diffs' | 'notes'>;

export interface ClassifyInput {
  citation: ParsedCitation;
  match?: WorkRecord;
  matchedVia?: 'id' | 'search';
  /** What the cited DOI/arXiv ID turned out to be, when the citation had one. */
  idResolvedTo?: WorkRecord;
  /**
   * The cited identifier resolved to a record with no usable title, so it says nothing about the citation.
   * Without another match the verdict is "Can't check", never "Wrong ID" or "Not found".
   */
  idUnusable?: boolean;
  /** 'unknown' means the retraction lookup could not give a complete answer. */
  retraction?: Retraction | 'unknown';
  searched: SourceName[];
  failed: SourceName[];
}

export interface CandidateScore {
  title: number;
  authors: number;
  yearOk: boolean;
  total: number;
}

const RECORD_NOTE_TEXT: Record<RecordNote, string> = {
  withdrawn: 'Note: withdrawn by the authors on arXiv',
  correction: 'Note: a correction has been published',
  expression_of_concern: 'Note: an expression of concern has been issued',
};

const RETRACTION_UNCHECKED = "The matched record is marked as retracted, but the retraction notice couldn't be looked up. Try again later";
const RETRACTION_UNKNOWN_NOTE = "Note: retraction status couldn't be checked. Try again later";
const CLOSE_RETRACTED_NOTE = 'Note: the closest record found has been retracted, but it may not be the cited work';
const CLOSE_RETRACTED_REASON = "A close record was found, but not close enough to tell whether it is the cited work";
export const UNREADABLE = "Couldn't read this reference reliably";
/** The name of the group that wrote the work was read in the title's place, so no search said anything about the work. */
const GROUP_AS_TITLE = "Only the name of the research group that wrote it could be read where the title goes, so it couldn't be looked up by its title";
/**
 * A title-less journal citation whose locator was read, but which no record in Crossref's answer carries (volume, page
 * and year). Can't check all the same: older, regional and smaller journals are often missing from Crossref.
 */
export const LOCATOR_NO_RECORD = 'The journal, volume and page were read, but no Crossref record was found there';
const WEAK_RECORD = "The closest record found has a similar title but no usable author list, so it couldn't be compared";
const BOOK_REASON = "Looks like a book or thesis, which these databases don't list reliably";
const REPORT_REASON = "Looks like a technical report, which these databases don't list reliably";
// A web reference that calls itself a report: "Virgo Project Technical Report No. VIR-0517A-15, 1989, https://...".
const REPORT = /\breport\b|\btech\.?\s*rep\b/i;
// What a reference says about itself that keeps it out of the databases, and the reason shown for it (instead of the
// book reason, which the parser's kind 'book' would otherwise give). A thesis keeps the book reason.
const NOT_PUBLISHED: readonly (readonly [RegExp, string])[] = [
  [/\bunpublished\b/i, 'Marked as unpublished, so these databases are not expected to list it'],
  [/\bin preparation\b/i, 'Marked as in preparation, so these databases may not list it yet'],
  [/\b(?:private|personal) communication\b/i, "A private communication, which these databases don't list"],
];
const NOT_PUBLISHED_REASONS = new Set(NOT_PUBLISHED.map(([, reason]) => reason));
const THESIS = /\b(?:thesis|dissertation)\b/i;
const IACR_REASON = "Looks like an IACR ePrint preprint, which these databases don't list reliably";
/** An entry that cites more than one work (severalWorks.ts): its parts mix, so it is never Not found, Wrong ID or Verified. */
export const SEVERAL_WORKS_REASON = 'This entry cites more than one work, and RefSure checks one work at a time';
// The Cryptology ePrint Archive: real papers, held by none of the required sources reliably.
const IACR_EPRINT = /\beprint\.iacr\.org\b|\bCryptology\s+e-?Print\s+Archive\b|\bIACR\s+e-?Print\b/i;

function yearWithinTolerance(cited: number | undefined, actual: number | undefined): boolean {
  if (cited === undefined || actual === undefined) return true;
  return Math.abs(cited - actual) <= YEAR_TOLERANCE;
}

function authorScore(c: ParsedCitation, r: WorkRecord): number {
  // A record with no author list tells us nothing, so it cannot count against the citation.
  if (r.authors.length === 0) return 1;
  return authorOverlap(c.authors, r.authors);
}

/** A title with no letters or digits (blank, whitespace, only punctuation) is the same as no title: there is nothing to compare. */
export function hasTitle(c: ParsedCitation): c is ParsedCitation & { title: string } {
  return c.title !== undefined && normalizeTitle(c.title) !== '';
}

/** A record whose title normalises to nothing is no evidence about any citation. */
export function hasUsableTitle(r: WorkRecord): boolean {
  return normalizeTitle(r.title) !== '';
}

function titleScore(c: ParsedCitation, r: WorkRecord): number {
  return hasTitle(c) ? citedTitleScore(c, r) : 0;
}

/**
 * What a short main title cited without the record's subtitle scores when the cited authors and year agree: enough for
 * Verified, not for a strong match (a retraction lookup), since a word or two is exactly what the strong-match bar keeps
 * out; with the record's volume and first page in the reference too, it is a strong match.
 */
const SHORT_MAIN_TITLE_SCORE = 0.94;
const LOCATED_SHORT_MAIN_TITLE_SCORE = STRONG_TITLE;

/**
 * The cited title against the record's (citedTitleSimilarity), with one allowance: a one- or two-word main title cited
 * without the record's subtitle ("Dean J, Ghemawat S. MapReduce. ... 2008" for "MapReduce: simplified data processing
 * on large clusters") counts as the same title when the cited authors agree as Verified needs and the cited year agrees,
 * and no clause that reads as a title stands between it and the venue unless it is the record's subtitle ("MapReduce.
 * Fault-tolerant scheduling for heterogeneous clusters. Communications of the ACM" names another work). A word or two
 * alone names many works, so with other authors, another year or none given it does not.
 */
function citedTitleScore(c: ParsedCitation & { title: string }, r: WorkRecord): number {
  const score = citedTitleSimilarity(c.title, r.title);
  if (isBuriedIn(c.title, r.title)) return Math.min(score, BURIED_TITLE_SCORE);
  if (score >= SHORT_MAIN_TITLE_SCORE || !dropsShortSubtitle(c.title, r.title)) return score;
  const authorsAgree = c.authors.length > 0 && r.authors.length > 0 && authorOverlap(c.authors, r.authors) >= AUTHOR_OK - AUTHOR_SLACK;
  if (!authorsAgree || c.year === undefined || !yearAgrees(c, r)) return score;
  const clause = titleLikeClauseAfter(c);
  if (clause !== undefined && citedTitleSimilarity(`${c.title}: ${clause}`, r.title) < VERIFIED_TITLE) return score;
  return locatorAgrees(c, r) ? LOCATED_SHORT_MAIN_TITLE_SCORE : SHORT_MAIN_TITLE_SCORE;
}

/** Below this share of the record's title words, a cited title found inside it after words of its own is buried there. */
const BURIED_TITLE_SHARE = 2 / 3;
/** What a buried title scores at most: below a candidate, so it is never a match on its own (a near miss may still be). */
const BURIED_TITLE_SCORE = CANDIDATE_TITLE - 0.01;

// A label some publishers put before the work's own title in the record: a notice ("RETRACTED ARTICLE: Graph neural
// networks", "Erratum: ...") or a section ("Perspective: Machine learning: protein folding at scale"). The words after
// it are the work's title, not another work's subtitle.
const NOTICE_PREFIX = /^\s*(?:retracted(?:\s+article)?|retraction|withdrawn|erratum|correction|perspective|editorial|commentary|review)\s*:/i;

/**
 * Is the cited title found inside a much longer record title, after words the citation does not give? "A path towards
 * autonomous machine intelligence" in "Introduction to Latent Variable Energy-Based Models: A Path Towards Autonomous
 * Machine Intelligence" is another work's subtitle: a few words of a topic recur in many titles. A record that only adds
 * a subtitle ("X" for "X: Y") or a short leading name ("BERT: Pre-training of ...") keeps its score, and so does one
 * that opens with a notice or section label (NOTICE_PREFIX) and ends with the cited title after its last colon.
 */
function isBuriedIn(cited: string, record: string): boolean {
  const c = titleWords(cited);
  const r = titleWords(record);
  if (c.length === 0 || c.length >= BURIED_TITLE_SHARE * r.length) return false;
  if (NOTICE_PREFIX.test(record) && titleWords(record.slice(record.lastIndexOf(':') + 1)).join(' ') === c.join(' ')) return false;
  return ` ${r.join(' ')} `.indexOf(` ${c.join(' ')} `) > 0;
}


// A word that makes a name an organisation's: "U.S. Securities and Exchange Commission", "World Bank", "U.S. Department of Energy".
const ORGANISATION_HEAD =
  /^(?:Commission|Agency|Administration|Department|Ministry|Office|Bureau|Board|Council|Committee|Authority|Organi[sz]ation|Association|Institute|Foundation|Bank|Reserve|Service|Union|Nations|Federation|Society|Corporation|Company|Inc\.?|Ltd\.?|LLC|Group|Cent(?:er|re)|Court|Parliament|Congress|Senate|Government|Survey|Forum|Fund|Programme|Program|Panel|Consortium|Collaboration|Collaborators|Investigators)$/;
const ORGANISATION_JOINING = new Set(['of', 'and', 'for', 'the', 'on', '&', 'de', 'des', 'du', 'für', 'und']);
// The year an author–date style prints right after the author: "(2026).", ", (2021)", ". 2023."
const YEAR_AFTER_AUTHOR = /^[\s.,;:]*(?:\(\s*(?:19|20)\d{2}[a-z]?\s*\)|(?:19|20)\d{2}[a-z]?\b)/;

/**
 * Is the cited "title" the name of the organisation that wrote the work, read by the parser in the author's place ("U.S.
 * Securities and Exchange Commission (2026). Tidal Trust V, post-effective amendment ...")? It opens the reference, the
 * year follows it, and it is an agency's name or capitalised words with an organisation's word among them. A record titled
 * after the organisation (a reference-work entry "Securities and Exchange Commission") is then no evidence about the
 * work, so no search result is matched by it.
 */
function titleIsAuthorName(c: ParsedCitation): boolean {
  if (c.title === undefined) return false;
  const raw = foldedText(c.raw);
  const title = foldedText(c.title).replace(/[\s.,;:]+$/, '');
  if (title === '' || !raw.startsWith(title) || !YEAR_AFTER_AUTHOR.test(raw.slice(title.length))) return false;
  if (AGENCY.test(title)) return true;
  const words = title.split(' ');
  // A number opens some names as a capital does: "1000 Genomes Project Consortium".
  // "Network" names a group only as a "Research Network": "Graph Attention Network (2018). ..." is a title-first title.
  return (words.some((w) => ORGANISATION_HEAD.test(w)) || /\bResearch Network$/.test(title)) && words.every((w) => /^[\p{Lu}\d]/u.test(w) || ORGANISATION_JOINING.has(w.toLowerCase()));
}

// The words that name a group writing research papers as one author: "Open Science Collaboration", "The UniProt Consortium",
// "GBD 2019 Diseases and Injuries Collaborators", "SPRINT Research Group", "Cancer Genome Atlas Research Network".
const RESEARCH_GROUP = /\b(?:Consortium|Collaborations?|Collaborators|Investigators|(?:Research|Study|Writing|Trial|Collaborative)\s+Group|Research\s+Network)\b/;

/**
 * Is the cited "title" a research group (a consortium, a collaboration, a trial's or study's group) named where the
 * authors go ("Open Science Collaboration (2015). Estimating the reproducibility of psychological science. Science ...")? The search then had only the group's name, so
 * nothing found for it says nothing about the work: Can't check, never Not found. Agencies and other bodies stay out:
 * they write reports, not journal papers, and "World Health Organization (2019). <title>. The Lancet ..." with nothing
 * found stays Not found.
 */
function titleIsResearchGroup(c: ParsedCitation): boolean {
  return titleIsAuthorName(c) && RESEARCH_GROUP.test(c.title ?? '');
}

/**
 * A search result that the reference's title says nothing about: the "title" is the authoring organisation's name
 * (titleIsAuthorName), or it is buried in the record's much longer title (isBuriedIn) and the cited authors and year do
 * not make it a near miss. The reference is then judged as if nothing matched it.
 */
function noTitleEvidence(c: ParsedCitation, r: WorkRecord): boolean {
  if (titleIsAuthorName(c)) return true;
  return hasTitle(c) && isBuriedIn(c.title, r.title) && !isNearMiss(c, r, scoreCandidate(c, r));
}

/** The record's volume and first page both stand as numbers in the reference after its title ("2008;51:107–113"). */
function locatorAgrees(c: ParsedCitation, r: WorkRecord): boolean {
  const page = r.pages?.[0];
  const after = textAfterTitle(c);
  if (r.volume === undefined || page === undefined || after === undefined) return false;
  const numbers: string[] = after.match(/[A-Za-z]?\d+/g) ?? [];
  return numbers.includes(r.volume) && numbers.some((n) => n.toLowerCase() === page.toLowerCase());
}

export function scoreCandidate(c: ParsedCitation, r: WorkRecord): CandidateScore {
  // With no author list parsed, the names may still stand in the title ("O.J. Ganor and A. Hanany, Small E(8) ..."):
  // the candidate is scored on the reference as it reads with that record in hand (resplitWithRecord).
  const read = c.authors.length === 0 ? resplitWithRecord(c, r) : c;
  const title = titleScore(read, r);
  const authors = authorScore(read, r);
  const yearOk = yearWithinTolerance(read.year, r.year);
  return { title, authors, yearOk, total: 0.6 * title + 0.3 * authors + (yearOk ? 0.1 : 0) };
}

/**
 * The best search result among those with a plausible title: highest title score first, then authors,
 * then year. Title scores within TITLE_TIE of each other count as tied, so a near-identical title cannot
 * outrank a better-attributed one on noise, and a weighted total can never let a worse title win.
 */
export function pickBest(c: ParsedCitation, rs: WorkRecord[]): WorkRecord | undefined {
  // An organisation's name read as the title matches records titled after the organisation, never the work.
  if (titleIsAuthorName(c)) return undefined;
  let best: { record: WorkRecord; score: CandidateScore } | undefined;
  for (const record of rs) {
    const score = scoreCandidate(c, record);
    if (score.title < CANDIDATE_TITLE && !isNearMiss(c, record, score)) continue;
    if (best === undefined || preferred(c, { record, score }, best)) best = { record, score };
  }
  return best?.record;
}

/**
 * Is candidate `a` a better reading of the reference than `b`? Candidates are ranked by a key, so the order is the same
 * whatever order the results came in: a record whose author list is implausible ranks below any other, and a record
 * whose authors agree with the reference ranks above any other ("Generative adversarial nets" by the cited authors, not
 * a 2023 book chapter of that name by someone else). Within a rank the title decides, then the authors, then the year
 * (beats): a record with no authors keeps its place among the others, and the cited authors' record with the cited title
 * and another year still beats their other paper of the cited year.
 */
function preferred(c: ParsedCitation, a: { record: WorkRecord; score: CandidateScore }, b: { record: WorkRecord; score: CandidateScore }): boolean {
  const ka = rankOf(c, a.record);
  const kb = rankOf(c, b.record);
  if (ka !== kb) return ka > kb;
  return beats(a.score, b.score);
}

/** The rank of a candidate before its scores are compared (see preferred). */
function rankOf(c: ParsedCitation, r: WorkRecord): number {
  if (hasImplausibleAuthors(r)) return 0;
  return genuineAuthorAgreement(c, r) ? 2 : 1;
}

/**
 * A record whose author list cannot be a real one: every "name" on it has no letter at all ("1", "2.") or is a single
 * Latin letter ("a"), as in some OpenAlex records. A name in any other script is a name, even of one character: most
 * Chinese family names are one Han character ("王"). Such a record is weak evidence on a search: never Verified or
 * Retracted there, and its list is never shown as differing from the cited authors. A record reached by the cited
 * identifier is judged as usual.
 */
export function hasImplausibleAuthors(r: WorkRecord): boolean {
  return r.authors.length > 0 && r.authors.every(isImplausibleName);
}

function isImplausibleName(name: string): boolean {
  const letters = name.replace(/\P{L}/gu, '');
  return letters === '' || (letters.length === 1 && /\p{Script=Latin}/u.test(letters));
}

const TITLE_TIE = 0.01;

/** Below CANDIDATE_TITLE, the lowest title similarity that can still be the cited work under a reworded title. */
const NEAR_MISS_TITLE = 0.6;
/** Content words a cited title needs, and the share of them the record's title must contain, for a near miss. */
const NEAR_MISS_MIN_WORDS = 4;
const NEAR_MISS_CONTAINED = 0.9;

/**
 * A record whose title is only close is still the cited work when the record's title contains (almost) every content
 * word of the cited one ("Framework for designing X" in "A General Framework for Designing X"; a journal title cited
 * for its longer arXiv title) and at least two cited authors and the year agree. A sibling paper by the same authors
 * shares their topic words, not all of the cited title. It is shown as Details differ (the title differs), never
 * Verified or Retracted: those need the stricter matches.
 */
function isNearMiss(c: ParsedCitation, r: WorkRecord, score: CandidateScore): boolean {
  if (score.title < NEAR_MISS_TITLE || !hasTitle(c) || c.authors.length < 2 || r.authors.length < 2) return false;
  if (c.year === undefined || r.year === undefined || !score.yearOk) return false;
  if (authorOverlap(c.authors, r.authors) < AUTHOR_OK - AUTHOR_SLACK) return false;
  const cited = descriptiveWords(c.title).filter((w) => !FUNCTION_WORDS.has(w));
  if (cited.length < NEAR_MISS_MIN_WORDS) return false;
  const record = new Set(titleWords(r.title));
  return cited.filter((w) => record.has(w)).length >= NEAR_MISS_CONTAINED * cited.length;
}

/**
 * The best of several strong matches. When the best ones are tied and exactly one of them is retracted (the same paper
 * published twice), a wrong pick would either hide the retraction or put it on the wrong paper, so the year and then
 * the venue the reference gives decide which one is meant; if they do not, the answer is 'ambiguous'.
 */
export function pickStrong(c: ParsedCitation, strong: WorkRecord[]): WorkRecord | 'ambiguous' | undefined {
  const best = pickBest(c, strong);
  if (best === undefined) return undefined;
  const top = scoreCandidate(c, best);
  const tied = strong.filter((r) => {
    const s = scoreCandidate(c, r);
    return Math.abs(s.title - top.title) <= TITLE_TIE && s.authors === top.authors && s.yearOk === top.yearOk;
  });
  if (tied.length < 2 || tied.filter((r) => r.isRetracted).length !== 1) return best;
  const sameYear = tied.filter((r) => r.year !== undefined && r.year === c.year);
  if (sameYear.length === 1) return sameYear[0];
  const pool = sameYear.length > 1 ? sameYear : tied;
  // A copy with no venue cannot be ruled out by the venue the reference names.
  if (pool.some((r) => venueWords(r.venue).length === 0)) return 'ambiguous';
  // The parsed venue is used when there is one; otherwise the text after the title (its last occurrence: the title may
  // also be quoted earlier in the entry). "Cell" is in "Stem cell niches" and says nothing about where it appeared.
  const parsedVenue = venueWords(c.venue);
  const at = c.title === undefined ? -1 : c.raw.lastIndexOf(c.title);
  const cited = parsedVenue.length > 0 ? parsedVenue : at >= 0 ? venueWords(c.raw.slice(at + (c.title?.length ?? 0))) : [];
  const sameVenue = pool.filter((r) => venueIsCited(venueWords(r.venue), cited));
  return sameVenue.length === 1 ? sameVenue[0] : 'ambiguous';
}

/** Words that may follow a venue's name without being part of it. */
const AFTER_VENUE = new Set(['vol', 'volume', 'no', 'number', 'pp', 'pages', 'issue', 'doi', 'arxiv', 'url']);

/** A venue or the text after a title as normalised words, without the "in" that introduces a venue. */
function venueWords(text: string | undefined): string[] {
  const words = titleWords(text ?? '');
  return words[0] === 'in' ? words.slice(1) : words;
}

/**
 * The record's venue is the one cited: it is what the citation's venue starts with, and what follows is not another
 * word of a longer name ("Cell" is not "Cell Reports", "Brain" is not "Brain Informatics"); a number, a volume or
 * page marker, or the end of the text does follow a venue.
 */
function venueIsCited(venue: string[], cited: string[]): boolean {
  if (venue.join(' ').length < 3 || venue.length > cited.length) return false;
  if (!venue.every((w, i) => cited[i] === w)) return false;
  const next = cited[venue.length];
  return next === undefined || /^\d/.test(next) || AFTER_VENUE.has(next);
}

function beats(a: CandidateScore, b: CandidateScore): boolean {
  if (Math.abs(a.title - b.title) > TITLE_TIE) return a.title > b.title;
  if (a.authors !== b.authors) return a.authors > b.authors;
  return a.yearOk && !b.yearOk;
}

/** Words that say something: pure numbers (years, volumes, pages) do not. */
function descriptiveWords(text: string): string[] {
  return titleWords(text).filter((w) => !/^\d+$/.test(w));
}

/** Links and identifiers taken out, leaving what the reference says about the paper. */
function withoutIdentifiers(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b(?:doi|arxiv)\s*:\s*\S+/gi, ' ')
    .replace(/\b10\.\d{4,9}\/\S+/g, ' ');
}

/**
 * The authors really agree. The record must have authors. With parsed authors: enough of the first three
 * cited surnames are on the record. With none parsed (the parser often misses them in journal styles): at
 * least two of the record's first three surnames (all of them, if it has fewer than two) are named in the
 * reference's author zone (see authorZone; never the title or venue), in any of their usual written forms.
 * An empty list is otherwise NOT agreement: it only means nothing could be compared; the lenient reading is
 * for scoring, not for serious verdicts.
 */
export function genuineAuthorAgreement(c: ParsedCitation, r: WorkRecord): boolean {
  if (r.authors.length === 0) return false;
  if (c.authors.length > 0) return authorOverlap(c.authors, r.authors) >= AUTHOR_OK - AUTHOR_SLACK;
  const names = recordNameCount(r);
  return names > 0 && recordAuthorsInZone(c, r) >= Math.min(2, names);
}

/**
 * A citation with an identifier and no title to compare is judged by the identifier alone, but not blindly: a
 * typo in the identifier lands on some other record, so the reference must confirm it unless it is bare. Years
 * out of range, or names that share no surname with the record, contradict it. A parsed author list confirms it
 * only when the record has authors and they overlap. Otherwise the author zone decides: empty, with no other
 * text about the paper, is a bare identifier (nothing to compare, so the identifier stands); a zone that names
 * one of the record's authors confirms it; any other zone (names of other people, only organisations, another
 * script, "See ref. 4", "Ibid.") or an empty zone beside other text leaves it unconfirmed. Absence of names is
 * neither agreement nor disagreement.
 */
function idOnlyEvidence(c: ParsedCitation, match: WorkRecord): 'consistent' | 'contradicted' | 'unconfirmed' {
  if (!yearWithinTolerance(c.year, match.year)) return 'contradicted';
  if (c.authors.length > 0) {
    if (match.authors.length === 0) return 'unconfirmed';
    return authorOverlap(c.authors, match.authors) > 0 ? 'consistent' : 'contradicted';
  }
  if (authorZone(c) === '') return descriptiveWords(withoutIdentifiers(c.raw)).length >= MIN_DESCRIPTIVE_WORDS ? 'unconfirmed' : 'consistent';
  if (!zoneNamesSomeone(c) || match.authors.length === 0) return 'unconfirmed';
  return recordAuthorsInZone(c, match) > 0 ? 'consistent' : 'contradicted';
}

/**
 * Checked by the identifier alone: a low-confidence citation that carries an identifier. Its parsed title
 * and authors are not to be trusted (they are usually fragments of something else), so they are not used for
 * scoring and cannot make a Wrong ID or a Details differ. The year and the raw text stay for the checks above:
 * a record from another decade, or one whose authors the reference does not name, contradicts the identifier.
 */
export function effectiveCitation(c: ParsedCitation): ParsedCitation {
  if (c.doi === undefined && c.arxivId === undefined) return c;
  // A "title" that is only names and a venue is no title either: the identifier and the author zone decide.
  if (c.confidence >= MIN_PARSE_CONFIDENCE && !(hasTitle(c) && c.authors.length === 0 && isNamesAndVenue(c.title))) return c;
  const out: ParsedCitation = { raw: c.raw, authors: [], kind: c.kind, confidence: c.confidence };
  if (c.doi !== undefined) out.doi = c.doi;
  if (c.arxivId !== undefined) out.arxivId = c.arxivId;
  if (c.year !== undefined) out.year = c.year;
  // A title-less journal reading keeps its venue: with the record in hand, words in front of the journal's name that the
  // record's journal does not account for are a title (withJournalLead).
  if (!hasTitle(c) && c.venue !== undefined) out.venue = c.venue;
  return out;
}

// Words of a venue or an identifier note that a title-less entry carries after its names.
const ID_NOTE_WORDS = new Set(['arxiv', 'preprint', 'eprint', 'e', 'print', 'in', 'press', 'submitted', 'to', 'appear', 'corr', 'abs']);
const NAME_LIKE_WORDS = new Set(['and', 'et', 'al', 'van', 'von', 'de', 'der', 'den', 'del', 'della', 'di', 'da', 'du', 'la', 'le', 'ter', 'ten', 'dos', 'das', 'do']);
// "E. Bousquet, M. Fava", "Bousquet, E.,": a reference that opens with a name.
const OPENS_WITH_NAME = /^(?:\p{Lu}\.\s?|\p{Lu}[\p{L}'’-]+,\s\p{Lu}\.)/u;

/**
 * A "title" that is only an author list and a venue, as in the title-less styles of physics journals ("E. Bousquet,
 * M. Fava, and A. H. Romero, Journal of Physics: Condensed Matter (2024), 10.1088/...", "D. Sivan and M. Tsodyks,
 * arXiv preprint arXiv:2411.12728"). It opens with a name and, identifiers and identifier notes aside, has no
 * ordinary lower-case words. A reference like that is checked by its identifier and its author zone.
 */
export function isNamesAndVenue(title: string): boolean {
  if (!OPENS_WITH_NAME.test(title.trim())) return false;
  const rest = withoutIdentifiers(title).replace(/\barXiv:\s*\S+/gi, ' ');
  for (const word of rest.split(/[\s,;()]+/)) {
    const first = word.charAt(0);
    if (first === '' || first === first.toUpperCase()) continue;
    const plain = normalizeTitle(word);
    if (plain === '' || ID_NOTE_WORDS.has(plain) || NAME_LIKE_WORDS.has(plain) || FUNCTION_WORDS.has(plain)) continue;
    return false;
  }
  return true;
}


/**
 * The reference as it is compared with a matched record, for the verdict and for the retraction lookup alike: words cut
 * off after its title that read as more of the title stay with it (withTitleTail), and the record may show where its
 * author list ends and its title begins (resplitWithRecord).
 */
export function comparedWith(c: ParsedCitation, r: WorkRecord): ParsedCitation {
  return resplitWithRecord(withVenueLead(withTitleTail(withJournalLead(c, r)), r), r);
}

/**
 * A title-less journal reading compared with a record: the words in front of the journal's name that the record's
 * journal does not account for are its title ("M. G. Alford, ..., Dark matter from locked quarks. Nucl. Phys. B537,
 * 10.1016/..." against Nuclear Physics B), so an invented title before a real article's journal is compared as one, never
 * passed over (journalNameLead).
 */
function withJournalLead(c: ParsedCitation, r: WorkRecord): ParsedCitation {
  const lead = journalNameLead(c, r);
  if (lead === undefined || lead === 'unaccounted') return c;
  const titled = { ...c, title: lead.title, venue: lead.venue };
  // Names the record does not list keep the reading without a title when that title is the record's: a real title written
  // in front of the journal is no reason to pass over them, and the identifier alone is judged as before.
  return namesNotOnRecord(c, r) && citedTitleScore(titled, r) >= VERIFIED_TITLE ? c : titled;
}

/** The reference names people, and none of them is on the record (read from the author zone when no list was parsed). */
function namesNotOnRecord(c: ParsedCitation, r: WorkRecord): boolean {
  if (r.authors.length === 0) return false;
  if (c.authors.length > 0) return authorOverlap(c.authors, r.authors) === 0;
  return zoneNamesSomeone(c) && recordAuthorsInZone(c, r) === 0;
}

/**
 * Shown when a title-less journal reading holds words in front of the journal's name that could be a title, and the
 * record has no journal name that tells which of them are the journal's.
 */
const JOURNAL_LEAD_UNACCOUNTED = "Words before the journal's name may be a title, and the record has no matching journal name to tell, so it couldn't be compared";

/**
 * Is this record the cited paper, firmly enough to be called Retracted (and to be worth a retraction
 * lookup)? The title is almost the same AND the authors genuinely agree AND the years are compatible; or,
 * when authors cannot be compared, the title is almost identical and the years are compatible. This is
 * deliberately narrower than the test for Verified, and it applies the same way to matches found by
 * identifier and by search: an identifier can point at the wrong record too.
 */
export function isStrongMatch(c: ParsedCitation, match: WorkRecord, via?: 'id' | 'search'): boolean {
  if (!hasUsableTitle(match) || (via !== 'id' && (hasImplausibleAuthors(match) || titleIsAuthorName(c)))) return false;
  // Nothing was cited to compare with. A search hit then proves nothing, but a record reached through the
  // cited identifier IS the paper the identifier names, unless the other details contradict it.
  if (!hasTitle(c)) return via === 'id' && idOnlyEvidence(c, match) === 'consistent';
  // The cited year may be that of any version of the work (preprint, online, print), as for Verified.
  if (!yearAgrees(c, match)) return false;
  const title = citedTitleScore(c, match);
  // Agreement read from the author zone (no parsed list) is weaker evidence than a parsed list, so the title
  // must still be specific: "Thomas Roe. Editorial." against an "Editorial" by Thomas is no match.
  const specific = c.authors.length > 0 || titleWords(c.title).length >= MIN_NO_AUTHOR_STRONG_WORDS;
  if (title >= STRONG_TITLE && specific && genuineAuthorAgreement(c, match)) return true;
  // Without authors to compare the title must be almost identical, and long enough to be specific:
  // "Editorial" or "See above" names thousands of unrelated pieces.
  const authorsMissing = c.authors.length === 0 || match.authors.length === 0;
  return authorsMissing && title >= STRONG_TITLE_NO_AUTHORS && titleWords(c.title).length >= MIN_NO_AUTHOR_STRONG_WORDS;
}

/**
 * Is this record the cited paper well enough to be called Verified? An id match counts unless the id points
 * to a different paper. A search match needs the title to match and the authors to agree; when either side
 * lists no authors the title alone must be nearly exact. A match that is only "close" may still be shown as
 * Details differ. (Retracted needs the stricter `isStrongMatch`.)
 */
export function isConfidentMatch(c: ParsedCitation, match: WorkRecord, via: 'id' | 'search' | undefined): boolean {
  if (via === 'id') return !isWrongId(c, match);
  if (hasImplausibleAuthors(match) || titleIsAuthorName(c)) return false;
  const title = titleScore(c, match);
  if (title < VERIFIED_TITLE) return false;
  if (c.authors.length === 0 || match.authors.length === 0) return title >= NO_AUTHOR_TITLE;
  return genuineAuthorAgreement(c, match);
}

/**
 * The arXiv record of the cited work differs from the reference only in its year, which is later than the posting by
 * more than the preprint window: the reference cites the journal version ("Commun. Num. Theor. Phys. 18 (2024) 653
 * [2001.06022]" for a paper posted in 2020, whose arXiv record names no journal). The engine then looks for that version
 * in Crossref by its title (see the engine's step 3b). A DOI in the reference names its own record.
 */
export function citesLaterVersion(c: ParsedCitation, idRecord: WorkRecord): boolean {
  if (idRecord.source !== 'arxiv' || c.doi !== undefined || !hasTitle(c) || !hasUsableTitle(idRecord)) return false;
  if (c.year === undefined || idRecord.year === undefined || c.year <= idRecord.year) return false;
  const compared = comparedWith(c, idRecord);
  const diffs = fieldDiffs(compared, idRecord);
  return diffs.length === 1 && diffs[0]?.field === 'year' && isConfidentMatch(compared, idRecord, 'search');
}

const ID_OCCURRENCE =/\b10\.\d{4,9}\/|\barxiv(?:\.org)?(?:\s*[:/.]\s*|\s+)(?:(?:abs|pdf)\/)?\d{4}\.\d{4,5}|\b[a-z-]+(?:\.[A-Z]{2})?\/\d{7}/gi;
const YEAR_WORD = /(?<![\d.])(?:19|20)\d{2}(?!\d|\.\d)/g;
/** Longer than this, a text is not one reference however it reads. */
const MAX_ONE_WORK_CHARS = 4000;

// A piece of an author list: "A. B. Name", "Aaron Jaech", "DeepSeek-AI", "and C. Person" (a few capitalised words).
// Each word is cut at its single space, so a run of capitals can be read only one way: a form that let words touch
// took minutes on a long run. No name is longer than MAX_NAME_PIECE_CHARS.
const NAME_PIECE = /^(?:(?:and|&)\s+)?\p{Lu}[\p{L}\d'’.-]*(?:\s\p{Lu}[\p{L}\d'’.-]*){0,3}\s?$/u;
const MAX_NAME_PIECE_CHARS = 200;
const isNamePiece = (piece: string): boolean => piece.length <= MAX_NAME_PIECE_CHARS && NAME_PIECE.test(piece);
// Two people named together ("B. Other and C. Person", "Other, B., Person, C."): the author list of another reference.
const NAME_PAIR = /\b\p{Lu}\.(?:\s?-?\p{Lu}\.)*\s?\p{Lu}[\p{L}'’-]+(?:,\s+|\s+and\s+|\s*&\s*)\p{Lu}\.(?:\s?-?\p{Lu}\.)*\s?\p{Lu}[\p{L}'’-]+|\b\p{Lu}[\p{L}'’-]+,\s\p{Lu}\.(?:\s?\p{Lu}\.)*,?\s(?:and\s|&\s)?\p{Lu}[\p{L}'’-]+,\s\p{Lu}\./u;

/**
 * An overlong text that still names one work: one identifier and one year, the length coming from a long author list
 * (a technical report with hundreds of authors). Several references run together carry several of each, or (when the
 * first has no year, "in preparation") another list of names after the first one's title.
 */
function isOneWork(raw: string): boolean {
  if (raw.length > MAX_ONE_WORK_CHARS) return false;
  const ids = raw.match(ID_OCCURRENCE) ?? [];
  const years = new Set(raw.match(YEAR_WORD) ?? []);
  if (ids.length !== 1 || years.size > 1) return false;
  const pieces = raw.slice(0, raw.search(ID_OCCURRENCE)).split(/,\s+/);
  let names = 0;
  while (names < pieces.length && isNamePiece((pieces[names] ?? '').trim())) names++;
  return !NAME_PAIR.test(pieces.slice(names).join(', '));
}

/** The reason for a book-kind reference that says it was never published (and is no thesis), or undefined. */
function notPublishedReason(raw: string): string | undefined {
  if (THESIS.test(raw)) return undefined;
  return NOT_PUBLISHED.find(([pattern]) => pattern.test(raw))?.[1];
}

/** Cases that need no lookup. The engine calls this first so it never sends them anywhere. */
export function preLookupVerdict(c: ParsedCitation): Verdict | undefined {
  const hasId = c.doi !== undefined || c.arxivId !== undefined;
  // Several works under one number: the identifier, the title, the venue and the numbers may each be another work's.
  if (citesSeveralWorks(c.raw)) return cantCheck(SEVERAL_WORKS_REASON);
  if (!hasId && IACR_EPRINT.test(c.raw)) return cantCheck(IACR_REASON);
  if (!hasId && c.kind === 'web' && REPORT.test(c.raw)) return cantCheck(REPORT_REASON);
  if (!hasId && (c.kind === 'web' || c.kind === 'software')) return cantCheck('Looks like a website or software, not a paper, so there is nothing to look up');
  if (!hasId && c.kind === 'book') return cantCheck(notPublishedReason(c.raw) ?? BOOK_REASON);
  // Low parse confidence is about the title and authors; a valid identifier is enough to look a reference up.
  // An overlong text with an identifier is usually several references run together: the identifier may be any one's,
  // unless it carries only one identifier and one year (one work with hundreds of authors).
  if (c.confidence < MIN_PARSE_CONFIDENCE && (!hasId || (c.raw.length > MAX_UNRELIABLE_ID_CHARS && !isOneWork(c.raw)))) return cantCheck(UNREADABLE);
  // Nothing to look up by: no identifier and no title to search for.
  if (!hasId && !hasTitle(c)) return cantCheck(UNREADABLE);
  return undefined;
}

/**
 * Shown when nothing was found for a reference in which no journal, conference or other scholarly venue could be read.
 * It says what the check could read, not what the reference contains: a venue the rules below do not know may be there.
 */
const NO_VENUE_NOT_LISTED =
  "Not in Crossref, arXiv, OpenReview or OpenAlex, and no journal or conference could be read from it: reports, manuals, news and other works like it are often not listed there";
// Dates and years say when, not where: "August 4, 1998", "June 2005", "(1903)", "2015-2018".
const MONTH_DAY_YEAR = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},\s*(?:19|20)\d{2}/gi;
const YEARS = /\b(?:1[5-9]|20)\d{2}[a-z]?\b/g;
// A version says which draft, not where a work appeared: "OpenReview [Position paper] 0.9.2", "v1.2", "version 3.1".
// Only a "v" with a dotted number, the word "version", or three dotted parts: "21.3" or "521.7553" may be a volume and
// issue ("Nature 521.7553").
const VERSION_NUMBERS = /\bv\d{1,4}(?:\.\d{1,4}){1,3}\b|\bversion\s+\d{1,4}(?:\.\d{1,4}){0,3}\b|(?<![\d.])\d{1,3}(?:\.\d{1,4}){2,3}(?![\d.]*\d)/gi;
// Grey literature named as such. "Lecture Notes in ..." is a book series, not a lecture's notes, and is not listed here.
const GREY_LITERATURE = /\b(?:technical\s+(?:report|paper|memo(?:randum)?|note)|tech\.?\s+rep\.?|white\s?paper|training\s+manual|user'?s?\s+(?:manual|guide)|internal\s+report|report\s+no\.|lecture\s+(?:notes?\s+(?:on|for)\b|slides|\d)|course\s+(?:notes|slides|materials?)|\bcoursera\b|\bslides\b)/i;
// Conference and journal acronyms, cased as they are written ("ICLR 2021", "In NeurIPS", "PNAS").
const VENUE_ACRONYMS = /(?<![\p{L}\d])(?:NeurIPS|NIPS|ICML|ICLR|CVPR|ICCV|ECCV|WACV|BMVC|ACL|EMNLP|NAACL|EACL|AACL|COLING|CoNLL|LREC|AAAI|IJCAI|KDD|SIGKDD|SIGIR|SIGMOD|VLDB|ICDE|WSDM|CIKM|RecSys|ICDM|WWW|CHI|UIST|CSCW|UAI|AISTATS|COLT|TMLR|JMLR|PMLR|PNAS|ICASSP|INTERSPEECH|Interspeech|MICCAI|ICRA|IROS|CoRL|SIGGRAPH|NDSS|USENIX|OSDI|SOSP|NSDI|ISCA|ASPLOS|PLDI|POPL|ICSE|STOC|FOCS|SODA|ICALP|IJCNN|ICPR|ICIP|ECML|PKDD|JHEP|JCAP|PRL)(?![\p{L}])/u;
// A journal's dotted abbreviation: two short capitalised words with full stops, not both single letters ("Phys. Rev.
// Lett.", "J. Mach. Learn. Res."; "U.S." is no journal).
const DOTTED_JOURNAL = /(?:^|[\s,(])(?:\p{Lu}\p{Ll}{1,6}\.\s?\p{Lu}\p{Ll}{0,6}\.|\p{Lu}\.\s?\p{Lu}\p{Ll}{1,6}\.)/u;
// The same without full stops, as Vancouver style writes it, closed by a full stop and the year or the end: "Nat Mach
// Intell. 2021". Three words, or two that open with a usual abbreviation ("Nat Commun", "Sci Rep"); six letters at most
// each, as abbreviations are ("Towards Data Science" is a blog).
const UNDOTTED_JOURNAL = /^(?:(?:\p{Lu}\p{Ll}{0,5}\s){2,5}|(?:Nat|Sci|Phys|Proc|Ann|Int|Eur|Am|Clin|Med|Biol|Chem|Neural|Mach|Comput|IEEE)\s)\p{Lu}\p{Ll}{0,5}\.\s*(?:(?:19|20)\d{2}[a-z]?\.?)?$/u;
// Journals named by one word or a fixed phrase, which no venue word marks. A curated list on purpose: a name read from
// its last word ("... Networks", "... Statistics", "... Engineering") is as often a company or an agency (Cisco
// Systems, Bureau of Labor Statistics, Uber Engineering), and an unknown name leaves the reference Can't check.
const JOURNAL_NAMES = new Set([
  'neuron', 'cell', 'lancet', 'bioinformatics', 'neurocomputing', 'automatica', 'biometrika', 'biometrics', 'econometrica', 'cognition', 'elife', 'entropy', 'sensors', 'neuroimage', 'nanoscale', 'optica', 'nonlinearity',
  'neural networks', 'neural computation', 'machine learning', 'artificial intelligence', 'pattern recognition', 'information sciences', 'information fusion', 'knowledge-based systems', 'expert systems with applications',
  'neural computing and applications', 'neural processing letters', 'computational linguistics', 'cognitive science', 'psychological science', 'psychological review', 'empirical software engineering',
  'qualitative research in psychology', 'computer vision and image understanding', 'image and vision computing', 'data mining and knowledge discovery', 'statistics and computing', 'computers & security',
  'communications of the acm', 'plos one', 'plos computational biology', 'scientific reports', 'ieee access', 'nucleic acids research', 'genome research', 'genome biology', 'current biology', 'cerebral cortex',
  'physical review a', 'physical review b', 'physical review c', 'physical review d', 'physical review e', 'physical review x', 'physical review research', 'classical and quantum gravity', 'general relativity and gravitation',
]);

// Words of a company, a news outlet, an institution or a meeting: such a name after a title is no journal ("Google
// Research", "OpenAI Blog", "Annual Meeting of the Society for Neuroscience", whose abstracts no database lists).
const ORGANISATION_WORDS = new Set(['google', 'openai', 'deepmind', 'microsoft', 'meta', 'facebook', 'amazon', 'apple', 'ibm', 'nvidia', 'baidu', 'alibaba', 'tencent', 'huawei', 'samsung', 'intel', 'blog', 'news', 'inc', 'ltd', 'llc', 'corp', 'corporation', 'company', 'lab', 'labs', 'laboratory', 'institute', 'university', 'college', 'school', 'department', 'center', 'centre', 'foundation', 'team', 'group', 'press', 'times', 'post', 'report', 'guardian', 'wired', 'reuters', 'bloomberg', 'forbes', 'verge', 'economist', 'atlantic', 'medium', 'substack', 'techcrunch', 'meeting', 'society', 'abstract', 'abstracts', 'poster']);

/** The reference's text after its title (the last place the title occurs), or the parsed venue if the title is not in it. */
function textAfterTitle(c: ParsedCitation): string | undefined {
  const at = c.title === undefined ? -1 : c.raw.lastIndexOf(c.title);
  return at >= 0 ? c.raw.slice(at + (c.title?.length ?? 0)) : c.venue;
}

/**
 * Does the text after the title name a journal or conference that no venue word marks? A known acronym ("ICLR 2021",
 * "PNAS"), a journal abbreviation ("Phys. Rev. Lett.", "Nat Mach Intell. 2021") or, as the part right after the title,
 * a known journal's name ("Neural Computation", "The Lancet", "Bioinformatics"). Company, news and institution names
 * are not, nor is a journal name the list does not know (the safe side: Can't check).
 */
function namesAJournal(after: string): boolean {
  const text = after.replace(/https?:\/\/\S+/gi, ' ');
  if (VENUE_ACRONYMS.test(text) || DOTTED_JOURNAL.test(text)) return true;
  const rest = text.replace(/^[\s.,;:"”’)\]]+/, '');
  const segment = /^[^.,;(\d]*/.exec(rest)?.[0].trim() ?? '';
  if (!/^\p{Lu}/u.test(segment)) return false;
  const words = titleWords(segment);
  if (words.some((w) => ORGANISATION_WORDS.has(w))) return false;
  if (words[0] !== 'the' && UNDOTTED_JOURNAL.test(rest)) return true;
  const name = (words[0] === 'the' ? words.slice(1) : words).join(' ');
  return JOURNAL_NAMES.has(name) || JOURNAL_NAMES.has(segment.toLowerCase().replace(/^the\s+/, ''));
}

/**
 * Does the reference say where it was published, so that the scholarly databases should know it? The parser's kind
 * 'paper' (a venue word, "In ...", an identifier) does, so does any number outside the title that is not a date
 * (a volume, pages, an article number: "Nanophotonics 8 (2019) 1945", "JHEP 09 (2022) 019"), and so does a journal or
 * conference named after the title without a venue word (namesAJournal). A reference with none of these (a company
 * report, a manual, a news story, a survey's name, an old thesis), or one that calls itself a technical report or white
 * paper, is a real work these databases often do not list, so their silence says nothing about it.
 */
function namesAVenue(c: ParsedCitation): boolean {
  if (GREY_LITERATURE.test(c.raw)) return false;
  if (c.kind === 'paper') return true;
  // A note field after the title ("Note: Product ID: GLOBAL_..._001_032") is no venue, and neither are its numbers. A
  // title that opens with "Note:" ("Note: A compact laser source", a common form in some journals) is no note field.
  const at = c.title === undefined || c.title === '' ? -1 : c.raw.lastIndexOf(c.title);
  const raw = at < 0 ? c.raw : `${c.raw.slice(0, at)} ${withoutNoteField(c.raw.slice(at + (c.title?.length ?? 0)))}`;
  const rest = raw.replace(/https?:\/\/\S+/gi, ' ').replace(VERSION_NUMBERS, ' ').replace(MONTH_DAY_YEAR, ' ').replace(YEARS, ' ');
  if (/\d/.test(rest)) return true;
  const after = textAfterTitle(c);
  return after !== undefined && namesAJournal(withoutNoteField(after));
}

/** Shown when nothing was found for legislation, a dataset or an agency's document: such works are in no database. */
const DOCUMENT_NOT_LISTED =
  "Not in Crossref, arXiv, OpenReview or OpenAlex, and it reads as legislation, a dataset or an agency's document: such works are often not listed there";
// Legislation named by its designation, as its title: "Directive (EU) 2023/959", "Regulation (EC) No 1907/2006",
// "Council Directive 92/43/EEC", "Commission Implementing Regulation (EU) 2018/2066".
const LEGISLATION_TITLE =
  /^(?:(?:Commission|Council|European\s+Parliament\s+and\s+Council)\s+)?(?:(?:Implementing|Delegated)\s+)?(?:Directive|Regulation|Decision)\s+(?:\((?:EU|EC|EEC|Euratom)\)\s+)?(?:No\.?\s*)?\d{2,4}\/\d{1,4}\b/;
// An official gazette and the citation that follows it: "Official Journal of the European Union, L 130, 16.5.2023, p.
// 134–202", "OJ L 396, 30.12.2006", "Pub. L. No. 117-169, 136 Stat. 1818", "42 U.S.C. § 7401 et seq.", "88 Fed. Reg.
// 1234". The tail takes only punctuation, numbers and the gazette's own abbreviations, so a journal named after it stays.
const GAZETTE =
  /(?:\b\d{1,3}\s+)?(?:\bOfficial\s+Journal\s+of\s+the\s+European\s+(?:Union|Communities)\b|\bO\.?J\.?\s+[LC]\b|\bPub\.\s*L\.(?=\s*(?:No\.?\s*)?\d+-\d+)|\bPublic\s+Law\s+(?:No\.?\s*)?(?=\d+-\d+)|\bU\.\s?S\.\s?C\.|(?<=\d\s)Stat\.|\bFed\.\s*Reg\.|\bFederal\s+Register\b)(?:[^\p{L}]|\b(?:L|C|No|Nr|p|pp|S|Stat|seq|et)\b)*/gu;
const NAMES_A_GAZETTE = new RegExp(GAZETTE.source, 'u');
// A dataset or product named by its identifier or a label: "Product ID: GLOBAL_MULTIYEAR_WAV_001_032", "DATASET_ID: ...",
// "[Data set]". With the identifier itself, and any code joined by underscores, for the venue test of what is left.
const DATASET_MARK = /\b(?:product|dataset|data\s*set)[\s_]*(?:id|identifier)\b|\[\s*(?:data\s*set|dataset)\s*\]/i;
const DATASET_CODES = /\b(?:product|dataset|data\s*set)[\s_]*(?:id|identifier)\b\s*:?\s*[\w.:/-]*|\[\s*(?:data\s*set|dataset)\s*\]|[\w.-]*_[\w.-]*/gi;
// Agencies that publish documents no scholarly database lists, named as a reference's only author.
const AGENCY =
  /^(?:the\s+)?(?:OECD|IMO|IEA|IPCC|IRENA|UNCTAD|UNEP|UNFCCC|UNDP|UNESCO|ICAO|FAO|IMF|WTO|ILO|EEA|EPA|NOAA|Eurostat|European\s+(?:Union|Commission|Environment\s+Agency)|United\s+Nations|World\s+Bank|World\s+Health\s+Organi[sz]ation|International\s+(?:Maritime\s+Organi[sz]ation|Energy\s+Agency|Monetary\s+Fund)|Marine\s+Environment\s+Protection\s+Committee|(?:E\.?U\.?\s+)?Copernicus(?:\s+\p{Lu}[\p{L}-]*){0,5})$/u;
// An agency's document number: "Resolution MEPC.377(80)", "Report No. 12", "Working Paper 2021/3".
const DOCUMENT_NUMBER = /\b(?:Resolution|Decision|Document|Doc\.|Circular|Report|Paper|Note|Brief|Series|No\.)\s*(?:No\.\s*)?[A-Z]{0,8}[.\s]?\d[\w.()/-]*/g;
// A release named by its quarter: "2025-Q1", "2024 Q3".
const QUARTERS = /\b(?:19|20)\d{2}[\s-]?Q[1-4]\b/g;
// Words of a journal, a proceedings volume or a preprint server: a reference that names one is a paper.
const PAPER_VENUE =
  /\b(?:journal|transactions|letters|annals|bulletin|quarterly|magazine|review|proceedings|conference|workshop|symposium|arxiv|preprint|biorxiv|medrxiv|ssrn|corr|nature|science|lancet|cell|plos|pnas|bmj|jama|nejm|physica|ieee|acm)\b|\badvances\s+in\b|\b(?:proc|trans|adv|syst|lett|rev|phys)\.|(?:^|[.,;]\s*)In:?\s+\p{Lu}/iu;

/**
 * Is a reference that nothing matched legislation, a dataset or an agency's document? Legislation by its designation as
 * the title or an official gazette after it, a dataset by its identifier, a document by an agency as its only author.
 * Only with no identifier, and only when what is left after the title, once the note field, the gazette citation, the
 * dataset codes and the agency's document numbers are taken out, names no journal, proceedings, conference or preprint and
 * holds no number but dates: an invented journal paper by an agency, or about a directive, still names its journal and
 * volume, and stays Not found.
 */
function readsAsDocument(c: ParsedCitation): boolean {
  if (c.title === undefined || c.doi !== undefined || c.arxivId !== undefined) return false;
  const raw = foldedText(c.raw);
  const title = foldedText(c.title);
  const at = title === '' ? -1 : raw.lastIndexOf(title);
  if (at < 0) return false;
  let after = raw.slice(at + title.length).replace(/https?:\/\/\S+/gi, ' ');
  const authors = raw.slice(0, at).replace(/\(\s*(?:19|20)\d{2}[a-z]?\s*\)/g, ' ').replace(/[\s.,;:]+$/, '').trim();
  // "World Bank (2024). State and trends ... Report No. ...": the parser took the agency for the title, so the work's own
  // title is the first sentence after it, and only what follows that is read.
  const agencyAsTitle = AGENCY.test(title.replace(/[\s.,;:]+$/, ''));
  if (agencyAsTitle) {
    // The work's own title runs to the first full stop or comma; a journal is never taken with it.
    after = after.replace(/^[\s.,;:]*(?:\(\s*(?:19|20)\d{2}[a-z]?\s*\)[\s.,;:]*)?/, '');
    const ownTitle = /^[\s\S]*?(?:[.,]\s+|\.?$)/.exec(after)?.[0] ?? '';
    if (!PAPER_VENUE.test(ownTitle) && !namesAJournal(ownTitle)) after = after.slice(ownTitle.length);
  }
  if (!agencyAsTitle && !LEGISLATION_TITLE.test(title) && !NAMES_A_GAZETTE.test(after) && !DATASET_MARK.test(after) && !AGENCY.test(authors)) return false;
  const left = withoutNoteField(after).replace(GAZETTE, ' ').replace(DATASET_CODES, ' ').replace(DOCUMENT_NUMBER, ' ');
  if (PAPER_VENUE.test(left) || namesAJournal(left)) return false;
  return !/\d/.test(left.replace(QUARTERS, ' ').replace(TALK_DATES, ' ').replace(MONTH_DAY_YEAR, ' ').replace(YEARS, ' ').replace(ORDINALS, ' '));
}

/** Shown when nothing was found for a reference that reads as a talk: the talk itself is in no database. */
const TALK_NOT_LISTED =
  "Not in Crossref, arXiv, OpenReview or OpenAlex, and it reads as a talk, slides or other material from a meeting: such works are often not listed there";
// A talk named as such after its title: "Invited talk", "Keynote", "Tutorial", "Slides", "Presentation at ...", "Lecture".
const TALK_WORDS = /\b(?:talks?|keynotes?|tutorials?|slides|plenary|presentations?|lectures?)\b/i;
// "Lecture Notes in Computer Science" and the like are book series of proceedings, not lectures.
const LECTURE_NOTES = /\blecture\s+notes\b/gi;
// A talk named by what it is, as a sentence of its own: "Keynote", "Invited talk", "Tutorial", "Plenary lecture", "Keynote
// address given at ...", "Lecture at ...". A paper's own designation ("oral presentation", "contributed talk") is none,
// and neither is a sentence that only opens with a talk word ("A tutorial review", "Keynote speakers and ...").
const TALK_DESIGNATION =
  /^(?:an?\s+)?(?:(?:keynote|plenary|invited|tutorial)\s+(?:talk|lecture|address|speech|presentation|tutorial)s?|keynotes?|plenary|invited\s+talks?|tutorials?|talks?|lectures?|slides)(?:\s+(?:(?:given|presented|delivered)\s+)?(?:at|to)\s+\S.*)?$/i;
// Where a sentence of the text after a title ends; a spaced dash sets a designation off too ("Keynote talk - Title").
const SENTENCE_BREAK = /[.;,:()[\]]|\s[-–—]\s/;
// Words that hold a talk word but name a paper: a venue's own name ("IEEE Communications Surveys & Tutorials", "ACL 2020:
// Tutorial Abstracts") and a paper's designation ("oral presentation", "spotlight talk", "contributed talk", "long talk").
// They are removed before the talk words are looked for.
const PAPER_WORDS_WITH_TALK_WORDS = /\bsurveys?\s*(?:&|\+|and)?\s*tutorials\b|\btutorial\s+abstracts\b|\b(?:oral|spotlight|poster|contributed|long|short|paper)\s+(?:talks?|presentations?)\b/gi;
// A proceedings volume named "Talks", as cased: "ACM SIGGRAPH 2019 Talks", "SIGGRAPH Talks", "<ACRONYM> <year> Talks".
// Case-sensitive, so "invited talks", "the talks" and "TED Talks" are still talks.
const TALKS_VOLUME = /\bSIGGRAPH(?:\s+Asia)?\s+(?:(?:19|20)\d{2}\s+)?Talks\b|\b\p{Lu}{2,}[\p{L}-]*\s+(?:19|20)\d{2}\s+Talks\b/gu;
// A journal or a "Proceedings of" volume after the title: the reference is a paper in it, and a talk word before it is
// the rest of a title the parser cut short ("... retrieval. A tutorial review. Journal of ...").
const JOURNAL_AFTER = /\b(?:journal|transactions|letters|annals|bulletin|quarterly|magazine)\b|\bproceedings\s+of\b/i;
// "Proceedings from <meeting>": how a talk at a meeting gets cited. A paper in a proceedings volume says "Proceedings of"
// (also after "Proceedings from": "Proceedings from Proceedings of CVPR") or gives its pages.
const PROCEEDINGS_FROM = /\bproceedings\s+from\b/i;
const ORDINALS = /\b\d+(?:st|nd|rd|th)\b/gi;
// The dates a talk is cited with: "7 July 2015", "6-11 July", "July 6-11", "July 6-11, 2015", "2015-07-07".
const MONTH_NAME = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b\\.?';
const TALK_DATES = new RegExp(
  `\\b\\d{1,2}(?:\\s*[-–]\\s*\\d{1,2})?\\s+${MONTH_NAME}(?:,?\\s+(?:19|20)\\d{2})?\\b|\\b${MONTH_NAME}\\s+\\d{1,2}(?:\\s*[-–]\\s*\\d{1,2})?(?:,?\\s*(?:19|20)\\d{2})?\\b|\\b(?:19|20)\\d{2}-\\d{2}-\\d{2}\\b`,
  'gi',
);

/** Text as the parser reads it: a word broken by a hyphen at a line end joined, whitespace collapsed. */
function foldedText(s: string): string {
  return joinLineEndHyphens(s).replace(/\s+/g, ' ').trim();
}

/**
 * Does the reference name itself a talk, as a sentence of its own: right after its title ("Title. Keynote talk. In
 * Proceedings of ..."), anywhere after it ("..., ICML 2015. Invited lecture."), or before the title, set off by a colon or a
 * spaced dash ("Invited talk: Title")? Such a word says what the work is, whatever venue follows.
 */
function namedAsTalk(title: string, after: string): boolean {
  const head = /^(.*?)(?::|\s[-–—]\s)/.exec(title)?.[1]?.trim();
  if (head !== undefined && TALK_DESIGNATION.test(head)) return true;
  return after.split(SENTENCE_BREAK).some((sentence) => TALK_DESIGNATION.test(sentence.trim()));
}

/**
 * Does the reference say that it is a talk (a keynote, a tutorial, a lecture, slides, a presentation), or cite nothing
 * after its title but the "proceedings from" a meeting? A talk is real and is in none of the databases, whatever meeting
 * it names. Only with no identifier and no page, volume or number after the title (dates and ordinals aside): those make
 * it a paper. A journal or "Proceedings of" volume after the title makes it a paper too, unless the reference names
 * itself a talk in a sentence of its own (namedAsTalk): a keynote or tutorial is often cited with the meeting's
 * proceedings. Only the text after the title and a designation that opens the title are read, never the names, and
 * nothing is read when the parsed title cannot be found in the reference.
 */
function readsAsTalk(c: ParsedCitation): boolean {
  if (c.title === undefined || c.doi !== undefined || c.arxivId !== undefined) return false;
  const raw = foldedText(c.raw);
  const title = foldedText(c.title);
  const at = title === '' ? -1 : raw.lastIndexOf(title);
  if (at < 0) return false;
  const after = raw.slice(at + title.length).replace(/https?:\/\/\S+/gi, ' ');
  const designated = namedAsTalk(title, after);
  if (JOURNAL_AFTER.test(after) && !designated) return false;
  const undated = after.replace(MONTH_DAY_YEAR, ' ').replace(YEARS, ' ').replace(ORDINALS, ' ');
  // "Proceedings from" is the weaker sign: any number besides a year or an ordinal ("July 18-24") makes it a paper.
  if (PROCEEDINGS_FROM.test(after) && !/\d/.test(undated)) return true;
  if (/\d/.test(after.replace(TALK_DATES, ' ').replace(YEARS, ' ').replace(ORDINALS, ' '))) return false;
  return designated || TALK_WORDS.test(after.replace(PAPER_WORDS_WITH_TALK_WORDS, ' ').replace(TALKS_VOLUME, ' ').replace(LECTURE_NOTES, ' '));
}

/** Shown when nothing was found for a talk about software, cited with its repository: neither is in these databases. */
const SOFTWARE_TALK_NOT_LISTED =
  "Not in Crossref, arXiv, OpenReview or OpenAlex, and it reads as a talk about software at a technology conference, cited with its code repository: such works are often not listed there";
const REPOSITORY = /\b(?:github\.com|gitlab\.com|bitbucket\.org)\//i;
// A meeting about technology rather than research, whose talks no database lists: NVIDIA's GPU Technology Conference
// (GTC), "... Technology Conference", "... Summit", "... Developer Conference", "DevDay".
const TECH_MEETING = /\bGTC\b|\btechnology\s+conference\b|\bsummit\b|\bdevelopers?['’]?\s+conference\b|\bdev\s?day\b/gi;
const NAMES_A_TECH_MEETING = new RegExp(TECH_MEETING.source, 'i');

/**
 * Is a reference that nothing matched a talk about software at a technology conference ("Warp: A high-performance Python
 * framework for GPU simulation and graphics. NVIDIA GPU Technology Conference (GTC), https://github.com/NVIDIA/warp,
 * 2022.")? Only with no identifier, a link to a code repository, such a meeting after the title and, once the meeting's
 * name is taken out, no proceedings, journal, conference acronym or number but dates: an invented paper "In Proceedings of
 * the GPU Technology Conference", or with a volume and pages, stays Not found.
 */
function readsAsSoftwareTalk(c: ParsedCitation): boolean {
  if (c.doi !== undefined || c.arxivId !== undefined || !REPOSITORY.test(c.raw)) return false;
  const after = textAfterCitedTitle(c);
  if (after === undefined || !NAMES_A_TECH_MEETING.test(after)) return false;
  const rest = after.replace(TECH_MEETING, ' ');
  if (PAPER_VENUE.test(rest) || VENUE_ACRONYMS.test(rest) || namesAJournal(rest)) return false;
  return !/\d/.test(rest.replace(TALK_DATES, ' ').replace(MONTH_DAY_YEAR, ' ').replace(YEARS, ' ').replace(ORDINALS, ' '));
}

/** Shown when nothing was found for a titled paper from before 1970: many journals of those years are in none of these databases. */
const OLD_NOT_LISTED =
  "Not in Crossref, arXiv, OpenReview or OpenAlex, and it was published before 1970: older journals are often not indexed there";
/**
 * Papers older than this that nothing matched are Can't check. In the evaluation's stored runs every titled reference of
 * before 1970 that nothing matched (Banzhaf, Rutgers Law Review 1965; Lifshitz and Kosevich, Sov. Phys. JETP 1956) is a
 * real classic in a journal of those years that no database holds, while the dozens of others of those years were found.
 * Later years hold real misses too (a translation journal of 1976), but also references found wrong by hand (from 1988),
 * and more of their journals are indexed: the cut-off is the narrowest that covers the cases seen.
 */
const OLDEST_LISTED_YEAR = 1970;
const YEAR_IN_TEXT = /(?<![\d.])(?:1[5-9]|20)\d{2}(?!\d|\.\d)/g;
// Another work after the title: a clause opening with a word after a semicolon ("...; A. Einstein, Ann. Phys. 49, 769
// (1916)"; Vancouver's "1953;171:737" opens with a number), or a person named after a separator ("..., A. Einstein, ...").
const ANOTHER_WORK_AFTER = /;\s*\p{L}|(?:^|[;,]\s*)\p{Lu}\.(?:\s?-?\p{Lu}\.)*\s?\p{Lu}\p{Ll}[\p{L}'’-]+(?:,|\s+(?:and|&)\s)/u;

/**
 * Is a reference that nothing matched a paper from before 1970? Only with no identifier (one that led nowhere is a sign of
 * its own), a cited year before 1970, no later year anywhere in it (a misread page number or a reprint's year never moves
 * a recent paper here), and no other work after its title: an invented paper with no year of its own does not borrow
 * an old one from a real reference appended to it. No list of journals decides: an invented paper given an old year is
 * Can't check too, an accepted cost; an invented paper with a recent year stays Not found.
 */
function readsAsOldPaper(c: ParsedCitation): boolean {
  if (c.doi !== undefined || c.arxivId !== undefined || c.year === undefined || c.year >= OLDEST_LISTED_YEAR) return false;
  const after = textAfterCitedTitle(c);
  if (after === undefined || ANOTHER_WORK_AFTER.test(after)) return false;
  return (withoutIdentifiers(c.raw).match(YEAR_IN_TEXT) ?? []).every((y) => Number(y) < OLDEST_LISTED_YEAR);
}

/** Is this the Can't check of a paper from before 1970 that nothing matched? The engine still tries its journal locator. */
export function isOldPaperVerdict(v: Verdict): boolean {
  return v.status === 'cant_check' && v.reason === OLD_NOT_LISTED;
}

/** The reference's text after its cited title, folded, with its note field and links taken out; undefined when the title is not in it. */
function textAfterCitedTitle(c: ParsedCitation): string | undefined {
  if (c.title === undefined) return undefined;
  const raw = foldedText(c.raw);
  const title = foldedText(c.title);
  const at = title === '' ? -1 : raw.lastIndexOf(title);
  return at < 0 ? undefined : withoutNoteField(raw.slice(at + title.length)).replace(/https?:\/\/\S+/gi, ' ');
}

/** Shown when nothing was found for a chapter cited in its book: these databases often list the book and not its chapters. */
const CHAPTER_NOT_LISTED = "Looks like a chapter in a book, which these databases don't list reliably";
// "Title. In <Book>, ...": the book a chapter is in, named right after the title.
const IN_AFTER_TITLE = /^[\s.,;:]*In:?\s+(?=\p{Lu})/u;
// A book's own marks after its name: pages ("pp. 73–88", "p. 73") or editors ("(Ed.)", "(eds.)", "edited by").
const CHAPTER_PAGES = /\bpp?\.\s*\d+(?:\s*[–—-]\s*\d+)?/gi;
const CHAPTER_MARK = /\bpp?\.\s*\d|\((?:eds?|editors?)\.?\)|\beds?\.|\bedited\s+by\b|\beditors?\b/i;
// What only a book has: its editors, or its publisher together with a book word. Pages alone are no sign of one (natbib
// cites a proceedings volume as "In Artificial Intelligence and Statistics, pp. 1273–1282." too), nor is a publisher
// alone ("In Algorithmic Learning Theory, pp. 1–20. Springer, 2010.", a proceedings volume published as a book).
const BOOK_EDITORS = /\((?:eds?|editors?)\.?\)|\beds?\.\s+by\b|\bedited\s+by\b|\bEds\./i;
const BOOK_PUBLISHER =
  /\b(?:Press|Verlag|Publishers?|Publishing|Springer|Wiley|Elsevier|Erlbaum|Routledge|Kluwer|Birkh(?:ä|a)user|Pergamon|North[- ]Holland|McGraw[- ]Hill|Prentice[- ]Hall|Addison[- ]Wesley|Blackwell|Sage|Taylor\s*(?:&|and)\s*Francis|World\s+Scientific|Dover|Plenum|Macmillan|Palgrave|de\s+Gruyter|Brill|Norton|Freeman|Benjamins?)\b/;
const BOOK_WORD = /\b(?:Handbook|Companion|Encyclop(?:e|ae|æ)dia)\b/i;
// Proceedings published as books whose names hold no venue word: such a title after "In" names a paper's venue.
const PROCEEDINGS_TITLE = /\b(?:Artificial\s+Intelligence\s+and\s+Statistics|Uncertainty\s+in\s+Artificial\s+Intelligence|Learning\s+Theory|Medical\s+Image\s+Computing|Knowledge\s+Discovery|Theory\s+of\s+Cryptography|Computer\s+Aided\s+Verification|Findings\s+of\s+the\s+Association\s+for\s+Computational\s+Linguistics)\b/i;
// A meeting, a book series or a volume after "In" names where a paper appeared, so the reference stays a paper.
const SERIES_OR_MEETING = /\b(?:meeting|congress|colloquium|lecture\s+notes|series|lncs|vols?\.?|volume)\b/i;

/**
 * Is a reference that nothing matched a chapter cited in its book ("In R. D. Wegener (Ed.), Social Attitudes and
 * Psychophysical Measurement, pp. 73–88.")? Only with no identifier, "In" and a capital right after the title, a book's
 * pages or editors after it, its editors or a publisher with a book word ("Handbook"), and no number besides those
 * pages, dates and years. A journal, a proceedings
 * volume, a meeting, a book series, a conference acronym or a journal's name or abbreviation after "In" keeps the
 * reference a paper (and Not found): an invented journal paper does not escape by adding "In".
 */
function readsAsChapter(c: ParsedCitation): boolean {
  if (c.doi !== undefined || c.arxivId !== undefined) return false;
  const after = textAfterCitedTitle(c);
  const open = after === undefined ? null : IN_AFTER_TITLE.exec(after);
  if (after === undefined || open === null) return false;
  const book = after.slice(open[0].length);
  if (!CHAPTER_MARK.test(book) || !(BOOK_EDITORS.test(book) || (BOOK_PUBLISHER.test(book) && BOOK_WORD.test(book)))) return false;
  if (PAPER_VENUE.test(book) || VENUE_ACRONYMS.test(book) || SERIES_OR_MEETING.test(book) || PROCEEDINGS_TITLE.test(book) || namesAJournal(book)) return false;
  return !/\d/.test(book.replace(CHAPTER_PAGES, ' ').replace(MONTH_DAY_YEAR, ' ').replace(YEARS, ' ').replace(ORDINALS, ' '));
}

// A report series named after the title: "Philosophy and Probability Working Paper 6", "NBER Working Paper 12345", "CEPR
// Discussion Paper No. 4567", "Staff Report 1234". Technical reports are GREY_LITERATURE's already.
const REPORT_SERIES = /\b(?:working|discussion|research|occasional|staff|policy)\s+(?:papers?|reports?|notes?|memorand(?:um|a)|briefs?)\b/i;
// The same with its number, taken out before the rest is read.
const REPORT_SERIES_NUMBER = /\b(?:working|discussion|research|occasional|staff|policy)\s+(?:papers?|reports?|notes?|memorand(?:um|a)|briefs?)(?:\s+series)?(?:\s*,)?(?:\s*(?:no\.?|nr\.?|number|#))?(?:\s*[A-Za-z]{0,4}[-.]?\d[\w./-]*)?/gi;

// Series that register a DOI with Crossref for every paper (NBER, the World Bank's Policy Research Working Papers, the
// IMF, IZA, CEPR, the Federal Reserve, BIS, the ECB): nothing found for one of their papers counts as for any paper.
const REGISTERED_SERIES_ACRONYM = /\b(?:NBER|IMF|IZA|CEPR|FEDS|Fed|FRB|FRBSF|BIS|ECB)\b|\bN\.B\.E\.R\./;
const REGISTERED_SERIES_NAME = /\b(?:national\s+bureau\s+of\s+economic\s+research|world\s+bank|policy\s+research\s+working\s+papers?|finance\s+and\s+economics\s+discussion\s+series|international\s+monetary\s+fund|cent(?:re|er)\s+for\s+economic\s+policy\s+research|federal\s+reserve|bank\s+for\s+international\s+settlements|european\s+central\s+bank)\b/i;

/**
 * Is a reference that nothing matched a paper in a report series ("Working Paper 6", "Discussion Paper No. 4567")? Only
 * with no identifier, a series word after the title, a series that does not register its papers with Crossref
 * ("NBER Working Paper 12345" stays a paper, and Not found), and, once the series and its number are taken out, no journal,
 * proceedings or preprint named and no number but dates and years. "Journal of Philosophy Working Papers 12(3), 45–67"
 * names a journal, and "Philosophy Working Paper 6, 45–67" has pages: both stay papers (and Not found).
 */
function readsAsSeriesReport(c: ParsedCitation): boolean {
  if (c.doi !== undefined || c.arxivId !== undefined) return false;
  const after = textAfterCitedTitle(c);
  if (after === undefined || !REPORT_SERIES.test(after)) return false;
  if (REGISTERED_SERIES_ACRONYM.test(after) || REGISTERED_SERIES_NAME.test(after)) return false;
  const left = after.replace(REPORT_SERIES_NUMBER, ' ');
  if (PAPER_VENUE.test(left) || namesAJournal(left)) return false;
  return !/\d/.test(left.replace(MONTH_DAY_YEAR, ' ').replace(YEARS, ' ').replace(ORDINALS, ' '));
}

/** A Can't check verdict with this reason, and nothing else to show. */
export function cantCheck(reason: string): Verdict {
  return { status: 'cant_check', reason, diffs: [], notes: [] };
}

/**
 * The verdict for a title-less journal citation whose journal, volume, page, year and author a record carries (see
 * journalLocator). That is a strong match, so a retraction can be found, if the reference names an author; otherwise
 * the citation is Verified. There is no other outcome: a citation that fits no record stays "Can't check", decided by the caller.
 */
export function locatorVerdict(c: ParsedCitation, match: WorkRecord, retraction: Retraction | 'unknown', namesAuthors: boolean): Verdict {
  const notes = recordNotes(match);
  // Words in front of the journal's name that the record's journal does not account for are a title, compared as one: an
  // invented title on a real article's locator is Details differ, never Verified (withJournalLead).
  const lead = journalNameLead(c, match);
  if (lead === 'unaccounted') return cantCheck(JOURNAL_LEAD_UNACCOUNTED);
  if (lead !== undefined) {
    const titled: ParsedCitation = { ...c, title: lead.title, venue: lead.venue };
    const diffs = fieldDiffs(comparedWith(titled, match), match).map((d) => (d.field === 'title' ? { ...d, cited: lead.title } : d));
    if (diffs.length > 0) {
      if (retraction !== 'unknown' && retraction.retracted) notes.push(CLOSE_RETRACTED_NOTE);
      return { status: 'details_differ', reason: diffs.map(diffSummary).join('; '), diffs, notes };
    }
  }
  // A match that no author backs up is too thin to call a work retracted.
  if (retraction !== 'unknown' && retraction.retracted && !namesAuthors) return cantCheck(ID_UNCONFIRMED);
  if (retraction !== 'unknown' && retraction.retracted) return { status: 'retracted', reason: retractedReason(c, retraction), diffs: [], notes };
  if (retraction === 'unknown') notes.push(RETRACTION_UNKNOWN_NOTE);
  return { status: 'verified', reason: 'Matches the record with this journal, volume, page and year', diffs: [], notes };
}

/**
 * Does a record found by a titled entry's journal locator carry the cited title, as Verified asks of a title? A Nature-
 * style entry looked up by its locator after its title searches missed (natureStyleLocatorReading) is Verified only so:
 * an invented title on a real article's locator stays what the title path made of it.
 */
export function carriesCitedTitle(c: ParsedCitation, r: WorkRecord): boolean {
  return hasTitle(c) && hasUsableTitle(r) && titleScore(c, r) >= VERIFIED_TITLE;
}

/** Is this the unreadable Can't check ("Couldn't read this reference reliably")? */
export function isUnreadable(v: Verdict): boolean {
  return v.status === 'cant_check' && v.reason === UNREADABLE;
}

/**
 * Is this the Can't check of a book, thesis, ISBN-bearing proceedings entry, IACR ePrint or work marked unpublished with
 * a real title? Such a
 * reference may still be verified by a Crossref title search (verifiedOnlyVerdict).
 */
export function isVerifiedOnlyLookup(c: ParsedCitation, v: Verdict | undefined): boolean {
  return v !== undefined && (v.reason === BOOK_REASON || v.reason === IACR_REASON || NOT_PUBLISHED_REASONS.has(v.reason)) && hasTitle(c) && isCredibleTitle(c.title);
}

/**
 * The verdict for such a reference that a Crossref title search matched: Verified when the record agrees on title,
 * authors and year as any confident search match must, with no field differing; otherwise undefined, and the reference
 * keeps its Can't check. This path never says Not found, Wrong ID, Details differ or Retracted: a book missing from
 * Crossref, or another edition of it, is no sign of anything, and a retracted record is no match. The record must list
 * people and, when the reference names anyone, a cited surname must be among them; without a parsed author list the
 * title must also be specific (four words or more): "Hydrodynamics" or "Deep learning" names many works.
 */
export function verifiedOnlyVerdict(c: ParsedCitation, match: WorkRecord): Verdict | undefined {
  if (!hasTitle(c) || !hasUsableTitle(match) || match.isRetracted) return undefined;
  // A record without people (an edited volume, a handbook listed by title) cannot vouch for the names cited with it:
  // invented authors would pass on the title alone. When the reference names anyone, a cited surname must be on the record.
  if (match.authors.length === 0) return undefined;
  const namesSomeone = c.authors.length > 0 || zoneNamesSomeone(c);
  if (namesSomeone && (c.authors.length === 0 ? recordAuthorsInZone(c, match) === 0 : authorOverlap(c.authors, match.authors) === 0)) return undefined;
  if (c.authors.length === 0 && titleWords(c.title).length < MIN_NO_AUTHOR_STRONG_WORDS) return undefined;
  if (!isConfidentMatch(c, match, 'search') || fieldDiffs(c, match).length > 0) return undefined;
  return { status: 'verified', reason: `Matches the ${sourceName(match.source)} record`, diffs: [], notes: recordNotes(match) };
}

export function classify(input: ClassifyInput): Verdict {
  const { matchedVia, retraction, searched, failed } = input;

  const early = preLookupVerdict(input.citation);
  if (early !== undefined) return early;

  // An ID lookup is the same thing as "what the ID resolved to", even if the caller only filled in `match`.
  const idRecord = input.idResolvedTo ?? (matchedVia === 'id' ? input.match : undefined);
  // A title-less reading whose journal's name holds words the identifier's record does not account for is read with them
  // as its title (withJournalLead); when the record has no journal name to tell, it is not compared at all.
  const effective = effectiveCitation(input.citation);
  const lead = idRecord !== undefined && hasUsableTitle(idRecord) ? journalNameLead(effective, idRecord) : undefined;
  if (lead === 'unaccounted') return cantCheck(JOURNAL_LEAD_UNACCOUNTED);
  const citation = lead === undefined || idRecord === undefined ? effective : withJournalLead(effective, idRecord);
  const idUsable = idRecord !== undefined && hasUsableTitle(idRecord);
  // A dataset, software or collection is often listed under a name of its own ("MDR SuperCon Datasheet" for "Superconducting
  // material database"): another title on it is no sign that the identifier names a different paper, so it is never Wrong
  // ID, and never the match it is compared with.
  const nonPaperId = idRecord !== undefined && idRecord.nonPaper === true && isWrongId(citation, idRecord);
  // A search result that the cited title says nothing about (an organisation's name, a title buried in a longer one) is
  // no match: never Details differ against another work.
  const unsupported = input.match !== undefined && input.match !== idRecord && (titleIsAuthorName(citation) || noTitleEvidence(comparedWith(citation, input.match), input.match));
  const given = (nonPaperId && input.match === idRecord) || unsupported ? undefined : input.match;
  const match = given ?? (idRecord !== undefined && !isWrongId(citation, idRecord) ? idRecord : undefined);
  // A match with no usable title (the unusable id record, however it was passed in) is no match at all.
  const usableMatch = match !== undefined && hasUsableTitle(match) ? match : undefined;
  const via = match !== undefined && match === idRecord ? 'id' : matchedVia;
  // The record may show where the reference's author list ends and its title begins (resplitWithRecord). The engine
  // reads it the same way before it decides on a retraction lookup.
  const compared = usableMatch === undefined ? citation : comparedWith(citation, usableMatch);
  const confident = usableMatch !== undefined && isConfidentMatch(compared, usableMatch, via);
  // Only a strong match can be called Retracted: a near miss, by id or by search, must not carry another work's retraction.
  const strong = usableMatch !== undefined && isStrongMatch(compared, usableMatch, via);

  const retracted = strong && retraction !== undefined && retraction !== 'unknown' && retraction.retracted;
  if (retracted) {
    return { status: 'retracted', reason: retractedReason(citation, retraction), diffs: [], notes: recordNotes(match) };
  }

  // A match found by the reference's own title beside such a record is judged as usual. With none it is Can't check, unless
  // the reference gives a full journal locator and every source answered: then it is Not found as any journal paper.
  if (nonPaperId && match === undefined && !(hasFullJournalLocator(citation) && REQUIRED_SOURCES.every((s) => searched.includes(s) && !failed.includes(s)))) return cantCheck(NON_PAPER_ID);
  if (!nonPaperId && idRecord !== undefined && isWrongId(citation, idRecord)) return wrongId(citation, idRecord);

  // An identifier-only citation whose record contradicts the other details (the identifier is probably a typo),
  // or whose details cannot confirm it: say which.
  if (usableMatch !== undefined && via === 'id' && !hasTitle(citation) && !strong) {
    return cantCheck(idOnlyEvidence(citation, usableMatch) === 'unconfirmed' ? ID_UNCONFIRMED : ID_MISMATCH);
  }

  // A weak record (an implausible author list) found by search whose title is not the cited one is no evidence either
  // way: neither Details differ against it nor Not found without it.
  if (usableMatch !== undefined && via !== 'id' && hasImplausibleAuthors(usableMatch) && hasTitle(compared) && citedTitleScore(compared, usableMatch) < VERIFIED_TITLE) {
    return cantCheck(WEAK_RECORD);
  }

  // A record marked retracted whose retraction lookup could not answer: neither Verified nor Retracted until it can.
  if (usableMatch !== undefined && usableMatch.isRetracted && retraction === 'unknown') return cantCheck(RETRACTION_UNCHECKED);

  if (usableMatch !== undefined) {
    const notes = recordNotes(usableMatch);
    // The engine only looks a retraction up for a strong match, so 'unknown' only ever arrives for one.
    if (retraction === 'unknown') notes.push(RETRACTION_UNKNOWN_NOTE);
    // Compared as re-read, shown as cited.
    const diffs = fieldDiffs(compared, usableMatch).map((d) => (d.field === 'title' ? { ...d, cited: citation.title ?? d.cited } : d));
    // A record marked retracted that is not a strong match may be another work: never Verified on it (a strong match is
    // Retracted above), and the row says the closest record was retracted, without saying the cited work was.
    if (usableMatch.isRetracted && !strong) {
      notes.push(CLOSE_RETRACTED_NOTE);
      if (diffs.length === 0) {
        const shown: FieldDiff = { field: 'title', cited: citation.title ?? '', actual: usableMatch.title };
        return { status: 'details_differ', reason: CLOSE_RETRACTED_REASON, diffs: [shown], notes };
      }
    }
    if (diffs.length === 0 && !confident) {
      // Same title but nothing to back it up (no authors to compare): show it as close, side by side.
      const shown: FieldDiff = { field: 'title', cited: citation.title ?? '', actual: usableMatch.title };
      return { status: 'details_differ', reason: 'A similar title was found, but there were no authors to confirm it', diffs: [shown], notes };
    }
    if (diffs.length === 0) return { status: 'verified', reason: `Matches the ${sourceName(usableMatch.source)} record`, diffs, notes };
    return { status: 'details_differ', reason: diffs.map(diffSummary).join('; '), diffs, notes };
  }

  if (input.idUnusable === true || (idRecord !== undefined && !idUsable)) {
    return cantCheck('The record for this DOI or arXiv ID has no title to compare with. Try again later');
  }

  // Only an identifier to go on, and it led nowhere: say that, not which title-search sources were skipped.
  if (!hasTitle(citation) && (citation.doi !== undefined || citation.arxivId !== undefined)) {
    return failed.length > 0 ? cantCheck("Couldn't look up this identifier right now. Try again later") : cantCheck("Couldn't find this identifier and there's no title to search by");
  }

  // Not found is an accusation too: it needs a cited title that reads as one. Without one, no source's answer (or
  // missing answer) changes anything, so the reference is unreadable whichever sources were searched.
  if (!hasTitle(citation) || !isCredibleTitle(citation.title ?? '')) return cantCheck(UNREADABLE);
  const unavailable = REQUIRED_SOURCES.filter((s) => !searched.includes(s) || failed.includes(s));
  if (unavailable.length === 0) {
    if (readsAsTalk(citation)) return cantCheck(TALK_NOT_LISTED);
    if (readsAsSoftwareTalk(citation)) return cantCheck(SOFTWARE_TALK_NOT_LISTED);
    if (readsAsDocument(citation)) return cantCheck(DOCUMENT_NOT_LISTED);
    if (readsAsChapter(citation)) return cantCheck(CHAPTER_NOT_LISTED);
    if (readsAsSeriesReport(citation)) return cantCheck(REPORT_REASON);
    if (!namesAVenue(citation)) return cantCheck(NO_VENUE_NOT_LISTED);
    if (readsAsOldPaper(citation)) return cantCheck(OLD_NOT_LISTED);
    if (titleIsResearchGroup(citation)) return cantCheck(GROUP_AS_TITLE);
    return { status: 'not_found', reason: `Not found in Crossref, arXiv, OpenReview or OpenAlex. ${NOT_FOUND_NOTE}`, diffs: [], notes: [] };
  }
  return cantCheck(`Couldn't search ${joinAnd(unavailable.map((s) => SOURCE_NAME[s]))}. Try again later`);
}

/**
 * Could a record contradict this cited "title"? Not when, links and identifiers aside, it has fewer than three
 * words that are not numbers, when at least half of its content words are boilerplate ("Accessed on 12 May
 * 2021", "Data available at", "Supplementary material for this article"), or when it is a venue and volume
 * ("Proceedings of the National Academy of Sciences 117(5), 2345").
 */
// "Luo, Yabiao Wang, L": the middle of an author list that was cut in the wrong place, not a title.
function isRunOfNames(title: string): boolean {
  if ((title.match(/,/g) ?? []).length < 2) return false;
  const tokens = title.split(/[\s,]+/).filter((t) => t !== '' && !/^(?:and|&)$/i.test(t));
  return tokens.length >= 3 && tokens.every((t) => /^\p{Lu}[\p{L}'’.-]*$/u.test(t));
}

// "Yali Wang, Zhipeng Zhou": a comma and nothing but capitalised words is a pair of names, not a title.
function isShortRunOfNames(title: string): boolean {
  if (!title.includes(',')) return false;
  const tokens = title.split(/[\s,]+/).filter((t) => t !== '' && !/^(?:and|&)$/i.test(t));
  return tokens.length >= 2 && tokens.length <= 8 && tokens.every((t) => /^\p{Lu}[\p{L}'’.-]*$/u.test(t));
}

// "R. Beig and P.T. Chrusciel, Killing vectors ...", "X. Zhang, Deep residual ...": the authors were left in front of the title.
// "O.J. Ganor and ...", "A.Yu. Kitaev, ...": initials run together count too.
const STARTS_WITH_INITIAL = /^\p{Lu}\.(?:\s|\p{Lu}\.|\p{Lu}\p{Ll}\.)/u;
const IN_VENUE_TITLE = /^in\s+\p{Lu}/u;

/** Can a database's silence about this cited "title" mean the work does not exist? Only if it reads as a title (citesRealTitle) and not as people. */
export function isCredibleTitle(title: string): boolean {
  if (!citesRealTitle(title) || isShortRunOfNames(title) || STARTS_WITH_INITIAL.test(title.trim())) return false;
  // "in Gravitational Waves: Proceedings of ...": where a work appeared, left as the title. A title is capitalised ("In
  // Defense of the Triplet Loss"), and a lower-case "in" before a capital opens the name of a book or proceedings.
  if (IN_VENUE_TITLE.test(title.trim())) return false;
  // "Title; Author, Author, 2018" has its authors in it; a title that ends on "in" or "of" was cut at the end of a line.
  if (title.includes(';')) return false;
  const last = titleWords(title).at(-1) ?? '';
  return !FUNCTION_WORDS.has(last);
}

function citesRealTitle(title: string): boolean {
  if (isRunOfNames(title)) return false;
  const words = titleWords(withoutIdentifiers(title));
  const descriptive = words.filter((w) => !/^\d+$/.test(w));
  if (descriptive.length < MIN_CREDIBLE_TITLE_WORDS) return false;
  const content = descriptive.filter((w) => !FUNCTION_WORDS.has(w) && !MONTHS.has(w));
  if (content.length === 0 || content.filter((w) => BOILERPLATE_WORDS.has(w)).length >= BOILERPLATE_SHARE * content.length) return false;
  return !(VENUE_FIRST_WORDS.has(words[0] ?? '') && descriptive.length < words.length);
}

/**
 * An identifier points to a different paper only when the cited title is a real title (see citesRealTitle), it
 * is far off, and the authors do not genuinely agree. On top of that the reference must name someone (its author
 * zone holds a Latin-script surname-like word; see zoneNamesSomeone), and the record's authors must be missing
 * from that zone: with no parsed author list (the parser often misses it) not one of the record's
 * first three surnames may be named there; with a parsed list that already disagrees, fewer than two of them
 * (fewer than one for a record of one author), since one shared common surname ("Wang", "Lee") proves little.
 * A different title with agreeing authors is a translated or reworded one (Details differ). A record with no
 * title says nothing at all.
 */
export function isWrongId(c: ParsedCitation, idRecord: WorkRecord): boolean {
  if (!hasTitle(c) || !hasUsableTitle(idRecord)) return false;
  if (!citesRealTitle(c.title)) return false;
  if (titleSimilarity(c.title, idRecord.title) >= WRONG_ID_TITLE) return false;
  if (genuineAuthorAgreement(c, idRecord)) return false;
  // Wrong ID needs positive evidence: the reference names someone, and not the record's authors. No readable
  // names (an empty zone, a title-first style, a native-script author list) is no evidence of a wrong identifier.
  if (!zoneNamesSomeone(c)) return false;
  const named = recordAuthorsInZone(c, idRecord);
  if (c.authors.length === 0) return named === 0;
  return named < Math.max(1, Math.min(2, recordNameCount(idRecord)));
}

function wrongId(c: ParsedCitation, idRecord: WorkRecord): Verdict {
  const label = c.doi !== undefined && c.arxivId !== undefined ? 'DOI/arXiv ID' : c.doi !== undefined ? 'DOI' : 'arXiv ID';
  const cited = c.doi !== undefined ? `DOI ${c.doi}` : `arXiv:${c.arxivId ?? ''}`;
  const diffs: FieldDiff[] = [
    { field: 'identifier', cited, actual: 'belongs to a different paper' },
    { field: 'title', cited: c.title ?? '', actual: idRecord.title },
  ];
  return { status: 'wrong_id', reason: `This ${label} points to a different paper than the title cited`, diffs, notes: [] };
}

function retractedReason(c: ParsedCitation, r: Retraction): string {
  // A retraction with no version stated is read as the cited version.
  if (r.version !== 'other') return 'The cited version has been formally retracted';
  // Name the twin from what was cited: an arXiv-only citation's twin is the journal version, and vice versa.
  if (c.arxivId !== undefined && c.doi === undefined) return 'The published version of this work has been formally retracted';
  if (c.doi !== undefined && c.arxivId === undefined) return 'The preprint of this work has been formally retracted';
  return 'Another version of this work (the published version or its preprint) has been formally retracted';
}

function recordNotes(match: WorkRecord | undefined): string[] {
  if (match === undefined) return [];
  return [...new Set(match.notes)].map((n) => RECORD_NOTE_TEXT[n]);
}

function fieldDiffs(c: ParsedCitation, r: WorkRecord): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  // No cited title (an ID-only citation) leaves nothing to compare, so it is not a difference.
  if (hasTitle(c) && citedTitleScore(c, r) < VERIFIED_TITLE) {
    diffs.push({ field: 'title', cited: c.title, actual: r.title });
  }
  // An implausible author list ("1") says nothing about who wrote the work.
  if (!hasImplausibleAuthors(r) && authorScore(c, r) < AUTHOR_OK - AUTHOR_SLACK) {
    diffs.push({ field: 'authors', cited: c.authors.slice(0, 3).join(', '), actual: r.authors.slice(0, 3).join(', ') });
  }
  if (!yearAgrees(c, r) && c.year !== undefined && r.year !== undefined) {
    diffs.push({ field: 'year', cited: String(c.year), actual: String(r.year) });
  }
  return diffs;
}

function diffSummary(d: FieldDiff): string {
  switch (d.field) {
    case 'year':
      return `Year differs (cited ${d.cited}, found ${d.actual})`;
    case 'authors':
      return `Authors differ (cited ${d.cited}; found ${d.actual})`;
    case 'title':
      return 'Title differs from the matched record';
    case 'identifier':
      return 'Identifier differs from the matched record';
  }
}
