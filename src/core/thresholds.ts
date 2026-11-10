// Matching thresholds, kept together so the accuracy evaluation (npm run eval) can tune them in one place.

/** Title similarity at or above which a title counts as the same title. */
export const VERIFIED_TITLE = 0.9;
/**
 * Title similarity a search result needs when authors cannot back it up (the citation or the record lists
 * none): the title alone must then be nearly exact before it counts as the same paper.
 */
export const NO_AUTHOR_TITLE = 0.95;
/** Minimum title similarity for a search result to be considered at all. */
export const CANDIDATE_TITLE = 0.75;
/** Below this an identifier's record is a different paper, not a variant of the cited one. */
export const WRONG_ID_TITLE = 0.5;
/**
 * Fraction of the first three cited surnames that must appear in the record. 0.67 is a rounded
 * two-thirds, so comparisons use AUTHOR_SLACK to let exactly 2 of 3 pass.
 */
export const AUTHOR_OK = 0.67;
export const AUTHOR_SLACK = 0.005;
/** Allowed gap in years: a preprint and its published version often differ by one. */
export const YEAR_TOLERANCE = 1;
/**
 * Allowed gap when the work has an arXiv version (the record is the arXiv one, or names it, or the reference cites an
 * arXiv id): physics and machine-learning papers are often cited by their journal year, two years after the posting.
 */
export const PREPRINT_YEAR_TOLERANCE = 2;
/** Years either side of the cited year that Crossref's journal-locator query asks for (kept apart from the matching tolerance). */
export const LOCATOR_YEAR_WINDOW = 1;
/** Below this the parser is not sure enough of the title/authors to look anything up. */
export const MIN_PARSE_CONFIDENCE = 0.4;

/** Title similarity a match needs, together with genuine author agreement and a year in range, to be called Retracted. */
export const STRONG_TITLE = 0.95;
/** The same, when either side lists no authors: the title alone must then be almost identical. */
export const STRONG_TITLE_NO_AUTHORS = 0.98;
