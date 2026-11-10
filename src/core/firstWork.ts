// An entry that cites several works (severalWorks.ts) whose first part is a complete work on its own: "J. Doe, Invented
// title, Phys. Rev. D 82, 123456 (2010); A. Einstein, Ann. Phys. 49, 769 (1916)." Appending a second work must not hide
// the first from Not found or Wrong ID, so that part is checked alone. Its Verified is still not shown as Verified: the
// entry cites more than one work, and a row is Verified only when all of it was found.
import { cantCheck, effectiveCitation, hasTitle, isCredibleTitle, preLookupVerdict, SEVERAL_WORKS_REASON, type Verdict } from './classify';
import { parseCitation } from './parseCitation';
import { citesSeveralWorks, firstWorkText } from './severalWorks';
import type { ParsedCitation } from './types';

export const FIRST_WORK_FOUND_REASON = 'The first work in this entry was found, but the entry cites more than one work, and RefSure checks one work at a time';
const FIRST_WORK_PREFIX = 'About the first work in this entry, which cites more than one: ';

/**
 * The first work of an entry that cites several, as a citation of its own, when it is complete: its own journal locator,
 * or identifier, with its year (firstWorkText), and its own identifier or a credible title with a venue. Undefined otherwise (the "[64]" shape, "E.
 * Goetz et al., in Proceedings ..., 2009; ...", whose first part has no locator of its own; a first part whose year is
 * left out), and then the whole entry is Can't check.
 */
export function firstWorkOf(c: ParsedCitation): ParsedCitation | undefined {
  if (!citesSeveralWorks(c.raw)) return undefined;
  const text = firstWorkText(c.raw);
  if (text === undefined) return undefined;
  const first = effectiveCitation(parseCitation({ index: 0, label: '', text }));
  if (preLookupVerdict(first) !== undefined) return undefined;
  if (first.doi !== undefined || first.arxivId !== undefined) return first;
  return hasTitle(first) && isCredibleTitle(first.title) && first.venue !== undefined && first.venue.trim() !== '' ? first : undefined;
}

/** The entry's verdict from its first work's: a Verified is Can't check; Can't check is the entry's own; the rest stand. */
export function firstWorkVerdict(v: Verdict): Verdict {
  if (v.status === 'verified') return cantCheck(FIRST_WORK_FOUND_REASON);
  if (v.status === 'cant_check') return cantCheck(SEVERAL_WORKS_REASON);
  return { ...v, reason: `${FIRST_WORK_PREFIX}${v.reason}` };
}
