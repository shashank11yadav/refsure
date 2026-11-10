// A work has several dates: the preprint, the online release, the print issue. A citation may use any of them.
import { stripArxivVersion } from './identifiers';
import { PREPRINT_YEAR_TOLERANCE, YEAR_TOLERANCE } from './thresholds';
import type { ParsedCitation, WorkRecord } from './types';

const NEW_STYLE_ID = /^(\d{2})(?:0[1-9]|1[0-2])\.\d{4,5}$/;
const OLD_STYLE_ID = /^[a-z-]+(?:\.[A-Za-z]{2})?\/(\d{2})(?:0[1-9]|1[0-2])\d{3}$/;
// The numbering began in 1991 and the new style in 2007, so two digits of 91 and above are 1990s.
const FIRST_ARXIV_YEAR_DIGITS = 91;

/** The year an arXiv id was assigned in (its YYMM prefix), or undefined for anything that is not an id. */
function arxivIdYear(id: string): number | undefined {
  const bare = stripArxivVersion(id.trim());
  const digits = NEW_STYLE_ID.exec(bare)?.[1] ?? OLD_STYLE_ID.exec(bare)?.[1];
  if (digits === undefined) return undefined;
  const yy = Number(digits);
  return yy >= FIRST_ARXIV_YEAR_DIGITS ? 1900 + yy : 2000 + yy;
}

/**
 * Every year the cited work is known by: the record's main year, its other dates, and the year of the arXiv version the
 * record is or links to. An arXiv id that only the reference gives is not one of them: it may not exist, or belong to
 * another work, unless it resolved to this record (which then carries it).
 */
export function knownYears(r: WorkRecord): number[] {
  const years = new Set<number>();
  const add = (year: number | undefined): void => {
    if (year !== undefined) years.add(year);
  };
  add(r.year);
  for (const year of r.otherYears ?? []) add(year);
  for (const id of [r.arxivId, r.otherVersion?.arxivId]) if (id !== undefined) add(arxivIdYear(id));
  return [...years];
}

/**
 * Does the cited year agree with the record? Within the tolerance of any known date of the work. Nothing to compare
 * (no cited year, or no date at all) agrees. It decides Verified against Details differ and is the year part of the
 * strong-match test that gates a retraction lookup.
 */
export function yearAgrees(c: ParsedCitation, r: WorkRecord): boolean {
  if (c.year === undefined) return true;
  const years = knownYears(r);
  const tolerance = hasPreprintVersion(r) ? PREPRINT_YEAR_TOLERANCE : YEAR_TOLERANCE;
  return years.length === 0 || years.some((y) => Math.abs(c.year as number - y) <= tolerance);
}

/**
 * The work is known to have an arXiv version: the record is one or links one. An arXiv id in the reference alone does
 * not show it (it may not exist); when it resolves to the work, the record carries it.
 */
export function hasPreprintVersion(r: WorkRecord): boolean {
  return r.source === 'arxiv' || r.arxivId !== undefined || r.otherVersion?.arxivId !== undefined;
}
