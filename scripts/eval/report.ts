// The text of tests/eval/RESULTS.md and of the console report, built from stored runs. Pure.
import { STATUSES } from '../../src/core/status';
import type { Status } from '../../src/core/types';
import { barFor, cantCheckParts, CORRUPTED_BAR, corruptedByKind, flagRate, flaggedCases, isLimitReason, judge, percent, tally, type Bar, type CantCheckCause, type CantCheckParts, type FlaggedCase, type Tally } from './score';
import type { CorruptedEntry, CorruptionKind, Inspection, PaperPath, RunFile } from './types';

const WORD: Record<Status, string> = { verified: 'Verified', details_differ: 'Details differ', wrong_id: 'Wrong ID', retracted: 'Retracted', not_found: 'Not found', cant_check: "Can't check" };
const CAUSE_WORD: Record<CantCheckCause, string> = {
  budget: 'lookup budget used up',
  not_a_paper: 'not a paper (website, software, book)',
  not_listed: 'not listed (no venue, talk, report, before 1970, ePrint)',
  unreadable: 'reference not readable',
  id_unconfirmed: 'identifier not confirmed',
  source_unavailable: 'a source could not answer',
  other: 'other',
};

export interface PathReport {
  name: string;
  /** Which bar applies. */
  bar: Bar;
  tally: Tally;
  /** Can't check split into out of scope (judged by hand), engine shortfall, budget and a source not answering (cantCheckParts). */
  parts: CantCheckParts;
  flagged: FlaggedCase[];
  falsePositives: number;
  pending: number;
  /** After inspection when every flagged case has been looked at, else as labelled. */
  notFoundOrWrongIdRate: number;
  detailsDifferRate: number;
  cantCheckRate: number;
  pass: boolean;
}

function row(cells: (string | number)[]): string {
  return `| ${cells.join(' | ')} |`;
}

