// Plain-text, CSV and JSON versions of a finished check (DESIGN 7.3). Pure: the side panel decides
// where the text goes (clipboard or file). Nothing here knows about settings, so no key can end up in one.

import { asText } from './coerce';
import { arxivUrl, dblpRecordUrl, isValidDblpKey, isValidOpenAlexWorkId, openalexWorkUrl } from './identifiers';
import { FIELD_NAME, sortProblemsFirst, sourceName, STATUS_WORD, totalsText } from './status';
import type { CheckResult, CheckSummary } from './types';

export const PDF_BETA_HELP = 'References read from the PDF. A few may be misread.';

/** "Checked using the arXiv version (arXiv:1706.03762)" for an OpenReview page checked through its arXiv twin. */
export function arxivVersionLine(arxivId: string): string {
  return `Checked using the arXiv version (arXiv:${arxivId})`;
}

/** The validated address of the arXiv version, or undefined when the stored id is not a valid arXiv id. */
export function arxivVersionUrl(arxivId: string): string | undefined {
  try {
    return arxivUrl(arxivId);
  } catch {
    return undefined;
  }
}

const RETRACTION_NOTICE = 'Retraction notice';

/** The page of a matched OpenAlex or DBLP record, built from its validated id; undefined for anything else. */
function recordPageLink(match: unknown): CheckResult['links'][number] | undefined {
  // `match` crossed the message boundary as "some record": every field is checked before it is used.
  if (match === null || typeof match !== 'object') return undefined;
  const { source, openalexId, dblpKey } = match as Record<string, unknown>;
  if (source === 'openalex' && typeof openalexId === 'string' && isValidOpenAlexWorkId(openalexId)) return { label: 'OpenAlex', url: openalexWorkUrl(openalexId) };
  if (source === 'dblp' && typeof dblpKey === 'string' && isValidDblpKey(dblpKey)) return { label: 'DBLP', url: dblpRecordUrl(dblpKey) };
  return undefined;
}

/**
 * The result's links for the panel and the exports: its DOI, arXiv and OpenReview links, or, when it has none of
 * those, the page of the OpenAlex or DBLP record it was matched with, so the reader can see what it was compared with.
 */
export function resultLinks(r: CheckResult): CheckResult['links'] {
  if (r.links.some((l) => l.label !== RETRACTION_NOTICE)) return r.links;
  const page = recordPageLink(r.match);
  return page === undefined ? r.links : [page, ...r.links];
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function checkedDate(summary: CheckSummary): string {
  return new Date(summary.finishedAt ?? summary.startedAt).toISOString().slice(0, 10);
}

/** A check that was stopped before it finished: how many references were done, out of how many. */
export interface ReportOptions {
  stoppedAfter?: { checked: number; total: number };
}

function stoppedLine({ checked, total }: { checked: number; total: number }): string {
  return `Stopped after ${checked} of ${total} ${total === 1 ? 'reference' : 'references'}`;
}

export function toPlainTextReport(s: CheckSummary, rs: CheckResult[], options: ReportOptions = {}): string {
  const lines: string[] = [`RefSure check — ${oneLine(s.paper.title) || s.paper.key}`, s.paper.url];
  if (options.stoppedAfter !== undefined) lines.push(stoppedLine(options.stoppedAfter));
  if (s.paper.viaArxivVersion !== undefined) lines.push(arxivVersionLine(s.paper.viaArxivVersion));
  if (s.beta || s.paper.viaPdf) lines.push(`Beta: ${PDF_BETA_HELP}`);
  // A stopped check counts what was checked, so "5 of 40 references checked: 5 verified" is not read as 35 failures.
  const { stoppedAfter } = options;
  const counted = stoppedAfter === undefined ? `${s.total} ${s.total === 1 ? 'reference' : 'references'}` : `${stoppedAfter.checked} of ${stoppedAfter.total} ${stoppedAfter.total === 1 ? 'reference' : 'references'} checked`;
  lines.push(`Checked on ${checkedDate(s)}`, '', `${counted}: ${totalsText(s.counts)}`, '');
  for (const r of sortProblemsFirst(rs)) {
    lines.push(`[${r.index}] ${STATUS_WORD[r.status]} — ${oneLine(r.reason)}`);
    lines.push(`    Cited: ${oneLine(r.citedText)}`);
    for (const d of r.diffs) lines.push(`    ${FIELD_NAME[d.field]}: cited ${oneLine(d.cited)}, found ${oneLine(d.actual)}`);
    for (const note of r.notes) lines.push(`    ${oneLine(note)}`);
    for (const link of resultLinks(r)) lines.push(`    ${oneLine(link.label)}: ${link.url}`);
    lines.push('');
  }
  lines.push('Checked against public databases. A status is a lead to look at, not a verdict.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------- CSV

const HEADER = [
  'Number',
  'Label',
  'Status',
  'Reason',
  'Cited reference',
  'Matched title',
  'Matched year',
  'Matched DOI',
  'Matched arXiv ID',
  'Differences',
  'Notes',
  'Links',
  'Sources searched',
  'Sources not reached',
] as const;

// A spreadsheet runs a cell that starts with one of these as a formula (SECURITY.md section 4).
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell: a leading formula character is defused with an apostrophe, and every cell is quoted, so a
 * spreadsheet whose list separator is ";" cannot split a cell and start a formula in the second half.
 */
function cell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

function row(values: readonly string[]): string {
  return values.map(cell).join(',');
}

export function toCsv(rs: CheckResult[]): string {
  const rows = [...rs].sort((a, b) => a.index - b.index).map((r) =>
    row([
      String(r.index),
      r.label,
      STATUS_WORD[r.status],
      r.reason,
      r.citedText,
      asText(r.match?.title),
      asText(r.match?.year),
      asText(r.match?.doi),
      asText(r.match?.arxivId),
      r.diffs.map((d) => `${FIELD_NAME[d.field]}: cited ${d.cited}, found ${d.actual}`).join('; '),
      r.notes.join('; '),
      resultLinks(r).map((l) => l.url).join(' '),
      r.sourcesSearched.map(sourceName).join('; '),
      r.sourcesFailed.map(sourceName).join('; '),
    ]),
  );
  return [row(HEADER), ...rows].join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------- JSON

export function toJson(s: CheckSummary, rs: CheckResult[], options: ReportOptions = {}): string {
  const { paper } = s;
  const out = {
    tool: 'RefSure',
    paper: {
      title: paper.title,
      url: paper.url,
      key: paper.key,
      origin: paper.origin,
      viaPdf: paper.viaPdf,
      ...(paper.viaArxivVersion !== undefined && { viaArxivVersion: paper.viaArxivVersion }),
    },
    checkedAt: new Date(s.finishedAt ?? s.startedAt).toISOString(),
    beta: s.beta,
    ...(options.stoppedAfter !== undefined && { stoppedAfter: options.stoppedAfter }),
    total: s.total,
    counts: s.counts,
    results: [...rs].sort((a, b) => a.index - b.index).map((r) => ({ ...r, links: resultLinks(r) })),
  };
  return JSON.stringify(out, null, 2);
}
