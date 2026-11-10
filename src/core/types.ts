// Shared domain types. Every other module imports its vocabulary from here.

/** The lookup services. Names match the keys of `RATE` in `src/config.ts`. */
export type SourceName = 'crossref' | 'openalex' | 'arxiv' | 'openreview' | 'dblp';

/**
 * Sources whose failure means a reference cannot be called "not found".
 * DBLP is best-effort and deliberately absent.
 */
export const REQUIRED_SOURCES: readonly SourceName[] = ['crossref', 'arxiv', 'openreview', 'openalex'];

export type Status = 'verified' | 'details_differ' | 'wrong_id' | 'retracted' | 'not_found' | 'cant_check';

/** One entry of a paper's bibliography, as read from the page or PDF. */
export interface RawReference {
  index: number;
  label: string;
  text: string;
  blocks?: string[];
  anchorId?: string;
  /**
   * A PDF entry cut from a line that held two (two columns read as one): it may still hold words of the other, so it is
   * never Not found.
   */
  partial?: true;
}

/** What the parser could pull out of a reference's text. */
export interface ParsedCitation {
  raw: string;
  doi?: string;
  arxivId?: string;
  title?: string;
  /** Lower-case, ASCII-folded surnames in cited order. */
  authors: string[];
  year?: number;
  venue?: string;
  kind: 'paper' | 'web' | 'software' | 'book' | 'unknown';
  /** 0 to 1: how sure the parser is that `title` and `authors` are right. */
  confidence: number;
}

export type RecordNote = 'withdrawn' | 'correction' | 'expression_of_concern';

/** A work as described by one lookup service. */
export interface WorkRecord {
  source: SourceName;
  title: string;
  /** Lower-case, ASCII-folded surnames. */
  authors: string[];
  /**
   * Given names in the same form and order as `authors` ('' where there is none), when the service lists
   * them separately. Only used to spot a record whose given and family names were entered the wrong way round.
   */
  givenNames?: string[];
  year?: number;
  /** Other dates the service gives for the same work (online, print, preprint posting), as years; never the main year. */
  otherYears?: number[];
  venue?: string;
  /** Every name the service gives the journal or series, long and abbreviated. Only used to match a journal citation. */
  venues?: string[];
  /** The abbreviated names among `venues` ("Phys. Rev. Lett."), when the service marks them as such. */
  shortVenues?: string[];
  /** Volume, and first page and article number (lower case), as the service gives them. Only used to match a journal citation. */
  volume?: string;
  pages?: string[];
  doi?: string;
  arxivId?: string;
  openreviewId?: string;
  /** The OpenAlex work id ("W2626778328") of an OpenAlex record; only used to link its page when there is no DOI. */
  openalexId?: string;
  /** The DBLP key ("conf/nips/VaswaniSPUJGKP17") of a DBLP record; only used to link its page when there is no DOI. */
  dblpKey?: string;
  isRetracted: boolean;
  notes: RecordNote[];
  /**
   * The service lists this work as a dataset, software, a collection or another kind of work that is not a paper. Such a
   * record often carries a name of its own, so a title that differs from it is no sign of a wrong identifier.
   */
  nonPaper?: true;
  /** The preprint or published twin of this record, when the service links one. */
  otherVersion?: { doi?: string; arxivId?: string };
}

export interface FieldDiff {
  field: 'title' | 'authors' | 'year' | 'identifier';
  cited: string;
  actual: string;
}

export interface Retraction {
  retracted: boolean;
  /** Which version carries the retraction: the one cited, or its twin. */
  version?: 'cited' | 'other';
  noticeDoi?: string;
}

export interface CheckResult {
  index: number;
  label: string;
  citedText: string;
  status: Status;
  reason: string;
  match?: WorkRecord;
  diffs: FieldDiff[];
  notes: string[];
  sourcesSearched: SourceName[];
  sourcesFailed: SourceName[];
  links: { label: string; url: string }[];
}

export interface PaperInfo {
  key: string;
  title: string;
  url: string;
  origin: 'arxiv-html' | 'arxiv-abs' | 'arxiv-pdf' | 'openreview';
  viaPdf: boolean;
  /** Set when the references come from the paper's arXiv version (an OpenReview page): the arXiv id. */
  viaArxivVersion?: string;
}

export interface CheckSummary {
  paper: PaperInfo;
  counts: Record<Status, number>;
  total: number;
  startedAt: number;
  finishedAt?: number;
  beta: boolean;
}
