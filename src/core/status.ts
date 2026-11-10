// The six statuses as the user meets them: words, one-line meanings, and the order problems are shown in.
// Pure data and small helpers, shared by the side panel, the reports and the welcome page.

import type { CheckResult, FieldDiff, SourceName, Status } from './types';

/** Every status once, the good news first: the order of the welcome page's list and of the counts in a summary. */
export const STATUSES: readonly Status[] = ['verified', 'details_differ', 'wrong_id', 'retracted', 'not_found', 'cant_check'];

/** A zero for each status. */
export function emptyCounts(): Record<Status, number> {
  return Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
}

/** How many of `results` have each status. */
export function countStatuses(results: Iterable<Pick<CheckResult, 'status'>>): Record<Status, number> {
  const counts = emptyCounts();
  for (const r of results) counts[r.status] += 1;
  return counts;
}

/** A list read as a sentence: "A", "A and B", "A, B and C". */
export function joinAnd(parts: readonly string[]): string {
  return parts.length <= 2 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`;
}

export const STATUS_WORD: Readonly<Record<Status, string>> = {
  verified: 'Verified',
  details_differ: 'Details differ',
  wrong_id: 'Wrong ID',
  retracted: 'Retracted',
  not_found: 'Not found',
  cant_check: "Can't check",
};

/** How a source is named to the reader: in the panel's "Searched:" line, the report and the CSV. */
export const SOURCE_NAME: Readonly<Record<SourceName, string>> = { crossref: 'Crossref', openalex: 'OpenAlex', arxiv: 'arXiv', openreview: 'OpenReview', dblp: 'DBLP' };

/** The name of a source for display; text that is not one of ours (a malformed record) is shown as it came. */
export function sourceName(source: string): string {
  return (SOURCE_NAME as Record<string, string | undefined>)[source] ?? source;
}

/** How a compared field is named to the reader (the panel's Cited / Found rows, the report and the CSV). */
export const FIELD_NAME: Readonly<Record<FieldDiff['field'], string>> = { title: 'Title', authors: 'Authors', year: 'Year', identifier: 'Identifier' };

/** One calm sentence per status; never an accusation (DESIGN section 5). */
export const STATUS_MEANING: Readonly<Record<Status, string>> = {
  verified: 'Found, and the title, authors and year match.',
  details_differ: 'Found a close match, but something differs, such as the year or the authors.',
  wrong_id: "The paper's DOI or arXiv ID (its permanent identifier) exists, but it belongs to a different paper than the title says.",
  retracted: 'The matched paper has been formally retracted.',
  not_found: 'No close match in Crossref, arXiv, OpenReview or OpenAlex. Some real works (reports, theses, some proceedings) are not in these databases, so look it up by hand.',
  cant_check: "Not something RefSure can look up (a website or a book, say), or a lookup didn't work.",
};

/** Problems first, so the references that need a look are at the top. */
export const STATUS_ORDER: readonly Status[] = ['retracted', 'wrong_id', 'not_found', 'details_differ', 'cant_check', 'verified'];

const RANK: Readonly<Record<Status, number>> = Object.fromEntries(STATUS_ORDER.map((status, i) => [status, i])) as Record<Status, number>;

/** The four statuses that ask the reader to look: Can't check is not a finding about the reference. */
export function isProblem(status: Status): boolean {
  return status === 'retracted' || status === 'wrong_id' || status === 'not_found' || status === 'details_differ';
}

function problemCount(counts: Readonly<Record<Status, number>>): number {
  return STATUS_ORDER.filter(isProblem).reduce((sum, status) => sum + counts[status], 0);
}

/** A new array: by status (problems first), then by reference number. */
export function sortProblemsFirst(results: readonly CheckResult[]): CheckResult[] {
  return [...results].sort((a, b) => RANK[a.status] - RANK[b.status] || a.index - b.index);
}

// DESIGN 7.3 lists the good news first: "40 verified · 2 with different details · 1 not found ...".
const TOTALS_ORDER: readonly Status[] = ['verified', 'details_differ', 'wrong_id', 'not_found', 'retracted', 'cant_check'];
const TOTALS_WORD: Readonly<Record<Status, string>> = {
  verified: 'verified',
  details_differ: 'with different details',
  wrong_id: 'wrong ID',
  retracted: 'retracted',
  not_found: 'not found',
  cant_check: "couldn't be checked",
};

/** The parts of the totals line, each a number with its word ("2 not found"). Empty when there are no references. */
export function totalsParts(counts: Readonly<Record<Status, number>>): string[] {
  return TOTALS_ORDER.filter((status) => counts[status] > 0).map((status) => `${counts[status]} ${TOTALS_WORD[status]}`);
}

export function totalsText(counts: Readonly<Record<Status, number>>): string {
  const parts = totalsParts(counts);
  return parts.length === 0 ? 'No references' : parts.join(' · ');
}

/** The sentence a screen reader hears when a check ends. */
export function completionMessage(counts: Readonly<Record<Status, number>>): string {
  // "To look at" rather than "problems": Not found only means "not in these databases".
  return `Check complete: ${counts.verified} verified, ${problemCount(counts)} to look at`;
}