function table(header: string[], rows: (string | number)[][]): string {
  return [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n');
}

const rate = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

function andList(items: readonly (string | number)[]): string {
  return items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${String(items.at(-1))}`;
}

/**
 * The held-out sets in a sentence: "six sets of 8 papers, all scored here" when every paper of every set was scored;
 * otherwise each set's size and how many of its papers were scored, so a gap shows.
 */
export function heldOutSetsText(sets: readonly { papers: number; scored: number }[]): string {
  const sizes = sets.map((s) => s.papers);
  if (sets.some((s) => s.scored !== s.papers)) return `${andList(sizes)} papers, of which ${andList(sets.map((s) => s.scored))} are scored here`;
  const count = `${COUNT_WORDS[sets.length] ?? sets.length} ${sets.length === 1 ? 'set' : 'sets'}`;
  const size = sizes.every((n) => n === sizes[0]) ? String(sizes[0]) : andList(sizes);
  return `${count} of ${size} ${size === '1' ? 'paper' : 'papers'}, all scored here`;
}

export function pathReport(name: string, path: PaperPath, runs: readonly RunFile[], inspection: Inspection, outOfScope: ReadonlySet<string> = new Set()): PathReport {
  const t = tally(runs);
  const flagged = flaggedCases(runs).filter((c) => c.status !== 'retracted');
  const judged = judge(flagged, inspection);
  const raw = t.counts.not_found + t.counts.wrong_id;
  const wrongly = judged.pending.length === 0 ? judged.falsePositives.length : raw;
  const bar = barFor(path);
  const report: PathReport = {
    name,
    bar,
    tally: t,
    parts: cantCheckParts(runs, outOfScope),
    flagged,
    falsePositives: judged.falsePositives.length,
    pending: judged.pending.length,
    notFoundOrWrongIdRate: rate(wrongly, t.refs),
    detailsDifferRate: rate(t.counts.details_differ, t.refs),
    cantCheckRate: rate(t.counts.cant_check, t.refs),
    pass: false,
  };
  report.pass = report.notFoundOrWrongIdRate <= bar.notFoundOrWrongId && report.detailsDifferRate <= bar.detailsDiffer && report.cantCheckRate <= bar.cantCheck;
  return report;
}

export function pathTables(reports: readonly PathReport[]): string {
  const rows = reports.map((r) => [
    r.name,
    `${r.tally.papers - r.tally.failedPapers}/${r.tally.papers}`,
    r.tally.refs,
    STATUSES.map((s) => `${r.tally.counts[s]}`).join(' / '),
  ]);
  const counts = table(['Path', 'Papers read', 'References checked', STATUSES.map((s) => WORD[s]).join(' / ')], rows);

  const bar = table(
    ['Path', 'Not found + Wrong ID (as labelled)', 'after inspection', 'bar', 'Details differ', 'bar', "Can't check", 'bar', 'Result'],
    reports.map((r) => {
      const raw = r.tally.counts.not_found + r.tally.counts.wrong_id;
      return [
        r.name,
        `${raw} (${percent(raw, r.tally.refs)})`,
        r.pending === 0 ? `${r.falsePositives} (${percent(r.falsePositives, r.tally.refs)})` : `${r.pending} not inspected yet`,
        `≤ ${(r.bar.notFoundOrWrongId * 100).toFixed(0)}%`,
        `${r.tally.counts.details_differ} (${percent(r.tally.counts.details_differ, r.tally.refs)})`,
        `≤ ${(r.bar.detailsDiffer * 100).toFixed(0)}%`,
        `${r.tally.counts.cant_check} (${percent(r.tally.counts.cant_check, r.tally.refs)})`,
        `≤ ${(r.bar.cantCheck * 100).toFixed(0)}%`,
        r.tally.refs === 0 ? 'not run' : r.pass ? 'meets the bar' : 'MISSES the bar',
      ];
    }),
  );

  const causes = table(
    ['Path', "Can't check", ...(Object.keys(CAUSE_WORD) as CantCheckCause[]).map((c) => CAUSE_WORD[c])],
    reports.map((r) => [r.name, r.tally.counts.cant_check, ...(Object.keys(CAUSE_WORD) as CantCheckCause[]).map((c) => r.tally.cantCheck[c])]),
  );
  const parts = table(
    ['Path', "Can't check (all)", 'out of scope (judged by hand)', 'engine shortfall (books included)', 'lookup budget', 'a source not answering'],
    reports.map((r) => [r.name, r.tally.counts.cant_check, r.parts.outOfScope, `${r.parts.engine} (${percent(r.parts.engine, r.tally.refs)})`, r.parts.budget, r.parts.unavailable]),
  );
  return [counts, '', bar, '', causes, '', parts].join('\n');
}

/** Printed above the timing table: the times are kept from the first run, in which every answer came from the services. */
export const TIMING_NOTE =
  'These times come from the first live run, the only one in which every request of a paper really went out; they are kept when a later run answers from the disk cache. The engine has since added requests (ten Crossref answers instead of five, a second page when comments crowd the first, lookups for journal citations without a title), so a live check today takes somewhat longer. The times were not measured again.';

export function timingTable(runs: readonly RunFile[]): string {
  const rows = runs
    .filter((r) => r.error === undefined)
    .map((r) => [
      r.key,
      r.results.length,
      r.timing.live ? `${(r.timing.t90Ms === null ? NaN : r.timing.t90Ms / 1000).toFixed(1)} s` : 'not measured (answers came from the cache)',
      r.timing.live ? `${((r.timing.firstResultMs ?? NaN) / 1000).toFixed(1)} s` : '',
      r.timing.live ? `${(r.timing.runMs / 1000).toFixed(1)} s` : '',
    ]);
  return table(['Paper', 'References checked', 'Until 90% of results', 'First result', 'Until all'], rows);
}

export function inspectionTable(cases: readonly FlaggedCase[], inspection: Inspection): string {
  const rows = cases.map((c) => {
    const found = inspection[c.caseKey];
    const cited = c.citedText.replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 110);
    return [c.caseKey, WORD[c.status], cited, found === undefined ? 'not inspected' : found.verdict === 'real' ? 'real reference (false positive)' : 'faulty reference (correct label)', found?.cause ?? '', (found?.note ?? '').replace(/\|/g, '/')];
  });
  return table(['Case', 'Label', 'Reference (start)', 'After looking it up', 'Cause', 'Note'], rows);
}

export interface SyntheticReport {
  corrupted: { total: number; flagged: number; rate: number; byKind: [CorruptionKind, number, number][]; budgetLimited: number; pass: boolean };
  retracted: { total: number; detected: number; withDoi: [number, number]; withoutDoi: [number, number]; pass: boolean };
  controls: { total: number; verified: number };
}

export function syntheticReport(corrupted: RunFile | undefined, retracted: RunFile | undefined, controls: RunFile | undefined, entries: { corrupted: CorruptedEntry[]; retractedWithDoi: boolean[] }): SyntheticReport {
  const kindOf = (index: number): CorruptionKind | undefined => entries.corrupted[index - 1]?.kind;
  const cr = corrupted?.results ?? [];
  const all = flagRate(cr);
  const byKind = [...corruptedByKind(cr, kindOf)].map(([kind, r]) => [kind, r.flagged, r.total] as [CorruptionKind, number, number]);
  const rr = retracted?.results ?? [];
  const isDetected = (status: Status): boolean => status === 'retracted';
  const split = (withDoi: boolean): [number, number] => {
    const these = rr.filter((r) => entries.retractedWithDoi[r.index - 1] === withDoi);
    return [these.filter((r) => isDetected(r.status)).length, these.length];
  };
  const detected = rr.filter((r) => isDetected(r.status)).length;
  return {
    corrupted: {
      total: all.total,
      flagged: all.flagged,
      rate: rate(all.flagged, all.total),
      byKind,
      budgetLimited: cr.filter((r) => r.status === 'cant_check' && isLimitReason(r.reason)).length,
      pass: all.total > 0 && rate(all.flagged, all.total) >= CORRUPTED_BAR,
    },
    retracted: { total: rr.length, detected, withDoi: split(true), withoutDoi: split(false), pass: rr.length > 0 && detected === rr.length },
    controls: { total: controls?.results.length ?? 0, verified: (controls?.results ?? []).filter((r) => r.status === 'verified').length },
  };
}
