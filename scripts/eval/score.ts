// Turning stored runs into the numbers of DESIGN section 10. Pure: no network, no disk, no clock.
import { emptyCounts } from '../../src/core/status';
import type { CheckResult, Status } from '../../src/core/types';
import type { CorruptionKind, InspectedCase, Inspection, OutOfScopeCase, PaperPath, RunFile } from './types';

/** Why a reference ended up "Can't check", in the order the checker decides it. */
export type CantCheckCause = 'budget' | 'not_a_paper' | 'not_listed' | 'unreadable' | 'id_unconfirmed' | 'source_unavailable' | 'other';

/** A reason that says a lookup limit was hit: the current wording and the one stored runs were written with. */
export function isLimitReason(reason: string): boolean {
  return reason.startsWith('Lookup limit reached') || / free daily search limit is used up\./.test(reason) || /lookup limits? (?:is|are) reached for now\./.test(reason);
}

export function cantCheckCause(result: CheckResult): CantCheckCause {
  const reason = result.reason;
  if (isLimitReason(reason)) return 'budget';
  // Older run files carry the earlier wording ("Not a paper", "Not a journal or conference paper").
  if (/^(?:Looks like a website or software|Looks like a book or thesis|Looks like a technical report|Marked as unpublished|Marked as in preparation|A private communication|Not a paper|Not a journal or conference paper)/.test(reason)) return 'not_a_paper';
  // Real works the databases often do not list: no venue named (reports, manuals, news), a talk, a paper from before 1970,
  // an IACR ePrint, or a journal locator that Crossref holds no record at.
  if (reason.startsWith('The journal, volume and page were read, but no Crossref record was found there')) return 'not_listed';
  if (reason.startsWith('Not in Crossref, arXiv, OpenReview or OpenAlex, and it was published before 1970') || reason.startsWith('Not in Crossref, arXiv, OpenReview or OpenAlex, and it names no journal') || reason.startsWith('Not in Crossref, arXiv, OpenReview or OpenAlex, and no journal or conference could be read') || reason.startsWith('Not in Crossref, arXiv, OpenReview or OpenAlex, and it reads as a talk') || reason.startsWith('Not in Crossref, arXiv, OpenReview or OpenAlex, and it reads as legislation') || reason.startsWith('Looks like an IACR ePrint')) return 'not_listed';
  // An entry that cites several works is read, but not as one work.
  if (reason.startsWith("Couldn't read this reference reliably") || reason.startsWith('This entry cites more than one work')) return 'unreadable';
  if (reason.startsWith("Couldn't confirm the identifier") || reason.startsWith("The identifier points to a record that doesn't match")) return 'id_unconfirmed';
  if (reason.startsWith("Couldn't search") || reason.startsWith('The matched record is marked as retracted') || reason.startsWith("Couldn't look up this identifier") || reason.startsWith('You appear to be offline') || reason.includes('has no title to compare') || reason.includes('record has no title')) return 'source_unavailable';
  return 'other';
}

export interface Tally {
  papers: number;
  /** Papers whose references could not be read or checked at all. */
  failedPapers: number;
  /** References in those papers, as the paper lists them, and the number actually checked (the sample). */
  referencesInPapers: number;
  refs: number;
  counts: Record<Status, number>;
  cantCheck: Record<CantCheckCause, number>;
}

function emptyTally(): Tally {
  return {
    papers: 0,
    failedPapers: 0,
    referencesInPapers: 0,
    refs: 0,
    counts: emptyCounts(),
    cantCheck: { budget: 0, not_a_paper: 0, not_listed: 0, unreadable: 0, id_unconfirmed: 0, source_unavailable: 0, other: 0 },
  };
}

export function tally(runs: readonly RunFile[]): Tally {
  const t = emptyTally();
  for (const run of runs) {
    t.papers += 1;
    // A paper whose reference list could not be found counts as a paper that could not be read.
    if (run.error !== undefined || run.referencesInPaper === 0) {
      t.failedPapers += 1;
      continue;
    }
    t.referencesInPapers += run.referencesInPaper;
    for (const r of run.results) {
      t.refs += 1;
      t.counts[r.status] += 1;
      if (r.status === 'cant_check') t.cantCheck[cantCheckCause(r)] += 1;
    }
  }
  return t;
}

/**
 * Can't check in four parts, for diagnosis (the all-in share stays the gate): `outOfScope`, judged by hand as something
 * no database lookup could check; `budget`, left unchecked because a lookup limit was hit (OpenAlex's daily budget, a
 * rate limit); `unavailable`, because a source did not answer, broke its contract or gave a record with no title (in an
 * offline re-score also: an answer that was never stored), which may hide a source or engine bug and is kept apart from
 * the budget; `engine`, everything else, which a better engine could check (books included: Crossref holds most of
 * them). The engine's own "not a paper" reason is no judgement: real papers have been mislabelled by it.
 */
export interface CantCheckParts {
  outOfScope: number;
  engine: number;
  budget: number;
  unavailable: number;
}

export function cantCheckParts(runs: readonly RunFile[], outOfScope: ReadonlySet<string>): CantCheckParts {
  const parts: CantCheckParts = { outOfScope: 0, engine: 0, budget: 0, unavailable: 0 };
  for (const run of runs) {
    if (run.error !== undefined) continue;
    for (const r of run.results) {
      if (r.status !== 'cant_check') continue;
      const cause = cantCheckCause(r);
      if (outOfScope.has(caseKeyOf(run.key, r.index))) parts.outOfScope += 1;
      else if (cause === 'budget') parts.budget += 1;
      else if (cause === 'source_unavailable') parts.unavailable += 1;
      else parts.engine += 1;
    }
  }
  return parts;
}

/** inspection.json: the inspected cases by key, and the `outOfScope` list beside them. */
export function readInspection(raw: unknown): { cases: Inspection; outOfScope: Set<string> } {
  const { outOfScope, ...cases } = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const listed = Array.isArray(outOfScope) ? (outOfScope as OutOfScopeCase[]) : [];
  return { cases: cases as Inspection, outOfScope: new Set(listed.map((c) => c.case)) };
}

// ---------------------------------------------------------------------------- the bar (DESIGN section 10)

export interface Bar {
  /** Real references wrongly labelled Not found or Wrong ID. */
  notFoundOrWrongId: number;
  detailsDiffer: number;
  cantCheck: number;
}

const HTML_BAR: Bar = { notFoundOrWrongId: 0.01, detailsDiffer: 0.05, cantCheck: 0.1 };
const PDF_BAR: Bar = { notFoundOrWrongId: 0.02, detailsDiffer: 0.08, cantCheck: 0.25 };
export const CORRUPTED_BAR = 0.9;

export function barFor(path: PaperPath): Bar {
  return path === 'arxiv-html' ? HTML_BAR : PDF_BAR;
}

// ---------------------------------------------------------------------------- inspection

/** A real-paper reference whose label asks the reader to look, so it is looked at by hand. */
export interface FlaggedCase {
  caseKey: string;
  runKey: string;
  path: PaperPath;
  index: number;
  status: Status;
  reason: string;
  citedText: string;
  matchedTitle: string | undefined;
}

export function caseKeyOf(runKey: string, index: number): string {
  return `${runKey}#${index}`;
}

/** Not found, Wrong ID and Retracted on real papers. (Details differ is counted as it is, not inspected.) */
export function flaggedCases(runs: readonly RunFile[]): FlaggedCase[] {
  const out: FlaggedCase[] = [];
  for (const run of runs) {
    if (run.group !== 'real' || run.path === undefined || run.error !== undefined) continue;
    for (const r of run.results) {
      if (r.status !== 'not_found' && r.status !== 'wrong_id' && r.status !== 'retracted') continue;
      out.push({ caseKey: caseKeyOf(run.key, r.index), runKey: run.key, path: run.path, index: r.index, status: r.status, reason: r.reason, citedText: r.citedText, matchedTitle: r.match?.title });
    }
  }
  return out;
}

export interface Judged {
  /** Flagged and inspected: the reference is real, so the label was wrong. */
  falsePositives: FlaggedCase[];
  /** Flagged and inspected: the reference really is faulty (or really is retracted). */
  confirmed: FlaggedCase[];
  /** Flagged and not inspected yet. */
  pending: FlaggedCase[];
}

export function judge(cases: readonly FlaggedCase[], inspection: Inspection): Judged {
  const out: Judged = { falsePositives: [], confirmed: [], pending: [] };
  for (const c of cases) {
    const found: InspectedCase | undefined = inspection[c.caseKey];
    if (found === undefined) out.pending.push(c);
    else if (found.verdict === 'real') out.falsePositives.push(c);
    else out.confirmed.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------- the synthetic sets

export interface FlagRate {
  total: number;
  /** Any status other than Verified. */
  flagged: number;
  byStatus: Record<Status, number>;
}

function emptyRate(): FlagRate {
  return { total: 0, flagged: 0, byStatus: emptyCounts() };
}

export function flagRate(results: readonly CheckResult[]): FlagRate {
  const rate = emptyRate();
  for (const r of results) {
    rate.total += 1;
    rate.byStatus[r.status] += 1;
    if (r.status !== 'verified') rate.flagged += 1;
  }
  return rate;
}

/** Corrupted citations by kind. `kindOf` maps a result's reference number to the kind of corruption. */
export function corruptedByKind(results: readonly CheckResult[], kindOf: (index: number) => CorruptionKind | undefined): Map<CorruptionKind, FlagRate> {
  const by = new Map<CorruptionKind, CheckResult[]>();
  for (const r of results) {
    const kind = kindOf(r.index);
    if (kind !== undefined) by.set(kind, [...(by.get(kind) ?? []), r]);
  }
  return new Map([...by].map(([kind, rs]) => [kind, flagRate(rs)]));
}

// ---------------------------------------------------------------------------- timing

/** When 90% of `total` results had arrived, from the time each one arrived (ms, any order). Null when fewer than 90% did. */
export function timeToShare(resultTimesMs: readonly number[], total: number, share = 0.9): number | null {
  if (total === 0) return null;
  const needed = Math.ceil(total * share);
  if (resultTimesMs.length < needed) return null;
  return [...resultTimesMs].sort((a, b) => a - b)[needed - 1] ?? null;
}

export function percent(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${((100 * part) / whole).toFixed(1)}%`;
}
